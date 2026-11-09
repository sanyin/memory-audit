import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { analyzeSession } from '../src/analyze.mjs';
import { decompressFrames } from '../src/session.mjs';

const dir = mkdtempSync(join(tmpdir(), 'memory-audit-'));

/**
 * The scenario from the brief, as a real transcript:
 *   turn 3  "存储用 Postgres，不要换。"
 *   turn 9  "改用 SQLite 吧。"
 *   turns 10..21 — Postgres still cited 4 times, SQLite never.
 */
function buildRecords() {
  const rows = [];
  let seq = 0;
  const push = (rec) => rows.push({ seq: seq++, time: 1_700_000_000_000 + seq * 1000, ...rec });
  const turnStart = (turn) => push({ type: 'turn/start', data: { turn } });
  const turnEnd = (turn) => push({ type: 'turn/end', data: { turn } });
  const user = (turn, text) => push({ type: 'user/message', data: { content: [{ type: 'text', text }], role: 'user' } });
  const assistant = (turn, text) => push({ type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } });
  const tool = (turn, name, args) => push({ type: 'tool/call', data: { turn, step: 1, callId: `c${seq}`, name, arguments: JSON.stringify(args) } });

  push({ type: 'session', id: 'session-fixture', version: 4, createdAt: 1_700_000_000_000, cwd: '/repo' });

  turnStart(1); user(1, '开始做这个项目。'); assistant(1, '好的，先看看目录。'); tool(1, 'pwsh', { command: 'ls' }); turnEnd(1);
  turnStart(2); assistant(2, '目录看完了，讲一下结构。'); turnEnd(2);
  turnStart(3); user(3, '存储用 Postgres，不要换。'); assistant(3, '明白，用 Postgres。'); turnEnd(3);
  for (const t of [4, 5, 6, 7, 8]) {
    turnStart(t);
    assistant(t, `继续在 Postgres 上实现，第 ${t} 轮。`);
    if (t === 5) tool(t, 'pwsh', { command: 'psql -c "select 1"' });
    turnEnd(t);
  }
  turnStart(9); user(9, '改用 SQLite 吧。'); assistant(9, '收到，改用 SQLite。'); turnEnd(9);
  for (let t = 10; t <= 21; t++) {
    turnStart(t);
    if ([11, 14, 17, 20].includes(t)) assistant(t, `写入逻辑仍然按 Postgres 的连接串处理，第 ${t} 轮。`);
    else assistant(t, `推进第 ${t} 轮的工作。`);
    turnEnd(t);
  }
  return rows;
}

function writeTranscript(rows, { frames = 1 } = {}) {
  const lines = rows.map((r) => JSON.stringify(r));
  const file = join(dir, `session-${Math.random().toString(36).slice(2)}.jsonl.zstd`);
  if (frames <= 1) {
    writeFileSync(file, zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`)));
    return file;
  }
  const mid = Math.floor(lines.length / 2);
  const a = zstdCompressSync(Buffer.from(`${lines.slice(0, mid).join('\n')}\n`));
  const b = zstdCompressSync(Buffer.from(`${lines.slice(mid).join('\n')}\n`));
  writeFileSync(file, Buffer.concat([a, b]));
  return file;
}

test('reproduces the brief: round 9 writes SQLite, round 3 said Postgres, behaviour keeps Postgres', () => {
  const data = analyzeSession({ transcriptPath: writeTranscript(buildRecords()) });

  assert.equal(data.conflicts.length, 1, 'exactly one slot conflict');
  const c = data.conflicts[0];
  assert.equal(c.slot, 'datastore');
  assert.equal(c.older.value, 'postgres');
  assert.equal(c.older.turn, 3);
  assert.equal(c.newer.value, 'sqlite');
  assert.equal(c.newer.turn, 9);
  assert.equal(c.verdict, 'write-ignored');
  assert.equal(c.windowTurns, 12, '12 turns after the write');
  assert.equal(c.oldMentions, 4, 'Postgres cited in 4 later turns');
  assert.equal(c.newMentions, 0, 'SQLite never cited');
  assert.equal(data.headline.writeIgnored, 1);
});

test('reads a transcript split across several zstd frames', () => {
  const rows = buildRecords();
  const file = writeTranscript(rows, { frames: 2 });
  const data = analyzeSession({ transcriptPath: file });
  assert.equal(data.meta.turns, 21);
  assert.equal(data.units.filter((u) => u.kind === 'claim').length >= 2, true);
});

test('user messages without an explicit turn are attributed to the open turn', () => {
  const data = analyzeSession({ transcriptPath: writeTranscript(buildRecords()) });
  const postgres = data.units.find((u) => u.value === 'postgres');
  assert.equal(postgres.turn, 3);
  assert.equal(postgres.channel, 'user');
});

test('claims require a decision word next to the term', () => {
  const data = analyzeSession({ transcriptPath: writeTranscript(buildRecords()) });
  const sqlite = data.units.find((u) => u.value === 'sqlite');
  assert.ok(sqlite, 'sqlite claim extracted');
  assert.equal(sqlite.polarity, 'adopt');
  // "继续在 Postgres 上实现" is a mention, never a claim.
  const claims = data.units.filter((u) => u.kind === 'claim');
  assert.equal(claims.filter((u) => u.value === 'postgres').length, 1);
});

test('every unit carries an origin and a lifetime', () => {
  const data = analyzeSession({ transcriptPath: writeTranscript(buildRecords()) });
  for (const u of data.units) {
    assert.ok(u.id, 'id');
    assert.ok(typeof u.turn === 'number', 'turn');
    assert.ok(Array.isArray(u.liveTurns), 'liveTurns');
  }
});

test('frame splitter rejects non-zstd input', () => {
  assert.throws(() => decompressFrames(Buffer.from('not compressed')));
});
