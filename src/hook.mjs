/**
 * Hook mode: the pre-send guard, wired to a `UserPromptSubmit` hook.
 *
 * Chosen policy (option 3 in the design discussion): speak only when the match
 * is strong AND the matched memory is already gone from the context. Repeating
 * something the model can still see is just verbosity; repeating something the
 * summary dropped is the actual failure we are hunting.
 *
 * Three hard rules, in order of importance:
 *   1. Never break the user's input. Any error -> exit 0, print nothing.
 *   2. Silence is the default. We only speak on a forgotten-memory hit.
 *   3. The hook runs on every submit, so analysis is cached by transcript
 *      identity (path + mtime + size).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkMessage } from './repeat.mjs';

const CACHE_DIR = join(tmpdir(), 'memory-audit-cache');

/** Hook payloads differ per host; accept the common shapes and fall back to raw text. */
export function promptOf(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  const candidates = [input.prompt, input.text, input.message, input.user_message, input.content];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (c && typeof c === 'object' && typeof c.text === 'string' && c.text.trim()) return c.text.trim();
    // Anthropic-style content blocks: [{type:'text',text:'…'}]
    if (Array.isArray(c)) {
      const joined = c
        .map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (joined) return joined;
    }
  }
  return '';
}

export function parseInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { prompt: '', payload: null };
  if (!s.startsWith('{') && !s.startsWith('[')) return { prompt: s, payload: null };
  try {
    const payload = JSON.parse(s);
    return { prompt: promptOf(payload), payload };
  } catch {
    return { prompt: s, payload: null };
  }
}

/** Minimal unit projection is all the guard needs; keeps the cache small. */
export const projectUnits = (units) =>
  units.map((u) => ({
    id: u.id,
    kind: u.kind,
    turn: u.turn,
    text: u.text,
    fullText: u.fullText ?? u.text,
    evictedAtTurn: u.evictedAtTurn ?? null,
    liveTurns: Array.isArray(u.liveTurns) ? u.liveTurns.length : (u.liveTurns ?? 0),
    repeatCount: u.repeatCount ?? 1,
  }));

export function cacheKeyFor(transcriptPath) {
  try {
    const st = statSync(transcriptPath);
    return `${transcriptPath}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

export function readCache(transcriptPath, key, { allowStaleMs = 0 } = {}) {
  try {
    const file = join(CACHE_DIR, `${createHash('sha1').update(transcriptPath).digest('hex')}.json`);
    if (!existsSync(file)) return null;
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (cached.key === key) return cached.units;
    // A live session changes every turn, so a strict key would never hit.
    // Recent-but-stale is good enough for a guard that only needs old memories.
    if (allowStaleMs > 0 && cached.at && Date.now() - cached.at <= allowStaleMs) return cached.units;
    return null;
  } catch {
    return null;
  }
}

export function writeCache(transcriptPath, key, units) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = join(CACHE_DIR, `${createHash('sha1').update(transcriptPath).digest('hex')}.json`);
    writeFileSync(file, JSON.stringify({ key, at: Date.now(), units }), 'utf8');
  } catch {
    /* cache is an optimisation, never a failure mode */
  }
}

export function composeAdvisory(hit, { maxChars = 320 } = {}) {
  const pct = Math.round(hit.similarity * 100);
  const head = `[memory-audit] 这句话与第 ${hit.turn} 轮的记忆重叠 ${pct}%，但那条记忆已在第 ${hit.evictedAtTurn} 轮被压缩掉，上下文里已经没有了。`;
  const quote = `第 ${hit.turn} 轮原话：「${(hit.text ?? '').slice(0, 120)}」`;
  const tail = '如果要沿用当时的要求，请把关键点重述一遍；否则模型只能靠猜。';
  const out = [head, quote, tail].join('\n');
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}

/**
 * Pure decision function: given a prompt and memory units, decide whether to speak.
 * Returns null when the correct behaviour is silence.
 */
export function decide(prompt, units, { threshold = 0.45 } = {}) {
  if (!prompt || prompt.length < 8) return null;
  const { hits, tooShort } = checkMessage(prompt, units, { threshold });
  if (tooShort) return null;
  const forgotten = hits.filter((h) => h.forgotten && h.similarity >= threshold);
  if (!forgotten.length) return null;
  const [best] = forgotten;
  return { hit: best, advisory: composeAdvisory(best), alternatives: forgotten.slice(1, 3) };
}
