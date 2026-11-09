import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const lexicon = JSON.parse(readFileSync(join(here, 'lexicon.json'), 'utf8'));

export const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

const TERM_INDEX = new Map();
for (const s of lexicon.slots) {
  for (const t of s.terms) {
    if (!TERM_INDEX.has(t)) TERM_INDEX.set(t, s.slot);
  }
}

const CANON = {
  postgresql: 'postgres',
  mongo: 'mongodb',
  nextjs: 'next.js',
  'apache 2.0': 'apache-2.0',
  golang: 'go',
  'json 文件': 'json file',
  'jsonl 文件': 'jsonl file',
};

const termRegex = (term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^[a-z0-9 .+#-]+$/i.test(term) ? new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'gi') : new RegExp(escaped, 'gi');
};

/** Split prose into sentence-like spans without touching fenced code. */
export function splitSentences(text) {
  const withoutFences = text.replace(/```[\s\S]*?```/g, ' ');
  const out = [];
  for (const line of withoutFences.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const piece of trimmed.split(/(?<=[。！？；!?;])\s*/)) {
      const p = piece.trim();
      if (p.length >= 3) out.push(p);
    }
  }
  return out;
}

const hasAny = (text, list) => list.some((t) => !t.includes('…') && text.includes(t));

const ALL_TRIGGERS = [...lexicon.triggers.decision, ...lexicon.triggers.replacement, ...lexicon.triggers.negation]
  .filter((t) => !t.includes('…'))
  .sort((a, b) => b.length - a.length)
  .map((t) => ({ t, re: new RegExp(/^[a-z ]+$/i.test(t) ? `\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b` : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));

/** A decision word must be near the term, otherwise "use" in an unrelated clause invents a memory. */
const triggerNear = (text, start) => {
  const window = text.slice(Math.max(0, start - 45), Math.min(text.length, start + 45));
  return ALL_TRIGGERS.find(({ re }) => re.test(window)) ?? null;
};

/**
 * Rule-based claim extraction.
 * A claim is (slot, value, polarity) asserted by one sentence.
 * Polarity comes from the window before the term: "不要 X" / "X 而不是 Y" / "改用 X".
 */
export function extractClaims(text, { channel = 'user', turn = 0, seq = 0, at = null } = {}) {
  const claims = [];
  for (const sentence of splitSentences(text)) {
    const lower = sentence.toLowerCase();
    const replacement = hasAny(lower, lexicon.triggers.replacement);
    const decision = hasAny(lower, lexicon.triggers.decision) || replacement;
    if (!decision) continue;
    if (/[a-z]:\\|\\[a-z]/i.test(sentence)) continue; // paths
    if (/(\$env:|pwsh-|exit code:|Get-ChildItem|node_modules|\.jsonl)/i.test(sentence)) continue; // pasted tool output

    const found = [];
    for (const [term, slot] of TERM_INDEX) {
      const re = termRegex(term);
      let m;
      while ((m = re.exec(sentence)) !== null) {
        found.push({ term, canon: CANON[term] ?? term, slot, start: m.index, end: m.index + m[0].length });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    if (found.length === 0) continue;
    found.sort((a, b) => a.start - b.start);

    // A replacement marker between two terms marks everything after it as rejected.
    let rejectFrom = Infinity;
    for (const marker of ['而不是', '不用', '不再用', 'instead of', 'rather than', 'replace']) {
      const i = lower.indexOf(marker);
      if (i !== -1) rejectFrom = Math.min(rejectFrom, i + marker.length);
    }

    const seen = new Set();
    for (const f of found) {
      if (!triggerNear(lower, f.start)) continue;
      const before = lower.slice(Math.max(0, f.start - 30), f.start);
      const negated = hasAny(before, lexicon.triggers.negation) || f.start >= rejectFrom;
      const polarity = negated ? 'reject' : 'adopt';
      const key = `${f.slot}:${f.canon}:${polarity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({
        id: `m_${hash(`${f.slot}|${f.canon}|${polarity}|${seq}|${sentence.slice(0, 40)}`)}`,
        kind: 'claim',
        slot: f.slot,
        value: f.canon,
        polarity,
        text: sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence,
        channel,
        turn,
        seq,
        at,
      });
    }
  }
  return claims;
}

/** Bullets of a markdown memory file become memory units; headings give the subject. */
export function extractMemoryFile(path, content) {
  const units = [];
  let heading = '';
  let lineNo = 0;
  for (const line of content.split(/\r?\n/)) {
    lineNo++;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      heading = h[1].trim();
      continue;
    }
    const b = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!b) continue;
    const text = b[1].replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (text.length < 4) continue;
    units.push({
      id: `f_${hash(`${path}#${lineNo}`)}`,
      kind: 'file',
      text: text.length > 220 ? `${text.slice(0, 217)}…` : text,
      fullText: text,
      origin: `${path.replace(/\\/g, '/')}${heading ? ` › ${heading}` : ''}`,
      line: lineNo,
      path,
    });
  }
  return units;
}
