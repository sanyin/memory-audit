/**
 * Repetition detection.
 *
 * A repeated instruction is the cheapest memory-failure signal there is: the
 * user does not repeat themselves for fun, they repeat themselves because the
 * first time did not stick. Unlike "was it used", this needs no inference --
 * the evidence is the second message.
 *
 * Similarity is deliberately lexical (character bigrams + ASCII words). It is
 * cheap, deterministic, and has no model in the loop, so a match can always be
 * shown side by side with the original.
 *
 * Two different questions, two different metrics:
 *   similarity()  symmetric — "are these the same request?" (clustering)
 *   coverage()    asymmetric — "how much of this new message is already known?"
 *                 (pre-send guard; a short message cannot be excused by a long one)
 */

const PUNCT = /[\s\u3000，。；：！？、,.!?;:"""''（）()【】\[\]「」《》<>]/g;

export const normText = (s) => String(s ?? '').replace(PUNCT, '').toLowerCase();

/** Character bigrams (works for Chinese without a tokenizer) + ASCII words. */
export function features(text) {
  const s = normText(text);
  const out = new Set();
  for (const w of s.match(/[a-z][a-z0-9.+#_-]{1,}/g) ?? []) out.add(w);
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

const intersect = (a, b) => {
  let n = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) n++;
  return n;
};

export const jaccard = (a, b) => {
  const i = intersect(a, b);
  return i / (a.size + b.size - i) || 0;
};

/** Share of `part` that also appears in `whole`. 1.0 means fully contained. */
export const containment = (part, whole) => (part.size ? intersect(part, whole) / part.size : 0);

const cache = new WeakMap();
const featsOf = (obj) => {
  if (!cache.has(obj)) cache.set(obj, features(obj.text));
  return cache.get(obj);
};

/** Symmetric 0..1 score used for clustering. 1 means identical after normalization. */
export function similarity(a, b) {
  const na = normText(a.text);
  const nb = normText(b.text);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const fa = featsOf(a);
  const fb = featsOf(b);
  return Math.max(jaccard(fa, fb), containment(fa, fb), containment(fb, fa));
}

/**
 * Every utterance of a memory unit, one row per turn it was said.
 * Units already merge byte-identical repeats, so we expand them back out.
 */
export function occurrencesOf(units) {
  const rows = [];
  for (const u of units) {
    if (u.kind !== 'requirement' && u.kind !== 'claim') continue;
    const turns = u.repeatTurns?.length ? u.repeatTurns : [u.turn];
    for (const t of turns) {
      rows.push({
        unitId: u.id,
        turn: t,
        text: u.text,
        fullText: u.fullText ?? u.text,
        kind: u.kind,
        seq: u.seq,
        evictedAtTurn: u.evictedAtTurn ?? null,
        liveTurns: u.liveTurns ?? [],
      });
    }
  }
  return rows.sort((a, b) => a.turn - b.turn);
}

/**
 * Greedy clustering: a new occurrence joins the first cluster whose
 * representative it is similar enough to. Representative is the earliest
 * occurrence, so the cluster reads as "what you originally asked".
 */
export function clusterRepeats(units, { threshold = 0.62 } = {}) {
  const rows = occurrencesOf(units);
  const seen = new Set();
  const clusters = [];
  for (const row of rows) {
    // Two near-identical sentences inside one message are a duplicate, not a
    // repetition: repetition is a statement coming back in a later turn.
    const key = `${row.unitId}|${row.turn}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let placed = false;
    for (const c of clusters) {
      if (c.members.some((m) => m.turn === row.turn)) continue;
      const sim = similarity(c.rep, row);
      if (sim >= threshold) {
        c.members.push({ ...row, sim });
        c.maxSim = Math.max(c.maxSim, sim);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rep: row, members: [{ ...row, sim: 1 }], maxSim: 1 });
  }

  return clusters
    .filter((c) => c.members.length > 1)
    .map((c) => {
      const first = c.members[0];
      const last = c.members[c.members.length - 1];
      const evicted = first.evictedAtTurn;
      const restatedAfterEviction = evicted != null && c.members.some((m) => m.turn > evicted);
      return {
        id: `rep_${c.members.map((m) => m.turn).join('-')}`,
        text: first.text,
        kind: first.kind,
        turns: c.members.map((m) => m.turn),
        count: c.members.length,
        gap: last.turn - first.turn,
        exact: c.maxSim === 1,
        maxSim: Number(c.maxSim.toFixed(3)),
        evictedAtTurn: evicted,
        restatedAfterEviction,
        firstTurn: first.turn,
        lastTurn: last.turn,
      };
    })
    .sort((a, b) => b.count - a.count || a.gap - b.gap);
}

/** Minimum shared features before a match is worth reporting. */
const MIN_SHARED = 4;
const MIN_PROBE_FEATURES = 6;

/**
 * Turn overlapping bigrams back into readable phrases, so a match can be
 * explained instead of asserted: "readme / 重写 / 英文" rather than "凑一, 松紧".
 */
export function sharedPhrases(probeText, unitText) {
  const b = normText(unitText);
  const phrases = new Set();

  for (const w of String(probeText).toLowerCase().match(/[a-z][a-z0-9.+#_-]{1,}/g) ?? []) {
    if (b.includes(w)) phrases.add(w);
  }

  // Work on CJK runs of the original text so punctuation breaks phrases apart
  // instead of gluing "宽松，紧凑" into one blob.
  for (const run of String(probeText).match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    const marked = new Array(Math.max(0, run.length - 1)).fill(false);
    for (let i = 0; i + 2 <= run.length; i++) marked[i] = b.includes(run.slice(i, i + 2));
    let start = -1;
    for (let i = 0; i <= marked.length; i++) {
      if (marked[i]) {
        if (start === -1) start = i;
      } else if (start !== -1) {
        const phrase = run.slice(start, i + 1);
        if (phrase.length >= 2) phrases.add(phrase);
        start = -1;
      }
    }
  }
  return [...phrases].slice(0, 6);
}

/**
 * Pre-send guard: how much of this new message already exists in memory?
 * `coverage` is the share of the *new* message that is covered by a memory, so
 * a long memory cannot make a short new question look familiar.
 */
export function checkMessage(text, units, { threshold = 0.45 } = {}) {
  const probe = { text };
  const probeFeatures = features(text);
  const hits = [];
  for (const u of units) {
    if (u.kind !== 'requirement' && u.kind !== 'claim' && u.kind !== 'goal') continue;
    const f = features(u.fullText ?? u.text);
    const shared = [...probeFeatures].filter((x) => f.has(x));
    const cov = containment(probeFeatures, f);
    if (cov < threshold || shared.length < MIN_SHARED) continue;
    hits.push({
      similarity: Number(cov.toFixed(3)),
      jaccard: Number(jaccard(probeFeatures, f).toFixed(3)),
      shared: sharedPhrases(text, u.fullText ?? u.text),
      sharedCount: shared.length,
      turn: u.turn,
      text: u.text,
      kind: u.kind,
      id: u.id,
      evictedAtTurn: u.evictedAtTurn ?? null,
      repeatCount: u.repeatCount ?? 1,
      // "already forgotten" is the interesting case: you are asking again for
      // something the context no longer contains.
      forgotten: u.evictedAtTurn != null,
      liveTurns: u.liveTurns?.length ?? 0,
    });
  }
  return { hits: hits.sort((a, b) => b.similarity - a.similarity).slice(0, 5), probeSize: probeFeatures.size, tooShort: probeFeatures.size < MIN_PROBE_FEATURES };
}
