#!/usr/bin/env node
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { analyzeSession } from './analyze.mjs';
import { renderReport } from './report.mjs';
import { toProvJson } from './prov.mjs';
import { checkMessage } from './repeat.mjs';

const argv = process.argv.slice(2);
const MODES = new Set(['audit', 'check', 'repeats']);
const mode = MODES.has(argv[0]) ? argv.shift() : 'audit';

function parseArgs(argv) {
  const out = { _: [], memory: [], out: 'audit-out', json: null, html: true, open: false, text: null, stdin: false, threshold: 0.45, failOnMatch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--memory' || a === '-m') out.memory.push(resolve(argv[++i]));
    else if (a === '--out' || a === '-o') out.out = resolve(argv[++i]);
    else if (a === '--json') out.json = resolve(argv[++i] ?? 'audit-out/audit.json');
    else if (a === '--prov') out.prov = resolve(argv[++i] ?? 'audit-out/prov.json');
    else if (a === '--text' || a === '-t') out.text = argv[++i];
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--threshold') out.threshold = Number(argv[++i] ?? 0.72);
    else if (a === '--fail-on-match') out.failOnMatch = true;
    else if (a === '--no-html') out.html = false;
    else if (a === '--latest') out.latest = true;
    else if (a === '--open') out.open = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(argv);

if (args.help || (args._.length === 0 && !args.latest && mode === 'audit') || (mode !== 'audit' && args._.length === 0 && !args.latest)) {
  console.log(`memory-audit — 把 agent 的记忆摊开：写在第几轮、还在不在、有没有被用过、和谁打架

用法
  memory-audit [audit] <session.jsonl[.zstd] ...> [选项]
  memory-audit --latest                                  # 自动挑最近一次会话
  memory-audit check <session> --text "要发出去的话"      # 发之前查：这句话说过吗
  memory-audit repeats <session>                         # 只列重复要求

选项
  -m, --memory <file|dir>   额外的记忆库（markdown 的 - 列表项，可重复）
  -o, --out <dir>           输出目录（默认 audit-out）
      --json <file>         另存机器可读的审计结果
      --prov <file>         导出 W3C PROV-JSON
      --no-html             只输出 JSON 与终端摘要
      --open                生成后用系统默认程序打开报告
  check 专用
      --text, -t <str>      待检查的文本
      --stdin               从标准输入读待检查的文本
      --threshold <n>       覆盖率阈值（默认 0.45）
      --fail-on-match       命中就以 1 退出（适合做钩子）

例
  memory-audit --latest --open
  memory-audit check --latest -t "把 README 再重写一版"
  memory-audit repeats --latest`);
  process.exit(args.help || mode === 'audit' ? 0 : 1);
}

function latestTranscript() {
  const root = join(homedir(), '.dsh', 'sessions');
  if (!existsSync(root)) throw new Error('找不到 ~/.dsh/sessions，请直接传会话文件');
  let best = null;
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const s of readdirSync(dir)) {
      const sd = join(dir, s);
      if (!statSync(sd).isDirectory()) continue;
      for (const f of readdirSync(sd)) {
        if (!/^session\.v\d+\.jsonl(\.zstd)?$/.test(f)) continue;
        const p = join(sd, f);
        const m = statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    }
  }
  if (!best) throw new Error('没有找到任何会话记录');
  return best.p;
}

function expandMemory(paths) {
  const files = [];
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`记忆文件不存在：${p}`);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p, { recursive: true })) {
        const full = join(p, String(f));
        if (/\.(md|txt)$/i.test(full) && statSync(full).isFile()) files.push(full);
      }
    } else files.push(p);
  }
  return files;
}

const transcripts = args._.length ? args._.map((p) => resolve(p)) : [latestTranscript()];

if (mode === 'check') {
  const text = args.stdin ? readFileSync(0, 'utf8') : args.text;
  if (!text || !text.trim()) {
    console.error('check 需要 --text "…" 或 --stdin');
    process.exit(2);
  }
  const t = transcripts[0];
  const data = analyzeSession({ transcriptPath: t, memoryPaths: expandMemory(args.memory) });
  const { hits, tooShort } = checkMessage(text.trim(), data.units, { threshold: args.threshold });
  const strong = hits.filter((x) => x.similarity >= Math.max(args.threshold, 0.8));

  if (!hits.length) {
    console.log(
      tooShort
        ? '这句话太短，词面比对不可靠，不作判断（工具选择弃权，而不是给一个假的“安全”）。'
        : `没有找到相似记忆（覆盖率阈值 ${args.threshold}）。这句话对这份记忆库来说是新的。`,
    );
    process.exit(0);
  }

  console.log(`这句话和第 ${[...new Set(hits.map((x) => x.turn))].join('、')} 轮的记忆重叠：`);
  for (const x of hits) {
    const badge = x.similarity >= 0.9 ? '几乎相同' : x.similarity >= 0.7 ? '高度重叠' : '部分重叠';
    const fate = x.forgotten ? `已在第 ${x.evictedAtTurn} 轮被压缩，上下文里没有了` : `仍在上下文（存活 ${x.liveTurns} 轮）`;
    console.log(`\n  覆盖 ${(x.similarity * 100).toFixed(0)}%  ${badge}  · 第 ${x.turn} 轮  ·  ${fate}${x.repeatCount > 1 ? `  ·  说过 ${x.repeatCount} 次` : ''}`);
    console.log(`  「${x.text}」`);
    if (x.shared.length) console.log(`  共用词：${x.shared.join('、')}`);
  }
  if (hits.some((x) => x.forgotten)) console.log('\n注意：命中的记忆已经不在上下文里了——重复它不会让模型“想起来”，只会再占一次预算。');
  process.exit(args.failOnMatch && strong.length ? 1 : 0);
}

