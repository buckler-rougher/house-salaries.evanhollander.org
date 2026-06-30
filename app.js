/* House Staff Salaries — app.js */

const $ = id => document.getElementById(id);
const fmt   = n => n == null ? "—" : "$" + Math.round(n).toLocaleString();
const fmtK  = n => n == null ? "—" : "$" + Math.round(n / 1000) + "k";
const fmtSh = n => { if (n == null) return "—"; return n >= 1000 ? "$" + Math.round(n/1000) + "k" : "$" + Math.round(n); };

let summary = null, employees = [];
let trendMetric = "median", trendMode = "overall", trendPosTitle = null, trendQFilter = 0;
let sortKey = "annual_equiv", sortDir = -1, page = 1, filtered = [];
let peopleData = null, peopleLoading = false;
let viewQIdx = -1; // index into summary.quarters; -1 = latest
let currentSelection = null; // { type: "title"|"person", titleName, personName, personOffice }
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

function viewedQuarter() {
  const qs = summary.quarters;
  return viewQIdx < 0 ? qs[qs.length - 1] : qs[viewQIdx];
}

function renderStats() {
  const qs = summary.quarters;
  const q = viewedQuarter();
  if (!q) return;
  const isLatest = q === qs[qs.length - 1];
  const o = q.overall;
  $("stat-median").textContent  = o.median != null ? Math.round(o.median).toLocaleString() : "—";
  $("stat-mean").textContent    = o.mean   != null ? Math.round(o.mean).toLocaleString()   : "—";
  $("stat-count").textContent   = o.count  != null ? o.count.toLocaleString() : "—";
  $("stat-intern-note").textContent = `+ ${(q.intern_count||0).toLocaleString()} interns`;
  $("stat-quarter").textContent = q.label;
  $("stat-updated").textContent = summary.updated;

  const lbl = $("stat-quarter-label");
  if (lbl) lbl.textContent = isLatest ? "Latest quarter" : "Quarter";

  const idx = qs.indexOf(q);
  const prev = $("qnav-prev"), next = $("qnav-next");
  if (prev) prev.disabled = idx <= 0;
  if (next) { next.disabled = isLatest; next.classList.toggle("qnav-disabled", isLatest); }

  // Q4 bonus notice
  const notice = $("q4-notice");
  if (q.quarter === 4) {
    const prev2 = [...qs].reverse().find(x => x.quarter !== 4 && qs.indexOf(x) < idx);
    const prevNote = prev2 ? ` For comparison, the median in ${prev2.label} was $${Math.round(prev2.overall.median).toLocaleString()}.` : "";
    notice.textContent = `Q4 (Oct–Dec) includes year-end bonuses and lump-sum payments that can significantly inflate these figures.${prevNote}`;
    notice.style.display = "";
  } else {
    notice.style.display = "none";
  }
}

function isLatestQuarter() {
  return viewQIdx < 0 || viewQIdx === summary.quarters.length - 1;
}

function navigateQuarter(dir) {
  const qs = summary.quarters;
  const cur = viewQIdx < 0 ? qs.length - 1 : viewQIdx;
  const next = cur + dir;
  if (next < 0 || next >= qs.length) return;
  viewQIdx = next === qs.length - 1 ? -1 : next;
  renderStats();
  renderDist();
  buildTitles();
  renderPosResults($("pos-search")?.value || "");
  buildOfficeData();
  renderOfficeList();
  $("type-bars").innerHTML = ""; renderTypeBars();
  // Re-render trend highlight if trend tab is active
  const trendPane = $("tab-trend");
  if (trendPane && trendPane.classList.contains("active")) renderTrend();
  // All Staff: show note if historical
  const tableNote = $("table-quarter-note");
  if (tableNote) tableNote.style.display = isLatestQuarter() ? "none" : "";

  // Re-render whatever is open in the left panel
  if (currentSelection) {
    if (currentSelection.type === "title") {
      const t = titles.find(x => x.title === currentSelection.titleName);
      const activeRow = document.querySelector(`.pos-row.active`);
      if (t) selectTitle(t, activeRow);
    } else if (currentSelection.type === "person") {
      showPerson(currentSelection.personName, currentSelection.personOffice);
    }
  }
}

