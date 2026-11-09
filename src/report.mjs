const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const VERDICT = {
  'write-ignored': { label: '写入即失效', tone: 'bad', hint: '新值写进去了，此后再没被提起；旧值仍在被使用。' },
  'legacy-dominant': { label: '旧值仍占优', tone: 'bad', hint: '新值偶尔出现，但旧值出现得更多。' },
  'both-silent': { label: '双方都沉默', tone: 'warn', hint: '两个值此后再没出现。冲突没有被解决，只是没人再提。' },
  'new-dominant': { label: '新值占优', tone: 'ok', hint: '新值更常出现，冲突正在被覆盖。' },
  'took-effect': { label: '替换生效', tone: 'ok', hint: '旧值此后再没出现，新值接管了。' },
};

const KIND = {
  claim: { label: '决策', tone: 'claim' },
  requirement: { label: '要求', tone: 'req' },
  goal: { label: '目标', tone: 'goal' },
  file: { label: '记忆文件', tone: 'file' },
};

const kchars = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));

function conflictCard(c) {
  const v = VERDICT[c.verdict] ?? { label: c.verdict, tone: 'warn', hint: '' };
  const newLabel = c.newer.polarity === 'reject' ? '否定了' : '写入了';
  return `
  <article class="conflict ${v.tone}" data-verdict="${esc(c.verdict)}">
    <header>
      <span class="slot">${esc(c.slotLabel)}</span>
      <span class="verdict ${v.tone}">${esc(v.label)}</span>
    </header>
    <p class="sentence">
      第 <b>${c.newer.turn}</b> 轮${newLabel}「${esc(c.newer.text)}」，
      与第 <b>${c.older.turn}</b> 轮的「${esc(c.older.text)}」冲突；
      此后 <b>${c.windowTurns}</b> 轮里：
      <b class="old">${esc(c.older.value)}</b> 被提及 <b>${c.oldMentions}</b> 轮
      <span class="dim">（其中 ${c.oldTool} 轮写进了工具调用）</span>，
      <b class="new">${esc(c.newer.value)}</b> 被提及 <b>${c.newMentions}</b> 轮
      <span class="dim">（其中 ${c.newTool} 轮写进了工具调用）</span>。
    </p>
    <p class="hint">${esc(v.hint)}</p>
    <details>
      <summary>逐轮证据</summary>
      <div class="evidence">
        <div><span class="dim">旧值出现轮次</span> ${c.older.mentionTurns.length ? c.older.mentionTurns.map((t) => `<code>${t}</code>`).join(' ') : '<span class="dim">无</span>'}</div>
        <div><span class="dim">新值出现轮次</span> ${c.newer.mentionTurns.length ? c.newer.mentionTurns.map((t) => `<code>${t}</code>`).join(' ') : '<span class="dim">无</span>'}</div>
        <div><span class="dim">旧值写进工具调用</span> ${c.older.toolTurns.length ? c.older.toolTurns.map((t) => `<code>${t}</code>`).join(' ') : '<span class="dim">无</span>'}</div>
        <div><span class="dim">新值写进工具调用</span> ${c.newer.toolTurns.length ? c.newer.toolTurns.map((t) => `<code>${t}</code>`).join(' ') : '<span class="dim">无</span>'}</div>
      </div>
    </details>
  </article>`;
}

function ledgerRow(u) {
  const k = KIND[u.kind] ?? { label: u.kind, tone: 'req' };
  const live = u.liveTurns?.length ?? 0;
  const strong = u.reuseTurns?.length ?? 0;
  const weak = u.relatedTurns?.length ?? 0;
  const term = u.mentionTurns?.length ?? 0;
  const evicted = u.evictedAtTurn != null;
  return `<tr data-kind="${esc(u.kind)}" data-id="${esc(u.id)}">
    <td class="num">${u.turn || '—'}</td>
    <td><span class="tag ${k.tone}">${esc(k.label)}</span></td>
    <td class="text">${esc(u.text)}${u.repeatCount > 1 ? `<span class="repeat" title="重复出现在第 ${u.repeatTurns.join('、')} 轮">重复 ${u.repeatCount}×</span>` : ''}</td>
    <td class="num ${evicted ? 'evicted' : ''}">${live}${evicted ? `<span class="mark" title="第 ${u.evictedAtTurn} 轮被压缩/裁剪">✕</span>` : ''}</td>
    <td class="num">${strong || '·'}</td>
    <td class="num dim">${term || weak || '·'}</td>
    <td class="num dim">${u.lastCitedTurn ?? '—'}</td>
  </tr>`;
}