if (mode === 'repeats') {
  const t = transcripts[0];
  const data = analyzeSession({ transcriptPath: t, memoryPaths: expandMemory(args.memory) });
  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true });
    writeFileSync(args.json, JSON.stringify({ session: data.meta.session.id, repeats: data.repeats }, null, 2), 'utf8');
  }
  if (!data.repeats.length) {
    console.log('没有检出重复要求。');
    process.exit(0);
  }
  console.log(`重复要求 ${data.repeats.length} 组（会话 ${data.meta.session.id}，${data.meta.turns} 轮）：\n`);
  for (const r of data.repeats) {
    const flag = r.restatedAfterEviction ? ' [压缩后重述]' : r.exact ? ' [原样重复]' : ` [近似 ${r.maxSim}]`;
    console.log(`  ${r.count}×  第 ${r.turns.join('、')} 轮  跨 ${r.gap} 轮${flag}`);
    console.log(`      「${r.text}」`);
  }
  const after = data.repeats.filter((r) => r.restatedAfterEviction).length;
  if (after) console.log(`\n其中 ${after} 组发生在压缩之后：摘要没接住，你只好又说了一遍。`);
  process.exit(0);
}

mkdirSync(args.out, { recursive: true });

const all = [];
for (const t of transcripts) {
  const data = analyzeSession({ transcriptPath: t, memoryPaths: expandMemory(args.memory) });
  all.push(data);

  const { headline: h, meta, conflicts } = data;
  const size = meta.textBytes >= 1e6 ? `${(meta.textBytes / 1e6).toFixed(1)}M` : `${Math.round(meta.textBytes / 1e3)}k`;
  console.log(`\n记忆审计 · ${meta.session.id} · ${meta.turns} 轮 · ${size} 字符`);
  console.log(`  记忆单元 ${h.units}（决策 ${h.claims} / 要求 ${h.requirements} / 目标 ${h.goals}）`);
  console.log(`  冲突 ${h.conflicts}${h.writeIgnored ? ` · 其中 ${h.writeIgnored} 条“写了等于没写”` : ''}`);
  console.log(`  重复要求 ${h.repeatGroups ?? 0} 组（压缩后重述 ${h.restatedAfterEviction ?? 0} 组） · 无强证据 ${h.neverReused} 条 · 压缩遗忘 ${h.evictedUnits} 条（${h.evictedTokens || "—"} tokens）`);
  if (data.fidelity.total) console.log(`  压缩保真度：摘要保留 ${data.fidelity.kept} 条 / 丢弃 ${data.fidelity.dropped} 条（依据 ${data.fidelity.summaries.length} 份摘要）`);
  console.log(`  技能 ${data.skills.installedCount} 装 / ${data.skills.loadedCount} 用`);

  for (const c of conflicts.slice(0, 3)) {
    console.log(`  ⚠ [${c.slotLabel}] 第 ${c.newer.turn} 轮写入「${c.newer.text}」，与第 ${c.older.turn} 轮「${c.older.text}」冲突；此后 ${c.windowTurns} 轮：${c.older.value} 被提及 ${c.oldMentions} 轮，${c.newer.value} 被提及 ${c.newMentions} 轮。`);
  }

  const stem = (meta.session.id || basename(dirname(t))).replace(/[^\w.-]+/g, '-');
  if (args.html) {
    const file = join(args.out, `${stem}.html`);
    writeFileSync(file, renderReport(data), 'utf8');
    console.log(`  报告 → ${file}`);
  }
  if (args.json) {
    const file = transcripts.length > 1 ? join(args.out, `${stem}.audit.json`) : args.json;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    console.log(`  数据 → ${file}`);
  }
  if (args.prov) {
    const file = transcripts.length > 1 ? join(args.out, `${stem}.prov.json`) : args.prov;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(toProvJson(data), null, 2), 'utf8');
    console.log(`  PROV → ${file}`);
  }
}

if (args.open && all.length) {
  const file = join(args.out, `${(all[0].meta.session.id || 'report').replace(/[^\w.-]+/g, '-')}.html`);
  const { spawn } = await import('node:child_process');
  spawn(process.platform === 'win32' ? 'cmd' : 'open', process.platform === 'win32' ? ['/c', 'start', '', file] : [file], { detached: true, stdio: 'ignore' }).unref();
}
