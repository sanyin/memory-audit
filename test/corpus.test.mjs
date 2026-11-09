import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessions, analyzeCorpus } from '../src/corpus.mjs';
import { renderCorpusReport } from '../src/corpus-report.mjs';

const dir = mkdtempSync(join(tmpdir(), 'memory-audit-corpus-'));

function makeSession(id, createdAt, turns) {
  const rows = [];
  let seq = 0;
  const push = (r) => rows.push({ seq: seq++, time: createdAt + seq * 1000, ...r });
  push({ type: 'session', id, version: 4, createdAt, cwd: '/repo' });
  for (const t of turns) {
    push({ type: 'turn/start', data: { turn: t.turn } });
    for (const m of t.messages) {
      if (m.role === 'user') push({ type: 'user/message', data: { content: [{ type: 'text', text: m.text }], role: 'user' } });
      else push({ type: 'assistant/message', data: { turn: t.turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: m.text }] } } });
    }
    push({ type: 'turn/end', data: { turn: t.turn } });
  }
  const project = join(dir, '--repo--');
  const sessionDir = join(project, `session-${id}`);
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, 'session.v4.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { path: file, project: '--repo--', sessionDir: `session-${id}`, mtime: createdAt, size: 1 };
}

const request = '把 README 重写一遍，中文为主，再加一份英文版。';

const a = makeSession('session-aaaa', 1_700_000_000_000, [
  { turn: 1, messages: [{ role: 'user', text: '开始做这个项目。' }, { role: 'assistant', text: '好的。' }] },
  { turn: 2, messages: [{ role: 'user', text: request }] },
  { turn: 3, messages: [{ role: 'user', text: '存储用 Postgres，不要换。' }, { role: 'assistant', text: '明白，用 Postgres。' }] },
  { turn: 4, messages: [{ role: 'assistant', text: '继续在 Postgres 上实现。' }] },
]);

const b = makeSession('session-bbbb', 1_700_000_100_000, [
  { turn: 1, messages: [{ role: 'user', text: request }] },
  { turn: 2, messages: [{ role: 'user', text: '改用 SQLite 吧。' }, { role: 'assistant', text: '收到，改用 SQLite。' }] },
  { turn: 3, messages: [{ role: 'assistant', text: '写入逻辑仍然按 Postgres 的连接串处理。' }] },
]);

test('discovery picks one file per session and honours the limit', () => {
  const found = discoverSessions({ root: dir, limit: 10 });
  assert.equal(found.length, 2);
  assert.ok(found.every((f) => f.path.endsWith('session.v4.jsonl')));
  assert.equal(discoverSessions({ root: dir, limit: 1 }).length, 1);
});

test('a requirement repeated in a later session becomes a cross-session thread', () => {
  const data = analyzeCorpus({ paths: [a, b] });
  assert.equal(data.meta.sessionCount, 2);
  assert.ok(data.crossRepeats.length >= 1, 'the README request repeats across sessions');
  const repeat = data.crossRepeats.find((r) => r.text.includes('README'));
  assert.ok(repeat);
  assert.equal(repeat.sessionCount, 2);
  assert.deepEqual(repeat.sessions.map((s) => s.sessionIndex), [0, 1]);
});

test('a decision overturned in a later session is flagged, and the old value is checked for survival', () => {
  const data = analyzeCorpus({ paths: [a, b] });
  const conflict = data.crossConflicts.find((c) => c.slot === 'datastore');
  assert.ok(conflict, 'postgres (session 1) vs sqlite (session 2)');
  assert.equal(conflict.older.value, 'postgres');
  assert.equal(conflict.newer.value, 'sqlite');
  assert.equal(conflict.newer.label.includes('bbbb'), true);
  assert.equal(conflict.verdict, 'old-survived', 'session 2 still writes Postgres after saying SQLite');
  assert.ok(conflict.oldTurns >= 1);
  assert.equal(conflict.newTurns, 0);
});

test('sessions from different projects never produce conflicts', () => {
  const c = makeSession('session-cccc', 1_700_000_200_000, [
    { turn: 1, messages: [{ role: 'user', text: '改用 SQLite 吧。' }] },
  ]);
  const other = { ...c, project: '--other--' };
  const data = analyzeCorpus({ paths: [a, other] });
  assert.equal(data.crossConflicts.length, 0);
});

test('corpus report renders the three questions', () => {
  const html = renderCorpusReport(analyzeCorpus({ paths: [a, b] }));
  assert.match(html, /跨会话记忆审计/);
  assert.match(html, /跨会话重复|没有检出跨会话重复/);
  assert.match(html, /生命线/);
  assert.match(html, /方法与限度/);
});
