/* House Staff Salaries — app.js */

const $ = id => document.getElementById(id);
const fmt   = n => n == null ? "—" : "$" + Math.round(n).toLocaleString();
const fmtK  = n => n == null ? "—" : "$" + Math.round(n / 1000) + "k";
const fmtSh = n => { if (n == null) return "—"; return n >= 1000 ? "$" + Math.round(n/1000) + "k" : "$" + Math.round(n); };

let summary = null, employees = [];
let trendMetric = "median", trendMode = "overall", trendPosTitle = null, trendQFilter = 0;
let sortKey = "annual_equiv", sortDir = -1, page = 1, filtered = [];
let peopleData = null, peopleLoading = false;
let historicalEmployeesCache = {}; // quarter id -> synthesized employee rows, built from peopleData
let viewQIdx = -1; // index into summary.quarters; -1 = latest
let officeTypeFilter = ""; // "" = all types, else "member"|"committee"|"leadership"|"administrative"
let inflationOn = false; // when true, historical dollar figures are scaled to the latest quarter's dollars
let currentSelection = null; // { type: "title"|"person", titleName, personName, personOffice }
const PAGE = 25;

const SALARY_CAP = 228000;
const TYPE_LABELS = { member:"Member", committee:"Committee", leadership:"Leadership", administrative:"Admin" };
const TYPE_COLORS = { member:"#2563eb", committee:"#059669", leadership:"#b45309", administrative:"#6b7280" };

