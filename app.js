/* House Staff Salaries — app.js */

const $ = id => document.getElementById(id);
const fmt = n => n == null ? "—" : "$" + Math.round(n).toLocaleString();
const fmtK = n => n == null ? "—" : "$" + (Math.round(n / 1000)) + "k";

let summary = null;
let employees = [];
let charts = {};

// ── Sort state ──
let sortKey = "annual_equiv";
let sortDir = -1;
let page = 1;
const PAGE_SIZE = 25;
let filtered = [];

// ── Office type labels ──
const TYPE_LABELS = {
  member: "Member Office",
  committee: "Committee",
  leadership: "Leadership",
  administrative: "Administrative",
};
const TYPE_COLORS = {
  member: "#3b82f6",
  committee: "#10b981",
  leadership: "#f59e0b",
  administrative: "#8b5cf6",
};

// ── Load data ──
async function loadData() {
  try {
    const [sumRes, empRes] = await Promise.all([
      fetch("data/summary.json"),
      fetch("data/employees.json"),
    ]);
    if (!sumRes.ok) throw new Error("summary.json not found");
    summary = await sumRes.json();

    if (empRes.ok) {
      const empData = await empRes.json();
      employees = empData.employees || [];
    }

    render();
  } catch (e) {
    $("app").innerHTML = `<div class="error-msg">Failed to load data: ${e.message}. Run <code>python scripts/fetch_sod.py</code> to generate the data files.</div>`;
  }
}

// ── Stats bar ──
function renderStats() {
  const latest = summary.quarters[summary.quarters.length - 1];
  if (!latest) return;
  const o = latest.overall;

  $("stat-employees").textContent = o.count.toLocaleString();
  $("stat-median").textContent = fmt(o.median);
  $("stat-mean").textContent = fmt(o.mean);
  $("stat-quarter").textContent = latest.label;
  $("stat-updated").textContent = summary.updated;
}

// ── Distribution chart ──
function renderDistribution() {
  const latest = summary.quarters[summary.quarters.length - 1];
  if (!latest) return;
  const dist = latest.distribution;

  const labels = dist.map(b =>
    b.max == null ? `$${b.min / 1000}k+` : `$${b.min / 1000}k`
  );
  const data = dist.map(b => b.count);

  const colors = dist.map(b => {
    if (b.min < 40000) return "#cbd5e1";
    if (b.min < 100000) return "#3b82f6";
    if (b.min < 160000) return "#1d4ed8";
    return "#1e3a8a";
  });

  if (charts.dist) charts.dist.destroy();
  charts.dist = new Chart($("chart-dist"), {
    type: "bar",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4, borderSkipped: false }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const b = dist[items[0].dataIndex];
              return b.max == null
                ? `$${(b.min / 1000).toFixed(0)}k and above`
                : `$${(b.min / 1000).toFixed(0)}k – $${(b.max / 1000).toFixed(0)}k`;
            },
            label: (item) => ` ${item.raw.toLocaleString()} employees`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, maxRotation: 45, color: "#64748b" },
        },
        y: {
          grid: { color: "#f1f5f9" },
          ticks: { font: { size: 11 }, color: "#64748b" },
        },
      },
    },
  });
}

