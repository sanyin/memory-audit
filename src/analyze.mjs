import { readFileSync } from 'node:fs';
import { parseSession, agentSurface, isLive } from './session.mjs';
import { extractClaims, extractMemoryFile, splitSentences, lexicon, hash } from './claims.mjs';
import { clusterRepeats } from './repeat.mjs';

const CANON = { postgresql: 'postgres', mongo: 'mongodb', nextjs: 'next.js', 'apache 2.0': 'apache-2.0', golang: 'go', 'json 文件': 'json file', 'jsonl 文件': 'jsonl file' };

function buildTermMatcher() {
  const terms = [];
  for (const s of lexicon.slots) for (const t of s.terms) terms.push({ term: t, slot: s.slot });
  terms.sort((a, b) => b.term.length - a.term.length);
  const parts = terms.map(({ term }) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /^[a-z0-9 .+#-]+$/i.test(term) ? `(?<![a-z0-9])${escaped}(?![a-z0-9])` : escaped;
  });
  const regex = new RegExp(parts.join('|'), 'gi');
  const byTerm = new Map(terms.map((t) => [t.term.toLowerCase(), t]));
  return (text) => {
    const hits = new Map();
    if (!text) return hits;
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const raw = m[0].toLowerCase();
      const hit = byTerm.get(raw);
      if (!hit) continue;
      const key = `${hit.slot}:${CANON[hit.term] ?? hit.term}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
    return hits;
  };
}

/** Normalized text for duplicate detection: "same requirement said twice" is a memory failure. */
export const norm = (s) => s.replace(/[\s\u3000]+/g, '').replace(/[，。；：！？、,.!?;:"""''（）()【】\[\]]/g, '').toLowerCase().slice(0, 160);

/** A distinctive 10-char fragment of the unit, used as a strict verbatim-reuse probe. */
export function anchorOf(text) {
  const clean = text.replace(/[\s\u3000]+/g, '').replace(/[，。；：！？、,.!?;:"""''（）()【】\[\]]/g, '');
  let best = { score: -1, anchor: '' };
  for (let i = 0; i + 8 <= clean.length; i++) {
    const w = clean.slice(i, i + 8);
    if (/^[\x00-\x7f]*$/.test(w) && /\d{4,}/.test(w)) continue;
    const variety = new Set(w).size;
    if (variety > best.score) best = { score: variety, anchor: w };
  }
  return best.anchor;
}

const STOP = new Set('的我你他她它了是在有和就不也这那要会能可对与及等以为把被让给从到只还又都很更最再才并但而如果所因于其之上下中一个这那么些'.split(''));
const STOP_EN = new Set('are this that with from have will would should could they them their there what when which while your about into than then these those been being does doing only also more most some such very just like over under after before because between without within using use used can not but all any each other same both its our out off own too now yet still here where how why who whom whose'.split(' '));

/** Cheap content features: CJK bigrams without stop characters, plus ASCII words. */
export function featuresOf(text) {
  const out = new Set();
  const ascii = text.toLowerCase().match(/[a-z][a-z0-9.+#-]{2,}/g) ?? [];
  for (const a of ascii) if (!STOP_EN.has(a)) out.add(a);
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (STOP.has(bg[0]) || STOP.has(bg[1])) continue;
      out.add(bg);
    }
  }
  return [...out];
}

const DIRECTIVES = [
  '要', '必须', '不要', '别', '请', '希望', '应该', '需要', '不能', '记得', '保持', '优先', '一律', '务必', '确保', '避免',
  '重写', '改成', '改为', '更新', '新增', '加一个', '加一份', '补上', '补充', '实现', '修复', '删掉', '去掉', '换成',
  '重构', '整理', '优化', '统一', '检查', '评价', '打分', '生成', '输出', '帮我', '给我', '麻烦', '做一下', '做个',
  'must', 'should', 'need to', 'please', 'always', 'never', "don't", 'do not', 'avoid', 'ensure', 'keep', 'rewrite',
];

export function extractRequirements(text) {
  const out = [];
  if (/sandbox_permissions|<system-reminder>|approval prompts are disabled/i.test(text)) return out;
  for (const s of splitSentences(text)) {
    if (s.length < 6 || s.length > 240) continue;
    if (!DIRECTIVES.some((d) => s.toLowerCase().includes(d))) continue;
    out.push(s);
  }
  return out;
}

export function analyzeSession({ transcriptPath, memoryPaths = [] }) {
  const parsed = parseSession(transcriptPath);
  const matchTerms = buildTermMatcher();
  const turns = parsed.turns;
  const turnNumbers = turns.map((t) => t.turn);

  const surface = new Map();
  const termIndex = new Map();
  for (const t of turns) {
    const all = [];
    const byWhere = { reasoning: [], text: [], 'tool-call': [] };
    for (const chunk of agentSurface(t)) {
      all.push(chunk.text);
      byWhere[chunk.where]?.push(chunk.text);
    }
    const joined = all.join('\n');
    const hits = matchTerms(joined);
    // Per-slot-value turn index: lets the cross-session view count mentions
    // without re-scanning every transcript.
    for (const [key, n] of hits) {
      const row = termIndex.get(key) ?? { turns: new Set(), occurrences: 0, toolTurns: new Set() };
      row.turns.add(t.turn);
      row.occurrences += n;
      if (matchTerms(byWhere['tool-call'].join('\n')).get(key)) row.toolTurns.add(t.turn);
      termIndex.set(key, row);
    }
    surface.set(t.turn, {
      hits,
      where: { reasoning: matchTerms(byWhere.reasoning.join('\n')), text: matchTerms(byWhere.text.join('\n')), 'tool-call': matchTerms(byWhere['tool-call'].join('\n')) },
      compact: joined.replace(/[\s\u3000]+/g, ''),
    });
  }

  // ---- units -------------------------------------------------------------
  const units = [];
  const byNorm = new Map();
  const push = (u) => {
    const key = `${u.kind}|${u.slot ?? ''}|${u.value ?? ''}|${norm(u.fullText ?? u.text)}`;
    const prev = byNorm.get(key);
    if (prev && key.length > 3) {
      // Same sentence said again in a later turn is a memory failure. Same turn is not.
      if (prev.repeatTurns[prev.repeatTurns.length - 1] !== u.turn) {
        prev.repeatCount += 1;
        prev.repeatTurns.push(u.turn);
      }
      return;
    }
    u.repeatCount = 1;
    u.repeatTurns = [u.turn];
    byNorm.set(key, u);
    units.push(u);
  };

  for (const t of turns) {
    for (const msg of t.user) {
      if (msg.synthetic) continue;
      // Typed instructions are short. Anything pasted (logs, catalogs, diffs) is not a memory claim.
      if (msg.text.length > 3000) continue;
      for (const c of extractClaims(msg.text, { channel: 'user', turn: t.turn, seq: msg.seq, at: msg.at })) push({ ...c, fullText: c.text, anchor: anchorOf(c.text) });
      for (const req of extractRequirements(msg.text)) {
        push({
          id: `r_${hash(`${msg.seq}|${req.slice(0, 30)}`)}`,
          kind: 'requirement',
          text: req.length > 200 ? `${req.slice(0, 197)}…` : req,
          fullText: req,
          channel: 'user',
          turn: t.turn,
          seq: msg.seq,
          at: msg.at,
          anchor: anchorOf(req),
        });
      }
    }
    for (const inj of t.injections) {
      if (inj.kind !== 'compaction-summary') continue;
      for (const c of extractClaims(inj.text, { channel: 'compaction', turn: t.turn, seq: inj.seq })) push({ ...c, fullText: c.text, anchor: anchorOf(c.text) });
    }
  }
  for (const g of parsed.goals) {
    if (!g.goal?.objective) continue;
    push({
      id: `g_${hash(`${g.goal.id}|${g.operation}|${g.seq}`)}`,
      kind: 'goal',
      text: `[${g.operation}] ${g.goal.objective}`,
      fullText: g.goal.objective,
      channel: 'goal',
      turn: g.turn,
      seq: g.seq,
      at: g.at,
      anchor: anchorOf(g.goal.objective),
    });
  }
  for (const p of memoryPaths) {
    for (const u of extractMemoryFile(p, readFileSync(p, 'utf8'))) {
      push({ ...u, channel: 'memory-file', turn: 0, seq: 0, anchor: anchorOf(u.fullText) });
    }
  }

  // ---- lifecycle + reuse -------------------------------------------------
  const evictions = parsed.evictions;

  for (const u of units) {
    u.features = u.kind === 'requirement' || u.kind === 'claim' || u.kind === 'goal' ? featuresOf(u.fullText ?? u.text).slice(0, 24) : [];
    u.confidence = u.kind === 'claim' ? 0.9 : u.kind === 'requirement' ? 0.6 : 0.8;
  }
  // Document frequency per feature: a phrase every turn contains proves nothing.
  const featureTurns = new Map();
  for (const u of units) {
    for (const f of u.features) {
      if (featureTurns.has(f)) continue;
      const set = new Set();
      for (const t of turns) if (surface.get(t.turn).compact.includes(f)) set.add(t.turn);
      featureTurns.set(f, set);
    }
  }
  const commonLimit = turnNumbers.length * 0.3;
  const tooCommon = (f) => (featureTurns.get(f)?.size ?? 0) > commonLimit;

  for (const u of units) {
    const live = [];
    for (const t of turnNumbers) if (t >= u.turn && isLive(u.seq, t, evictions)) live.push(t);
    u.liveTurns = live;
    u.evictedAtTurn = u.kind === 'claim' || u.kind === 'requirement' || u.kind === 'goal'
      ? evictions.filter((e) => e.atTurn > u.turn && u.seq >= e.startSeq && u.seq <= e.endSeq).reduce((min, e) => (min == null ? e.atTurn : Math.min(min, e.atTurn)), null)
      : null;

    const mentionTurns = [];
    const reuseTurns = [];
    const relatedTurns = [];
    const toolTurns = [];
    let occurrences = 0;
    const key = u.kind === 'claim' && u.slot ? `${u.slot}:${u.value}` : null;
    for (const t of turnNumbers) {
      if (t <= u.turn) continue;
      const s = surface.get(t);
      if (key) {
        const n = s.hits.get(key);
        if (n) {
          mentionTurns.push(t);
          occurrences += n;
          if (s.where['tool-call'].get(key)) toolTurns.push(t);
        }
      }
      if (u.anchor && u.anchor.length >= 8 && s.compact.includes(u.anchor)) reuseTurns.push(t);
      if (u.features.length) {
        let hits = 0;
        for (const f of u.features) {
          if (tooCommon(f)) continue;
          if (featureTurns.get(f)?.has(t)) hits++;
        }
        if (hits >= 3) relatedTurns.push(t);
      }
    }
    u.mentionTurns = mentionTurns;
    u.mentionOccurrences = occurrences;
    u.toolTurns = toolTurns;
    u.reuseTurns = reuseTurns;
    u.relatedTurns = relatedTurns;
    u.lastCitedTurn = [...mentionTurns, ...reuseTurns, ...relatedTurns].length ? Math.max(...mentionTurns, ...reuseTurns, ...relatedTurns) : null;
  }

  // ---- conflicts ---------------------------------------------------------
  const conflicts = [];
  const claims = units.filter((u) => u.kind === 'claim' && u.slot);
  for (const slot of new Set(claims.map((c) => c.slot))) {
    const group = claims.filter((c) => c.slot === slot);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.value === b.value) continue;
        if (!(a.polarity === 'adopt' || b.polarity === 'adopt')) continue;
        const [older, newer] = a.turn < b.turn || (a.turn === b.turn && a.seq < b.seq) ? [a, b] : [b, a];
        if (older.id === newer.id) continue;
        const after = turnNumbers.filter((t) => t > newer.turn);
        const cnt = (list) => after.filter((t) => list.includes(t)).length;
        const oldMentions = cnt(older.mentionTurns);
        const newMentions = cnt(newer.mentionTurns);
        let verdict;
        if (newMentions === 0 && oldMentions > 0) verdict = 'write-ignored';
        else if (newMentions > 0 && oldMentions === 0) verdict = 'took-effect';
        else if (newMentions === 0 && oldMentions === 0) verdict = 'both-silent';
        else if (newMentions >= oldMentions) verdict = 'new-dominant';
        else verdict = 'legacy-dominant';
        conflicts.push({
          id: `c_${hash(`${older.id}|${newer.id}`)}`,
          slot,
          slotLabel: lexicon.slots.find((s) => s.slot === slot)?.label ?? slot,
          older,
          newer,
          windowTurns: after.length,
          oldMentions,
          newMentions,
          oldTool: cnt(older.toolTurns),
          newTool: cnt(newer.toolTurns),
          verdict,
        });
      }
    }
  }
  const rank = { 'write-ignored': 0, 'legacy-dominant': 1, 'both-silent': 2, 'new-dominant': 3, 'took-effect': 4 };
  conflicts.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.windowTurns - a.windowTurns);

  // ---- compaction fidelity ----------------------------------------------
  // Anthropic's context-engineering note warns that compaction trades recall
  // for space: "overly aggressive compaction can result in the loss of subtle
  // but critical context". This measures that trade instead of assuming it.
  const summaries = parsed.compactions.filter((c) => c.phase === 'summary' && c.text);
  const summaryIndex = summaries.map((s) => ({ turn: s.turn, seq: s.seq, text: s.text, hits: matchTerms(s.text) }));
  for (const u of units) {
    u.compactionKept = null;
    u.compactionHow = null;
    if (u.evictedAtTurn == null) continue;
    for (const s of summaryIndex) {
      if (s.turn < u.turn) continue;
      let kept = false;
      if (u.kind === 'claim' && u.slot) kept = Boolean(s.hits.get(`${u.slot}:${u.value}`));
      else kept = (u.features ?? []).filter((f) => !tooCommon(f) && s.text.includes(f)).length >= 2;
      if (kept) {
        u.compactionKept = true;
        u.compactionHow = u.kind === 'claim' ? 'term' : 'features';
        break;
      }
    }
    if (u.compactionKept === null) u.compactionKept = false;
  }
  const evictedAll = units.filter((u) => u.evictedAtTurn != null);
  const byKind = {};
  for (const u of evictedAll) {
    byKind[u.kind] = byKind[u.kind] ?? { total: 0, kept: 0 };
    byKind[u.kind].total += 1;
    if (u.compactionKept) byKind[u.kind].kept += 1;
  }
  const fidelity = {
    total: evictedAll.length,
    kept: evictedAll.filter((u) => u.compactionKept).length,
    dropped: evictedAll.filter((u) => !u.compactionKept).length,
    byKind,
    summaries: summaries.map((s) => ({ turn: s.turn, seq: s.seq, chars: s.text.length })),
  };

  // ---- skills ------------------------------------------------------------
  const installed = new Map();
  for (const t of turns) {
    for (const inj of t.injections) {
      if (inj.kind !== 'skill-catalog') continue;
      for (const m of inj.text.matchAll(/^\s*-\s+`([^`]+)`\s*:/gm)) {
        if (!installed.has(m[1])) installed.set(m[1], { name: m[1], injectedTurns: [] });
        installed.get(m[1]).injectedTurns.push(t.turn);
      }
    }
  }
  const loaded = new Map();
  for (const l of parsed.skillLoads) {
    if (!l.name) continue;
    if (!loaded.has(l.name)) loaded.set(l.name, { name: l.name, turns: [] });
    loaded.get(l.name).turns.push(l.turn);
  }
  const skillRows = [...installed.values()]
    .map((s) => ({ ...s, catalogTurns: s.injectedTurns.length, loadTurns: loaded.get(s.name)?.turns ?? [], loaded: loaded.has(s.name) }))
    .sort((a, b) => b.loadTurns.length - a.loadTurns.length || a.name.localeCompare(b.name));

  const pressure = turns.map((t) => ({ turn: t.turn, user: t.chars.user, assistant: t.chars.assistant, tool: t.chars.tool, system: t.chars.system, total: t.chars.user + t.chars.assistant + t.chars.tool + t.chars.system }));

  const actionable = units.filter((u) => u.kind === 'claim' || u.kind === 'requirement');
  const neverReused = actionable.filter((u) => u.reuseTurns.length === 0 && u.relatedTurns.length === 0 && u.mentionTurns.length === 0);
  const repeated = units.filter((u) => u.repeatCount > 1);
  const repeats = clusterRepeats(units);
  const evictedUnits = units.filter((u) => u.evictedAtTurn != null);

  return {
    meta: {
      transcript: transcriptPath,
      generatedAt: new Date().toISOString(),
      session: parsed.session,
      turns: turnNumbers.length,
      maxTurn: turnNumbers[turnNumbers.length - 1] ?? 0,
      rows: parsed.stats.rows,
      textBytes: parsed.stats.textBytes,
      compressed: parsed.stats.compressed,
      memoryPaths,
    },
    units,
    conflicts,
    skills: {
      installedCount: installed.size,
      loadedCount: loaded.size,
      neverLoadedCount: Math.max(0, installed.size - loaded.size),
      rows: skillRows,
      catalogTurns: parsed.catalogTurns,
    },
    evictions,
    termIndex: Object.fromEntries(
      [...termIndex.entries()].map(([k, v]) => [
        k,
        { turns: [...v.turns].sort((a, b) => a - b), occurrences: v.occurrences, toolTurns: [...v.toolTurns].sort((a, b) => a - b) },
      ]),
    ),
    compactions: parsed.compactions,
    goals: parsed.goals.map((g) => ({ operation: g.operation, turn: g.turn, objective: g.goal?.objective ?? '', at: g.at })),
    pressure,
    fidelity,
    headline: {
      units: units.length,
      claims: units.filter((u) => u.kind === 'claim').length,
      requirements: units.filter((u) => u.kind === 'requirement').length,
      goals: units.filter((u) => u.kind === 'goal').length,
      conflicts: conflicts.length,
      writeIgnored: conflicts.filter((c) => c.verdict === 'write-ignored' || c.verdict === 'legacy-dominant').length,
      neverReused: neverReused.length,
      repeated: repeated.length,
      repeatGroups: repeats.length,
      restatedAfterEviction: repeats.filter((r) => r.restatedAfterEviction).length,
      evictedUnits: evictedUnits.length,
      evictedTokens: evictions.reduce((s, e) => s + (e.tokens ?? 0), 0),
      compactionKept: fidelity.kept,
      compactionDropped: fidelity.dropped,
    },
    neverReused,
    repeated,
    repeats,
    evicted: evictedUnits,
    limits: [
      '来源只有四种：用户自己写下的话、压缩摘要、目标记录、记忆文件。模型内部推理不算“记忆来源”，只算“使用证据”。',
      '“被用过”分三级：原样复述（10 字片段逐字命中，强）、术语共现（同一槽位词出现，弱）、写进工具调用（最强，说明真的落到了动作里）。',
      '短词命中不等于使用：模型提到 “postgres” 也可能是在否定它。工具只报告可核对的证据，不推断意图。',
      '冲突只在内置槽位词表（src/lexicon.json）内成立。自然语言约束之间的矛盾（“要完整” vs “别啰嗦”）规则判断不了，工具会明确留空而不是编一个。',
      '压缩/裁剪造成的遗忘可见；模型权重里“自己忘掉的”不可见。本报告只覆盖后者之外的部分。',
    ],
  };
}