export function renderReport(data) {
  const { headline: h, meta, units, conflicts, skills, evictions, pressure, limits, fidelity } = data;
  const maxTurn = meta.maxTurn || 1;
  const timelineUnits = units.filter((u) => u.turn > 0).slice(0, 60);
  const payload = JSON.stringify({
    maxTurn,
    turns: pressure.map((p) => p.turn),
    units: timelineUnits.map((u) => ({
      id: u.id,
      turn: u.turn,
      kind: u.kind,
      text: u.text,
      live: u.liveTurns ?? [],
      reuse: u.reuseTurns ?? [],
      term: u.mentionTurns ?? [],
      tool: u.toolTurns ?? [],
      evicted: u.evictedAtTurn ?? null,
    })),
    evictions,
    pressure,
  }).replace(/</g, '\\u003c');

  const pressureMax = Math.max(1, ...pressure.map((p) => p.total));

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆审计 · ${esc(meta.session.id ?? 'session')}</title>
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
.stat .k{color:var(--dim);font-size:12px;letter-spacing:.04em}
.stat .v{font:600 26px/1.2 var(--mono);margin-top:4px}
.stat.bad .v{color:var(--red)} .stat.warn .v{color:var(--amber)} .stat.ok .v{color:var(--teal)}
.conflict{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:10px;padding:18px 20px;margin-bottom:12px}
.conflict.bad{border-left-color:var(--red)} .conflict.ok{border-left-color:var(--teal)}
.conflict header{display:flex;gap:10px;align-items:center}
.slot{font-family:var(--mono);font-size:12px;color:var(--dim);border:1px solid var(--line);padding:2px 8px;border-radius:999px}
.verdict{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px}
.verdict.bad{background:rgba(224,91,91,.14);color:#ff8f8f} .verdict.warn{background:rgba(240,180,41,.14);color:var(--amber)} .verdict.ok{background:rgba(53,196,168,.14);color:var(--teal)}
.sentence{margin:10px 0 4px;font-size:16px;line-height:1.85}
.sentence b{font-family:var(--mono);color:var(--text)}
.sentence .old{color:#ff9a9a} .sentence .new{color:#7fe3ce}
.hint{color:var(--dim);font-size:13px;margin:6px 0 0}
details{margin-top:10px} summary{cursor:pointer;color:var(--dim);font-size:13px}
.evidence{margin-top:8px;font-size:13px;display:grid;gap:4px}
code{font-family:var(--mono);background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:0 5px;font-size:12px}
.empty{background:var(--panel);border:1px dashed var(--line);border-radius:10px;padding:22px;color:var(--dim);font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:12px;letter-spacing:.05em;text-transform:uppercase;position:sticky;top:0;background:var(--bg)}
td.num{font-family:var(--mono);white-space:nowrap}
td.text{max-width:620px}
tr:hover td{background:var(--panel)}
.tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);white-space:nowrap;color:var(--dim)}
.tag.claim{color:var(--amber);border-color:rgba(240,180,41,.35)}
.tag.req{color:#9fb4cc}
.tag.goal{color:var(--violet);border-color:rgba(167,139,250,.3)}
.tag.file{color:var(--teal);border-color:rgba(53,196,168,.3)}
.repeat{font-size:11px;color:var(--red);margin-left:8px;border:1px solid rgba(224,91,91,.35);border-radius:999px;padding:0 6px}
.evicted{color:var(--dim)} .evicted .mark{color:var(--red);margin-left:4px}
.filters{display:flex;gap:8px;margin:0 0 10px;flex-wrap:wrap}
.filters button{background:var(--panel);border:1px solid var(--line);color:var(--dim);border-radius:999px;padding:4px 12px;font-size:13px;cursor:pointer}
.filters button[aria-pressed="true"]{color:var(--text);border-color:#39434f;background:var(--panel2)}
.axis{display:grid;font-family:var(--mono);font-size:10px;color:var(--dim);margin:0 0 6px 260px;gap:2px}
.grid{display:grid;margin-left:0}
.row{display:grid;grid-template-columns:250px 1fr;gap:10px;align-items:center;border-bottom:1px solid rgba(34,42,51,.6);padding:3px 0}
.row .label{font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cells{display:grid;gap:2px}
.cell{height:16px;border-radius:2px;background:#151a20}
.cell.live{background:#1d242c}
.cell.write{background:var(--amber)}
.cell.reuse{background:var(--teal)}
.cell.term{background:#2b4a63}
.cell.tool{background:#2f6f63}
.cell.evicted{background:#2a1b1b}
.legend{display:flex;gap:16px;font-size:12px;color:var(--dim);margin-top:12px;flex-wrap:wrap}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.pres{display:grid;gap:3px;margin-top:8px}
.prow{display:grid;grid-template-columns:34px 1fr;gap:8px;align-items:center}
.pturn{font-family:var(--mono);font-size:10px;color:var(--dim);text-align:right}
.pbar{display:flex;align-items:stretch;border-radius:2px;overflow:hidden;background:#0f1318}
.pbar i{display:block;height:100%;min-width:0}
.prose{color:#c5ccd6;font-size:14px;max-width:760px}
.kv{display:grid;grid-template-columns:220px 1fr;gap:4px 16px;font-size:13px}
.kv .k{color:var(--dim)} .kv .v{font-family:var(--mono)}
ol.limits{color:#b9c2ce;font-size:14px;padding-left:22px} ol.limits li{margin-bottom:8px}
.skills{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
footer{margin-top:64px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
@media (max-width:760px){.row{grid-template-columns:110px 1fr}.axis{margin-left:120px}.kv{grid-template-columns:1fr}}
</style></head><body><div class="wrap">

<h1>记忆审计</h1>
<div class="sub">${esc(meta.session.id)} · ${meta.turns} 轮 · ${kchars(meta.textBytes)} 字符 · ${meta.rows} 条记录 · ${esc(meta.generatedAt)}</div>
<div class="sub" style="margin-top:4px">来源：${esc(meta.transcript)}</div>

<div class="stats">
  <div class="stat"><div class="k">记忆单元</div><div class="v">${h.units}</div></div>
  <div class="stat"><div class="k">可判定的决策</div><div class="v">${h.claims}</div></div>
  <div class="stat ${h.conflicts ? 'bad' : ''}"><div class="k">冲突</div><div class="v">${h.conflicts}</div></div>
  <div class="stat warn"><div class="k">写了等于没写</div><div class="v">${h.writeIgnored}</div></div>
  <div class="stat"><div class="k">无强证据的记忆</div><div class="v">${h.neverReused}</div></div>
  <div class="stat ${h.repeated ? 'warn' : ''}"><div class="k">被重复说过的</div><div class="v">${h.repeated}</div></div>
  <div class="stat ${h.evictedUnits ? 'bad' : ''}"><div class="k">被压缩/裁剪遗忘</div><div class="v">${h.evictedUnits}</div></div>
</div>

<h2><span class="cn">冲突</span>同一件事，两种说法</h2>
${conflicts.length ? conflicts.map(conflictCard).join('') : `<div class="empty">这个会话里没有可以被词表判定的槽位冲突。
  这通常不是“没有冲突”，而是<b>冲突没有被写成可以判定的形式</b>：自然语言的要求（“要完整” vs “别啰嗦”）之间也能打架，但规则抓不住。
  工具在这里留空，而不是猜一个。</div>`}

<h2><span class="cn">账本</span>每一条记忆的出生与去向</h2>
<div class="filters" id="filters">
  <button data-kind="all" aria-pressed="true">全部 ${units.length}</button>
  <button data-kind="claim" aria-pressed="false">决策 ${units.filter((u) => u.kind === 'claim').length}</button>
  <button data-kind="requirement" aria-pressed="false">要求 ${units.filter((u) => u.kind === 'requirement').length}</button>
  <button data-kind="goal" aria-pressed="false">目标 ${units.filter((u) => u.kind === 'goal').length}</button>
  <button data-kind="file" aria-pressed="false">记忆文件 ${units.filter((u) => u.kind === 'file').length}</button>
</div>
<table id="ledger">
<thead><tr><th>写入轮</th><th>类型</th><th>内容（原样引用）</th><th title="从写入到被压缩/裁剪之间，它在上下文里存在了几轮">存活</th><th title="后文逐字命中 8 字以上片段：强证据">复述</th><th title="同一槽位术语共现 / 特征词相关：弱证据">弱证</th><th>最后引用</th></tr></thead>
<tbody>${units.map(ledgerRow).join('')}</tbody>
</table>

<h2><span class="cn">时间轴</span>写入、存活、被引用、被抹掉</h2>
<div class="axis" id="axis"></div>
<div class="grid" id="timeline"></div>
<div class="legend">
  <span><i style="background:var(--amber)"></i>写入</span>
  <span><i style="background:#1d242c;outline:1px solid #2a333d"></i>在上下文</span>
  <span><i style="background:var(--teal)"></i>逐字复述</span>
  <span><i style="background:#2b4a63"></i>术语共现</span>
  <span><i style="background:#2f6f63"></i>写进工具调用</span>
  <span><i style="background:#2a1b1b;outline:1px solid #4a2a2a"></i>已不在上下文</span>
</div>

<h2><span class="cn">上下文压力</span>记忆为什么会被挤掉</h2>
<div class="prose">每一轮塞进模型的字符数。灰＝用户输入，蓝＝模型输出与工具参数，青＝工具结果，紫＝系统注入。压缩点用红色标记。</div>
<div class="pres" id="pressure"></div>
<div class="sub" style="margin-top:8px">本会话共压缩/裁剪 ${evictions.length} 次，抹掉 ${h.evictedTokens} tokens（来自 ${h.evictedUnits} 条记忆所在区间）。</div>

<h2><span class="cn">压缩保真度</span>摘要留下了什么，丢掉了什么</h2>
${fidelity && fidelity.total ? `
<div class="prose">压缩是拿「空间」换「召回」。这里不猜，只核对：把被压掉的每一条记忆，拿去和压缩后的摘要逐字比对——摘要里还找得到它的关键词，就算保住了。</div>
<div class="skills" style="margin-top:12px">
  <div class="stat ok"><div class="k">被压掉</div><div class="v">${fidelity.total}</div></div>
  <div class="stat ${fidelity.kept ? 'ok' : ''}"><div class="k">摘要还留着</div><div class="v">${fidelity.kept}</div></div>
  <div class="stat ${fidelity.dropped ? 'bad' : ''}"><div class="k">彻底丢掉</div><div class="v">${fidelity.dropped}</div></div>
</div>
<table style="margin-top:14px">
<thead><tr><th>类型</th><th>被压掉</th><th>摘要保留</th><th>丢弃</th></tr></thead>
<tbody>${Object.entries(fidelity.byKind).map(([k, v]) => `<tr><td><span class="tag ${KIND[k]?.tone ?? 'req'}">${esc(KIND[k]?.label ?? k)}</span></td><td class="num">${v.total}</td><td class="num">${v.kept}</td><td class="num">${v.total - v.kept}</td></tr>`).join('')}</tbody>
</table>
<div class="hint" style="margin-top:8px">依据 ${fidelity.summaries.length} 份压缩摘要（第 ${fidelity.summaries.map((s) => s.turn).join('、')} 轮）。决策被保留、要求被丢掉，是最常见的失真方向。</div>
` : `<div class="empty">这个会话没有发生压缩，或压缩摘要没有留下可核对的文本。没有证据时，工具不评功过。</div>`}

<h2><span class="cn">技能</span>装上的和真正用上的</h2>
<div class="skills">
  <div class="stat"><div class="k">目录里的技能</div><div class="v">${skills.installedCount}</div></div>
  <div class="stat ${skills.neverLoadedCount ? 'warn' : ''}"><div class="k">从未被加载</div><div class="v">${skills.neverLoadedCount}</div></div>
  <div class="stat ok"><div class="k">被加载过</div><div class="v">${skills.loadedCount}</div></div>
</div>
<div class="prose" style="margin-top:10px">技能目录在 ${skills.catalogTurns} 轮里被注入上下文。注入不等于使用：只有 <code>skill</code> 工具调用才算真的读了它。
${skills.rows.filter((s) => s.loaded).map((s) => `<div>· <code>${esc(s.name)}</code> 在第 ${s.loadTurns.join('、')} 轮被加载</div>`).join('') || '<div class="dim">没有任何技能被加载。</div>'}</div>

<h2><span class="cn">方法与限度</span>这个工具不知道什么</h2>
<ol class="limits">${limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
<div class="kv" style="margin-top:18px">
  <div class="k">会话记录</div><div class="v">${esc(meta.transcript)}</div>
  <div class="k">记录条数 / 文本量</div><div class="v">${meta.rows} / ${meta.textBytes} 字符${meta.compressed ? '（zstd，多帧）' : ''}</div>
  <div class="k">证据等级</div><div class="v">原样复述 &gt; 写进工具调用 &gt; 术语共现 &gt; 仅存在于上下文</div>
  <div class="k">不复存在的证据</div><div class="v">模型权重里的偏好、未外化的判断、被摘要改写的含义</div>
</div>

<footer>memory-audit · 生成于 ${esc(meta.generatedAt)} · 所有数字都可以回溯到会话记录里的具体 seq，报告本身不产生新事实。</footer>
</div>
<script>
const data = ${payload};
const turnIdx = new Map(data.turns.map((t, i) => [t, i]));
const axis = document.getElementById('axis');
axis.style.gridTemplateColumns = 'repeat(' + data.turns.length + ',1fr)';
axis.innerHTML = data.turns.map(t => '<span>' + (t === 1 || t % 5 === 0 || t === data.turns[data.turns.length - 1] ? t : '') + '</span>').join('');

const wall = document.getElementById('timeline');
wall.innerHTML = data.units.map(u => {
  const cells = data.turns.map(t => {
    if (t === u.turn) return '<i class="cell write" title="第 ' + t + ' 轮写入"></i>';
    if (u.evicted && t >= u.evicted) return '<i class="cell evicted" title="第 ' + t + ' 轮已不在上下文"></i>';
    if (u.live.includes(t)) {
      if (u.reuse.includes(t)) return '<i class="cell reuse" title="第 ' + t + ' 轮逐字复述"></i>';
      if (u.tool.includes(t)) return '<i class="cell tool" title="第 ' + t + ' 轮写进工具调用"></i>';
      if (u.term.includes(t)) return '<i class="cell term" title="第 ' + t + ' 轮术语共现"></i>';
      return '<i class="cell live" title="第 ' + t + ' 轮在上下文中"></i>';
    }
    return '<i class="cell" title="第 ' + t + ' 轮不在上下文"></i>';
  }).join('');
  return '<div class="row"><div class="label" title="' + u.text.replace(/"/g, '&quot;') + '">' + u.turn + ' · ' + u.text.slice(0, 34) + '</div><div class="cells" style="grid-template-columns:repeat(' + data.turns.length + ',1fr)">' + cells + '</div></div>';
}).join('');

const pmax = Math.max.apply(null, data.pressure.map(p => p.total).concat([1]));
document.getElementById('pressure').innerHTML = data.pressure.map(p => {
  const h = 6 + Math.round(40 * p.total / pmax);
  const seg = (v, c) => '<i style="flex:' + v + ';background:' + c + '" title="第 ' + p.turn + ' 轮 ' + v + ' 字符"></i>';
  const ev = data.evictions.filter(e => e.atTurn === p.turn).length;
  return '<div class="prow"><span class="pturn">' + p.turn + (ev ? ' ✕' : '') + '</span><div class="pbar" style="height:' + h + 'px" title="第 ' + p.turn + ' 轮 · 共 ' + p.total + ' 字符">'
    + seg(p.system, '#4c3b7a') + seg(p.user, '#3a4450') + seg(p.assistant, '#2b4a63') + seg(p.tool, '#2f6f63')
    + '</div></div>';
}).join('');

document.getElementById('filters').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  for (const x of document.querySelectorAll('#filters button')) x.setAttribute('aria-pressed', String(x === b));
  const k = b.dataset.kind;
  for (const tr of document.querySelectorAll('#ledger tbody tr')) {
    tr.style.display = k === 'all' || tr.dataset.kind === k ? '' : 'none';
  }
});
</script>
</body></html>`;
}
