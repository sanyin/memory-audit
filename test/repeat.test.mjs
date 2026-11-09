import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeSession } from '../src/analyze.mjs';
import { similarity, clusterRepeats, checkMessage, sharedPhrases, features, containment } from '../src/repeat.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, '..', 'examples', 'demo-repeat.jsonl');

test('identical text scores 1, unrelated text scores low', () => {
  const a = { text: '把 README 重写一遍，中文为主，再加一份英文版。' };
  const same = { text: '把 README 重写一遍，中文为主，再加一份英文版。' };
  const near = { text: 'README 再重写一遍，中文为主，也要一份英文版。' };
  const far = { text: '帮我画一张整体架构图，标注每个模块的输入输出' };

  assert.equal(similarity(a, same), 1);
  assert.ok(similarity(a, near) >= 0.62, `near-verbatim should cluster, got ${similarity(a, near)}`);
  assert.ok(similarity(a, far) < 0.3, `unrelated should stay apart, got ${similarity(a, far)}`);
});

test('coverage is asymmetric: a long memory does not excuse a short new question', () => {
  const probe = features('画个架构图');
  const longMemory = features('帮我画一张整体架构图，标注每个模块的输入输出，再写一段说明');
  const shortMemory = features('画个架构图');
  assert.ok(containment(probe, longMemory) < 1);
  assert.equal(containment(probe, shortMemory), 1);
});

test('repeats are found across a compaction and flagged as restated', () => {
  const data = analyzeSession({ transcriptPath: demo });
  assert.equal(data.repeats.length, 1);
  const [r] = data.repeats;
  assert.deepEqual(r.turns, [3, 12]);
  assert.equal(r.count, 2);
  assert.equal(r.restatedAfterEviction, true, 'the repeat happened after the summary dropped it');
  assert.equal(r.evictedAtTurn, 8);
});

test('the remembered unit really was evicted, and the summary did not keep it', () => {
  const data = analyzeSession({ transcriptPath: demo });
  const unit = data.units.find((u) => u.turn === 3 && u.kind === 'requirement');
  assert.ok(unit, 'turn 3 requirement captured');
  assert.equal(unit.evictedAtTurn, 8);
  assert.equal(unit.compactionKept, false);
  assert.equal(data.fidelity.total, 1);
  assert.equal(data.fidelity.dropped, 1);
});

test('pre-send guard matches a paraphrase and says it was forgotten', () => {
  const data = analyzeSession({ transcriptPath: demo });
  const { hits } = checkMessage('把 README 重写一下，中英文都要', data.units);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].turn, 3);
  assert.equal(hits[0].forgotten, true);
  assert.ok(hits[0].similarity >= 0.45);
});

test('pre-send guard stays quiet on a new request', () => {
  const data = analyzeSession({ transcriptPath: demo });
  const { hits } = checkMessage('帮我画一张整体架构图，标注每个模块的输入输出', data.units);
  assert.equal(hits.length, 0);
});

test('very short messages abstain instead of guessing', () => {
  const data = analyzeSession({ transcriptPath: demo });
  const { hits, tooShort } = checkMessage('好', data.units);
  assert.equal(hits.length, 0);
  assert.equal(tooShort, true);
});

test('shared phrases are readable, not raw bigrams', () => {
  const phrases = sharedPhrases('界面风格有点宽松,紧凑一些', '另外，截图里面的格式有点宽松，紧凑一些，舍去一些没必要的部分');
  assert.ok(phrases.includes('有点宽松'), `got ${phrases.join('|')}`);
  assert.ok(!phrases.some((p) => p.length > 8), 'no runaway merged blobs');
});

test('clustering ignores two near-identical sentences inside one turn', () => {
  const units = [
    { id: 'a', kind: 'requirement', turn: 2, seq: 1, text: '把 README 重写一遍，中文为主', fullText: '把 README 重写一遍，中文为主', repeatTurns: [2], liveTurns: [2] },
    { id: 'b', kind: 'requirement', turn: 2, seq: 2, text: '把 README 重写一遍，中文为主，再加英文', fullText: '把 README 重写一遍，中文为主，再加英文', repeatTurns: [2], liveTurns: [2] },
  ];
  assert.equal(clusterRepeats(units).length, 0);
});
