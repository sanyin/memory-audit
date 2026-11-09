const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const VERDICT = {
  'old-survived': { label: '旧值还在用', tone: 'bad', hint: '后面写进去的值此后再没出现，旧值仍在后续会话里被使用。' },
  'old-dominant': { label: '旧值占优', tone: 'bad', hint: '新值出现过，但旧值出现得更多。' },
  'both-silent': { label: '双方都沉默', tone: 'warn', hint: '两个值在之后的会话里都没再出现。冲突没有被解决，只是被遗忘。' },
  'new-dominant': { label: '新值占优', tone: 'ok', hint: '新值更常出现，替换正在发生。' },
  'new-adopted': { label: '替换生效', tone: 'ok', hint: '旧值此后再没出现，新值接管了。' },
};

const KIND = { claim: { label: '决策', tone: 'claim' }, requirement: { label: '要求', tone: 'req' }, goal: { label: '目标', tone: 'goal' }, file: { label: '记忆文件', tone: 'file' } };

const kchars = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

function conflictCard(c) {
  const v = VERDICT[c.verdict] ?? { label: c.verdict, tone: 'warn', hint: '' };
  return `
  <article class="conflict ${v.tone}">
    <header>
      <span class="slot">${esc(c.slot)}</span>
      <span class="verdict ${v.tone}">${esc(v.label)}</span>
    </header>
    <p class="sentence">
      会话 <b>${esc(c.newer.label)}</b> 第 <b>${c.newer.turn}</b> 轮写入了「${esc(c.newer.text)}」，
      与会话 <b>${esc(c.older.label)}</b> 第 <b>${c.older.turn}</b> 轮的「${esc(c.older.text)}」冲突；
      此后 <b>${c.sessionsAfter}</b> 个会话里：
      <b class="old">${esc(c.older.value)}</b> 在 <b>${c.oldSessions}</b> 个会话（${c.oldTurns} 轮）中被用到，
      <b class="new">${esc(c.newer.value)}</b> 在 <b>${c.newSessions}</b> 个会话（${c.newTurns} 轮）中被用到。
    </p>
    <p class="hint">${esc(v.hint)}</p>
  </article>`;
}

function lifeline(t, maxIndex) {
  const hit = new Map();
  for (const o of t.occurrences) hit.set(o.sessionIndex, (hit.get(o.sessionIndex) ?? 0) + 1);
  const cells = [];
  for (let i = 0; i <= maxIndex; i++) {
    const n = hit.get(i) ?? 0;
    cells.push(`<i class="dot ${n > 1 ? 'multi' : n === 1 ? 'on' : ''}" title="会话 ${i + 1}${n ? ` · 出现 ${n} 次` : ' · 未出现'}"></i>`);
  }
  return `<span class="line">${cells.join('')}</span>`;
}

