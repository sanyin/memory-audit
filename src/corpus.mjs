/**
 * Cross-session memory: the real question is not "what did this conversation
 * remember", it is "what survived between conversations".
 *
 * A session is a context window with a life story. When the window closes, the
 * only things that cross the boundary are files, skills, and whatever the next
 * session re-derives from them. So the unit of analysis becomes the *thread*:
 * one memory, its occurrences in N sessions, and whether the later sessions
 * ever picked it up again.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { analyzeSession } from './analyze.mjs';
import { similarity } from './repeat.mjs';

const SESSION_FILE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;

/** Newest session file per session directory, newest directories first. */
export function discoverSessions({ root = join(homedir(), '.dsh', 'sessions'), project = null, limit = 12 } = {}) {
  if (!existsSync(root)) throw new Error(`找不到会话目录：${root}`);
  const found = [];
  for (const projectDir of readdirSync(root)) {
    if (project && projectDir !== project && !projectDir.includes(project)) continue;
    const projectPath = join(root, projectDir);
    if (!statSync(projectPath).isDirectory()) continue;
    for (const sessionDir of readdirSync(projectPath)) {
      const dir = join(projectPath, sessionDir);
      if (!statSync(dir).isDirectory()) continue;
      let best = null;
      for (const f of readdirSync(dir)) {
        const m = SESSION_FILE.exec(f);
        if (!m) continue;
        const p = join(dir, f);
        const st = statSync(p);
        const version = Number(m[1]);
        if (!best || version > best.version || (version === best.version && st.mtimeMs > best.mtime)) {
          best = { path: p, version, mtime: st.mtimeMs, size: st.size };
        }
      }
      if (best) found.push({ ...best, project: projectDir, sessionDir });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

const shortId = (id) => (id ?? '').replace(/^session-/, '').slice(0, 8);

/**
 * Greedy thread clustering across sessions.
 * Claims merge on their typed identity first (slot+value+polarity); everything
 * else merges on lexical similarity. Text similarity alone would merge
 * "用 Postgres" and "别用 Postgres".
 */
function clusterThreads(items) {
  const threads = [];
  for (const item of items) {
    let target = threads.find((t) => {
      const rep = t.members[0].unit;
      if (rep.kind === 'claim' && item.unit.kind === 'claim' && rep.slot && item.unit.slot) {
        if (rep.slot === item.unit.slot && rep.value === item.unit.value && rep.polarity === item.unit.polarity) return true;
        return false;
      }
      return similarity({ text: rep.fullText ?? rep.text }, { text: item.unit.fullText ?? item.unit.text }) >= 0.66;
    });
    if (!target) {
      target = { id: `t_${threads.length + 1}`, members: [], maxSim: 1 };
      threads.push(target);
    }
    target.members.push(item);
  }

  return threads.map((t) => {
    const first = t.members[0];
    const sessionIds = [...new Set(t.members.map((m) => m.sessionId))];
    return {
      id: t.id,
      text: first.unit.text,
      kind: first.unit.kind,
      slot: first.unit.slot ?? null,
      value: first.unit.value ?? null,
      polarity: first.unit.polarity ?? null,
      occurrences: t.members.map((m) => ({
        sessionId: m.sessionId,
        label: m.label,
        project: m.project,
        sessionIndex: m.sessionIndex,
        turn: m.unit.turn,
        evictedAtTurn: m.unit.evictedAtTurn ?? null,
        repeatCount: m.unit.repeatCount ?? 1,
      })),
      count: t.members.length,
      sessionCount: sessionIds.length,
      sessionIds,
      crossSession: sessionIds.length > 1,
    };
  });
}

export function analyzeCorpus({ paths, memoryPaths = [], onProgress = () => {} }) {
  const loaded = [];
  for (const p of paths) {
    onProgress(`解析 ${p.project}/${shortId(p.sessionDir)}…`);
    const data = analyzeSession({ transcriptPath: p.path, memoryPaths });
    loaded.push({ ...p, data });
  }
  // Chronology by session creation, not by file mtime: a resumed session is
  // touched today but was born weeks ago.
  loaded.sort((a, b) => (a.data.meta.session.createdAt ?? 0) - (b.data.meta.session.createdAt ?? 0));
  loaded.forEach((s, i) => {
    s.sessionIndex = i;
    s.sessionId = s.data.meta.session.id ?? shortId(s.sessionDir);
    s.label = `${shortId(s.sessionId)} · ${s.project.replace(/^--|--$/g, '').slice(0, 22)}`;
  });

  const items = [];
  for (const s of loaded) {
    for (const unit of s.data.units) {
      if (!['requirement', 'claim', 'goal'].includes(unit.kind)) continue;
      items.push({ unit, sessionId: s.sessionId, sessionIndex: s.sessionIndex, label: s.label, project: s.project });
    }
  }
  items.sort((a, b) => a.sessionIndex - b.sessionIndex || a.unit.turn - b.unit.turn);
  const threads = clusterThreads(items);

  // ---- cross-session repeats --------------------------------------------
  const crossRepeats = threads
    .filter((t) => t.crossSession && (t.kind === 'requirement' || t.kind === 'claim'))
    // Repeating a template in seven unrelated projects is not a memory failure.
    .filter((t) => new Set(t.occurrences.map((o) => o.project)).size === 1)
    .map((t) => ({
      ...t,
      sessions: t.occurrences.map((o) => ({ label: o.label, turn: o.turn, sessionIndex: o.sessionIndex })),
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount || b.count - a.count);

  // ---- cross-session conflicts ------------------------------------------
  const claims = [];
  for (const s of loaded) {
    for (const u of s.data.units) {
      if (u.kind !== 'claim' || !u.slot) continue;
      claims.push({ unit: u, session: s });
    }
  }
  const crossConflicts = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.unit.slot !== b.unit.slot || a.unit.value === b.unit.value) continue;
      if (!(a.unit.polarity === 'adopt' || b.unit.polarity === 'adopt')) continue;
      if (a.session.sessionIndex === b.session.sessionIndex) continue; // same-session audit covers it
      if (a.session.project !== b.session.project) continue; // different cwds are different worlds
      const [older, newer] = a.session.sessionIndex < b.session.sessionIndex ||
        (a.session.sessionIndex === b.session.sessionIndex && a.unit.turn < b.unit.turn) ? [a, b] : [b, a];

      const key = (c) => `${c.unit.slot}:${c.unit.value}`;
      // The write's own session still counts: "you said SQLite, then kept
      // writing Postgres for the rest of the session" is the sharpest evidence.
      const postWrite = (session, c, afterTurn) => {
        const idx = session.data.termIndex[key(c)];
        if (!idx) return { turns: 0, sessions: 0 };
        const turns = idx.turns.filter((t) => t > afterTurn).length;
        return { turns, sessions: turns > 0 ? 1 : 0 };
      };
      const later = (c) => loaded.filter((s) => s.sessionIndex > newer.session.sessionIndex && s.data.termIndex[key(c)]);

      const oldOwn = postWrite(newer.session, older, newer.unit.turn);
      const newOwn = postWrite(newer.session, newer, newer.unit.turn);
      const oldLater = later(older);
      const newLater = later(newer);
      const oldTurns = oldOwn.turns + oldLater.reduce((n, s) => n + s.data.termIndex[key(older)].turns.length, 0);
      const newTurns = newOwn.turns + newLater.reduce((n, s) => n + s.data.termIndex[key(newer)].turns.length, 0);

      let verdict;
      if (newTurns === 0 && oldTurns > 0) verdict = 'old-survived';
      else if (newTurns > 0 && oldTurns === 0) verdict = 'new-adopted';
      else if (newTurns === 0 && oldTurns === 0) verdict = 'both-silent';
      else verdict = newTurns >= oldTurns ? 'new-dominant' : 'old-dominant';

      crossConflicts.push({
        id: `xc_${older.session.sessionId}_${newer.session.sessionId}_${older.unit.slot}_${older.unit.value}_${newer.unit.value}`,
        slot: older.unit.slot,
        older: { label: older.session.label, turn: older.unit.turn, text: older.unit.text, value: older.unit.value },
        newer: { label: newer.session.label, turn: newer.unit.turn, text: newer.unit.text, value: newer.unit.value },
        sessionsAfter: loaded.length - newer.session.sessionIndex - 1,
        oldSessions: oldOwn.sessions + oldLater.length,
        newSessions: newOwn.sessions + newLater.length,
        oldTurns,
        newTurns,
        verdict,
      });
    }
  }
  const rank = { 'old-survived': 0, 'old-dominant': 1, 'both-silent': 2, 'new-dominant': 3, 'new-adopted': 4 };
  crossConflicts.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.sessionsAfter - a.sessionsAfter);

  const orphans = threads.filter((t) => !t.crossSession && (t.kind === 'requirement' || t.kind === 'claim'));

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      sessionCount: loaded.length,
      firstSessionAt: loaded[0]?.data.meta.session.createdAt ?? null,
      lastSessionAt: loaded[loaded.length - 1]?.data.meta.session.createdAt ?? null,
    },
    sessions: loaded.map((s) => ({
      sessionIndex: s.sessionIndex,
      id: s.sessionId,
      label: s.label,
      project: s.project,
      turns: s.data.meta.turns,
      units: s.data.units.length,
      evicted: s.data.units.filter((u) => u.evictedAtTurn != null).length,
      textBytes: s.data.meta.textBytes,
      createdAt: s.data.meta.session.createdAt ?? null,
    })),
    threads,
    crossRepeats,
    crossConflicts,
    orphans,
    headline: {
      sessions: loaded.length,
      threads: threads.length,
      crossSessionThreads: threads.filter((t) => t.crossSession).length,
      crossRepeats: crossRepeats.length,
      crossConflicts: crossConflicts.length,
      survived: crossConflicts.filter((c) => c.verdict === 'old-survived' || c.verdict === 'old-dominant').length,
      orphans: orphans.length,
      crossSessionRate: threads.length ? Number(((threads.filter((t) => t.crossSession).length / threads.length) * 100).toFixed(1)) : 0,
      turns: loaded.reduce((n, s) => n + s.data.meta.turns, 0),
      textBytes: loaded.reduce((n, s) => n + s.data.meta.textBytes, 0),
    },
    limits: [
      '跨会话只认「再次出现」：同一句话在另一个会话里又被说了一遍，或同一个槽位值又在模型产出里出现。没再次出现，不等于没被继承——只是没有证据。',
      '会话之间没有共享的 seq，所以对齐只能靠内容和时间先后。时间用的是会话创建时间，不是文件修改时间。',
      '词表仍然只覆盖技术栈类槽位；跨会话的自然语言约束，靠的是文本相似度（阈值 0.66），会漏掉换了大半说法的重复。',
      '这里不判断「哪个会话是对的」。冲突只报事实：谁先写、谁后写、之后谁还在被使用。',
    ],
  };
}
