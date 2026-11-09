import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * DSH appends an independent zstd frame per flush, so a transcript is a
 * concatenation of frames. Node decodes only the first one, so we locate frame
 * boundaries by the magic number and keep the first boundary that decodes.
 * Decoding a slice costs one frame, not the whole file.
 */
export function decompressFrames(buf) {
  const offsets = [];
  for (let i = buf.indexOf(ZSTD_MAGIC, 0); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 1)) offsets.push(i);
  if (offsets.length === 0) throw new Error('not a zstd container (no frame magic)');
  const parts = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    let end = buf.length;
    for (let j = i + 1; j < offsets.length; j++) {
      try {
        zstdDecompressSync(buf.subarray(start, offsets[j]));
        end = offsets[j];
        break;
      } catch {
        /* truncated frame: keep walking to the real boundary */
      }
    }
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      /* incomplete trailing frame after a crash: keep what we have */
    }
    while (i + 1 < offsets.length && offsets[i + 1] < end) i++;
  }
  return Buffer.concat(parts);
}

export function readRecords(path) {
  const raw = readFileSync(path);
  const isZstd = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC);
  const text = (isZstd ? decompressFrames(raw) : raw).toString('utf8');
  const rows = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { rows, bad, compressed: isZstd, bytes: raw.length, textBytes: Buffer.byteLength(text) };
}

const textOf = (content) =>
  (content ?? [])
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const reasoningOf = (content) =>
  (content ?? [])
    .filter((c) => c && c.type === 'reasoning')
    .map((c) => c.text)
    .join('\n');

/**
 * Normalizes a DSH session log into turns. Everything downstream works on this
 * shape, so other transcripts (Claude/Codex style) only need their own adapter.
 */
