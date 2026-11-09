#!/usr/bin/env node
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { analyzeSession } from './analyze.mjs';
import { renderReport } from './report.mjs';
import { toProvJson } from './prov.mjs';

const argv = process.argv.slice(2);

function parseArgs(argv) {
  const out = { _: [], memory: [], out: 'audit-out', json: null, html: true, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--memory' || a === '-m') out.memory.push(resolve(argv[++i]));
    else if (a === '--out' || a === '-o') out.out = resolve(argv[++i]);
    else if (a === '--json') out.json = resolve(argv[++i] ?? 'audit-out/audit.json');
    else if (a === '--prov') out.prov = resolve(argv[++i] ?? 'audit-out/prov.json');
    else if (a === '--no-html') out.html = false;
    else if (a === '--open') out.open = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(argv);

if (args.help || (args._.length === 0 && !args.latest)) {
  console.log(`memory-audit — 把 agent 的记忆摊开：写在第几轮、还在不在、有没有被用过、和谁打架

用法
  memory-audit <session.jsonl[.zstd] ...> [选项]
  memory-audit --latest                 # 自动挑最近一次会话

选项
  -m, --memory <file|dir>   额外的记忆库（markdown 的 - 列表项，可重复）
  -o, --out <dir>           输出目录（默认 audit-out）
      --json <file>         另存机器可读的审计结果
      --no-html             只输出 JSON 与终端摘要
      --open                生成后用系统默认程序打开报告

例
  memory-audit "%USERPROFILE%\\.dsh\\sessions\\--D-Skills--\\session-*/session.v4.jsonl.zstd" --open
  memory-audit session.jsonl -m ./MEMORY.md --json audit.json --no-html`);
  process.exit(args.help ? 0 : 1);
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
  console.log(`  被重复说过 ${h.repeated} 条 · 无强证据 ${h.neverReused} 条 · 压缩遗忘 ${h.evictedUnits} 条（${h.evictedTokens} tokens）`);
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