// ── Range bars (office type) ──
function renderRangeBars() {
  const latest = summary.quarters[summary.quarters.length - 1];
  if (!latest) return;

  const maxSalary = 250000;
  const container = $("range-bars");
  container.innerHTML = "";

  const order = ["member", "committee", "leadership", "administrative"];
  order.forEach(type => {
    const s = latest.by_type[type];
    if (!s || s.count === 0) return;

    const pct = v => Math.min(100, (v / maxSalary) * 100);

    const row = document.createElement("div");
    row.className = "range-row";
    row.innerHTML = `
      <span class="range-label">${TYPE_LABELS[type] || type}</span>
      <div class="range-track-wrap">
        <div class="range-track range-bg"></div>
        <div class="range-track range-iqr" style="left:${pct(s.p25)}%;width:${pct(s.p75) - pct(s.p25)}%;background:${TYPE_COLORS[type]}"></div>
        <div class="range-median-line" style="left:${pct(s.median)}%;background:${TYPE_COLORS[type]}"></div>
      </div>
      <div class="range-values">
        <div style="color:${TYPE_COLORS[type]};font-weight:600">${fmtK(s.median)}</div>
        <div>${fmtK(s.p25)}–${fmtK(s.p75)}</div>
      </div>
    `;
    container.appendChild(row);
  });

  // Legend
  const legend = document.createElement("div");
  legend.style.cssText = "display:flex;gap:16px;margin-top:8px;font-size:.72rem;color:#64748b;flex-wrap:wrap;";
  legend.innerHTML = `
    <span>Bar = middle 50% (25th–75th percentile)</span>
    <span>Line = median</span>
  `;
  container.appendChild(legend);
}

// ── Trend chart ──
let trendMetric = "median";

function renderTrend() {
  const qs = summary.quarters;
  const labels = qs.map(q => q.label.replace("–", "–").split(" ").slice(-1)[0] + " " + q.id.slice(0,4) + " Q" + q.quarter);
  // Shorter labels
  const shortLabels = qs.map(q => `${q.id.slice(0,4)} Q${q.quarter}`);

  const metrics = {
    median: { label: "Median", key: "median" },
    mean:   { label: "Average", key: "mean" },
    p75:    { label: "75th Percentile", key: "p75" },
    p25:    { label: "25th Percentile", key: "p25" },
  };

  const m = metrics[trendMetric];
  const data = qs.map(q => q.overall[m.key]);

  if (charts.trend) charts.trend.destroy();
  charts.trend = new Chart($("chart-trend"), {
    type: "line",
    data: {
      labels: shortLabels,
      datasets: [{
        label: m.label + " Annual Equiv.",
        data,
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,.08)",
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointBackgroundColor: "#3b82f6",
        borderWidth: 2.5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => qs[items[0].dataIndex].label,
            label: (item) => ` ${fmt(item.raw)} annual equivalent`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, maxRotation: 45, color: "#64748b" },
        },
        y: {
          grid: { color: "#f1f5f9" },
          ticks: {
            font: { size: 11 },
            color: "#64748b",
            callback: v => "$" + (v / 1000).toFixed(0) + "k",
          },
        },
      },
    },
  });
}

function setTrendMetric(metric) {
  trendMetric = metric;
  document.querySelectorAll(".trend-btn").forEach(b => b.classList.toggle("active", b.dataset.metric === metric));
  renderTrend();
}

// ── Employee table ──
function applyFilters() {
  const q = $("search-input").value.toLowerCase().trim();
  const type = $("filter-type").value;
  const qtr = $("filter-quarter").value;

  filtered = employees.filter(e => {
    if (type && e.type !== type) return false;
    if (q && !e.name.toLowerCase().includes(q) && !e.office.toLowerCase().includes(q)) return false;
    return true;
  });

  page = 1;
  renderTable();
}

