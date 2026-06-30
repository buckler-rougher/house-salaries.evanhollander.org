/* House Staff Salaries — app.js */

const $ = id => document.getElementById(id);
const fmt   = n => n == null ? "—" : "$" + Math.round(n).toLocaleString();
const fmtK  = n => n == null ? "—" : "$" + Math.round(n / 1000) + "k";
const fmtSh = n => { if (n == null) return "—"; return n >= 1000 ? "$" + Math.round(n/1000) + "k" : "$" + Math.round(n); };

let summary = null, employees = [], charts = {};
let trendMetric = "median", trendMode = "overall", trendPosTitle = null, trendQFilter = 0;
let sortKey = "annual_equiv", sortDir = -1, page = 1, filtered = [];
let peopleData = null, peopleLoading = false;
const PAGE = 25;

const SALARY_CAP = 228000;
const TYPE_LABELS = { member:"Member", committee:"Committee", leadership:"Leadership", administrative:"Admin" };
const TYPE_COLORS = { member:"#2563eb", committee:"#059669", leadership:"#b45309", administrative:"#6b7280" };

async function loadData() {
  try {
    const [sr, er] = await Promise.all([fetch("data/summary.json"), fetch("data/employees.json")]);
    if (!sr.ok) throw new Error("Run scripts/fetch_sod.py to generate data.");
    summary = await sr.json();
    if (er.ok) { const d = await er.json(); employees = d.employees || []; }
    render();
    restoreHash();
  } catch(e) {
    $("loading").innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

async function loadPeople() {
  if (peopleData || peopleLoading) return;
  peopleLoading = true;
  try {
    const r = await fetch("data/people.json");
    if (r.ok) { const d = await r.json(); peopleData = d.people || []; }
  } catch(e) { /* non-fatal */ }
  peopleLoading = false;
}

function renderStats() {
  const q = summary.quarters[summary.quarters.length - 1];
  if (!q) return;
  const o = q.overall;
  $("stat-median").textContent  = o.median != null ? Math.round(o.median).toLocaleString() : "—";
  $("stat-mean").textContent    = o.mean   != null ? Math.round(o.mean).toLocaleString()   : "—";
  $("stat-count").textContent   = o.count  != null ? o.count.toLocaleString() : "—";
  $("stat-intern-note").textContent = `+ ${(q.intern_count||0).toLocaleString()} interns`;
  $("stat-quarter").textContent = q.label;
  $("stat-updated").textContent = summary.updated;
  $("footer-updated").textContent = summary.updated;
}

function renderDist() {
  const q = summary.quarters[summary.quarters.length - 1];
  if (!q) return;
  const dist = q.distribution;
  const labels = dist.map(b => b.max == null ? `$${b.min/1000}k+` : `$${b.min/1000}k`);
  const accent = "#c0392b";
  const colors = dist.map(b => {
    if (b.min < 50000)  return "#e8e5df";
    if (b.min < 80000)  return "#f4a69a";
    if (b.min < 130000) return accent;
    return "#8b1a12";
  });
  if (charts.dist) charts.dist.destroy();
  charts.dist = new Chart($("chart-dist"), {
    type: "bar",
    data: { labels, datasets: [{ data: dist.map(b => b.count), backgroundColor: colors, borderRadius: 3, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#111", padding: 10, cornerRadius: 6,
          callbacks: {
            title: items => { const b = dist[items[0].dataIndex]; return b.max == null ? `$${b.min/1000}k+` : `$${b.min/1000}k – $${b.max/1000}k`; },
            label: item => ` ${item.raw.toLocaleString()} employees`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45, color: "#888" } },
        y: { grid: { color: "#eeece8" }, ticks: { font: { size: 11 }, color: "#888" } },
      },
    },
  });
}

function renderTypeBars() {
  const q = summary.quarters[summary.quarters.length - 1];
  if (!q) return;
  const max = 220000, pct = v => Math.min(100, v/max*100);
  const c = $("type-bars"); c.innerHTML = "";
  ["member","committee","leadership","administrative"].forEach(type => {
    const s = q.by_type[type]; if (!s || !s.count) return;
    const col = TYPE_COLORS[type];
    const row = document.createElement("div"); row.className = "type-row";
    row.innerHTML = `
      <div class="type-label">${TYPE_LABELS[type]}<br><span class="type-label-sub">${s.count.toLocaleString()} staff</span></div>
      <div class="type-track-wrap">
        <div class="type-track type-bg"></div>
        <div class="type-track type-iqr" style="left:${pct(s.p25)}%;width:${pct(s.p75)-pct(s.p25)}%;background:${col}"></div>
        <div class="type-track type-needle" style="left:${pct(s.median)}%;background:${col}"></div>
      </div>
      <span class="type-val" style="color:${col}">${fmtK(s.median)}</span>`;
    c.appendChild(row);
  });
  const leg = document.createElement("div");
  leg.style.cssText = "margin-top:14px;font-size:.7rem;color:#888;display:flex;gap:16px";
  leg.innerHTML = "<span>Bar = 25th–75th percentile</span><span>Line = median</span>";
  c.appendChild(leg);
}

const TYPE_COLORS_TREND = {
  member: "#2563eb", committee: "#059669", leadership: "#b45309", administrative: "#6b7280"
};

function renderTrend() {
  if (charts.trend) { charts.trend.destroy(); charts.trend = null; }
  $("trend-empty").style.display = "none";
  $("chart-trend").style.display = "";
  const qs = filteredQuarters(trendQFilter);
  const labels = qs.map(q => q.label);

  if (trendMode === "overall") {
    charts.trend = drawChart($("chart-trend"), labels, [{
      label: METRIC_LABELS[trendMetric], data: qs.map(q => q.overall[trendMetric]),
      borderColor: "#c0392b", backgroundColor: "rgba(192,57,43,.07)", fill: true,
      tension: 0.3, pointRadius: 4, pointBackgroundColor: "#fff", pointBorderColor: "#c0392b", pointBorderWidth: 2, borderWidth: 2,
    }]);

  } else if (trendMode === "type") {
    const datasets = ["member","committee","leadership","administrative"].map(type => ({
      label: TYPE_LABELS[type],
      data: qs.map(q => q.by_type[type]?.[trendMetric] ?? null),
      borderColor: TYPE_COLORS_TREND[type], backgroundColor: TYPE_COLORS_TREND[type] + "15",
      tension: 0.3, pointRadius: 3, borderWidth: 2, spanGaps: true,
    }));
    charts.trend = drawChart($("chart-trend"), labels, datasets, { legend: true });

  } else if (trendMode === "position") {
    if (!trendPosTitle) {
      $("chart-trend").style.display = "none";
      $("trend-empty").style.display = "";
      return;
    }
    const data = qs.map(q => {
      const t = (q.top_titles || []).find(t => t.title === trendPosTitle);
      return t ? t[trendMetric] : null;
    });
    charts.trend = drawChart($("chart-trend"), labels, [{
      label: "", data, borderColor: "#c0392b", backgroundColor: "rgba(192,57,43,.07)", fill: true,
      tension: 0.3, pointRadius: 4, pointBackgroundColor: "#fff", pointBorderColor: "#c0392b", pointBorderWidth: 2, borderWidth: 2, spanGaps: true,
    }]);
  }
}

// ── Position lookup ──
let titles = [];

function buildTitles() {
  // Compute from all employees in the latest quarter (covers every title, any count)
  const groups = {};
  employees.filter(e => !e.intern && !e.shared).forEach(e => {
    if (!e.title) return;
    if (!groups[e.title]) groups[e.title] = [];
    groups[e.title].push(e.annual_equiv);
  });
  titles = Object.entries(groups).map(([title, amts]) => {
    const s = amts.slice().sort((a,b)=>a-b);
    const p = pct => { const i=(s.length-1)*pct/100,lo=Math.floor(i),hi=Math.min(lo+1,s.length-1); return s[lo]+(s[hi]-s[lo])*(i-lo); };
    return { title, count: s.length, median: Math.round(p(50)), mean: Math.round(s.reduce((a,b)=>a+b,0)/s.length),
      p25: Math.round(p(25)), p75: Math.round(p(75)), p10: Math.round(p(10)), p90: Math.round(p(90)),
      min: s[0], max: s[s.length-1] };
  }).sort((a,b) => b.count - a.count);
}

function renderPosResults(query) {
  const q = query.toLowerCase().trim();
  const hits = q ? titles.filter(t => t.title.toLowerCase().includes(q)).slice(0,8) : titles.slice(0,8);
  const c = $("pos-results"); c.innerHTML = "";
  if (!hits.length) {
    c.innerHTML = `<div style="padding:10px 12px;font-size:.82rem;color:#888">No matches.</div>`;
    return;
  }
  hits.forEach(t => {
    const el = document.createElement("div"); el.className = "pos-row";
    el.innerHTML = `<span class="pos-row-name">${esc(t.title)}</span><span class="pos-row-count">${t.count.toLocaleString()} staff</span><span class="pos-row-median">${fmtK(t.median)}</span>`;
    el.addEventListener("click", () => selectTitle(t, el));
    c.appendChild(el);
  });
}

function selectTitle(t, el) {
  document.querySelectorAll(".pos-row").forEach(r => r.classList.remove("active"));
  el?.classList.add("active");
  $("lookup-hint").style.display = "none";
  $("range-card-wrap").style.display = "";
  setHash({ pos: t.title });
  const max = Math.max(t.max||0, 220000), pct = v => Math.min(100, v/max*100);

  const staff = employees
    .filter(e => !e.intern && !e.shared && e.title === t.title)
    .sort((a,b) => b.annual_equiv - a.annual_equiv);

  const trendLabels = summary.quarters.map(q => q.label);
  const trendData = summary.quarters.map(q => {
    const found = (q.top_titles || []).find(x => x.title === t.title);
    return found ? found.median : null;
  });
  const hasTrend = trendData.filter(v => v != null).length >= 2;

  const staffHtml = staff.length ? `
    <div class="range-staff-list">
      <div class="range-staff-heading">Staff with this title</div>
      ${staff.slice(0,30).map(e => {
        const over = e.annual_equiv > SALARY_CAP;
        return `<div class="range-staff-row">
          <span class="range-staff-name person-link" data-name="${esc(e.name)}" data-office="${esc(cleanOrg(e.office))}">${esc(e.name)}</span>
          <span class="range-staff-office">${esc(cleanOrg(e.office))}</span>
          <span class="range-staff-amt">${over?`<span class="cap-warn" title="May include bonus/lump sum">⚠</span> `:""}${fmt(e.annual_equiv)}</span>
        </div>`;
      }).join("")}
      ${staff.length>30?`<div class="range-staff-more">+${staff.length-30} more</div>`:""}
    </div>` : "";

  $("range-card").innerHTML = `
    <div class="range-card-title">${esc(t.title)}</div>
    <div class="range-card-sub">${t.count.toLocaleString()} employees · latest quarter · annual equivalent</div>
    <div class="range-bar-wrap">
      <div class="range-bar-track">
        <div class="range-bar-fill" style="left:${pct(t.p10)}%;width:${pct(t.p90)-pct(t.p10)}%"></div>
        <div class="range-bar-needle" style="left:${pct(t.median)}%"></div>
      </div>
      <div class="range-bar-labels"><span>${fmtSh(t.p10)} (P10)</span><span>${fmtSh(t.p90)} (P90)</span></div>
    </div>
    <div class="range-trio">
      <div class="range-trio-cell"><div class="range-trio-val">${fmtSh(t.p25)}</div><div class="range-trio-key">25th pct.</div></div>
      <div class="range-trio-cell"><div class="range-trio-val">${fmtSh(t.median)}</div><div class="range-trio-key">Median</div></div>
      <div class="range-trio-cell"><div class="range-trio-val">${fmtSh(t.p75)}</div><div class="range-trio-key">75th pct.</div></div>
    </div>
    <div class="range-min-max"><span>Min: ${fmtSh(t.min)}</span><span>Max: ${fmtSh(t.max)}</span></div>
    ${hasTrend ? miniTrendHtml("mini-pos-trend-wrap", "Salary trend") : ""}
    ${staffHtml}`;
  if (hasTrend) {
    const wrap = document.getElementById("mini-pos-trend-wrap");
    if (wrap) makeMiniTrend(wrap, (metric, qf) => {
      return filteredQuarters(qf).map(q => {
        const found = (q.top_titles || []).find(x => x.title === t.title);
        return found ? found[metric] : null;
      });
    });
  }
}

// ── Person profile ──
async function showPerson(name, officeName) {
  setHash({ person: name + "|" + officeName });
  $("lookup-hint").style.display = "none";
  $("range-card-wrap").style.display = "";
  $("range-card").innerHTML = `<div style="padding:12px 0;color:var(--ink3);font-size:.85rem">Loading history…</div>`;

  await loadPeople();

  const person = peopleData?.find(p => p.name === name && p.office === officeName);
  const latestEmp = employees.find(e => e.name === name && cleanOrg(e.office) === officeName);

  const histHtml = person ? (() => {
    // Build quarter label map
    const labelMap = {};
    summary.quarters.forEach(q => labelMap[q.id] = q.label);
    const hist = person.history;
    const data = hist.map(h => h.quarterly_pay * 4);
    const labels = hist.map(h => labelMap[h.quarter] || h.quarter);

    // Change vs first quarter
    const first = data[0], last = data[data.length - 1];
    const change = last - first;
    const changePct = first ? ((change / first) * 100).toFixed(0) : null;
    const changeStr = changePct != null
      ? `<span style="color:${change >= 0 ? '#059669' : '#dc2626'};font-weight:700">${change >= 0 ? "+" : ""}${fmt(change)} (${change >= 0 ? "+" : ""}${changePct}%) since ${labels[0]}</span>`
      : "";

    const compHtml = latestEmp ? `<div class="person-comp" id="person-comp-block">
      <div class="person-comp-label">Compare to: <span id="person-comp-title-display" class="person-comp-title-link">${esc(latestEmp.title)}</span></div>
      <div style="position:relative;display:none" id="person-comp-search-wrap">
        <input id="person-comp-search" class="t-input" placeholder="Search a title…" autocomplete="off"
          style="font-size:.78rem;padding:5px 8px;width:100%;box-sizing:border-box;margin:4px 0" />
        <div id="person-comp-results" class="pos-results"
          style="position:absolute;z-index:10;background:var(--bg);border:1.5px solid var(--line);border-radius:8px;width:100%;display:none;max-height:200px;overflow-y:auto"></div>
      </div>
      <div id="person-comp-stats"></div>
    </div>` : "";

    return `<div class="mini-trend-wrap" id="person-trend-wrap">
      <div class="mini-trend-heading">Pay history · annual equivalent</div>
      ${changeStr ? `<div style="margin-bottom:8px;font-size:.8rem">${changeStr}</div>` : ""}
      <div class="mini-ctrl-row">
        <div class="mini-pills">
          <button class="mini-q active" data-q="0">All</button>
          <button class="mini-q" data-q="1">Q1</button>
          <button class="mini-q" data-q="2">Q2</button>
          <button class="mini-q" data-q="3">Q3</button>
          <button class="mini-q" data-q="4">Q4</button>
        </div>
      </div>
      <div class="mini-chart-wrap" id="person-chart"></div>
      ${compHtml}
    </div>`;
  })() : `<div style="padding:8px 0;font-size:.82rem;color:var(--ink3)">No multi-quarter history found. This person may have joined recently or changed offices.</div>`;

  const over = latestEmp && latestEmp.annual_equiv > SALARY_CAP;
  $("range-card").innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px">
      <div>
        <div class="range-card-title">${esc(name)}</div>
        <div class="range-card-sub">${esc(officeName)}${latestEmp ? ` · ${esc(latestEmp.title)}` : ""}</div>
      </div>
      <button onclick="clearPerson()" style="background:none;border:none;cursor:pointer;color:var(--ink3);font-size:1.1rem;line-height:1;padding:2px">×</button>
    </div>
    ${latestEmp ? `<div style="font-size:1.4rem;font-weight:800;color:var(--ink);margin:10px 0 2px;font-variant-numeric:tabular-nums">${over?`<span class="cap-warn">⚠</span> `:""}${fmt(latestEmp.annual_equiv)}<span style="font-size:.75rem;font-weight:400;color:var(--ink3);margin-left:6px">est. annual</span></div>` : ""}
    ${histHtml}`;

  if (person) {
    const labelMap = {};
    summary.quarters.forEach(q => labelMap[q.id] = q.label);
    let qf = 0;
    function drawPersonChart() {
      const filtQs = summary.quarters.filter(q => !qf || q.quarter === qf);
      const filtData = filtQs.map(q => {
        const h = person.history.find(h => h.quarter === q.id);
        return h ? h.quarterly_pay * 4 : null;
      });
      const filtLabels = filtQs.map(q => q.label);
      const el = $("person-chart");
      if (el) el.innerHTML = svgSparkline(filtData, filtLabels);
    }
    drawPersonChart();
    document.querySelectorAll("#person-trend-wrap .mini-q").forEach(b => {
      b.addEventListener("click", () => {
        qf = +b.dataset.q;
        document.querySelectorAll("#person-trend-wrap .mini-q").forEach(x => x.classList.toggle("active", x === b));
        drawPersonChart();
      });
    });
  }

  if (latestEmp) {
    const allTitles = summary.quarters[summary.quarters.length - 1]?.top_titles || [];
    function renderCompStats(titleStr) {
      const ts = allTitles.find(t => t.title === titleStr);
      const el = $("person-comp-stats");
      if (!el) return;
      if (!ts) { el.innerHTML = `<div style="font-size:.78rem;color:var(--ink3);padding:6px 0">No salary data for this title.</div>`; return; }
      const you = latestEmp.annual_equiv;
      const pctile = you < ts.p25 ? "below 25th pct." : you < ts.median ? "25–50th pct." : you < ts.p75 ? "50–75th pct." : "above 75th pct.";
      el.innerHTML = `
        <div class="person-comp-row"><span>25th pct.</span><span>${fmtK(ts.p25)}</span></div>
        <div class="person-comp-row"><span>Median</span><span>${fmtK(ts.median)}</span></div>
        <div class="person-comp-row person-comp-you"><span>This person</span><span>${fmtK(you)} <em style="font-weight:400;font-size:.7rem;color:var(--ink3)">${pctile}</em></span></div>
        <div class="person-comp-row"><span>75th pct.</span><span>${fmtK(ts.p75)}</span></div>`;
    }
    renderCompStats(person?.title || latestEmp.title);

    const searchEl = $("person-comp-search");
    const resultsEl = $("person-comp-results");
    const searchWrap = $("person-comp-search-wrap");
    const titleDisplay = $("person-comp-title-display");
    if (searchEl && resultsEl && searchWrap && titleDisplay) {
      titleDisplay.addEventListener("click", () => {
        searchWrap.style.display = searchWrap.style.display === "none" ? "block" : "none";
        if (searchWrap.style.display === "block") { searchEl.value = ""; searchEl.focus(); }
      });
      searchEl.addEventListener("input", () => {
        const q = searchEl.value.toLowerCase().trim();
        if (!q) { resultsEl.style.display = "none"; return; }
        const hits = allTitles.filter(t => t.title.toLowerCase().includes(q)).slice(0, 10);
        if (!hits.length) { resultsEl.style.display = "none"; return; }
        resultsEl.innerHTML = hits.map(t =>
          `<div class="pos-result-item" data-title="${esc(t.title)}">${esc(t.title)}<span style="float:right;color:var(--ink3);font-size:.75rem">${fmtK(t.median)}</span></div>`
        ).join("");
        resultsEl.style.display = "block";
        resultsEl.querySelectorAll(".pos-result-item").forEach(row => {
          row.addEventListener("click", () => {
            titleDisplay.textContent = row.dataset.title;
            searchWrap.style.display = "none";
            resultsEl.style.display = "none";
            renderCompStats(row.dataset.title);
          });
        });
      });
      document.addEventListener("click", e => {
        if (!e.target.closest("#person-comp-block")) {
          searchWrap.style.display = "none";
          resultsEl.style.display = "none";
        }
      });
    }
  }
}

function clearPerson() {
  setHash({});
  $("range-card-wrap").style.display = "none";
  $("lookup-hint").style.display = "";
  document.querySelectorAll(".pos-row").forEach(r => r.classList.remove("active"));
}

// ── URL hash state ──
function setHash(state) {
  const parts = [];
  if (state.pos)    parts.push("pos=" + encodeURIComponent(state.pos));
  if (state.person) parts.push("person=" + encodeURIComponent(state.person));
  history.replaceState(null, "", parts.length ? "#" + parts.join("&") : location.pathname);
}

function restoreHash() {
  if (!location.hash) return;
  const params = {};
  location.hash.slice(1).split("&").forEach(p => {
    const [k, v] = p.split("=");
    params[k] = decodeURIComponent(v || "");
  });
  if (params.pos) {
    const t = titles.find(t => t.title === params.pos);
    if (t) {
      const row = [...document.querySelectorAll(".pos-row")].find(r => r.querySelector(".pos-row-name")?.textContent === t.title);
      selectTitle(t, row);
    }
  }
  if (params.person) {
    const [name, office] = params.person.split("|");
    if (name && office) showPerson(name, office);
  }
}

// ── By Office ──
let officeData = [];

function buildOfficeData() {
  const groups = {};
  employees.filter(e => !e.intern && !e.shared).forEach(e => {
    const key = cleanOrg(e.office);
    if (!groups[key]) groups[key] = { name: key, type: e.type, amounts: [] };
    groups[key].amounts.push(e.annual_equiv);
  });
  officeData = Object.values(groups).map(g => {
    const s = g.amounts.slice().sort((a,b) => a-b);
    const p = pct => { const i=(s.length-1)*pct/100; const lo=Math.floor(i),hi=Math.min(lo+1,s.length-1); return s[lo]+(s[hi]-s[lo])*(i-lo); };
    const totalAnnual = Math.round(s.reduce((a,b)=>a+b,0));
    return { name: g.name, type: g.type, count: s.length,
      min: Math.round(s[0]), max: Math.round(s[s.length-1]),
      median: Math.round(p(50)), p25: Math.round(p(25)), p75: Math.round(p(75)),
      totalAnnual };
  });
}

const METRIC_LABELS = { median:"Median", mean:"Average", p25:"25th pct.", p75:"75th pct." };

function miniTrendHtml(wrapId, heading) {
  return `<div class="mini-trend-wrap" id="${wrapId}">
    <div class="mini-trend-heading">${heading}</div>
    <div class="mini-ctrl-row">
      <div class="mini-pills">
        <button class="mini-pill active" data-metric="median">Median</button>
        <button class="mini-pill" data-metric="mean">Avg</button>
        <button class="mini-pill" data-metric="p25">P25</button>
        <button class="mini-pill" data-metric="p75">P75</button>
      </div>
      <div class="mini-pills">
        <button class="mini-q active" data-q="0">All</button>
        <button class="mini-q" data-q="1">Q1</button>
        <button class="mini-q" data-q="2">Q2</button>
        <button class="mini-q" data-q="3">Q3</button>
        <button class="mini-q" data-q="4">Q4</button>
      </div>
    </div>
    <div class="mini-chart-wrap"></div>
  </div>`;
}

function filteredQuarters(qFilter) {
  const qs = summary.quarters;
  return qFilter ? qs.filter(q => q.quarter === qFilter) : qs;
}

function drawChart(canvasEl, labels, datasets, opts = {}) {
  const { legend = false, mini = false } = opts;
  const sz = mini ? 9 : 11;
  return new Chart(canvasEl, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: !mini,
      plugins: {
        legend: legend ? { display: true, position: "bottom", labels: { font: { size: 11 }, boxWidth: 12, padding: 16 } } : { display: false },
        tooltip: { backgroundColor: "#111", padding: mini ? 8 : 10, cornerRadius: 5,
          callbacks: {
            title: items => labels[items[0].dataIndex],
            label: item => item.raw != null ? ` ${item.dataset.label ? item.dataset.label+": " : ""}${fmt(item.raw)}` : " No data",
          }},
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: sz }, maxRotation: 45, color: "#aaa", maxTicksLimit: mini ? 6 : 12 } },
        y: { grid: { color: "#eeece8" }, ticks: { font: { size: sz }, color: "#aaa", callback: v => "$"+(v/1000).toFixed(0)+"k", maxTicksLimit: mini ? 4 : 6 } },
      },
    },
  });
}

function svgSparkline(data, labels) {
  const W = 560, H = 200;
  const pad = { t: 14, r: 16, b: 48, l: 54 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;

  const valid = data.map((v, i) => ({ v, i })).filter(d => d.v != null);
  if (!valid.length) return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%"><text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="11" fill="#aaa">No data</text></svg>`;

  const minV = Math.min(...valid.map(d => d.v));
  const maxV = Math.max(...valid.map(d => d.v));
  const vRange = maxV - minV || 1;
  const sx = i => pad.l + (i / Math.max(data.length - 1, 1)) * pw;
  const sy = v => pad.t + ph - ((v - minV) / vRange) * ph;

  // Y gridlines + labels
  const yTicks = [0, 0.33, 0.67, 1].map(f => {
    const v = minV + vRange * f, y = sy(v);
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eeece8" stroke-width="1"/>
            <text x="${pad.l - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#888">$${(v/1000).toFixed(0)}k</text>`;
  }).join("");

  // X labels — show ~6 evenly spaced
  const step = Math.max(1, Math.ceil(labels.length / 6));
  const xLabels = labels.map((lb, i) => {
    if (i % step !== 0 && i !== labels.length - 1) return "";
    return `<text x="${sx(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#888">${lb}</text>`;
  }).join("");

  // Segments (skip null gaps)
  const segs = [];
  let cur = [];
  data.forEach((v, i) => {
    if (v != null) { cur.push([sx(i), sy(v)]); }
    else if (cur.length) { segs.push(cur); cur = []; }
  });
  if (cur.length) segs.push(cur);

  const fills = segs.map(s => {
    if (s.length < 2) return "";
    const d = s.map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    return `<path d="${d} L${s[s.length-1][0].toFixed(1)},${(pad.t+ph).toFixed(1)} L${s[0][0].toFixed(1)},${(pad.t+ph).toFixed(1)} Z" fill="rgba(192,57,43,.07)" stroke="none"/>`;
  }).join("");

  const lines = segs.map(s => {
    const d = s.map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="#c0392b" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join("");

  const dots = valid.map(({ v, i }) =>
    `<circle cx="${sx(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="4" fill="white" stroke="#c0392b" stroke-width="2"><title>${labels[i]}: $${Math.round(v).toLocaleString()}</title></circle>`
  ).join("");

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">${yTicks}${fills}${lines}${dots}${xLabels}</svg>`;
}

function makeMiniTrend(wrapEl, getDataFn) {
  let metric = "median", qf = 0;

  function render() {
    const qs = filteredQuarters(qf);
    const data = getDataFn(metric, qf);
    const labels = qs.map(q => q.label);
    const chartWrap = wrapEl.querySelector(".mini-chart-wrap");
    if (chartWrap) chartWrap.innerHTML = svgSparkline(data, labels);
  }

  wrapEl.querySelectorAll(".mini-pill[data-metric]").forEach(pill => {
    pill.addEventListener("click", () => {
      metric = pill.dataset.metric;
      wrapEl.querySelectorAll(".mini-pill[data-metric]").forEach(p => p.classList.toggle("active", p === pill));
      render();
    });
  });
  wrapEl.querySelectorAll(".mini-q[data-q]").forEach(btn => {
    btn.addEventListener("click", () => {
      qf = +btn.dataset.q;
      wrapEl.querySelectorAll(".mini-q").forEach(b => b.classList.toggle("active", b === btn));
      render();
    });
  });

  render();
}

function renderOfficeDetail(officeName, el) {
  const staff = employees.filter(e => !e.intern && cleanOrg(e.office) === officeName)
    .sort((a,b) => b.annual_equiv - a.annual_equiv);
  if (!staff.length) { el.innerHTML = `<div class="office-detail-empty">No staff data.</div>`; return; }
  const amts = staff.map(e => e.annual_equiv).sort((a,b)=>a-b);
  const p = pct => { const i=(amts.length-1)*pct/100,lo=Math.floor(i),hi=Math.min(lo+1,amts.length-1); return amts[lo]+(amts[hi]-amts[lo])*(i-lo); };
  const median = Math.round(p(50)), p25 = Math.round(p(25)), p75 = Math.round(p(75));
  const trendWrapId = "mini-office-" + officeName.replace(/[^a-z0-9]/gi, "_");
  const hasTrend = summary.quarters.some(q => (q.top_offices || []).find(o => o.name === officeName));

  el.innerHTML = `
    <div class="office-detail-stats">
      <div class="office-detail-stat"><div class="office-detail-val">${fmtK(p25)}</div><div class="office-detail-key">25th pct.</div></div>
      <div class="office-detail-stat"><div class="office-detail-val">${fmtK(median)}</div><div class="office-detail-key">Median</div></div>
      <div class="office-detail-stat"><div class="office-detail-val">${fmtK(p75)}</div><div class="office-detail-key">75th pct.</div></div>
    </div>
    <div class="office-total-payroll">Est. annual payroll: <strong>${fmt(staff.reduce((s,e)=>s+e.annual_equiv,0))}</strong> across ${staff.length} staff</div>
    ${hasTrend ? miniTrendHtml(trendWrapId, "Salary trend") : ""}
    <div class="office-staff-list">${staff.map(e => {
      const over = e.annual_equiv > SALARY_CAP;
      return `<div class="office-staff-row">
        <span class="office-staff-name person-link" data-name="${esc(e.name)}" data-office="${esc(officeName)}">${esc(e.name)}</span>
        <span class="office-staff-title">${esc(e.title)}</span>
        <span class="office-staff-amt">${over?`<span class="cap-warn" title="May include bonus/lump sum">⚠</span> `:""}${fmt(e.annual_equiv)}</span>
      </div>`;
    }).join("")}</div>`;
  if (hasTrend) {
    const wrap = document.getElementById(trendWrapId);
    if (wrap) makeMiniTrend(wrap, (metric, qf) => {
      return filteredQuarters(qf).map(q => {
        const o = (q.top_offices || []).find(o => o.name === officeName);
        return o ? o[metric] : null;
      });
    });
  }
}

let officeSortKey = "median";

function renderOfficeList() {
  const q = ($("office-search").value || "").toLowerCase().trim();
  const type = $("office-type-filter").value;
  officeSortKey = $("office-sort").value;

  let rows = officeData.filter(o => {
    if (type && o.type !== type) return false;
    if (q && !o.name.toLowerCase().includes(q)) return false;
    return true;
  });

  rows.sort((a,b) => {
    if (officeSortKey === "count") return b.count - a.count;
    if (officeSortKey === "name")  return a.name.localeCompare(b.name);
    return b.max - a.max;
  });

  const container = $("office-list");
  if (rows.length === 0) {
    container.innerHTML = `<div style="padding:16px 0;font-size:.85rem;color:var(--ink3)">No matching offices.</div>`;
    return;
  }

  const listEl = document.createElement("div");
  listEl.className = "office-list";
  rows.slice(0, 150).forEach(o => {
    const wrap = document.createElement("div");
    wrap.className = "office-wrap";
    wrap.innerHTML = `
      <div class="office-row">
        <div class="office-name">${esc(o.name)}</div>
        <span class="badge badge-${o.type}">${TYPE_LABELS[o.type]||o.type}</span>
        <span class="office-count">${o.count} staff</span>
        <span class="office-range">${fmtK(o.min)}<span class="office-range-sep">–</span>${fmtK(o.max)}</span>
        <span class="office-chevron">›</span>
      </div>
      <div class="office-detail" style="display:none"></div>`;
    const row = wrap.querySelector(".office-row");
    const detail = wrap.querySelector(".office-detail");
    const chevron = wrap.querySelector(".office-chevron");
    row.addEventListener("click", () => {
      const open = detail.style.display !== "none";
      // close all
      container.querySelectorAll(".office-detail").forEach(d => d.style.display="none");
      container.querySelectorAll(".office-chevron").forEach(c => { c.textContent="›"; c.style.transform=""; });
      if (!open) {
        detail.style.display = "";
        chevron.textContent = "›";
        chevron.style.transform = "rotate(90deg)";
        if (!detail.dataset.loaded) {
          detail.dataset.loaded = "1";
          renderOfficeDetail(o.name, detail);
        }
      }
    });
    listEl.appendChild(wrap);
  });
  container.innerHTML = "";
  container.appendChild(listEl);
}

// ── Table ──
function applyFilters() {
  const q = $("emp-search").value.toLowerCase().trim();
  const type = $("emp-office").value;
  const show = $("emp-type").value;
  filtered = employees.filter(e => {
    if (show === "staff"  &&  e.intern) return false;
    if (show === "intern" && !e.intern) return false;
    if (type && e.type !== type) return false;
    if (q && !e.name.toLowerCase().includes(q) && !e.office.toLowerCase().includes(q) && !e.title.toLowerCase().includes(q)) return false;
    return true;
  });
  page = 1; renderTable();
}

function renderTable() {
  if (sortKey === "name") filtered.sort((a,b) => sortDir * a.name.localeCompare(b.name));
  else filtered.sort((a,b) => sortDir * ((a[sortKey]||0) - (b[sortKey]||0)));
  const slice = filtered.slice((page-1)*PAGE, page*PAGE);
  const totalPages = Math.max(1, Math.ceil(filtered.length/PAGE));
  $("emp-tbody").innerHTML = slice.map(e => {
    const overCap = e.annual_equiv > SALARY_CAP;
    return `<tr>
      <td class="td-name"><span class="person-link" data-name="${esc(e.name)}" data-office="${esc(cleanOrg(e.office))}">${esc(e.name)}</span></td>
      <td class="td-office" title="${esc(e.office)}">${esc(cleanOrg(e.office))}</td>
      <td class="td-title">${esc(e.title)}</td>
      <td><span class="badge badge-${e.intern?"intern":e.shared?"shared":e.type}">${e.intern?"Intern":e.shared?"Shared":(TYPE_LABELS[e.type]||e.type)}</span></td>
      <td class="td-amt-q">${fmt(e.quarterly_pay)}</td>
      <td class="td-amt">${overCap ? `<span class="cap-warn" title="Exceeds $228k staff salary cap — may include a bonus or lump-sum payment">⚠</span> ` : ""}${fmt(e.annual_equiv)}</td>
    </tr>`;
  }).join("");
  $("table-info").textContent = `${filtered.length.toLocaleString()} employees`;
  const pg = $("pagination"); pg.innerHTML = "";
  paginationRange(page, totalPages).forEach(p => {
    if (p === "…") { const s = document.createElement("span"); s.textContent="…"; s.style.cssText="padding:4px 6px;color:#888;font-size:.8rem"; pg.appendChild(s); }
    else { const b = document.createElement("button"); b.className="page-btn"+(p===page?" active":""); b.textContent=p; b.onclick=()=>{page=p;renderTable();}; pg.appendChild(b); }
  });
}

function paginationRange(cur, total) {
  if (total<=7) return Array.from({length:total},(_,i)=>i+1);
  if (cur<=4) return [1,2,3,4,5,"…",total];
  if (cur>=total-3) return [1,"…",total-4,total-3,total-2,total-1,total];
  return [1,"…",cur-1,cur,cur+1,"…",total];
}

function setSortKey(key) {
  if (sortKey===key) sortDir*=-1; else { sortKey=key; sortDir=-1; }
  document.querySelectorAll("th[data-sort]").forEach(th => {
    const on = th.dataset.sort===key; th.classList.toggle("sorted",on);
    th.querySelector(".sort-icon").textContent = on?(sortDir===1?"↑":"↓"):"↕";
  });
  renderTable();
}

function cleanOrg(o) {
  return o.replace(/^FISCAL YEAR \d{4}\s*/i,"").replace(/^\d{4}\s+/,"");
}
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function render() {
  $("loading").remove(); $("app").style.display = "";
  renderStats(); renderDist(); buildTitles(); renderPosResults(""); buildOfficeData();
  filtered = employees.filter(e => !e.intern); renderTable();
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
    const tab = b.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(x => x.classList.toggle("active", x===b));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id==="tab-"+tab));
    if (tab==="type" && !$("office-list").children.length) renderOfficeList();
    if (tab==="typebars" && !$("type-bars").children.length) renderTypeBars();
    if (tab==="trend") { if (!charts.trend) renderTrend(); }
  }));
  document.querySelectorAll(".trend-mode").forEach(b => b.addEventListener("click", () => {
    trendMode = b.dataset.mode;
    document.querySelectorAll(".trend-mode").forEach(x => x.classList.toggle("active", x===b));
    $("trend-overall-ctrl").style.display = trendMode === "overall" ? "" : "none";
    $("trend-pos-ctrl").style.display = trendMode === "position" ? "" : "none";
    if (charts.trend) { charts.trend.destroy(); charts.trend=null; }
    renderTrend();
  }));
  document.querySelectorAll(".pill").forEach(p => p.addEventListener("click", () => {
    trendMetric = p.dataset.metric;
    document.querySelectorAll(".pill").forEach(x => x.classList.toggle("active", x===p));
    if (charts.trend) { charts.trend.destroy(); charts.trend=null; }
    renderTrend();
  }));
  document.querySelectorAll(".trend-q").forEach(b => b.addEventListener("click", () => {
    trendQFilter = +b.dataset.q;
    document.querySelectorAll(".trend-q").forEach(x => x.classList.toggle("active", x===b));
    $("trend-q-note").style.display = trendQFilter === 4 ? "" : "none";
    if (charts.trend) { charts.trend.destroy(); charts.trend=null; }
    renderTrend();
  }));

  // Position search for trend tab
  const trendSearch = $("trend-pos-search");
  const trendResults = $("trend-pos-results");
  trendSearch.addEventListener("input", () => {
    const q = trendSearch.value.toLowerCase().trim();
    if (!q) { trendResults.style.display = "none"; return; }
    // Search titles that appear in at least 2 quarters
    const titleCounts = {};
    summary.quarters.forEach(qtr => (qtr.top_titles||[]).forEach(t => { titleCounts[t.title] = (titleCounts[t.title]||0)+1; }));
    const hits = Object.keys(titleCounts).filter(t => t.toLowerCase().includes(q) && titleCounts[t] >= 2).slice(0,8);
    if (!hits.length) { trendResults.style.display = "none"; return; }
    trendResults.style.display = "";
    trendResults.innerHTML = hits.map(t => `<div class="pos-row" data-title="${esc(t)}">${esc(t)}</div>`).join("");
    trendResults.querySelectorAll(".pos-row").forEach(row => row.addEventListener("click", () => {
      trendPosTitle = row.dataset.title;
      trendSearch.value = trendPosTitle;
      trendResults.style.display = "none";
      if (charts.trend) { charts.trend.destroy(); charts.trend=null; }
      renderTrend();
    }));
  });
  document.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => setSortKey(th.dataset.sort)));
  document.addEventListener("click", e => {
    const el = e.target.closest(".person-link");
    if (el) { e.stopPropagation(); showPerson(el.dataset.name, el.dataset.office); }
  });
  $("office-search").addEventListener("input", renderOfficeList);
  $("office-type-filter").addEventListener("change", renderOfficeList);
  $("office-sort").addEventListener("change", renderOfficeList);
  $("pos-search").addEventListener("input", e => renderPosResults(e.target.value));
  $("emp-search").addEventListener("input", applyFilters);
  $("emp-type").addEventListener("change", applyFilters);
  $("emp-office").addEventListener("change", applyFilters);
  loadData();
});