async function loadData() {
  try {
    const [sr, er] = await Promise.all([fetch("data/summary.json", { cache: "no-cache" }), fetch("data/employees.json", { cache: "no-cache" })]);
    if (!sr.ok) throw new Error("Run scripts/fetch_sod.py to generate data.");
    summary = await sr.json();
    if (er.ok) { const d = await er.json(); employees = d.employees || []; }

    // Apply the persisted quarter/office-type filter before the very first
    // render, not after — otherwise render() draws the "All types" chart,
    // restoreState() immediately re-renders with the real filter, and every
    // chart's first-load entrance gets replaced by a morph from a state the
    // user never actually saw.
    try {
      const saved = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
      if (saved) {
        if (typeof saved.viewQIdx === "number" && saved.viewQIdx >= 0 && saved.viewQIdx < summary.quarters.length - 1) {
          viewQIdx = saved.viewQIdx;
        }
        officeTypeFilter = saved.officeTypeFilter || "";
        document.querySelectorAll(".type-filter-btn[data-type]").forEach(b => b.classList.toggle("active", (b.dataset.type || "") === officeTypeFilter));
        inflationOn = !!saved.inflationOn;
        $("inflation-toggle")?.setAttribute("aria-pressed", inflationOn ? "true" : "false");
      }
    } catch(e) { /* ignore */ }

    render();
    updateInflationNote();
    await restoreState();
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

function statsFor(q) {
  const aq = adjQuarter(q);
  return officeTypeFilter ? (aq.by_type[officeTypeFilter] || { median: null, mean: null, count: 0 }) : aq.overall;
}

// CPI ratio to scale a quarter's nominal dollars into the latest quarter's
// dollars — always 1 for the latest quarter itself (the base), and 1
// whenever the toggle is off or CPI data is missing for either quarter.
function cpiFactorForQuarter(q) {
  if (!inflationOn || !q) return 1;
  const latest = summary.quarters[summary.quarters.length - 1];
  if (!q.cpi || !latest.cpi) return 1;
  return latest.cpi / q.cpi;
}
function cpiFactorForId(qId) {
  return cpiFactorForQuarter(summary.quarters.find(q => q.id === qId));
}

const MONEY_FIELDS = ["median","mean","p10","p25","p75","p90","min","max","total_quarterly_pay"];
function scaleAgg(obj, f) {
  if (!obj || f === 1) return obj;
  const out = { ...obj };
  MONEY_FIELDS.forEach(k => { if (out[k] != null) out[k] = out[k] * f; });
  return out;
}

// Returns a quarter object with every pre-aggregated monetary field (overall,
// by_type, top_offices, top_titles, distribution bucket edges) scaled to the
// latest quarter's dollars when the inflation toggle is on. Bucket *counts*
// are untouched — we don't have raw per-employee data for historical
// quarters to re-bin people, so we relabel the bucket edges instead, which
// is exactly equivalent (these are still the same people, just described in
// today's dollars). Raw per-employee arrays (only ever used for the latest
// quarter, whose factor is always 1) are left alone.
function adjQuarter(q) {
  const f = cpiFactorForQuarter(q);
  if (f === 1) return q;
  return {
    ...q,
    overall: scaleAgg(q.overall, f),
    by_type: q.by_type ? Object.fromEntries(Object.entries(q.by_type).map(([k, v]) => [k, scaleAgg(v, f)])) : q.by_type,
    top_offices: (q.top_offices || []).map(o => scaleAgg(o, f)),
    top_titles: (q.top_titles || []).map(t => scaleAgg(t, f)),
    distribution: (q.distribution || []).map(b => ({ ...b, min: b.min * f, max: b.max != null ? b.max * f : null })),
  };
}

// Scrolls a number element's displayed text from its current value to `to`,
// the same tween used for the trend chart's points — same easing, same idea.
function animateNumberText(el, to, fmt = (v => Math.round(v).toLocaleString())) {
  if (!el) return;
  if (to == null) { el.textContent = "—"; return; }
  const from = parseFloat((el.textContent || "").replace(/[^0-9.-]/g, ""));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !isFinite(from)) { el.textContent = fmt(to); return; }
  if (from === to) { el.textContent = fmt(to); return; }

  const gen = (parseInt(el.dataset.numGen || "0", 10) + 1).toString();
  el.dataset.numGen = gen;
  const duration = 500;
  const start = performance.now();
  const easeCubic = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const step = now => {
    if (el.dataset.numGen !== gen) return; // superseded by a newer render
    const t = Math.min(1, (now - start) / duration);
    el.textContent = fmt(from + (to - from) * easeCubic(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStats() {
  const qs = summary.quarters;
  const q = viewedQuarter();
  if (!q) return;
  const isLatest = q === qs[qs.length - 1];
  const o = statsFor(q);
  animateNumberText($("stat-median"), o.median);
  animateNumberText($("stat-mean"), o.mean);
  animateNumberText($("stat-count"), o.count);
  // Interns aren't broken out by office type, so that count is only meaningful unfiltered
  $("stat-intern-note").textContent = officeTypeFilter ? "" : `+ ${(q.intern_count||0).toLocaleString()} interns`;
  $("stat-quarter").innerHTML = esc(q.label).replace(/–/g, '<span class="quarter-text-sep">–</span>');
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
    const prevMedian = prev2 ? statsFor(prev2).median : null;
    const prevNote = prevMedian != null ? ` For comparison, the median in ${prev2.label} was $${Math.round(prevMedian).toLocaleString()}.` : "";
    notice.textContent = `Q4 (Oct–Dec) includes year-end bonuses and lump-sum payments that can significantly inflate these figures.${prevNote}`;
    notice.style.display = "";
  } else {
    notice.style.display = "none";
  }
}

function isLatestQuarter() {
  return viewQIdx < 0 || viewQIdx === summary.quarters.length - 1;
}

async function navigateQuarter(dir) {
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

  // All Staff: for historical quarters, synthesize rows from each person's
  // history (only staff active 3+ quarters are tracked there, so some are missing)
  const tableNote = $("table-quarter-note");
  if (tableNote) tableNote.style.display = isLatestQuarter() ? "none" : "";
  if (!isLatestQuarter()) await loadPeople();
  applyFilters();

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
  saveState();
}

async function setOfficeTypeFilter(type) {
  officeTypeFilter = type;
  document.querySelectorAll(".type-filter-btn[data-type]").forEach(b => b.classList.toggle("active", (b.dataset.type || "") === type));

  renderStats();
  renderDist();
  buildTitles();
  renderPosResults($("pos-search")?.value || "");
  buildOfficeData();
  renderOfficeList();
  $("type-bars").innerHTML = ""; renderTypeBars();
  if (!isLatestQuarter()) await loadPeople();
  applyFilters();
  renderTrend();

  // Re-render whatever is open in the left panel
  if (currentSelection) {
    if (currentSelection.type === "title") {
      const t = titles.find(x => x.title === currentSelection.titleName);
      const activeRow = document.querySelector(`.pos-row.active`);
      if (t) selectTitle(t, activeRow); else clearTitle();
    } else if (currentSelection.type === "person") {
      showPerson(currentSelection.personName, currentSelection.personOffice);
    }
  }
  saveState();
}

async function setInflationOn(on) {
  inflationOn = on;
  const btn = $("inflation-toggle");
  if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
  updateInflationNote();

  renderStats();
  renderDist();
  buildTitles();
  renderPosResults($("pos-search")?.value || "");
  buildOfficeData();
  renderOfficeList();
  if (!isLatestQuarter()) await loadPeople();
  applyFilters();
  renderTrend();

  // Re-render whatever is open in the left panel
  if (currentSelection) {
    if (currentSelection.type === "title") {
      const t = titles.find(x => x.title === currentSelection.titleName);
      const activeRow = document.querySelector(`.pos-row.active`);
      if (t) selectTitle(t, activeRow); else clearTitle();
    } else if (currentSelection.type === "person") {
      showPerson(currentSelection.personName, currentSelection.personOffice);
    }
  }
  saveState();
}

function updateInflationNote() {
  const note = $("inflation-note");
  if (!note) return;
  if (!inflationOn) { note.textContent = ""; return; }
  const latest = summary.quarters[summary.quarters.length - 1];
  note.textContent = `in ${latest.label} dollars`;
}

function computeDistributionBuckets(amounts, bucketSize = 10000, maxVal = 250000) {
  const buckets = [];
  for (let lo = 0; lo < maxVal; lo += bucketSize) {
    const hi = lo + bucketSize;
    buckets.push({ min: lo, max: hi, count: amounts.filter(a => a >= lo && a < hi).length });
  }
  // Always include the overflow bucket, even at 0, so the bar count/width and
  // x-axis stay the same shape across office types (some, like Leadership,
  // have nobody above $250k, which used to shift their whole axis).
  buckets.push({ min: maxVal, max: null, count: amounts.filter(a => a >= maxVal).length });
  return buckets;
}

let lastDistYStep = null; // previous y-axis step, so tick labels can scroll instead of snap
let lastDistBarState = null; // previous bars' rendered y/height/fill, so they can morph instead of re-growing

function renderDist() {
  const viewed = adjQuarter(viewedQuarter());
  if (!viewed) return;
  const q = viewed;
  const distLabel = $("dist-pane-label");
  const typeLabel = officeTypeFilter ? ` — ${TYPE_LABELS[officeTypeFilter]} offices` : "";
  if (distLabel) distLabel.textContent = `Annual salary equivalent — full-time staff${typeLabel} — ${q.label}`;

  const distNote = $("dist-type-note");
  const canFilterHere = !officeTypeFilter || isLatestQuarter();
  if (distNote) distNote.style.display = canFilterHere ? "none" : "";

  const dist = (officeTypeFilter && isLatestQuarter())
    ? computeDistributionBuckets(employees.filter(e => !e.intern && !e.shared && e.type === officeTypeFilter && e.annual_equiv != null).map(e => e.annual_equiv))
    : q.distribution;
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
  const fromYStep = lastDistYStep;
  lastDistYStep = yStep;

  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const v = i * yStep, y = sy(v);
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eeece8" stroke-width="1"/>
            <text class="dist-ytick" data-i="${i}" x="${(pad.l - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">${v.toLocaleString()}</text>`;
  }).join("");

  const barW = pw / dist.length;
  const barGap = Math.max(1, barW * 0.12);

  // Whether the previous render had the same bar layout to morph from —
  // if so we tween each bar's y/height/fill in place instead of replaying
  // the grow-from-zero entrance, so switching office type just nudges bar
  // heights rather than re-animating the whole chart.
  const canMorphBars = lastDistBarState && lastDistBarState.length === dist.length;

  const barTargets = dist.map((b, i) => {
    const bh = (b.count / yMax) * ph;
    const x = pad.l + i * barW + barGap / 2;
    const w = barW - barGap;
    const y = pad.t + ph - bh;
    return { x, w, y, h: bh, fill: barColors[i] };
  });

  const bars = dist.map((b, i) => {
    const t = barTargets[i];
    const label = b.max == null ? `$${Math.round(b.min/1000)}k+` : `$${Math.round(b.min/1000)}k – $${Math.round(b.max/1000)}k`;
    const startStyle = canMorphBars
      ? ""
      : `style="--i:${i};transform-origin:${(t.x + t.w/2).toFixed(1)}px ${(pad.t + ph).toFixed(1)}px;
          animation:barGrow 400ms ease-out both;animation-delay:calc(var(--i)*30ms)"`;
    return `<rect x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" width="${t.w.toFixed(1)}" height="${t.h.toFixed(1)}"
      fill="${t.fill}" rx="2" data-i="${i}"
      data-label="${label}" data-count="${b.count}"
      ${startStyle}
      class="dist-bar"/>`;
  }).join("");

  // X axis labels — every other if tight; rotated -45° anchored at bottom of each bar
  const tight = dist.length > 10;
  const xLabels = dist.map((b, i) => {
    if (tight && i % 2 !== 0) return "";
    const lbl = b.max == null ? `$${Math.round(b.min/1000)}k+` : `$${Math.round(b.min/1000)}k`;
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

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Morph existing bars into their new heights/colors instead of replaying
  // the grow-in — e.g. switching office type should just nudge each bar,
  // not re-animate the whole chart from zero.
  if (canMorphBars && !reduceMotion) {
    const barEls = [...wrap.querySelectorAll(".dist-bar")];
    barEls.forEach((el, i) => {
      const prev = lastDistBarState[i];
      el.style.transition = "none";
      el.setAttribute("y", prev.y.toFixed(1));
      el.setAttribute("height", prev.h.toFixed(1));
      el.setAttribute("fill", prev.fill);
    });
    void wrap.offsetWidth; // force reflow so the "from" state paints before transitioning
    requestAnimationFrame(() => {
      barEls.forEach((el, i) => {
        const t = barTargets[i];
        el.style.transition = "height 450ms cubic-bezier(.4,0,.2,1), y 450ms cubic-bezier(.4,0,.2,1), fill 300ms ease";
        el.setAttribute("y", t.y.toFixed(1));
        el.setAttribute("height", t.h.toFixed(1));
        el.setAttribute("fill", t.fill);
      });
    });
  }
  lastDistBarState = barTargets;

  // Scroll the y-axis tick labels from their old values to the new ones,
  // same idea as the hero stats — gridlines sit at fixed positions, only the
  // number at each one changes.
  if (fromYStep != null && fromYStep !== yStep && !reduceMotion) {
    const gen = (parseInt(wrap.dataset.distGen || "0", 10) + 1).toString();
    wrap.dataset.distGen = gen;
    const tickEls = [...wrap.querySelectorAll(".dist-ytick")];
    const duration = 500;
    const start = performance.now();
    const easeCubic = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const step = now => {
      if (wrap.dataset.distGen !== gen) return;
      const t = Math.min(1, (now - start) / duration);
      const e = easeCubic(t);
      tickEls.forEach(el => {
        const i = +el.dataset.i;
        const fromV = i * fromYStep, toV = i * yStep;
        el.textContent = Math.round(fromV + (toV - fromV) * e).toLocaleString();
      });
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

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
  // This tab is for comparing types against each other, so it ignores the
  // global office-type filter on purpose — filtering it down to one type
  // would defeat the point.
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
  // Always compute against every quarter so a quarter-filter change can zoom
  // between "all quarters" and "just this subset" instead of a hard cut.
  const allQs = summary.quarters;
  const labels = allQs.map(q => q.label);
  const visible = allQs.map(q => !trendQFilter || q.quarter === trendQFilter);
  const hlLabel = isLatestQuarter() ? null : viewedQuarter().label;
  const hlOpts = { highlightLabel: hlLabel, visible };

  if (trendMode === "overall") {
    drawSvgLineChart($("chart-trend"), labels, [{
      id: "overall", label: METRIC_LABELS[trendMetric], color: "#c0392b", fill: true,
      data: allQs.map(q => { const aq = adjQuarter(q); return officeTypeFilter ? (aq.by_type[officeTypeFilter]?.[trendMetric] ?? null) : aq.overall[trendMetric]; }),
    }], hlOpts);

  } else if (trendMode === "type") {
    // Comparing types against each other on purpose, so this ignores the
    // global office-type filter and inflation adjustment — same reasoning
    // as the By Type tab (both are comparison views, not point-in-time reads).
    const datasets = ["member","committee","leadership","administrative"].map(type => ({
      id: type, label: TYPE_LABELS[type],
      data: allQs.map(q => q.by_type[type]?.[trendMetric] ?? null),
      color: TYPE_COLORS_TREND[type], fill: false,
    }));
    drawSvgLineChart($("chart-trend"), labels, datasets, { legend: true, ...hlOpts });

  } else if (trendMode === "position") {
    if (!trendPosTitle) {
      $("chart-trend").style.display = "none";
      $("trend-empty").style.display = "";
      return;
    }
    // top_titles isn't broken out by office type, so this trend always covers every type
    const data = allQs.map(q => {
      const t = (adjQuarter(q).top_titles || []).find(t => t.title === trendPosTitle);
      return t ? t[trendMetric] : null;
    });
    drawSvgLineChart($("chart-trend"), labels, [{
      id: "position", label: "", data, color: "#c0392b", fill: true,
    }], hlOpts);
  }

  const posTypeNote = $("trend-pos-type-note");
  if (posTypeNote) posTypeNote.style.display = (trendMode === "position" && officeTypeFilter) ? "" : "none";
}

// ── Position lookup ──
let titles = [];

function buildTitles() {
  if (isLatestQuarter()) {
    // Compute from full employee list (covers every title, any count)
    const groups = {};
    employees.filter(e => !e.intern && !e.shared && (!officeTypeFilter || e.type === officeTypeFilter)).forEach(e => {
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
    // Use pre-aggregated top_titles from that quarter's summary — not broken out
    // by office type, so a type filter can't narrow these down (yet).
    titles = (adjQuarter(viewedQuarter()).top_titles || []).slice();
  }
  const posTypeNote = $("pos-type-note");
  if (posTypeNote) posTypeNote.style.display = (officeTypeFilter && !isLatestQuarter()) ? "" : "none";
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

let preTitleTab = null; // tab that was active before a position replaced it, so clearTitle() can restore it

function selectTitle(t, el) {
  if (currentSelection?.type !== "title") {
    preTitleTab = document.querySelector(".tab-btn.active")?.dataset.tab || "dist";
  }
  currentSelection = { type: "title", titleName: t.title };
  document.querySelectorAll(".pos-row").forEach(r => r.classList.remove("active"));
  el?.classList.add("active");
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
  $("tab-position").classList.add("active");
  setHash({ pos: t.title });
  const max = Math.max(t.max||0, 220000), pct = v => Math.min(100, v/max*100);

  const staff = employees
    .filter(e => !e.intern && !e.shared && e.title === t.title && (!officeTypeFilter || e.type === officeTypeFilter))
    .sort((a,b) => b.annual_equiv - a.annual_equiv);

  const trendLabels = summary.quarters.map(q => q.label);
  const trendData = summary.quarters.map(q => {
    const found = (adjQuarter(q).top_titles || []).find(x => x.title === t.title);
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
          <span class="range-staff-office office-link" data-office="${esc(cleanOrg(e.office))}">${esc(cleanOrg(e.office))}</span>
          <span class="range-staff-amt">${over?`<span class="cap-warn" title="May include bonus/lump sum">⚠</span> `:""}${fmt(e.annual_equiv)}</span>
        </div>`;
      }).join("")}
      ${staff.length>30?`<div class="range-staff-more">+${staff.length-30} more</div>`:""}
    </div>` : "";

  $("position-view").innerHTML = `
    <div class="range-card">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div>
        <div class="range-card-title">${esc(t.title)}</div>
        <div class="range-card-sub">${t.count.toLocaleString()} employees${(officeTypeFilter && isLatestQuarter()) ? ` · ${TYPE_LABELS[officeTypeFilter]} offices` : ""} · latest quarter · annual equivalent</div>
      </div>
      <button onclick="clearTitle()" style="background:none;border:none;cursor:pointer;color:var(--ink3);font-size:1.1rem;line-height:1;padding:2px;flex-shrink:0;margin-top:2px">&times;</button>
    </div>
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
    ${staffHtml}
    </div>`;
  if (hasTrend) {
    const wrap = document.getElementById("mini-pos-trend-wrap");
    if (wrap) makeMiniTrend(wrap, (metric, qf) => {
      return filteredQuarters(qf).map(q => {
        const found = (adjQuarter(q).top_titles || []).find(x => x.title === t.title);
        return found ? found[metric] : null;
      });
    });
  }
  if (window.innerWidth <= 900) {
    $("tab-position").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ── Person modal ──
function closePersonDetail() {
  document.querySelectorAll(".emp-detail-row").forEach(row => row.style.display = "none");
  currentSelection = null;
  setHash({});
}

async function showPerson(name, officeName) {
  currentSelection = { type: "person", personName: name, personOffice: officeName };
  setHash({ person: name + "|" + officeName });

  // Switch to All Staff tab
  const tabBtn = document.querySelector('.tab-btn[data-tab="table"]');
  if (tabBtn && !tabBtn.classList.contains("active")) tabBtn.click();

  // Search for the person
  const searchEl = $("emp-search");
  if (searchEl) {
    searchEl.value = name;
    applyFilters();
  }

  // Show inline detail
  await showPersonInline(name, officeName);
}

// Toggles a person's detail row open/closed directly in place — used when
// clicking a name that's already visible in the All Staff table, so we don't
// touch the search box or switch tabs (mirrors how office rows expand).
function togglePersonInline(name, officeName) {
  const detailId = `emp-detail-${esc(name).replace(/\s+/g,"-").toLowerCase()}`;
  const detail = $(detailId);
  const row = detail ? detail.closest(".emp-detail-row") : null;
  const wasOpen = row && row.style.display !== "none";
  document.querySelectorAll(".emp-detail-row").forEach(r => r.style.display = "none");
  document.querySelectorAll(".emp-row-chevron").forEach(c => c.classList.remove("open"));
  if (wasOpen) {
    currentSelection = null;
    setHash({});
    return;
  }
  currentSelection = { type: "person", personName: name, personOffice: officeName };
  setHash({ person: name + "|" + officeName });
  showPersonInline(name, officeName);
}

async function showPersonInline(name, officeName) {
  // Close all other detail rows
  document.querySelectorAll(".emp-detail-row").forEach(row => row.style.display = "none");
  document.querySelectorAll(".emp-row-chevron").forEach(c => c.classList.remove("open"));

  // Find the detail row for this person
  const detailId = `emp-detail-${esc(name).replace(/\s+/g,"-").toLowerCase()}`;
  const detail = $(detailId);
  if (!detail) {
    console.warn(`Detail container not found: ${detailId}`);
    return;
  }

  detail.innerHTML = `<div style="padding:24px 0;color:var(--ink3);font-size:.85rem">Loading…</div>`;
  const detailRow = detail.parentElement.parentElement;
  detailRow.style.display = "";
  detailRow.previousElementSibling?.querySelector(".emp-row-chevron")?.classList.add("open");

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
      const latestAnn = latest.quarterly_pay * 4 * cpiFactorForId(latest.quarter), priorAnn = prior.quarterly_pay * 4 * cpiFactorForId(prior.quarter);
      const diff = latestAnn - priorAnn;
      const pct = Math.round((diff / priorAnn) * 100);
      const labelMap = {};
      summary.quarters.forEach(q => labelMap[q.id] = q.label);
      const sign = diff >= 0 ? "+" : "−";
      const color = diff >= 0 ? "#059669" : "#dc2626";
      yoyHtml = `<div class="emp-detail-yoy">
        <span style="color:${color};font-weight:700">${sign}${fmtK(Math.abs(diff))} (${sign}${Math.abs(pct)}%)</span>
        <span class="emp-detail-yoy-label">vs. ${labelMap[priorId] || priorId} · same quarter last year</span>
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
    chartHtml = `<div class="emp-detail-section">Pay history · annual equivalent</div>${qFilterHtml}<div class="emp-detail-chart" id="emp-detail-chart"></div>`;
  } else {
    chartHtml = `<div style="font-size:.82rem;color:var(--ink3);margin:16px 0">No multi-quarter history — this person may have joined recently or changed offices.</div>`;
  }

  // Comparison section
  const allTitles = summary.quarters[summary.quarters.length - 1]?.top_titles || [];
  const compTitle = latestEmp?.title || person?.title || "";
  const compHtml = latestEmp ? `
    <div class="emp-detail-section">
      Compare to: <span id="ed-comp-title" class="emp-comp-title-link">${esc(compTitle)}</span>
    </div>
    <div class="ed-comp-wrap" id="ed-comp-wrap" style="display:none">
      <input id="ed-comp-search" class="ed-comp-input" placeholder="Search a title…" autocomplete="off" />
      <div id="ed-comp-results" class="ed-comp-results"></div>
    </div>
    <div id="ed-comp-stats"></div>` : "";

  detail.innerHTML = `
    <div class="emp-detail-name">${esc(name)}</div>
    <div class="emp-detail-meta"><span class="office-link" data-office="${esc(officeName)}">${esc(officeName)}</span>${latestEmp ? ` · ${esc(latestEmp.title)}` : ""}</div>
    ${latestEmp ? `<div class="emp-detail-salary">${over ? `<span class="cap-warn">⚠</span> ` : ""}${fmt(latestEmp.annual_equiv)}</div>
    <div class="emp-detail-salary-sub">est. annual · latest quarter</div>` : ""}
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
      const data = filtQs.map(q => { const h = person.history.find(h => h.quarter === q.id); return h ? h.quarterly_pay * 4 * cpiFactorForQuarter(q) : null; });
      const labels = filtQs.map(q => q.label);
      const el = detail.querySelector(".emp-detail-chart");
      if (el) el.innerHTML = svgSparkline(data, labels);
    }
    drawPersonChart();
    detail.querySelectorAll(".mini-q").forEach(b => {
      b.addEventListener("click", () => {
        qf = +b.dataset.q;
        detail.querySelectorAll(".mini-q").forEach(x => x.classList.toggle("active", x === b));
        drawPersonChart();
      });
    });
  }

  // Wire comparison
  if (latestEmp) {
    function renderCompStats(titleStr) {
      const ts = allTitles.find(t => t.title === titleStr);
      const el = detail.querySelector("#ed-comp-stats");
      if (!el) return;
      if (!ts) { el.innerHTML = `<div style="font-size:.78rem;color:var(--ink3);padding:6px 0">No salary data for this title.</div>`; return; }
      const you = latestEmp.annual_equiv;
      const pctileNum = estimatePercentile(you, ts);
      const pctile = pctileNum != null ? `${ordinal(pctileNum)} percentile` : "";
      const youRow = `<div class="emp-detail-comp-row emp-detail-comp-you"><span>${esc(name)} ${pctile ? `<span style="font-weight:400;font-size:.72rem;opacity:.7">${pctile}</span>` : ""}</span><span>${fmtK(you)}</span></div>`;
      const r25 = `<div class="emp-detail-comp-row"><span>25th pct.</span><span>${fmtK(ts.p25)}</span></div>`;
      const rMed = `<div class="emp-detail-comp-row"><span>Median</span><span>${fmtK(ts.median)}</span></div>`;
      const r75 = `<div class="emp-detail-comp-row"><span>75th pct.</span><span>${fmtK(ts.p75)}</span></div>`;
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

    const titleEl = detail.querySelector("#ed-comp-title"), wrap = detail.querySelector("#ed-comp-wrap"), searchEl = detail.querySelector("#ed-comp-search"), resultsEl = detail.querySelector("#ed-comp-results");
    if (titleEl) {
      titleEl.addEventListener("click", () => {
        wrap.style.display = wrap.style.display === "none" ? "block" : "none";
        if (wrap.style.display === "block") { searchEl.value = ""; searchEl.focus(); }
      });
      searchEl.addEventListener("input", () => {
        const q = searchEl.value.toLowerCase().trim();
        if (!q) { resultsEl.style.display = "none"; return; }
        const hits = allTitles.filter(t => t.title.toLowerCase().includes(q)).slice(0, 10);
        resultsEl.innerHTML = hits.map(t => `<div class="ed-comp-result" data-title="${esc(t.title)}"><span class="ed-comp-result-title">${esc(t.title)}</span><span class="ed-comp-result-med">${fmtK(t.median)}</span></div>`).join("");
        resultsEl.style.display = hits.length ? "block" : "none";
        resultsEl.querySelectorAll(".ed-comp-result").forEach(row => {
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

function clearTitle() {
  currentSelection = null;
  setHash({});
  document.querySelectorAll(".pos-row").forEach(r => r.classList.remove("active"));

  const restoreTab = preTitleTab || "dist";
  preTitleTab = null;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === restoreTab));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === "tab-" + restoreTab));
}

function clearPerson() {
  closePersonDetail();
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

// ── Persisted UI state (survives reload) ──
const STATE_KEY = "hss-ui-state";

function saveState() {
  const state = {
    tab: document.querySelector(".tab-btn.active")?.dataset.tab || "dist",
    viewQIdx,
    officeTypeFilter,
    inflationOn,
    office: {
      search: $("office-search")?.value || "",
      sort: $("office-sort")?.value || "max",
    },
    table: {
      search: $("emp-search")?.value || "",
      type: $("emp-type")?.value || "staff",
      sortKey, sortDir,
    },
    trend: { mode: trendMode, metric: trendMetric, qFilter: trendQFilter, posTitle: trendPosTitle },
  };
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch(e) { /* ignore (private mode, etc.) */ }
}

async function restoreState() {
  let state;
  try { state = JSON.parse(localStorage.getItem(STATE_KEY) || "null"); } catch(e) { state = null; }
  if (!state) return;

  if (typeof state.viewQIdx === "number" && state.viewQIdx >= 0 && state.viewQIdx < summary.quarters.length - 1) {
    viewQIdx = state.viewQIdx;
  }

  officeTypeFilter = state.officeTypeFilter || "";
  document.querySelectorAll(".type-filter-btn[data-type]").forEach(b => b.classList.toggle("active", (b.dataset.type || "") === officeTypeFilter));
  inflationOn = !!state.inflationOn;
  $("inflation-toggle")?.setAttribute("aria-pressed", inflationOn ? "true" : "false");
  updateInflationNote();

  if (state.office) {
    if ($("office-search"))       $("office-search").value = state.office.search || "";
    if ($("office-sort"))         $("office-sort").value = state.office.sort || "max";
  }
  if (state.table) {
    if ($("emp-search")) $("emp-search").value = state.table.search || "";
    if ($("emp-type"))   $("emp-type").value = state.table.type || "staff";
    if (state.table.sortKey) sortKey = state.table.sortKey;
    if (typeof state.table.sortDir === "number") sortDir = state.table.sortDir;
  }
  if (state.trend) {
    trendMode = state.trend.mode || "overall";
    trendMetric = state.trend.metric || "median";
    trendQFilter = state.trend.qFilter || 0;
    trendPosTitle = state.trend.posTitle || null;
    document.querySelectorAll(".trend-mode").forEach(x => x.classList.toggle("active", x.dataset.mode === trendMode));
    document.querySelectorAll(".pill").forEach(x => x.classList.toggle("active", x.dataset.metric === trendMetric));
    document.querySelectorAll(".trend-q").forEach(x => x.classList.toggle("active", +x.dataset.q === trendQFilter));
    if ($("trend-overall-ctrl")) $("trend-overall-ctrl").style.display = trendMode === "overall" ? "" : "none";
    if ($("trend-pos-ctrl"))     $("trend-pos-ctrl").style.display = trendMode === "position" ? "" : "none";
    if ($("trend-q-note"))       $("trend-q-note").style.display = trendQFilter === 0 ? "" : "none";
    if (trendPosTitle && $("trend-pos-search")) $("trend-pos-search").value = trendPosTitle;
  }

  // Re-render everything that depends on the restored quarter/filters.
  // renderStats()/renderDist() are deliberately NOT repeated here — the
  // quarter and office-type filter are already applied before the very
  // first render() call in loadData(), so re-running them here would just
  // immediately replace (and cut short) the chart's first-load entrance
  // animation with a redundant, value-identical re-render.
  buildTitles(); renderPosResults($("pos-search")?.value || ""); buildOfficeData(); renderOfficeList();
  $("type-bars").innerHTML = ""; renderTypeBars();
  updateSortIcons();
  if (!isLatestQuarter()) await loadPeople();
  applyFilters();
  renderTrend();
  if (!isLatestQuarter()) { const note = $("table-quarter-note"); if (note) note.style.display = ""; }

  const tabBtn = document.querySelector(`.tab-btn[data-tab="${state.tab}"]`);
  if (tabBtn && !tabBtn.classList.contains("active")) tabBtn.click();
}

// ── By Office ──
let officeData = [];

function buildOfficeData() {
  if (isLatestQuarter()) {
    const groups = {};
    employees.filter(e => !e.intern && !e.shared && (!officeTypeFilter || e.type === officeTypeFilter)).forEach(e => {
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
        mean: Math.round(totalAnnual / s.length),
        totalAnnual };
    });
  } else {
    // Use pre-aggregated top_offices from that quarter's summary
    officeData = (adjQuarter(viewedQuarter()).top_offices || [])
      .filter(o => !officeTypeFilter || o.type === officeTypeFilter)
      .map(o => ({
        name: o.name, type: o.type, count: o.count,
        min: o.min, max: o.max, median: o.median, p25: o.p25, p75: o.p75,
        mean: o.mean,
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

// Where point i would sit if it were on the straight line between its nearest
// selected (visible) neighbors — used so points being hidden/revealed during a
// quarter-filter zoom collapse onto (or peel off) that line instead of just
// holding their real position and fading in place.
function interceptSeriesValue(dataArr, selIdx, i) {
  const withData = selIdx.filter(idx => dataArr[idx] != null);
  if (withData.length < 2) return dataArr[i] ?? (withData[0] != null ? dataArr[withData[0]] : dataArr[i]);

  let prev = null, next = null;
  for (const idx of withData) {
    if (idx < i) prev = idx;
    if (idx > i && next === null) next = idx;
  }
  if (prev != null && next != null) {
    const frac = (i - prev) / (next - prev);
    return dataArr[prev] + (dataArr[next] - dataArr[prev]) * frac;
  }
  // Before the first selected point or after the last one — extrapolate along
  // the nearest segment's slope instead of flatlining to a single endpoint,
  // so leading/trailing points slide consistently with the interior ones.
  if (prev == null) {
    const [i0, i1] = withData;
    const slope = (dataArr[i1] - dataArr[i0]) / (i1 - i0);
    return dataArr[i0] + slope * (i - i0);
  } else {
    const iN = withData[withData.length - 1], iM = withData[withData.length - 2];
    const slope = (dataArr[iN] - dataArr[iM]) / (iN - iM);
    return dataArr[iN] + slope * (i - iN);
  }
}

const trendChartCache = new WeakMap(); // containerEl -> { datasetSig, yMin, yMax, datasets (filtered), fullLabels, visible }

// xs/opacities let a zoom animation override each point's pixel position and
// visibility independently of its index — everything else derives from them.
function buildTrendChartBody(labels, datasets, yMin, yMax, highlightLabel, xs = null, opacities = null) {
  const W = 680, H = 300;
  const pad = { t: 16, r: 16, b: 52, l: 58 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const n = labels.length;
  const vRange = yMax - yMin || 1;

  const sx = xs ? (i => xs[i]) : (i => pad.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw));
  const op = opacities ? (i => opacities[i]) : (() => 1);
  const sy = v => pad.t + ph - ((v - yMin) / vRange) * ph;

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + (vRange * i / 4), y = sy(v);
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eeece8" stroke-width="1"/>
            <text x="${(pad.l - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">$${(v/1000).toFixed(0)}k</text>`;
  }).join("");

  // X labels — only for points that are (mostly) visible right now, thinned so they don't collide
  const visibleIdx = [];
  for (let i = 0; i < n; i++) if (op(i) > 0.5) visibleIdx.push(i);
  const vn = visibleIdx.length;
  const rotateX = vn > 6;
  const step = Math.max(1, Math.ceil(vn / 8));
  const showIdx = new Set();
  for (let k = 0; k < vn; k += step) showIdx.add(visibleIdx[k]);
  if (vn) showIdx.add(visibleIdx[vn - 1]);
  const sortedVis = [...showIdx].sort((a, b) => a - b);
  if (sortedVis.length >= 2) {
    const lastPos = visibleIdx.indexOf(sortedVis[sortedVis.length - 1]);
    const penPos = visibleIdx.indexOf(sortedVis[sortedVis.length - 2]);
    if (lastPos - penPos < step) showIdx.delete(sortedVis[sortedVis.length - 2]);
  }
  const xLabels = labels.map((lb, i) => {
    if (!showIdx.has(i)) return "";
    const x = sx(i);
    if (rotateX) {
      const ty = pad.t + ph + 6;
      return `<text text-anchor="end" font-size="10" fill="#888"
        transform="translate(${x.toFixed(1)},${ty.toFixed(1)}) rotate(-45)">${lb}</text>`;
    }
    return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#888">${lb}</text>`;
  }).join("");

  // Per-dataset paths — a point counts as part of a line segment only while it's
  // (mostly) visible, so fading/appearing points during a zoom detach cleanly.
  const pathEls = datasets.map(ds => {
    const color = ds.color;
    const segs = [];
    let cur = [];
    ds.data.forEach((v, i) => {
      if (v != null && op(i) > 0.5) cur.push([i, v]);
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
      const o = op(i);
      if (o <= 0.02) return "";
      return `<circle cx="${sx(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="4" fill="white" stroke="${color}" stroke-width="2" opacity="${o.toFixed(2)}"
        class="trend-dot" data-i="${i}" data-val="${v}" data-label="${esc(ds.label || "")}"/>`;
    }).join("");

    return fills + lines + dots;
  }).join("");

  const hlIdx = highlightLabel != null ? labels.indexOf(highlightLabel) : -1;
  const hlLine = hlIdx >= 0 ? (() => {
    const x = sx(hlIdx).toFixed(1);
    return `<line x1="${x}" x2="${x}" y1="${pad.t}" y2="${pad.t + ph}" stroke="#c0392b" stroke-width="1.5" stroke-dasharray="4 3" opacity=".5"/>
            <text x="${x}" y="${(pad.t - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#c0392b" opacity=".8">${labels[hlIdx]}</text>`;
  })() : "";

  return { svgBody: `${yTicks}${hlLine}${pathEls}${xLabels}`, W, H, pad, ph, sx };
}

function drawSvgLineChart(containerEl, fullLabels, fullDatasets, opts = {}) {
  const { legend = false, highlightLabel = null } = opts;
  const visible = opts.visible || fullLabels.map(() => true);

  const visIdx = [];
  for (let i = 0; i < fullLabels.length; i++) if (visible[i]) visIdx.push(i);
  const labels = visIdx.map(i => fullLabels[i]);
  const datasets = fullDatasets.map(d => ({ ...d, data: visIdx.map(i => d.data[i]) }));

  const allVals = datasets.flatMap(ds => ds.data.filter(v => v != null));
  if (!allVals.length) { containerEl.innerHTML = `<p style="padding:20px;color:#888;font-size:.85rem">No data.</p>`; return; }

  const minV = Math.min(...allVals), maxV = Math.max(...allVals);
  const vPad = (maxV - minV) * 0.1 || maxV * 0.1 || 1;
  const yMin = Math.max(0, minV - vPad), yMax = maxV + vPad;

  const finish = (animateIn = true) => {
    if (animateIn) {
      // Animate lines via stroke-dashoffset
      containerEl.querySelectorAll(".trend-line").forEach(path => {
        const len = path.getTotalLength();
        path.style.strokeDasharray = len;
        path.style.strokeDashoffset = len;
        path.style.transition = "stroke-dashoffset 500ms ease-out";
        requestAnimationFrame(() => requestAnimationFrame(() => { path.style.strokeDashoffset = "0"; }));
      });
      containerEl.querySelectorAll(".trend-dot").forEach(dot => {
        dot.style.animation = "fadeIn 300ms ease-out both";
        dot.style.animationDelay = "400ms";
        dot.style.opacity = "0";
      });
    }

    // Tooltip on dots
    ensureTooltip();
    const { pad, ph, sx } = buildTrendChartBody(labels, datasets, yMin, yMax, highlightLabel);
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

    // Legend (appended as a sibling after containerEl, so look for it there)
    containerEl.parentElement?.querySelectorAll(".trend-legend").forEach(el => el.remove());
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
  };

  const renderStatic = (animateIn) => {
    const { svgBody, W, H } = buildTrendChartBody(labels, datasets, yMin, yMax, highlightLabel);
    containerEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">${svgBody}</svg>`;
    finish(animateIn);
  };

  const EASE = "cubic-bezier(.4,0,.2,1)"; // smoother than plain "ease" for the CSS crossfade below
  const easeCubic = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic, for the value-morph tween
  // easeInOutSine: no sudden acceleration change anywhere along the curve — the
  // smoothest standard easing, unlike quint/cubic which snap through the middle.
  const easeZoomSine = t => -(Math.cos(Math.PI * t) - 1) / 2;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Use a stable per-series id (not the display label) so switching metrics —
  // which changes the Overall series' label, e.g. "Median" -> "Average" — doesn't
  // look like a different series and fall back to a crossfade instead of morphing.
  const datasetSig = datasets.map((d, i) => d.id ?? d.label ?? i).join("|");
  const prev = trendChartCache.get(containerEl);
  const gen = (parseInt(containerEl.dataset.trendGen || "0", 10) + 1).toString();
  containerEl.dataset.trendGen = gen;

  // Same series and same point count — covers metric switches (Median -> Average)
  // AND switching directly between two same-size quarter filters (Q1 -> Q3): both
  // are just "the Nth point changed value", so tween values/position by index,
  // regardless of which actual quarters they are.
  const canMorph = prev && !reduceMotion && prev.datasetSig === datasetSig
    && prev.datasets.length === datasets.length
    && prev.datasets.every((d, i) => d.data.length === datasets[i].data.length);

  const sameFull = prev && prev.fullLabels && prev.fullLabels.join(",") === fullLabels.join(",");
  const prevWasAll = prev && prev.visible && prev.visible.every(v => v);
  const nowIsAll = visible.every(v => v);
  // Only zoom when one side is literally "All quarters" and the other is a subset —
  // that's the case where the point count actually changes.
  const isQuarterZoom = !canMorph && prev && prev.datasetSig === datasetSig && sameFull
    && !reduceMotion && prevWasAll !== nowIsAll;

  if (!containerEl.dataset.trendRendered) {
    // Very first paint ever for this container — keep the draw-in flourish
    containerEl.dataset.trendRendered = "1";
    containerEl.style.opacity = "1";
    containerEl.style.transform = "";
    renderStatic(true);
  } else if (reduceMotion) {
    containerEl.style.opacity = "1";
    containerEl.style.transform = "";
    renderStatic(false);
  } else if (canMorph) {
    // Same series/quarters, values changed (e.g. switching median -> average):
    // tween each point and the y-axis range to their new values instead of a hard cut.
    containerEl.style.transform = "";
    const fromDatasets = prev.datasets, fromYMin = prev.yMin, fromYMax = prev.yMax;
    const duration = 420;
    const start = performance.now();
    const step = now => {
      if (containerEl.dataset.trendGen !== gen) return; // superseded by a later render
      const t = Math.min(1, (now - start) / duration);
      const e = easeCubic(t);
      const iYMin = fromYMin + (yMin - fromYMin) * e;
      const iYMax = fromYMax + (yMax - fromYMax) * e;
      const iDatasets = datasets.map((ds, di) => ({
        ...ds,
        data: ds.data.map((v, i) => {
          const fv = fromDatasets[di].data[i];
          if (v == null || fv == null) return t < 1 ? (t < .5 ? fv : v) : v;
          return fv + (v - fv) * e;
        }),
      }));
      const { svgBody, W, H } = buildTrendChartBody(labels, iDatasets, iYMin, iYMax, highlightLabel);
      containerEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">${svgBody}</svg>`;
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        finish(false);
      }
    };
    requestAnimationFrame(step);
  } else if (isQuarterZoom) {
    // Real zoom: the newly-(de)selected points slide to their new spots on the
    // timeline; the *other* points collapse onto the straight line between their
    // nearest selected neighbors (so the line "straightens out") before fading,
    // or peel off that line as they fade in — instead of just holding position
    // and fading in place, which read as moving "in odd directions".
    containerEl.style.transform = "";
    const n = fullLabels.length;
    const W = 680, H = 300, pad = { t: 16, r: 16, b: 52, l: 58 }, pw = W - pad.l - pad.r;
    const allIdx = fullLabels.map((_, i) => i);
    const oldVisIdx = allIdx.filter(i => prev.visible[i]);
    const newVisIdx = allIdx.filter(i => visible[i]);

    const xFull = i => pad.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
    const xSubset = (idxArr, i) => {
      const rank = idxArr.indexOf(i);
      return pad.l + (idxArr.length <= 1 ? pw / 2 : (rank / (idxArr.length - 1)) * pw);
    };

    const fullVals = fullDatasets.flatMap(d => d.data.filter(v => v != null));
    const fMinV = Math.min(...fullVals), fMaxV = Math.max(...fullVals);
    const fPad = (fMaxV - fMinV) * 0.1 || fMaxV * 0.1 || 1;
    const fullYMin = Math.max(0, fMinV - fPad), fullYMax = fMaxV + fPad;

    const oldYMin = prev.yMin, oldYMax = prev.yMax;
    const newYMin = yMin, newYMax = yMax;

    const oldX = i => oldVisIdx.includes(i) ? xSubset(oldVisIdx, i) : xFull(i);
    const oldOp = i => oldVisIdx.includes(i) ? 1 : 0;
    const fullX = i => xFull(i);
    const fullOp = () => 1;
    const newX = i => newVisIdx.includes(i) ? xSubset(newVisIdx, i) : xFull(i);
    const newOp = i => newVisIdx.includes(i) ? 1 : 0;

    const needsOut = oldVisIdx.length !== n;
    const needsIn = newVisIdx.length !== n;

    // Datasets with every non-selected point's value replaced by where it sits
    // on the straight line between its nearest selected neighbors.
    const interceptedDatasets = selIdx => fullDatasets.map(ds => ({
      ...ds,
      data: ds.data.map((v, i) => selIdx.includes(i) ? v : interceptSeriesValue(ds.data, selIdx, i)),
    }));

    const runPhase = (fromX, toX, fromOp, toOp, fromDatasetsV, toDatasetsV, fromYMinV, toYMinV, fromYMaxV, toYMaxV, duration, onDone) => {
      const start = performance.now();
      const step = now => {
        if (containerEl.dataset.trendGen !== gen) return;
        const t = Math.min(1, (now - start) / duration);
        const e = easeZoomSine(t);
        const xs = allIdx.map(i => fromX(i) + (toX(i) - fromX(i)) * e);
        const ops = allIdx.map(i => fromOp(i) + (toOp(i) - fromOp(i)) * e);
        const iYMin = fromYMinV + (toYMinV - fromYMinV) * e;
        const iYMax = fromYMaxV + (toYMaxV - fromYMaxV) * e;
        const iDatasets = toDatasetsV.map((ds, di) => ({
          ...ds,
          data: ds.data.map((v, i) => {
            const fv = fromDatasetsV[di].data[i];
            if (v == null || fv == null) return v;
            return fv + (v - fv) * e;
          }),
        }));
        const { svgBody } = buildTrendChartBody(fullLabels, iDatasets, iYMin, iYMax, highlightLabel, xs, ops);
        containerEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">${svgBody}</svg>`;
        if (t < 1) requestAnimationFrame(step); else onDone();
      };
      requestAnimationFrame(step);
    };

    if (needsOut) {
      runPhase(oldX, fullX, oldOp, fullOp, interceptedDatasets(oldVisIdx), fullDatasets, oldYMin, fullYMin, oldYMax, fullYMax, 420, () => {
        if (needsIn) runPhase(fullX, newX, fullOp, newOp, fullDatasets, interceptedDatasets(newVisIdx), fullYMin, newYMin, fullYMax, newYMax, 480, () => renderStatic(false));
        else renderStatic(false);
      });
    } else if (needsIn) {
      runPhase(fullX, newX, fullOp, newOp, fullDatasets, interceptedDatasets(newVisIdx), fullYMin, newYMin, fullYMax, newYMax, 480, () => renderStatic(false));
    } else {
      renderStatic(false);
    }
  } else {
    // Different series (mode switch) — plain crossfade, no zoom metaphor
    containerEl.style.transform = "";
    containerEl.style.transition = `opacity 150ms ${EASE}`;
    containerEl.style.opacity = "0.35";
    setTimeout(() => {
      if (containerEl.dataset.trendGen !== gen) return;
      renderStatic(false);
      containerEl.style.opacity = "0.35";
      void containerEl.offsetWidth; // force reflow so the dip is committed before animating back to 1
      if (containerEl.dataset.trendGen === gen) containerEl.style.opacity = "1";
    }, 150);
  }

  trendChartCache.set(containerEl, {
    datasetSig, yMin, yMax,
    datasets: datasets.map(d => ({ ...d, data: d.data.slice() })),
    fullLabels: fullLabels.slice(), visible: visible.slice(),
  });
}

function ordinal(n) {
  const r100 = n % 100;
  if (r100 >= 11 && r100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// Piecewise-linear interpolation across known percentile points
function estimatePercentile(v, ts) {
  const pts = [[0, ts.min], [10, ts.p10], [25, ts.p25], [50, ts.median], [75, ts.p75], [90, ts.p90], [100, ts.max]]
    .filter(([, val]) => val != null);
  if (pts.length < 2) return null;
  if (v <= pts[0][1]) return pts[0][0];
  if (v >= pts[pts.length - 1][1]) return pts[pts.length - 1][0];
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, v0] = pts[i], [p1, v1] = pts[i + 1];
    if (v >= v0 && v <= v1) {
      if (v1 === v0) return p0;
      return Math.round(p0 + (p1 - p0) * (v - v0) / (v1 - v0));
    }
  }
  return null;
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

  // X labels — show ~6 evenly spaced; rotate once there are enough that they'd crowd
  const step = Math.max(1, Math.ceil(labels.length / 6));
  const rotateX = labels.length > 4;
  const xLabels = labels.map((lb, i) => {
    if (i % step !== 0 && i !== labels.length - 1) return "";
    if (rotateX) {
      const ty = pad.t + ph + 6;
      return `<text text-anchor="end" font-size="10" fill="#888"
        transform="translate(${sx(i).toFixed(1)},${ty.toFixed(1)}) rotate(-45)">${lb}</text>`;
    }
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

const MINI_EASE_CUBIC = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // value-morph
const MINI_EASE_ZOOM = t => -(Math.cos(Math.PI * t) - 1) / 2; // easeInOutSine — no sudden snap through the middle

// Stripped-down sparkline frame for mid-zoom animation only — no x-axis text or
// trend annotation (those come back once renderStatic() calls the real svgSparkline).
function buildSparklineFrame(fullLabels, fullData, xs, opacities) {
  const W = 560, H = 200;
  const pad = { t: 22, r: 16, b: 48, l: 54 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const n = fullLabels.length;

  const visNow = [];
  for (let i = 0; i < n; i++) if (opacities[i] > 0.5 && fullData[i] != null) visNow.push(fullData[i]);
  const minV = visNow.length ? Math.min(...visNow) : 0;
  const maxV = visNow.length ? Math.max(...visNow) : 1;
  const vRange = maxV - minV || 1;

  const sx = i => xs[i];
  const sy = v => pad.t + ph - ((v - minV) / vRange) * ph;
  const op = i => opacities[i];

  const yTicks = [0, .33, .67, 1].map(f => {
    const v = minV + vRange * f, y = sy(v);
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eeece8" stroke-width="1"/>
            <text x="${pad.l - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#888">$${(v/1000).toFixed(0)}k</text>`;
  }).join("");

  const segs = [];
  let cur = [];
  fullData.forEach((v, i) => {
    if (v != null && op(i) > 0.5) cur.push([sx(i), sy(v)]);
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

  const dots = fullData.map((v, i) => {
    if (v == null) return "";
    const o = op(i);
    if (o <= 0.02) return "";
    return `<circle cx="${sx(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="4" fill="white" stroke="#c0392b" stroke-width="2" opacity="${o.toFixed(2)}"/>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">${yTicks}${fills}${lines}${dots}</svg>`;
}

function makeMiniTrend(wrapEl, getDataFn) {
  let metric = "median", qf = 0;
  const chartWrap = wrapEl.querySelector(".mini-chart-wrap");
  let prev = null; // { fullLabels, fullData, visible, data, labels }
  let gen = 0;

  function computeView() {
    const allQs = summary.quarters;
    const fullLabels = allQs.map(q => q.label);
    const visible = allQs.map(q => !qf || q.quarter === qf);
    const fullData = getDataFn(metric, 0); // qf=0 -> every quarter, aligned with fullLabels
    const visIdx = [];
    for (let i = 0; i < fullLabels.length; i++) if (visible[i]) visIdx.push(i);
    return {
      fullLabels, fullData, visible,
      labels: visIdx.map(i => fullLabels[i]),
      data: visIdx.map(i => fullData[i]),
    };
  }

  function renderStatic(view) {
    if (chartWrap) chartWrap.innerHTML = svgSparkline(view.data, view.labels);
  }

  function render() {
    if (!chartWrap) return;
    gen++;
    const myGen = gen;
    const view = computeView();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const canMorph = prev && !reduceMotion && prev.data.length === view.data.length;
    const prevWasAll = prev && prev.visible.every(v => v);
    const nowIsAll = view.visible.every(v => v);
    const isZoom = !canMorph && prev && !reduceMotion && prevWasAll !== nowIsAll
      && prev.fullLabels.join(",") === view.fullLabels.join(",");

    if (!prev || reduceMotion) {
      renderStatic(view);
    } else if (canMorph) {
      // Same point count — a metric switch (Median -> Average) or a direct switch
      // between two same-size quarter filters: tween each point's value by index.
      const fromData = prev.data;
      const duration = 380;
      const start = performance.now();
      const step = now => {
        if (myGen !== gen) return;
        const t = Math.min(1, (now - start) / duration);
        const e = MINI_EASE_CUBIC(t);
        const iData = view.data.map((v, i) => {
          const fv = fromData[i];
          if (v == null || fv == null) return t < 1 ? (t < .5 ? fv : v) : v;
          return fv + (v - fv) * e;
        });
        chartWrap.innerHTML = svgSparkline(iData, view.labels);
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } else if (isZoom) {
      // Real zoom: reveal every quarter on the timeline, then push in on the
      // newly-selected slice (or the reverse when returning to "All quarters").
      const n = view.fullLabels.length;
      const pad = { l: 54, r: 16 }, pw = 560 - pad.l - pad.r;
      const allIdx = view.fullLabels.map((_, i) => i);
      const oldVisIdx = allIdx.filter(i => prev.visible[i]);
      const newVisIdx = allIdx.filter(i => view.visible[i]);

      const xFull = i => pad.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
      const xSubset = (idxArr, i) => {
        const rank = idxArr.indexOf(i);
        return pad.l + (idxArr.length <= 1 ? pw / 2 : (rank / (idxArr.length - 1)) * pw);
      };
      const oldX = i => oldVisIdx.includes(i) ? xSubset(oldVisIdx, i) : xFull(i);
      const oldOp = i => oldVisIdx.includes(i) ? 1 : 0;
      const fullX = i => xFull(i);
      const fullOp = () => 1;
      const newX = i => newVisIdx.includes(i) ? xSubset(newVisIdx, i) : xFull(i);
      const newOp = i => newVisIdx.includes(i) ? 1 : 0;

      const needsOut = oldVisIdx.length !== n;
      const needsIn = newVisIdx.length !== n;

      // Non-selected points collapse onto (or peel off) the straight line between
      // their nearest selected neighbors, instead of holding position and fading.
      const intercepted = selIdx => view.fullData.map((v, i) => selIdx.includes(i) ? v : interceptSeriesValue(view.fullData, selIdx, i));

      const runPhase = (fromX, toX, fromOp, toOp, fromData, toData, duration, onDone) => {
        const start = performance.now();
        const step = now => {
          if (myGen !== gen) return;
          const t = Math.min(1, (now - start) / duration);
          const e = MINI_EASE_ZOOM(t);
          const xs = allIdx.map(i => fromX(i) + (toX(i) - fromX(i)) * e);
          const ops = allIdx.map(i => fromOp(i) + (toOp(i) - fromOp(i)) * e);
          const iData = toData.map((v, i) => {
            const fv = fromData[i];
            if (v == null || fv == null) return v;
            return fv + (v - fv) * e;
          });
          chartWrap.innerHTML = buildSparklineFrame(view.fullLabels, iData, xs, ops);
          if (t < 1) requestAnimationFrame(step); else onDone();
        };
        requestAnimationFrame(step);
      };

      if (needsOut) {
        runPhase(oldX, fullX, oldOp, fullOp, intercepted(oldVisIdx), view.fullData, 400, () => {
          if (needsIn) runPhase(fullX, newX, fullOp, newOp, view.fullData, intercepted(newVisIdx), 460, () => renderStatic(view));
          else renderStatic(view);
        });
      } else if (needsIn) {
        runPhase(fullX, newX, fullOp, newOp, view.fullData, intercepted(newVisIdx), 460, () => renderStatic(view));
      } else {
        renderStatic(view);
      }
    } else {
      renderStatic(view);
    }

    prev = view;
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
    const qData = adjQuarter(viewedQuarter());
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
        const o = (adjQuarter(q).top_offices || []).find(o => o.name === officeName);
        return o ? o[metric] : null;
      });
    });
  }
}

let officeSortKey = "median";

function fmtTotal(n) {
  if (n == null) return "—";
  if (n >= 1000000) return "$" + (n/1000000).toFixed(1).replace(/\.0$/,"") + "M";
  return fmtK(n);
}

function officeRangeHtml(o, sortKey) {
  if (sortKey === "median") return `${fmtK(o.median)}<span class="office-range-tag">median</span>`;
  if (sortKey === "mean")   return `${fmtK(o.mean)}<span class="office-range-tag">avg</span>`;
  if (sortKey === "total")  return `${fmtTotal(o.totalAnnual)}<span class="office-range-tag">total</span>`;
  return `${fmtK(o.min)}<span class="office-range-sep">–</span>${fmtK(o.max)}`;
}

function renderOfficeList() {
  const q = ($("office-search").value || "").toLowerCase().trim();
  officeSortKey = $("office-sort").value;

  // Office type is filtered globally already (officeData is built from it in buildOfficeData())
  let rows = officeData.filter(o => {
    if (q && !o.name.toLowerCase().includes(q)) return false;
    return true;
  });

  rows.sort((a,b) => {
    if (officeSortKey === "count")  return b.count - a.count;
    if (officeSortKey === "name")   return a.name.localeCompare(b.name);
    if (officeSortKey === "median") return b.median - a.median;
    if (officeSortKey === "mean")   return b.mean - a.mean;
    if (officeSortKey === "total")  return (b.totalAnnual||0) - (a.totalAnnual||0);
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
        <span class="office-count"><span class="office-count-num">${o.count}</span><span class="office-count-label">&nbsp;staff</span></span>
        <span class="office-range">${officeRangeHtml(o, officeSortKey)}</span>
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

function jumpToOffice(officeName) {
  closePersonDetail();
  const tabBtn = document.querySelector('.tab-btn[data-tab="type"]');
  if (tabBtn) tabBtn.click();
  const search = $("office-search");
  if (search) search.value = officeName;
  renderOfficeList();
  saveState();
  requestAnimationFrame(() => {
    const wrap = [...document.querySelectorAll("#office-list .office-wrap")]
      .find(w => w.querySelector(".office-name")?.textContent === officeName);
    if (wrap) {
      wrap.querySelector(".office-row").click();
      wrap.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

// ── Table ──
function buildHistoricalEmployees(qId) {
  if (historicalEmployeesCache[qId]) return historicalEmployeesCache[qId];
  const list = (peopleData || []).reduce((acc, p) => {
    const h = p.history.find(x => x.quarter === qId);
    if (h) acc.push({
      name: p.name, office: p.office, title: p.title, type: p.type,
      intern: false, shared: false,
      quarterly_pay: h.quarterly_pay,
      annual_equiv: Math.round(h.quarterly_pay * 4),
    });
    return acc;
  }, []);
  historicalEmployeesCache[qId] = list;
  return list;
}

function currentEmployeeSource() {
  if (isLatestQuarter()) return employees; // the base quarter — factor is always 1
  const q = viewedQuarter();
  const rows = buildHistoricalEmployees(q.id);
  const f = cpiFactorForQuarter(q);
  if (f === 1) return rows;
  // buildHistoricalEmployees() caches raw nominal figures (keyed only by
  // quarter id) so the cache stays valid regardless of the inflation
  // toggle — scale a fresh copy here instead of baking it into the cache.
  return rows.map(e => ({ ...e, quarterly_pay: e.quarterly_pay * f, annual_equiv: Math.round(e.annual_equiv * f) }));
}

function applyFilters() {
  const q = $("emp-search").value.toLowerCase().trim();
  const show = $("emp-type").value;
  filtered = currentEmployeeSource().filter(e => {
    if (show === "staff"  &&  e.intern) return false;
    if (show === "intern" && !e.intern) return false;
    if (officeTypeFilter && e.type !== officeTypeFilter) return false;
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
    return `<tr class="emp-row" data-name="${esc(e.name)}" data-office="${esc(cleanOrg(e.office))}">
      <td class="td-name"><span class="person-link" data-name="${esc(e.name)}" data-office="${esc(cleanOrg(e.office))}">${esc(e.name)}</span></td>
      <td class="td-office" title="${esc(e.office)}"><span class="office-link" data-office="${esc(cleanOrg(e.office))}">${esc(cleanOrg(e.office))}</span></td>
      <td class="td-title">${esc(e.title)}</td>
      <td><span class="badge badge-${e.intern?"intern":e.shared?"shared":e.type}">${e.intern?"Intern":e.shared?"Shared":(TYPE_LABELS[e.type]||e.type)}</span></td>
      <td class="td-amt-q">${fmt(e.quarterly_pay)}</td>
      <td class="td-amt">${overCap ? `<span class="cap-warn" title="Exceeds $228k staff salary cap — may include a bonus or lump-sum payment">⚠</span> ` : ""}${fmt(e.annual_equiv)}<span class="emp-row-chevron">›</span></td>
    </tr>
    <tr class="emp-detail-row" style="display:none">
      <td colspan="6"><div class="emp-detail" id="emp-detail-${esc(e.name).replace(/\s+/g,"-").toLowerCase()}"></div></td>
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

function updateSortIcons() {
  document.querySelectorAll("th[data-sort]").forEach(th => {
    const on = th.dataset.sort===sortKey; th.classList.toggle("sorted",on);
    th.querySelector(".sort-icon").textContent = on?(sortDir===1?"↑":"↓"):"↕";
  });
}

function setSortKey(key) {
  if (sortKey===key) sortDir*=-1; else { sortKey=key; sortDir=-1; }
  updateSortIcons();
  renderTable();
  saveState();
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

  document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
    const tab = b.dataset.tab;
    if (currentSelection?.type === "title") clearTitle();
    document.querySelectorAll(".tab-btn").forEach(x => x.classList.toggle("active", x===b));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id==="tab-"+tab));
    if (tab==="type" && !$("office-list").children.length) renderOfficeList();
    if (tab==="typebars" && !$("type-bars").children.length) renderTypeBars();
    if (tab==="trend") { renderTrend(); }
    saveState();
  }));
  document.querySelectorAll(".trend-mode").forEach(b => b.addEventListener("click", () => {
    trendMode = b.dataset.mode;
    document.querySelectorAll(".trend-mode").forEach(x => x.classList.toggle("active", x===b));
    $("trend-overall-ctrl").style.display = trendMode === "overall" ? "" : "none";
    $("trend-pos-ctrl").style.display = trendMode === "position" ? "" : "none";
    renderTrend();
    saveState();
  }));
  document.querySelectorAll(".pill").forEach(p => p.addEventListener("click", () => {
    trendMetric = p.dataset.metric;
    document.querySelectorAll(".pill").forEach(x => x.classList.toggle("active", x===p));
    renderTrend();
    saveState();
  }));
  document.querySelectorAll(".trend-q").forEach(b => b.addEventListener("click", () => {
    trendQFilter = +b.dataset.q;
    document.querySelectorAll(".trend-q").forEach(x => x.classList.toggle("active", x===b));
    $("trend-q-note").style.display = trendQFilter === 0 ? "" : "none";
    renderTrend();
    saveState();
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
      saveState();
    }));
  });
  document.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => setSortKey(th.dataset.sort)));
  document.addEventListener("click", e => {
    const off = e.target.closest(".office-link");
    if (off) { e.preventDefault(); e.stopPropagation(); jumpToOffice(off.dataset.office); return; }

    const el = e.target.closest(".person-link");
    if (el) {
      e.preventDefault(); e.stopPropagation();
      const inTable = el.closest("#emp-tbody");
      if (inTable) togglePersonInline(el.dataset.name, el.dataset.office);
      else showPerson(el.dataset.name, el.dataset.office);
      return;
    }

    const row = e.target.closest(".emp-row");
    if (row) togglePersonInline(row.dataset.name, row.dataset.office);
  });
  $("office-search").addEventListener("input", () => { renderOfficeList(); saveState(); });
  $("office-sort").addEventListener("change", () => { renderOfficeList(); saveState(); });
  $("pos-search").addEventListener("input", e => renderPosResults(e.target.value));
  $("emp-search").addEventListener("input", () => { applyFilters(); saveState(); });
  $("emp-type").addEventListener("change", () => { applyFilters(); saveState(); });
  document.querySelectorAll(".type-filter-btn[data-type]").forEach(btn => {
    btn.addEventListener("click", () => setOfficeTypeFilter(btn.dataset.type || ""));
  });
  $("inflation-toggle")?.addEventListener("click", () => setInflationOn(!inflationOn));

  // Suggestion drawer
  const drawer = $("suggest-drawer");
  const overlay = $("suggest-overlay");
  const openDrawer = () => {
    overlay.style.display = "";
    drawer.removeAttribute("aria-hidden");
    drawer.classList.add("open");
    $("suggest-message")?.focus();
  };
  const closeDrawer = () => {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    overlay.style.display = "none";
  };
  $("suggest-fab").addEventListener("click", openDrawer);
  $("suggest-close").addEventListener("click", closeDrawer);
  overlay.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && drawer.classList.contains("open")) closeDrawer();
  });

  // Data & privacy modal
  const dataModal = $("suggest-data-modal");
  const openDataModal  = () => { dataModal.style.display = "flex"; $("suggest-data-close").focus(); };
  const closeDataModal = () => { dataModal.style.display = "none"; $("suggest-privacy-link")?.focus(); };
  $("suggest-privacy-link").addEventListener("click", e => { e.preventDefault(); openDataModal(); });
  $("suggest-data-close").addEventListener("click", closeDataModal);
  $("suggest-data-backdrop").addEventListener("click", closeDataModal);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && dataModal.style.display !== "none") { e.stopPropagation(); closeDataModal(); }
  }, true);

  $("suggest-form").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = $("suggest-submit");
    const errEl = $("suggest-error");
    errEl.style.display = "none";
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const fd = new FormData(e.target);
      const res = await fetch("https://contact.evanhollander.org/api/submit", {
        method: "POST", body: fd,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Something went wrong.");
      $("suggest-form").style.display = "none";
      $("suggest-success").style.display = "";
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = "";
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  loadData();
});