function renderTable() {
  filtered.sort((a, b) => sortDir * (a[sortKey] - b[sortKey]));

  const start = (page - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const tbody = $("emp-tbody");
  tbody.innerHTML = slice.map(e => `
    <tr>
      <td class="td-name">${escHtml(e.name)}</td>
      <td class="td-office" title="${escHtml(e.office)}">${escHtml(cleanOfficeName(e.office))}</td>
      <td><span class="badge badge-${e.type}">${TYPE_LABELS[e.type] || e.type}</span></td>
      <td class="td-amount">${fmt(e.quarterly_pay)}</td>
      <td class="td-amount" style="color:#1d4ed8">${fmt(e.annual_equiv)}</td>
    </tr>
  `).join("");

  $("table-info").textContent = `${filtered.length.toLocaleString()} employees`;

  const pg = $("pagination");
  pg.innerHTML = "";
  const range = paginationRange(page, totalPages);
  range.forEach(p => {
    if (p === "…") {
      const s = document.createElement("span");
      s.textContent = "…";
      s.style.cssText = "padding:4px 6px;color:#94a3b8;font-size:.8rem";
      pg.appendChild(s);
    } else {
      const btn = document.createElement("button");
      btn.className = "page-btn" + (p === page ? " active" : "");
      btn.textContent = p;
      btn.onclick = () => { page = p; renderTable(); };
      pg.appendChild(btn);
    }
  });
}

function paginationRange(cur, total) {
  if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
  if (cur <= 4) return [1,2,3,4,5,"…",total];
  if (cur >= total - 3) return [1,"…",total-4,total-3,total-2,total-1,total];
  return [1,"…",cur-1,cur,cur+1,"…",total];
}

function setSortKey(key) {
  if (sortKey === key) sortDir *= -1;
  else { sortKey = key; sortDir = -1; }
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === key);
    if (th.dataset.sort === key) th.querySelector(".sort-icon").textContent = sortDir === 1 ? "↑" : "↓";
    else th.querySelector(".sort-icon").textContent = "↕";
  });
  renderTable();
}

function cleanOfficeName(org) {
  return org.replace(/^\d{4}\s+/, "");
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function populateQuarterFilter() {
  const sel = $("filter-quarter");
  summary.quarters.slice().reverse().forEach(q => {
    const opt = document.createElement("option");
    opt.value = q.id;
    opt.textContent = q.label;
    sel.appendChild(opt);
  });
}

// ── Title salary bars ──
let titleSortKey = "median";

function renderTitleBars() {
  const latest = summary.quarters[summary.quarters.length - 1];
  if (!latest || !latest.top_titles) return;

  const q = $("title-search").value.toLowerCase().trim();
  let titles = latest.top_titles.filter(t =>
    !q || t.title.toLowerCase().includes(q)
  );

  titles.sort((a, b) => {
    if (titleSortKey === "count") return b.count - a.count;
    if (titleSortKey === "name") return a.title.localeCompare(b.title);
    return b.median - a.median;
  });

  const maxSalary = Math.max(...titles.map(t => t.p90), 250000);
  const pct = v => Math.min(100, (v / maxSalary) * 100);

  const container = $("title-bars");
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "title-bars";

  titles.forEach(t => {
    const row = document.createElement("div");
    row.className = "title-bar-row";
    row.innerHTML = `
      <span class="title-bar-label" title="${escHtml(t.title)}">${escHtml(t.title)}</span>
      <div class="title-bar-track">
        <div class="title-bar-iqr" style="left:${pct(t.p25)}%;width:${pct(t.p75)-pct(t.p25)}%"></div>
        <div class="title-bar-median" style="left:${pct(t.median)}%"></div>
      </div>
      <div class="title-bar-meta">
        <div class="title-bar-median-val">${fmtK(t.median)}</div>
        <div class="title-bar-count">${t.count.toLocaleString()} employees</div>
      </div>
    `;
    wrap.appendChild(row);
  });

  if (titles.length === 0) {
    wrap.innerHTML = `<div style="color:var(--gray-400);font-size:.85rem;padding:12px 0">No matching positions.</div>`;
  }
  container.appendChild(wrap);
}

// ── Main render ──
function render() {
  $("loading").remove();
  $("app").style.display = "";

  renderStats();
  renderDistribution();
  renderRangeBars();
  populateQuarterFilter();
  renderTrend();
  renderTitleBars();

  filtered = [...employees];
  renderTable();
}

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".trend-btn").forEach(b => {
    b.addEventListener("click", () => setTrendMetric(b.dataset.metric));
  });
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => setSortKey(th.dataset.sort));
  });
  $("search-input").addEventListener("input", applyFilters);
  $("filter-type").addEventListener("change", applyFilters);
  $("title-search").addEventListener("input", renderTitleBars);
  $("title-sort").addEventListener("change", () => {
    titleSortKey = $("title-sort").value;
    renderTitleBars();
  });

  loadData();
});