export function renderCorpusReport(data) {
  const { headline: h, meta, sessions, threads, crossRepeats, crossConflicts, limits } = data;
  const maxIndex = sessions.length - 1;
  const actionable = threads.filter((t) => ['requirement', 'claim', 'goal'].includes(t.kind));
  const crossing = actionable.filter((t) => t.crossSession).sort((a, b) => b.sessionCount - a.sessionCount || b.count - a.count);
  const orphansShown = actionable.filter((t) => !t.crossSession && t.kind !== 'goal').slice(0, 20);

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>跨会话记忆审计 · ${h.sessions} 个会话</title>
<style>
:root{--bg:#0b0d10;--panel:#12161b;--panel2:#161b22;--line:#222a33;--text:#e7eaef;--dim:#8b98a8;--amber:#f0b429;--teal:#35c4a8;--red:#e05b5b;--violet:#a78bfa;--mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:48px 28px 96px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:56px 0 14px;font-weight:600}
h2 .cn{text-transform:none;letter-spacing:0;color:var(--text);font-size:18px;margin-right:10px}
.sub{color:var(--dim);font-size:13px;font-family:var(--mono)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:28px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stat .k{color:var(--dim);font-size:12px}
.stat .v{font:600 26px/1.2 var(--mono);margin-top:4px}
.stat.bad .v{color:var(--red)} .stat.warn .v{color:var(--amber)} .stat.ok .v{color:var(--teal)}
.conflict{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:10px;padding:18px 20px;margin-bottom:12px}
.conflict.bad{border-left-color:var(--red)} .conflict.ok{border-left-color:var(--teal)}
.conflict header{display:flex;gap:10px;align-items:center}
.slot{font-family:var(--mono);font-size:12px;color:var(--dim);border:1px solid var(--line);padding:2px 8px;border-radius:999px}
.verdict{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px}
.verdict.bad{background:rgba(224,91,91,.14);color:#ff8f8f} .verdict.warn{background:rgba(240,180,41,.14);color:var(--amber)} .verdict.ok{background:rgba(53,196,168,.14);color:var(--teal)}
.sentence{margin:10px 0 4px;font-size:15px;line-height:1.85}
.sentence b{font-family:var(--mono)}
.sentence .old{color:#ff9a9a} .sentence .new{color:#7fe3ce}
.hint{color:var(--dim);font-size:13px;margin:6px 0 0}
.empty{background:var(--panel);border:1px dashed var(--line);border-radius:10px;padding:22px;color:var(--dim);font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:12px;letter-spacing:.05em;text-transform:uppercase}
td.num{font-family:var(--mono);white-space:nowrap}
tr:hover td{background:var(--panel)}
.tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);white-space:nowrap;color:var(--dim)}
.tag.claim{color:var(--amber);border-color:rgba(240,180,41,.35)} .tag.req{color:#9fb4cc} .tag.goal{color:var(--violet);border-color:rgba(167,139,250,.3)}
.line{display:inline-flex;gap:3px;align-items:center}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#1b222a;border:1px solid #2a333d}
.dot.on{background:#2b4a63;border-color:#3a6485}
.dot.multi{background:var(--teal);border-color:var(--teal)}
.badge{font-family:var(--mono);font-size:11px;background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:0 5px;margin-right:4px}
ol.limits{color:#b9c2ce;font-size:14px;padding-left:22px} ol.limits li{margin-bottom:8px}
footer{margin-top:64px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
</style></head><body><div class="wrap">

<h1>跨会话记忆审计</h1>
<div class="sub">${h.sessions} 个会话 · ${when(meta.firstSessionAt)} → ${when(meta.lastSessionAt)} · ${h.turns} 轮 · ${kchars(h.textBytes)} 字符 · ${esc(meta.generatedAt)}</div>

<div class="stats">
  <div class="stat"><div class="k">记忆线索</div><div class="v">${h.threads}</div></div>
  <div class="stat ok"><div class="k">跨会话出现过</div><div class="v">${h.crossSessionThreads}<span style="font-size:13px;color:var(--dim)"> · ${h.crossSessionRate ?? 0}%</span></div></div>
  <div class="stat ${h.crossRepeats ? 'warn' : ''}"><div class="k">跨会话重复</div><div class="v">${h.crossRepeats}</div></div>
  <div class="stat ${h.crossConflicts ? 'bad' : ''}"><div class="k">跨会话冲突</div><div class="v">${h.crossConflicts}</div></div>
  <div class="stat ${h.survived ? 'bad' : ''}"><div class="k">写了等于没写</div><div class="v">${h.survived}</div></div>
  <div class="stat"><div class="k">只活在一个会话</div><div class="v">${h.orphans}</div></div>
</div>

<h2><span class="cn">冲突</span>换了会话，说法变了</h2>
${crossConflicts.length ? crossConflicts.map(conflictCard).join('') : `<div class="empty">没有跨会话的槽位冲突。要么你从没改过主意，要么你改主意时换了说法——后者这个工具抓不到。</div>`}

<h2><span class="cn">重复</span>同一句话，在另一个会话里又说了一遍</h2>
${crossRepeats.length
  ? `<table><thead><tr><th>内容</th><th>出现在</th><th>次数</th><th>类型</th></tr></thead><tbody>${crossRepeats
      .map((t) => `<tr><td>${esc(t.text)}</td><td>${t.sessions.map((s) => `<span class="badge">${esc(s.label)} · 第 ${s.turn} 轮</span>`).join('')}</td><td class="num">${t.count}</td><td><span class="tag ${KIND[t.kind]?.tone ?? 'req'}">${esc(KIND[t.kind]?.label ?? t.kind)}</span></td></tr>`)
      .join('')}</tbody></table>`
  : `<div class="empty">没有检出跨会话重复。注意：这里只认「换了个会话又说一遍」，换了说法的重问查不到。</div>`}

<h2><span class="cn">线索</span>每条记忆的跨会话生命线</h2>
<div class="sub" style="margin-bottom:10px">一行一条记忆，一个圆点一个会话（按创建时间从左到右）；空心＝没出现，深色＝出现过，青色＝出现多次。</div>
${crossing.length
  ? `<table><thead><tr><th>内容</th><th>类型</th><th>会话</th><th>出现</th><th>生命线</th></tr></thead><tbody>
${crossing
  .map(
    (t) => `<tr><td>${esc(t.text)}</td><td><span class="tag ${KIND[t.kind]?.tone ?? 'req'}">${esc(KIND[t.kind]?.label ?? t.kind)}</span></td><td class="num">${t.sessionCount}</td><td class="num">${t.count}</td><td>${lifeline(t, maxIndex)}</td></tr>`,
  )
  .join('')}
</tbody></table>`
  : `<div class="empty">一条记忆都没有跨过会话边界。这不是“记忆很好”，而是<b>会话之间根本不共享记忆</b>——除非它被写进文件、技能或代码。</div>`}

<details style="margin-top:18px">
  <summary style="cursor:pointer;color:var(--dim);font-size:13px">只出现过一个会话的记忆（${h.orphans} 条，列出前 20）</summary>
  <table style="margin-top:10px"><thead><tr><th>内容</th><th>类型</th><th>出现</th><th>生命线</th></tr></thead><tbody>
${orphansShown
  .map(
    (t) => `<tr><td>${esc(t.text)}</td><td><span class="tag ${KIND[t.kind]?.tone ?? 'req'}">${esc(KIND[t.kind]?.label ?? t.kind)}</span></td><td class="num">${t.count}</td><td>${lifeline(t, maxIndex)}</td></tr>`,
  )
  .join('')}
  </tbody></table>
</details>

<h2><span class="cn">会话索引</span>按创建时间排列</h2>
<table><thead><tr><th>#</th><th>会话</th><th>创建</th><th>轮次</th><th>记忆单元</th><th>被压缩遗忘</th><th>文本量</th></tr></thead><tbody>
${sessions
  .map(
    (s) => `<tr><td class="num">${s.sessionIndex + 1}</td><td>${esc(s.label)}</td><td class="num">${when(s.createdAt)}</td><td class="num">${s.turns}</td><td class="num">${s.units}</td><td class="num">${s.evicted}</td><td class="num">${kchars(s.textBytes)}</td></tr>`,
  )
  .join('')}
</tbody></table>

<h2><span class="cn">方法与限度</span>跨会话比单会话更不可靠</h2>
<ol class="limits">${limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>

<footer>memory-audit corpus · 生成于 ${esc(meta.generatedAt)} · 每个圆点对应一次真实出现，报告不产生新事实。</footer>
</div></body></html>`;
}