function renderDist() {
  const viewed = viewedQuarter();
  if (!viewed) return;
  const q = viewed;
  const distLabel = $("dist-pane-label");
  if (distLabel) distLabel.textContent = `Annual salary equivalent — full-time staff — ${q.label}`;
  const dist = q.distribution;
  const barColors = dist.map(b => {
    if (b.min < 50000)  return "#e8e5df";
    if (b.min < 80000)  return "#f4a69a";
    if (b.min < 130000) return "#c0392b";
    return "#8b1a12";
  });

  const W = 680, H = 280;
  const pad = { t: 16, r: 16, b: 48, l: 52 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;

  const counts = dist.map(b => b.count);
  const maxCount = Math.max(...counts) || 1;

  // Y axis: 5 ticks
  const yStep = Math.ceil(maxCount / 5 / 10) * 10 || 1;
  const yMax = yStep * 5;
  const sy = v => pad.t + ph - (v / yMax) * ph;

  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const v = i * yStep, y = sy(v);
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eeece8" stroke-width="1"/>
            <text x="${(pad.l - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">${v.toLocaleString()}</text>`;
  }).join("");

  const barW = pw / dist.length;
  const barGap = Math.max(1, barW * 0.12);

  const bars = dist.map((b, i) => {
    const bh = (b.count / yMax) * ph;
    const x = pad.l + i * barW + barGap / 2;
    const w = barW - barGap;
    const y = pad.t + ph - bh;
    const label = b.max == null ? `$${b.min/1000}k+` : `$${b.min/1000}k – $${b.max/1000}k`;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}"
      fill="${barColors[i]}" rx="2"
      data-label="${label}" data-count="${b.count}"
      style="--i:${i};transform-origin:${(x + w/2).toFixed(1)}px ${(pad.t + ph).toFixed(1)}px;
        animation:barGrow 400ms ease-out both;animation-delay:calc(var(--i)*30ms)"
      class="dist-bar"/>`;
  }).join("");

  // X axis labels — every other if tight; rotated -45° anchored at bottom of each bar
  const tight = dist.length > 10;
  const xLabels = dist.map((b, i) => {
    if (tight && i % 2 !== 0) return "";
    const lbl = b.max == null ? `$${b.min/1000}k+` : `$${b.min/1000}k`;
    const cx = pad.l + (i + 0.5) * barW;
    const ty = pad.t + ph + 6; // just below the plot area
    return `<text text-anchor="end" font-size="10" fill="#888"
      transform="translate(${cx.toFixed(1)},${ty.toFixed(1)}) rotate(-45)">${lbl}</text>`;
  }).join("");

  const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
    ${yTicks}${bars}${xLabels}
  </svg>`;

  const wrap = $("chart-dist");
  wrap.innerHTML = svg;

  // Tooltip
  ensureTooltip();
  wrap.querySelectorAll(".dist-bar").forEach(rect => {
    rect.style.cursor = "pointer";
    rect.addEventListener("mouseover", e => {
      const tt = $("chart-tooltip");
      tt.innerHTML = `<strong>${rect.dataset.label}</strong><br>${Number(rect.dataset.count).toLocaleString()} employees`;
      tt.style.display = "block";
    });
    rect.addEventListener("mousemove", e => positionTooltip(e));
    rect.addEventListener("mouseout", () => { $("chart-tooltip").style.display = "none"; });
  });
}

function renderTypeBars() {
  const q = viewedQuarter();
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
  $("trend-empty").style.display = "none";
  $("chart-trend").style.display = "";
  const qs = filteredQuarters(trendQFilter);
  const labels = qs.map(q => q.label);
  const hlLabel = isLatestQuarter() ? null : viewedQuarter().label;
  const hlOpts = { highlightLabel: hlLabel };

  if (trendMode === "overall") {
    drawSvgLineChart($("chart-trend"), labels, [{
      label: METRIC_LABELS[trendMetric], data: qs.map(q => q.overall[trendMetric]),
      color: "#c0392b", fill: true,
    }], hlOpts);

  } else if (trendMode === "type") {
    const datasets = ["member","committee","leadership","administrative"].map(type => ({
      label: TYPE_LABELS[type],
      data: qs.map(q => q.by_type[type]?.[trendMetric] ?? null),
      color: TYPE_COLORS_TREND[type], fill: false,
    }));
    drawSvgLineChart($("chart-trend"), labels, datasets, { legend: true, ...hlOpts });

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
    drawSvgLineChart($("chart-trend"), labels, [{
      label: "", data, color: "#c0392b", fill: true,
    }], hlOpts);
  }
}

// ── Position lookup ──
let titles = [];

function buildTitles() {
  if (isLatestQuarter()) {
    // Compute from full employee list (covers every title, any count)
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
  } else {
    // Use pre-aggregated top_titles from that quarter's summary
    titles = (viewedQuarter().top_titles || []).slice();
  }
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
  currentSelection = { type: "title", titleName: t.title };
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

// ── Person modal ──
function closePersonModal() {
  const overlay = $("person-modal-overlay");
  if (overlay) overlay.style.display = "none";
  currentSelection = null;
  setHash({});
}

async function showPerson(name, officeName) {
  currentSelection = { type: "person", personName: name, personOffice: officeName };
  setHash({ person: name + "|" + officeName });

  const overlay = $("person-modal-overlay");
  const body = $("person-modal-body");
  overlay.style.display = "flex";
  body.innerHTML = `<div style="padding:24px 0;color:var(--ink3);font-size:.85rem">Loading…</div>`;

  await loadPeople();

  const person = peopleData?.find(p => p.name === name && p.office === officeName);
  const latestEmp = employees.find(e => e.name === name && cleanOrg(e.office) === officeName);
  const over = latestEmp && latestEmp.annual_equiv > SALARY_CAP;

  // Year-over-year same-quarter stat
  let yoyHtml = "";
  if (person && person.history.length >= 2) {
    const hist = [...person.history].sort((a, b) => a.quarter.localeCompare(b.quarter));
    // Find most recent quarter and look for same quarter one year prior
    const latest = hist[hist.length - 1];
    const [latestYear, latestQ] = latest.quarter.split("Q");
    const priorId = `${+latestYear - 1}Q${latestQ}`;
    const prior = hist.find(h => h.quarter === priorId);
    if (prior) {
      const latestAnn = latest.quarterly_pay * 4, priorAnn = prior.quarterly_pay * 4;
      const diff = latestAnn - priorAnn;
      const pct = Math.round((diff / priorAnn) * 100);
      const labelMap = {};
      summary.quarters.forEach(q => labelMap[q.id] = q.label);
      const sign = diff >= 0 ? "+" : "−";
      const color = diff >= 0 ? "#059669" : "#dc2626";
      yoyHtml = `<div class="person-modal-yoy">
        <span style="color:${color};font-weight:700">${sign}${fmtK(Math.abs(diff))} (${sign}${Math.abs(pct)}%)</span>
        <span class="person-modal-yoy-label">vs. ${labelMap[priorId] || priorId} · same quarter last year</span>
      </div>`;
    }
  }

  // Pay history chart
  let chartHtml = "", qFilterHtml = "";
  if (person) {
    qFilterHtml = `<div class="mini-ctrl-row" style="margin-bottom:8px">
      <div class="mini-pills">
        <button class="mini-q active" data-q="0">All</button>
        <button class="mini-q" data-q="1">Q1</button>
        <button class="mini-q" data-q="2">Q2</button>
        <button class="mini-q" data-q="3">Q3</button>
        <button class="mini-q" data-q="4">Q4</button>
      </div>
    </div>`;
    chartHtml = `<div class="person-modal-section">Pay history · annual equivalent</div>${qFilterHtml}<div class="person-modal-chart" id="person-modal-chart"></div>`;
  } else {
    chartHtml = `<div style="font-size:.82rem;color:var(--ink3);margin:16px 0">No multi-quarter history — this person may have joined recently or changed offices.</div>`;
  }

  // Comparison section
  const allTitles = summary.quarters[summary.quarters.length - 1]?.top_titles || [];
  const compTitle = latestEmp?.title || person?.title || "";
  const compHtml = latestEmp ? `
    <div class="person-modal-section">
      Compare to: <span id="pm-comp-title" class="person-comp-title-link">${esc(compTitle)}</span>
    </div>
    <div style="position:relative;display:none" id="pm-comp-wrap">
      <input id="pm-comp-search" class="t-input" placeholder="Search a title…" autocomplete="off"
        style="font-size:.78rem;padding:5px 8px;width:100%;box-sizing:border-box;margin:0 0 6px" />
      <div id="pm-comp-results" class="pos-results"
        style="position:absolute;z-index:10;background:var(--bg);border:1.5px solid var(--line);border-radius:8px;width:100%;display:none;max-height:180px;overflow-y:auto;top:36px"></div>
    </div>
    <div id="pm-comp-stats"></div>` : "";

  body.innerHTML = `
    <div class="person-modal-name">${esc(name)}</div>
    <div class="person-modal-meta">${esc(officeName)}${latestEmp ? ` · ${esc(latestEmp.title)}` : ""}</div>
    ${latestEmp ? `<div class="person-modal-salary">${over ? `<span class="cap-warn">⚠</span> ` : ""}${fmt(latestEmp.annual_equiv)}</div>
    <div class="person-modal-salary-sub">est. annual · latest quarter</div>` : ""}
    ${yoyHtml}
    ${chartHtml}
    ${compHtml}`;

  // Wire chart
  if (person) {
    const labelMap = {};
    summary.quarters.forEach(q => labelMap[q.id] = q.label);
    let qf = 0;
    function drawPersonChart() {
      const filtQs = summary.quarters.filter(q => !qf || q.quarter === qf);
      const data = filtQs.map(q => { const h = person.history.find(h => h.quarter === q.id); return h ? h.quarterly_pay * 4 : null; });
      const labels = filtQs.map(q => q.label);
      const el = $("person-modal-chart");
      if (el) el.innerHTML = svgSparkline(data, labels);
    }
    drawPersonChart();
    document.querySelectorAll("#person-modal-body .mini-q").forEach(b => {
      b.addEventListener("click", () => {
        qf = +b.dataset.q;
        document.querySelectorAll("#person-modal-body .mini-q").forEach(x => x.classList.toggle("active", x === b));
        drawPersonChart();
      });
    });
  }

  // Wire comparison
  if (latestEmp) {
    function renderCompStats(titleStr) {
      const ts = allTitles.find(t => t.title === titleStr);
      const el = $("pm-comp-stats");
      if (!el) return;
      if (!ts) { el.innerHTML = `<div style="font-size:.78rem;color:var(--ink3);padding:6px 0">No salary data for this title.</div>`; return; }
      const you = latestEmp.annual_equiv;
      const youRow = `<div class="person-modal-comp-row person-modal-comp-you"><span>${esc(name)}</span><span>${fmtK(you)}</span></div>`;
      const r25 = `<div class="person-modal-comp-row"><span>25th pct.</span><span>${fmtK(ts.p25)}</span></div>`;
      const rMed = `<div class="person-modal-comp-row"><span>Median</span><span>${fmtK(ts.median)}</span></div>`;
      const r75 = `<div class="person-modal-comp-row"><span>75th pct.</span><span>${fmtK(ts.p75)}</span></div>`;
      const rows = you < ts.p25
        ? [youRow, r25, rMed, r75]
        : you < ts.median
          ? [r25, youRow, rMed, r75]
          : you < ts.p75
            ? [r25, rMed, youRow, r75]
            : [r25, rMed, r75, youRow];
      el.innerHTML = rows.join("");
    }
    renderCompStats(compTitle);

    const titleEl = $("pm-comp-title"), wrap = $("pm-comp-wrap"), searchEl = $("pm-comp-search"), resultsEl = $("pm-comp-results");
    if (titleEl) {
      titleEl.addEventListener("click", () => {
        wrap.style.display = wrap.style.display === "none" ? "block" : "none";
        if (wrap.style.display === "block") { searchEl.value = ""; searchEl.focus(); }
      });
      searchEl.addEventListener("input", () => {
        const q = searchEl.value.toLowerCase().trim();
        if (!q) { resultsEl.style.display = "none"; return; }
        const hits = allTitles.filter(t => t.title.toLowerCase().includes(q)).slice(0, 10);
        resultsEl.innerHTML = hits.map(t => `<div class="pos-result-item" data-title="${esc(t.title)}">${esc(t.title)}<span style="float:right;color:var(--ink3);font-size:.75rem">${fmtK(t.median)}</span></div>`).join("");
        resultsEl.style.display = hits.length ? "block" : "none";
        resultsEl.querySelectorAll(".pos-result-item").forEach(row => {
          row.addEventListener("click", () => {
            titleEl.textContent = row.dataset.title;
            wrap.style.display = "none"; resultsEl.style.display = "none";
            renderCompStats(row.dataset.title);
          });
        });
      });
    }
  }
}

function clearPerson() {
  closePersonModal();
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
  if (isLatestQuarter()) {
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
  } else {
    // Use pre-aggregated top_offices from that quarter's summary
    officeData = (viewedQuarter().top_offices || []).map(o => ({
      name: o.name, type: o.type, count: o.count,
      min: o.min, max: o.max, median: o.median, p25: o.p25, p75: o.p75,
      totalAnnual: o.total_quarterly_pay != null ? o.total_quarterly_pay * 4 : null,
    }));
  }
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

function ensureTooltip() {
  if ($("chart-tooltip")) return;
  const tt = document.createElement("div");
  tt.id = "chart-tooltip";
  tt.style.cssText = "position:fixed;pointer-events:none;background:#111;color:#fff;font-size:.75rem;padding:8px 12px;border-radius:6px;z-index:1000;display:none;line-height:1.6;white-space:nowrap";
  document.body.appendChild(tt);
}

function positionTooltip(e) {
  const tt = $("chart-tooltip");
  if (!tt) return;
  let x = e.clientX + 14, y = e.clientY - 10;
  const tw = tt.offsetWidth, th = tt.offsetHeight;
  if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 14;
  if (y + th > window.innerHeight - 8) y = e.clientY - th - 10;
  tt.style.left = x + "px";
  tt.style.top = y + "px";
}

function drawSvgLineChart(containerEl, labels, datasets, opts = {}) {
  const { legend = false, highlightLabel = null } = opts;
  const W = 680, H = 300;
  const pad = { t: 16, r: 16, b: 52, l: 58 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const n = labels.length;

  // Gather all valid values for Y range
  const allVals = datasets.flatMap(ds => ds.data.filter(v => v != null));
  if (!allVals.length) { containerEl.innerHTML = `<p style="padding:20px;color:#888;font-size:.85rem">No data.</p>`; return; }

  const minV = Math.min(...allVals), maxV = Math.max(...allVals);
  const vPad = (maxV - minV) * 0.1 || maxV * 0.1 || 1;
  const yMin = Math.max(0, minV - vPad), yMax = maxV + vPad;
  const vRange = yMax - yMin || 1;

  const sx = i => pad.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
  const sy = v => pad.t + ph - ((v - yMin) / vRange) * ph;

  // Y ticks
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + (vRange * i / 4), y = sy(v);
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eeece8" stroke-width="1"/>
            <text x="${(pad.l - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">$${(v/1000).toFixed(0)}k</text>`;
  }).join("");

  // X labels
  const rotateX = n > 6;
  const xLabels = labels.map((lb, i) => {
    const x = sx(i);
    if (rotateX) {
      const ty = pad.t + ph + 6;
      return `<text text-anchor="end" font-size="10" fill="#888"
        transform="translate(${x.toFixed(1)},${ty.toFixed(1)}) rotate(-45)">${lb}</text>`;
    }
    return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#888">${lb}</text>`;
  }).join("");

  // Per-dataset paths
  const pathEls = datasets.map(ds => {
    const color = ds.color;
    // Segment into runs of non-null
    const segs = [];
    let cur = [];
    ds.data.forEach((v, i) => {
      if (v != null) cur.push([i, v]);
      else if (cur.length) { segs.push(cur); cur = []; }
    });
    if (cur.length) segs.push(cur);

    const fills = (ds.fill && segs.length) ? segs.map(s => {
      if (s.length < 2) return "";
      const d = s.map(([i, v], j) => `${j ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");
      const last = s[s.length - 1], first = s[0];
      return `<path d="${d} L${sx(last[0]).toFixed(1)},${(pad.t + ph).toFixed(1)} L${sx(first[0]).toFixed(1)},${(pad.t + ph).toFixed(1)} Z" fill="${color}" opacity=".07" stroke="none"/>`;
    }).join("") : "";

    const lines = segs.map(s => {
      const d = s.map(([i, v], j) => `${j ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" class="trend-line"/>`;
    }).join("");

    const dots = ds.data.map((v, i) => {
      if (v == null) return "";
      return `<circle cx="${sx(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="4" fill="white" stroke="${color}" stroke-width="2"
        class="trend-dot" data-i="${i}" data-val="${v}" data-label="${esc(ds.label || "")}"
        style="animation:fadeIn 300ms ease-out both;animation-delay:400ms;opacity:0"/>`;
    }).join("");

    return fills + lines + dots;
  }).join("");

  // Viewed-quarter highlight line
  const hlIdx = highlightLabel != null ? labels.indexOf(highlightLabel) : -1;
  const hlLine = hlIdx >= 0 ? (() => {
    const x = sx(hlIdx).toFixed(1);
    return `<line x1="${x}" x2="${x}" y1="${pad.t}" y2="${pad.t + ph}" stroke="#c0392b" stroke-width="1.5" stroke-dasharray="4 3" opacity=".5"/>
            <text x="${x}" y="${(pad.t - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#c0392b" opacity=".8">${labels[hlIdx]}</text>`;
  })() : "";

  const svgStr = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
    ${yTicks}${hlLine}${pathEls}${xLabels}
  </svg>`;

  containerEl.innerHTML = svgStr;

  // Animate lines via stroke-dashoffset
  containerEl.querySelectorAll(".trend-line").forEach(path => {
    const len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    path.style.transition = "stroke-dashoffset 500ms ease-out";
    requestAnimationFrame(() => requestAnimationFrame(() => { path.style.strokeDashoffset = "0"; }));
  });

  // Tooltip on dots
  ensureTooltip();
  // Group dots by x-index for multi-series tooltips
  const dotsByIndex = {};
  containerEl.querySelectorAll(".trend-dot").forEach(dot => {
    const i = dot.dataset.i;
    if (!dotsByIndex[i]) dotsByIndex[i] = [];
    dotsByIndex[i].push(dot);
  });
  Object.entries(dotsByIndex).forEach(([i, dots]) => {
    const hoverRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const cx = sx(+i);
    hoverRect.setAttribute("x", (cx - 12).toFixed(1));
    hoverRect.setAttribute("y", pad.t);
    hoverRect.setAttribute("width", "24");
    hoverRect.setAttribute("height", ph);
    hoverRect.setAttribute("fill", "transparent");
    hoverRect.style.cursor = "crosshair";
    containerEl.querySelector("svg").appendChild(hoverRect);
    hoverRect.addEventListener("mouseover", e => {
      const tt = $("chart-tooltip");
      const lbl = labels[+i];
      const lines = datasets.map(ds => {
        const v = ds.data[+i];
        const prefix = ds.label ? `${ds.label}: ` : "";
        return `${prefix}${v != null ? fmt(v) : "—"}`;
      });
      tt.innerHTML = `<strong>${lbl}</strong><br>${lines.join("<br>")}`;
      tt.style.display = "block";
      positionTooltip(e);
    });
    hoverRect.addEventListener("mousemove", positionTooltip);
    hoverRect.addEventListener("mouseout", () => { $("chart-tooltip").style.display = "none"; });
  });

  // Legend
  const legendEl = containerEl.querySelector(".trend-legend");
  if (legendEl) legendEl.remove();
  if (legend && datasets.length > 1) {
    const leg = document.createElement("div");
    leg.className = "trend-legend";
    leg.style.cssText = "display:flex;flex-wrap:wrap;gap:12px 20px;margin-top:10px;font-size:.75rem;color:#444";
    leg.innerHTML = datasets.map(ds =>
      `<span style="display:flex;align-items:center;gap:5px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${ds.color}"></span>
        ${esc(ds.label)}
      </span>`
    ).join("");
    containerEl.after(leg);
  }
}

function linReg(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  return { slope, intercept };
}

function svgSparkline(data, labels) {
  const W = 560, H = 200;
  const pad = { t: 22, r: 16, b: 48, l: 54 };
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

  // Trend line + annotation (need ≥3 valid points)
  let trendEl = "", annotEl = "";
  if (valid.length >= 3) {
    const { slope, intercept } = linReg(valid.map(d => d.i), valid.map(d => d.v));
    const x0 = valid[0].i, x1 = valid[valid.length - 1].i;
    const ty0 = sy(slope * x0 + intercept), ty1 = sy(slope * x1 + intercept);
    trendEl = `<line x1="${sx(x0).toFixed(1)}" y1="${ty0.toFixed(1)}" x2="${sx(x1).toFixed(1)}" y2="${ty1.toFixed(1)}"
      stroke="#6b7280" stroke-width="1.2" stroke-dasharray="4 3" opacity=".7"/>`;
    // slope is per quarter index step; annualise × 4
    const annualSlope = slope * 4;
    const sign = annualSlope >= 0 ? "+" : "−";
    const abs = Math.abs(annualSlope);
    const label = `${sign}$${abs >= 1000 ? (abs/1000).toFixed(1)+"k" : Math.round(abs)} / yr trend`;
    annotEl = `<text x="${(W - pad.r).toFixed(1)}" y="14" text-anchor="end" font-size="11" fill="#6b7280">${label}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">${yTicks}${fills}${lines}${trendEl}${dots}${xLabels}${annotEl}</svg>`;
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
  const trendWrapId = "mini-office-" + officeName.replace(/[^a-z0-9]/gi, "_");
  const hasTrend = summary.quarters.some(q => (q.top_offices || []).find(o => o.name === officeName));

  if (isLatestQuarter()) {
    const staff = employees.filter(e => !e.intern && cleanOrg(e.office) === officeName)
      .sort((a,b) => b.annual_equiv - a.annual_equiv);
    if (!staff.length) { el.innerHTML = `<div class="office-detail-empty">No staff data.</div>`; return; }
    const amts = staff.map(e => e.annual_equiv).sort((a,b)=>a-b);
    const p = pct => { const i=(amts.length-1)*pct/100,lo=Math.floor(i),hi=Math.min(lo+1,amts.length-1); return amts[lo]+(amts[hi]-amts[lo])*(i-lo); };
    const median = Math.round(p(50)), p25 = Math.round(p(25)), p75 = Math.round(p(75));
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
  } else {
    // Historical quarter: use top_offices aggregate stats, no individual staff list
    const qData = viewedQuarter();
    const o = (qData.top_offices || []).find(o => o.name === officeName);
    if (!o) { el.innerHTML = `<div class="office-detail-empty">No data for this quarter.</div>`; return; }
    el.innerHTML = `
      <div class="office-detail-stats">
        <div class="office-detail-stat"><div class="office-detail-val">${fmtK(o.p25)}</div><div class="office-detail-key">25th pct.</div></div>
        <div class="office-detail-stat"><div class="office-detail-val">${fmtK(o.median)}</div><div class="office-detail-key">Median</div></div>
        <div class="office-detail-stat"><div class="office-detail-val">${fmtK(o.p75)}</div><div class="office-detail-key">75th pct.</div></div>
      </div>
      ${o.total_quarterly_pay ? `<div class="office-total-payroll">Est. annual payroll: <strong>${fmt(o.total_quarterly_pay * 4)}</strong> across ${o.count} staff</div>` : ""}
      ${hasTrend ? miniTrendHtml(trendWrapId, "Salary trend") : ""}
      <div class="office-detail-empty" style="font-size:.75rem;margin-top:8px">Individual staff data only available for the latest quarter.</div>`;
  }
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
  $("qnav-prev").addEventListener("click", () => navigateQuarter(-1));
  $("qnav-next").addEventListener("click", () => navigateQuarter(1));
  startPlaceholderCycle();
}

function startPlaceholderCycle() {
  const input = $("pos-search");
  const overlay = $("pos-placeholder");
  const word = $("pos-placeholder-word");
  if (!input || !overlay || !word) return;

  // Pull titles from data; shuffle so it's not alphabetical
  const pool = (summary.quarters[summary.quarters.length - 1]?.top_titles || [])
    .map(t => t.title)
    .sort(() => Math.random() - .5);
  if (pool.length < 2) return;

  let idx = 0;
  let paused = false;
  let timer;

  function showHide() {
    overlay.classList.toggle("pos-placeholder-hidden", input.value.length > 0);
  }
  input.addEventListener("focus", () => { paused = true; showHide(); });
  input.addEventListener("blur",  () => { paused = false; showHide(); });
  input.addEventListener("input", showHide);

  function cycle() {
    if (paused || input.value.length > 0) { timer = setTimeout(cycle, 3000); return; }
    idx = (idx + 1) % pool.length;
    // slide old out
    word.classList.remove("ph-in");
    word.classList.add("ph-out");
    setTimeout(() => {
      word.textContent = pool[idx] + "…";
      word.classList.remove("ph-out");
      word.classList.add("ph-in");
    }, 350);
    timer = setTimeout(cycle, 3000);
  }

  word.textContent = pool[idx] + "…";
  timer = setTimeout(cycle, 3000);
}

document.addEventListener("DOMContentLoaded", () => {
  const fy = $("footer-year"); if (fy) fy.textContent = new Date().getFullYear();

  // Person modal close
  $("person-modal-close")?.addEventListener("click", closePersonModal);
  $("person-modal-overlay")?.addEventListener("click", e => {
    if (e.target === $("person-modal-overlay")) closePersonModal();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && $("person-modal-overlay")?.style.display !== "none") closePersonModal();
  });
  document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
    const tab = b.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(x => x.classList.toggle("active", x===b));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id==="tab-"+tab));
    if (tab==="type" && !$("office-list").children.length) renderOfficeList();
    if (tab==="typebars" && !$("type-bars").children.length) renderTypeBars();
    if (tab==="trend") { renderTrend(); }
  }));
  document.querySelectorAll(".trend-mode").forEach(b => b.addEventListener("click", () => {
    trendMode = b.dataset.mode;
    document.querySelectorAll(".trend-mode").forEach(x => x.classList.toggle("active", x===b));
    $("trend-overall-ctrl").style.display = trendMode === "overall" ? "" : "none";
    $("trend-pos-ctrl").style.display = trendMode === "position" ? "" : "none";
    renderTrend();
  }));
  document.querySelectorAll(".pill").forEach(p => p.addEventListener("click", () => {
    trendMetric = p.dataset.metric;
    document.querySelectorAll(".pill").forEach(x => x.classList.toggle("active", x===p));
    renderTrend();
  }));
  document.querySelectorAll(".trend-q").forEach(b => b.addEventListener("click", () => {
    trendQFilter = +b.dataset.q;
    document.querySelectorAll(".trend-q").forEach(x => x.classList.toggle("active", x===b));
    $("trend-q-note").style.display = trendQFilter === 4 ? "" : "none";
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
