/**
 * PROV-JSON export (W3C PROV-DM, 2013 Recommendation).
 *
 * The model is a direct profile of PROV:
 *   memory unit        -> prov:Entity
 *   turn               -> prov:Activity
 *   the model          -> prov:SoftwareAgent
 *   write              -> wasGeneratedBy(entity, turn)
 *   citation/reuse     -> used(turn, entity, role)
 *   compaction/prune   -> wasInvalidatedBy(entity, compactionActivity)
 *   summary            -> entity derived from the units it replaced
 *
 * Why bother: provenance that cannot be exchanged cannot be checked by anyone
 * else. PROV is the only vocabulary here with a W3C recommendation behind it.
 */
const PREFIX = {
  prov: 'http://www.w3.org/ns/prov#',
  ma: 'https://github.com/memory-audit/ns#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

const iso = (ms) => {
  if (!ms) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
};

export function toProvJson(data) {
  const out = { prefix: { ...PREFIX }, agent: {}, activity: {}, entity: {}, wasGeneratedBy: {}, used: {}, wasInvalidatedBy: {}, wasDerivedFrom: {} };
  let n = 0;
  const id = (k) => `_:${k}${++n}`;

  out.agent['ma:model'] = {
    'prov:type': 'prov:SoftwareAgent',
    'prov:label': data.meta.session.id ?? 'model',
    'ma:sessions': [data.meta.transcript],
  };

  const turns = new Set(data.units.map((u) => u.turn));
  for (const t of data.pressure) turns.add(t.turn);
  for (const t of [...turns].sort((a, b) => a - b)) {
    out.activity[`ma:turn-${t}`] = { 'prov:type': 'ma:Turn', 'ma:turn': t };
  }

  for (const e of data.evictions) {
    const key = `ma:compaction-${e.atSeq}`;
    if (!out.activity[key]) {
      out.activity[key] = { 'prov:type': 'ma:Compaction', 'ma:turn': e.atTurn, 'ma:kind': e.kind, 'ma:tokens': e.tokens ?? null };
    }
  }

  for (const u of data.units) {
    const eid = `ma:unit-${u.id}`;
    out.entity[eid] = {
      'prov:type': u.kind === 'goal' ? 'ma:Goal' : u.kind === 'claim' ? 'ma:Claim' : u.kind === 'requirement' ? 'ma:Requirement' : 'ma:MemoryFileEntry',
      'prov:label': u.text,
      'ma:turn': u.turn,
      'ma:seq': u.seq,
      'ma:channel': u.channel,
      'ma:slot': u.slot ?? null,
      'ma:value': u.value ?? null,
      'ma:polarity': u.polarity ?? null,
      'ma:liveTurns': u.liveTurns ?? [],
      'ma:repeatCount': u.repeatCount ?? 1,
      'prov:generatedAtTime': iso(u.at),
    };
    if (u.turn) {
      out.wasGeneratedBy[id('gen')] = { 'prov:entity': eid, 'prov:activity': `ma:turn-${u.turn}`, 'prov:time': iso(u.at) };
    }
    for (const t of u.reuseTurns ?? []) out.used[id('use')] = { 'prov:activity': `ma:turn-${t}`, 'prov:entity': eid, 'ma:evidence': 'verbatim-quote' };
    for (const t of u.toolTurns ?? []) out.used[id('use')] = { 'prov:activity': `ma:turn-${t}`, 'prov:entity': eid, 'ma:evidence': 'tool-call' };
    for (const t of u.mentionTurns ?? []) out.used[id('use')] = { 'prov:activity': `ma:turn-${t}`, 'prov:entity': eid, 'ma:evidence': 'term-cooccurrence' };
    if (u.evictedAtTurn != null) {
      const ev = data.evictions.find((e) => e.atTurn === u.evictedAtTurn && u.seq >= e.startSeq && u.seq <= e.endSeq);
      if (ev) out.wasInvalidatedBy[id('inv')] = { 'prov:entity': eid, 'prov:activity': `ma:compaction-${ev.atSeq}`, 'prov:time': null };
    }
  }

  for (const c of data.compactions.filter((x) => x.phase === 'summary')) {
    const sid = `ma:summary-${c.seq}`;
    out.entity[sid] = { 'prov:type': 'ma:CompactionSummary', 'prov:label': (c.text ?? '').slice(0, 300), 'ma:turn': c.turn };
    for (const u of data.units) {
      if (u.evictedAtTurn != null && u.turn <= c.turn) {
        out.wasDerivedFrom[id('der')] = { 'prov:generatedEntity': sid, 'prov:usedEntity': `ma:unit-${u.id}` };
      }
    }
  }

  return { ...out, 'ma:generatedAt': data.meta.generatedAt, 'ma:session': data.meta.session.id };
}
