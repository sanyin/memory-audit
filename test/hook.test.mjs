import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeSession } from '../src/analyze.mjs';
import { decide, parseInput, composeAdvisory, projectUnits, cacheKeyFor, readCache, writeCache } from '../src/hook.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, '..', 'examples', 'demo-repeat.jsonl');
const cli = join(here, '..', 'src', 'cli.mjs');

const units = () => projectUnits(analyzeSession({ transcriptPath: demo }).units);

test('payload shapes: Claude Code, generic, plain text', () => {
  assert.equal(parseInput('{"prompt":"把 README 重写一下"}').prompt, '把 README 重写一下');
  assert.equal(parseInput('{"hook_event_name":"UserPromptSubmit","prompt":"hi"}').payload.hook_event_name, 'UserPromptSubmit');
  assert.equal(parseInput('{"content":[{"type":"text","text":"嵌套文本"}]}').prompt, '嵌套文本');
  assert.equal(parseInput('就是一段纯文本').prompt, '就是一段纯文本');
  assert.equal(parseInput('').prompt, '');
});

test('speaks only when the matching memory is already gone', () => {
  const forgotten = decide('把 README 重写一下，中英文都要', units());
  assert.ok(forgotten, 'forgotten repeat must warn');
  assert.equal(forgotten.hit.turn, 3);
  assert.equal(forgotten.hit.forgotten, true);

  assert.equal(decide('现在别动文档，先改代码', units()), null, 'still-live memory stays quiet');
  assert.equal(decide('帮我画一张整体架构图，标注每个模块的输入输出', units()), null, 'new request stays quiet');
  assert.equal(decide('好', units()), null, 'too short to judge');
});

test('advisory is short and carries the evidence', () => {
  const { hit } = decide('把 README 重写一下，中英文都要', units());
  const text = composeAdvisory(hit);
  assert.ok(text.includes(String(hit.turn)));
  assert.ok(text.includes(String(hit.evictedAtTurn)));
  assert.ok(text.length <= 320, `advisory too long: ${text.length}`);
});

test('cache round-trips, and a changed transcript invalidates it', () => {
  const key = cacheKeyFor(demo);
  assert.ok(key);
  const u = units();
  writeCache(demo, key, u);
  assert.deepEqual(readCache(demo, key), u);
  assert.equal(readCache(demo, `${key}:changed`), null);
});

test('CLI: advisory on forgotten repeat, silent otherwise, exit 0', () => {
  const run = (input, extra = []) =>
    spawnSync(process.execPath, [cli, 'hook', '-s', demo, ...extra], { input, encoding: 'utf8' });

  const hit = run('{"hook_event_name":"UserPromptSubmit","prompt":"把 README 重写一下，中英文都要"}');
  assert.equal(hit.status, 0);
  assert.match(hit.stdout, /第 3 轮/);

  const live = run('{"prompt":"现在别动文档，先改代码"}');
  assert.equal(live.status, 0);
  assert.equal(live.stdout.trim(), '');

  const fresh = run('{"prompt":"帮我画一张整体架构图，标注每个模块的输入输出"}');
  assert.equal(fresh.status, 0);
  assert.equal(fresh.stdout.trim(), '');

  const broken = run('not json at all {{{');
  assert.equal(broken.status, 0, 'a hook must never break the user input');
  assert.equal(broken.stdout.trim(), '');
});

test('CLI: --hook-json emits the hook contract, --block uses exit 2', () => {
  const payload = '{"prompt":"把 README 重写一下，中英文都要"}';
  const json = spawnSync(process.execPath, [cli, 'hook', '-s', demo, '--hook-json'], { input: payload, encoding: 'utf8' });
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('第 3 轮'));

  const blocked = spawnSync(process.execPath, [cli, 'hook', '-s', demo, '--block'], { input: payload, encoding: 'utf8' });
  assert.equal(blocked.status, 2);

  const quietBlock = spawnSync(process.execPath, [cli, 'hook', '-s', demo, '--block'], { input: '{"prompt":"随便说点新的东西，比如天气"}', encoding: 'utf8' });
  assert.equal(quietBlock.status, 0, 'no hit means no block');
});