export function parseSession(path) {
  const { rows, bad, compressed, bytes, textBytes } = readRecords(path);
  const session = { id: null, cwd: null, createdAt: null, version: null };
  const turns = new Map();
  const evictions = [];
  const goals = [];
  const compactions = [];
  const skillLoads = [];
  let catalogTurns = 0;
  let currentTurn = 0;
  let toolNames = [];

  const bucket = (t) => {
    if (!turns.has(t)) turns.set(t, { turn: t, startTime: null, endTime: null, user: [], injections: [], assistantText: [], reasoning: [], toolCalls: [], toolResults: [], systemText: [], chars: { user: 0, assistant: 0, tool: 0, system: 0 } });
    return turns.get(t);
  };

  for (const r of rows) {
    const d = r.data ?? {};
    if (r.type === 'session') {
      session.id = r.id;
      session.cwd = r.cwd;
      session.createdAt = r.createdAt;
      session.version = r.version;
      continue;
    }
    if (r.type === 'request/header') {
      toolNames = (d.header?.tools ?? []).map((t) => t.name);
      continue;
    }
    if (r.type === 'turn/start') {
      currentTurn = d.turn ?? currentTurn + 1;
      bucket(currentTurn).startTime = r.time ?? null;
      continue;
    }
    if (r.type === 'turn/end') {
      const t = d.turn ?? currentTurn;
      bucket(t).endTime = r.time ?? null;
      continue;
    }

    const turn = typeof d.turn === 'number' ? d.turn : currentTurn;

    if (typeof r.surfaceOp === 'object' && r.surfaceOp && r.surfaceOp.op === 'replace') {
      evictions.push({
        kind: 'replace',
        startSeq: r.surfaceOp.startSeq,
        endSeq: r.surfaceOp.endSeq,
        atSeq: r.seq,
        atTurn: currentTurn || turn,
      });
    }

    if (r.type === 'compaction/prune') {
      const shadowed = d.shadowedSeqs ?? [];
      for (const s of shadowed) {
        evictions.push({ kind: 'prune', startSeq: s, endSeq: s, atSeq: r.seq, atTurn: currentTurn || turn, tokens: d.shadowedTokenCount ?? null });
      }
      compactions.push({ phase: 'prune', seq: r.seq, turn, tokens: d.shadowedTokenCount ?? null });
      continue;
    }
    if (r.type === 'compaction/start' || r.type === 'compaction/end') {
      compactions.push({ phase: r.type.split('/')[1], seq: r.seq, turn: turn || d.turn, compactionId: d.compactionId });
      continue;
    }
    if (r.type === 'compaction/summary') {
      compactions.push({ phase: 'summary', seq: r.seq, turn, text: textOf(d.summary), compactionId: d.compactionId });
      const b = bucket(turn || 1);
      b.injections.push({ kind: 'compaction-summary', seq: r.seq, text: textOf(d.summary), atSeq: r.seq });
      b.chars.system += textOf(d.summary).length;
      continue;
    }
    if (r.type === 'goal/change') {
      goals.push({ seq: r.seq, turn, operation: d.operation, goal: d.goal, at: r.time });
      continue;
    }

    if (r.type === 'user/message') {
      const text = textOf(d.content);
      const b = bucket(turn);
      const synthetic = /^\s*<(system-reminder|goal_round|goal_complete|goal_continue)/.test(text) || /<compacted-summary>/.test(text);
      b.user.push({ seq: r.seq, text, synthetic, at: r.time });
      b.chars.user += text.length;
      if (/<available_skills>/.test(text)) catalogTurns++;
      if (/<available_skills>/.test(text)) {
        b.injections.push({ kind: 'skill-catalog', seq: r.seq, text });
      }
      continue;
    }

    if (r.type === 'system/message') {
      const text = textOf(d.message?.content);
      const b = bucket(turn);
      b.systemText.push({ seq: r.seq, text });
      b.chars.system += text.length;
      if (/<available_skills>/.test(text)) {
        catalogTurns++;
        b.injections.push({ kind: 'skill-catalog', seq: r.seq, text });
      }
      continue;
    }

    if (r.type === 'assistant/message') {
      const content = d.message?.content ?? [];
      const b = bucket(turn);
      const text = textOf(content);
      const reasoning = reasoningOf(content);
      if (text) b.assistantText.push({ seq: r.seq, text, at: r.time });
      if (reasoning) b.reasoning.push({ seq: r.seq, text: reasoning });
      b.chars.assistant += text.length + reasoning.length;
      for (const c of content) {
        if (c?.type === 'tool-call') {
          b.toolCalls.push({ seq: r.seq, name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}), callId: c.id ?? c.callId });
        }
      }
      continue;
    }

    if (r.type === 'tool/call') {
      const b = bucket(turn);
      b.toolCalls.push({ seq: r.seq, name: d.name, arguments: d.arguments ?? '', callId: d.callId });
      if (d.name === 'skill') {
        try {
          const args = JSON.parse(d.arguments || '{}');
          const name = args.name ?? args.skill ?? null;
          if (name) skillLoads.push({ turn, seq: r.seq, name });
        } catch {
          /* unparsable args: still a load, name unknown */
          skillLoads.push({ turn, seq: r.seq, name: null });
        }
      }
      continue;
    }

    if (r.type === 'tool/result') {
      const b = bucket(turn);
      const text = textOf(d.message?.content);
      b.toolResults.push({ seq: r.seq, text, callId: d.toolCallId, isError: !!d.message?.isError });
      b.chars.tool += text.length;
      continue;
    }
  }

  const ordered = [...turns.values()].sort((a, b) => a.turn - b.turn);
  for (const t of ordered) {
    t.startSeq = Math.min(
      ...[...t.user, ...t.toolCalls, ...t.toolResults, ...t.assistantText, ...t.reasoning, ...t.injections, ...t.systemText]
        .map((x) => x.seq)
        .filter((n) => typeof n === 'number'),
      Infinity,
    );
    t.endSeq = Math.max(
      ...[...t.user, ...t.toolCalls, ...t.toolResults, ...t.assistantText, ...t.reasoning, ...t.injections, ...t.systemText]
        .map((x) => x.seq)
        .filter((n) => typeof n === 'number'),
      -Infinity,
    );
  }

  return {
    session,
    turns: ordered,
    evictions,
    goals,
    compactions,
    skillLoads,
    catalogTurns,
    toolNames,
    stats: { rows: rows.length, badLines: bad, compressed, fileBytes: bytes, textBytes },
  };
}

/** Everything the model emitted in a turn (reasoning + visible text + tool arguments). */
export function agentSurface(turn) {
  const chunks = [];
  for (const r of turn.reasoning) chunks.push({ where: 'reasoning', text: r.text });
  for (const a of turn.assistantText) chunks.push({ where: 'text', text: a.text });
  for (const c of turn.toolCalls) chunks.push({ where: 'tool-call', text: `${c.name} ${c.arguments}` });
  return chunks;
}

/** Was seq s still inside the live window during turn t? */
export function isLive(seq, turn, evictions) {
  for (const e of evictions) {
    if (e.atTurn <= turn) {
      if (seq >= e.startSeq && seq <= e.endSeq) return false;
    }
  }
  return true;
}
