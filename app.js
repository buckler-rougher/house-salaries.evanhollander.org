/* House Staff Salaries — app.js */

const $ = id => document.getElementById(id);
const fmt   = n => n == null ? "—" : "$" + Math.round(n).toLocaleString();
const fmtK  = n => n == null ? "—" : "$" + Math.round(n / 1000) + "k";
const fmtSh = n => { if (n == null) return "—"; return n >= 1000 ? "$" + Math.round(n/1000) + "k" : "$" + Math.round(n); };

// A plain substring search on a full name misses "john smith" against
// "John A. Smith" — a middle name/initial (with or without a period, which
// people also aren't consistent about) sits right where the search expects
// the last name to start. Falls back to word-subset matching: every word
// in the query has to match (as a substring) some word in the name,
// regardless of order or what's in between.
function fuzzyNameMatch(haystack, queryLower) {
  const norm = s => s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  const normHay = norm(haystack), normQ = norm(queryLower);
  if (normHay.includes(normQ)) return true;
  const hayWords = normHay.split(" ");
  const qWords = normQ.split(" ").filter(Boolean);
  return qWords.length > 0 && qWords.every(qw => hayWords.some(hw => hw.includes(qw)));
}

let summary = null, employees = [];
let trendMetric = "median", trendMode = "overall", trendQFilter = 0;
let sortKey = "annual_equiv", sortDir = -1, page = 1, filtered = [];
let peopleData = null, peopleLoading = false;
let historicalEmployeesCache = {}; // quarter id -> synthesized employee rows, built from peopleData
let viewQIdx = -1; // index into summary.quarters; -1 = latest
let officeTypeFilter = ""; // "" = all types, else "member"|"committee"|"leadership"|"administrative"
let partyFilter = ""; // "" = all parties, else "D"|"R"|"I" — see partyOptionsFor() for which apply to which officeTypeFilter
let inflationOn = false; // when true, historical dollar figures are scaled to the latest quarter's dollars
let currentSelection = null; // { type: "title"|"person", titleName, personName, personOffice }
const PAGE = 25;

const SALARY_CAP = 228000;
// Matches fetch_sod.py's HOUSE_MIN_ANNUAL — the backend's pre-aggregated
// stats (aq.overall, aq.by_type, top_offices/top_titles) only ever include
// staff at or above this floor ("full-time staff"). Any client-side
// recomputation (party filtering, since by_type has no party breakdown) has
// to apply the same floor, or it pulls in below-floor rows the backend
// numbers exclude and reads inconsistently low next to them.
const HOUSE_MIN_ANNUAL = 45000;
const ALL_STAFF_KEY = "__ALL_STAFF__"; // sentinel titleStr for "compare to all staff" instead of one title

// Charts embed their own <svg>...</svg> as raw innerHTML, often several at
// once on the same page (position card, office card, per-person chart) — a
// fixed gradient id would collide across them, so each call gets its own.
let gradSeq = 0;
function areaFillGradient(color, topOpacity) {
  const id = `areaFade${gradSeq++}`;
  const defs = `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="${topOpacity}"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient>`;
  return { id, defs };
}
const TYPE_LABELS = { member:"Member", committee:"Committee", leadership:"Leadership", administrative:"Administrative" };
const TYPE_COLORS = { member:"#e9730c", committee:"#d8649a", leadership:"#c99908", administrative:"#6b7280" };

const PARTY_NAMES = { D: "Democrat", R: "Republican", I: "Independent" };
function partyBadgeHtml(party) {
  const p = party && party.party;
  if (!p || !PARTY_NAMES[p]) return "";
  return `<span class="party-badge party-badge-${p.toLowerCase()}" title="${PARTY_NAMES[p]}${party.state ? ` — ${esc(party.state)}` : ""}">${p}</span>`;
}

// Member offices carry a full {party,state,district} dict (o.party, from the
// member's own registration). Leadership offices only carry a bare "D"/"R"
// letter (o.leadership_party, resolved from the office name + which party
// holds the majority) — wrap it in the same shape so one badge renderer
// covers both.
// Same shape mismatch as officePartyBadge, but for comparing against
// partyFilter: member items carry item.party.party, leadership items carry
// a bare item.leadership_party. Every partyFilter comparison must go through
// this — comparing item.party?.party directly silently never matches
// leadership items (they have no .party at all), making the filter look
// like it does nothing for Leadership.
function partyValueOf(item) {
  if (item.type === "member") return item.party?.party;
  if (item.type === "leadership") return item.leadership_party;
  return null;
}

// Bioguide's photo endpoint is keyed off the Bioguide ID's first letter,
// e.g. "P000197" -> .../photo/P/P000197.jpg — see the footer's Biographical
// Directory of the U.S. Congress attribution for the source.
function memberPhotoHeaderHtml(party, officeName) {
  if (!party?.bioguide) return "";
  const url = `https://bioguide.congress.gov/bioguide/photo/${party.bioguide[0]}/${party.bioguide}.jpg`;
  return `<div class="office-detail-member-header">
    <img class="office-detail-photo" src="${url}" alt="${esc(officeName)}" loading="lazy" onerror="this.parentElement.remove()">
    <div>
      <div class="office-detail-member-name">${esc(officeName)}${officePartyBadge({ type: "member", party })}</div>
      <div class="office-detail-member-meta">${esc(party.state)}${party.district ? "-" + esc(party.district.slice(party.state.length) || party.district) : ""}</div>
    </div>
  </div>`;
}

function officePartyBadge(o) {
  if (o.type === "member") return partyBadgeHtml(o.party);
  if (o.type === "leadership") return partyBadgeHtml(o.leadership_party ? { party: o.leadership_party } : null);
  return "";
}

async function loadData() {
  setupSparklineTooltips();
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
        partyFilter = partyOptionsFor(officeTypeFilter).includes(saved.partyFilter) ? saved.partyFilter : "";
        document.querySelectorAll(".party-filter-btn[data-party]").forEach(b => b.classList.toggle("active", (b.dataset.party || "") === partyFilter));
        updatePartyFilterVisibility();
        inflationOn = !!saved.inflationOn;
        $("inflation-toggle")?.setAttribute("aria-pressed", inflationOn ? "true" : "false");
      }
    } catch(e) { /* ignore */ }

    render();
    updateInflationNote();
    await restoreState();
    restoreHash();
    // restoreHash() only ran once, at load — a same-page hash link (like the
    // footer's link to a specific person) just updates location.hash without
    // a reload, so without this listener nothing would visibly happen when
    // clicking it.
    window.addEventListener("hashchange", restoreHash);

    // people.json is large (~11MB), so it's not fetched up front — but kick
    // it off now in the background rather than waiting for something to
    // need it. Once it lands, refresh the position search results so their
    // preview numbers match what the card actually shows once you click
    // in (positionHeaderStats() prefers this tenure-filtered data over the
    // raw roster snapshot the moment it's available).
    loadPeople().then(() => {
      renderPosResults($("pos-search")?.value || "");
      // Both depend on tenure, which only exists once peopleData lands —
      // buildOfficeData() ran before that on the initial render, so the
      // office list's tenure sort and the tenure-by-bucket chart would
      // otherwise show "no tenure data" until some unrelated action
      // happened to rebuild them.
      buildOfficeData();
      renderOfficeList();
      renderTenureChart();
    });
  } catch(e) {
    // render() removes #loading as its first step, so if anything after that
    // point throws (restoreState, restoreHash, ...) #loading is already gone
    // — falling back to a fresh error banner instead of crashing on a null
    // lookup, which was masking the real error above.
    console.error("loadData failed:", e);
    const loading = $("loading");
    if (loading) {
      loading.innerHTML = `<div class="error-msg">${e.message}</div>`;
    } else {
      const banner = document.createElement("div");
      banner.className = "error-msg";
      banner.textContent = e.message;
      document.body.prepend(banner);
    }
  }
}

async function loadPeople() {
  if (peopleData || peopleLoading) return;
  peopleLoading = true;
  try {
    // people.json is sharded (data/people-0.json, -1.json, ...) — a single
    // file crossed Cloudflare Pages' 25 MiB per-file deploy limit once the
    // 2016 backfill roughly doubled tracked history. Shard count/order
    // don't matter to anything downstream, so just fetch every shard in
    // parallel and concatenate.
    const mr = await fetch("data/people-manifest.json", { cache: "no-cache" });
    if (mr.ok) {
      const manifest = await mr.json();
      const shardResults = await Promise.all(
        Array.from({ length: manifest.shards }, (_, i) =>
          fetch(`data/people-${i}.json`, { cache: "no-cache" }).then(r => r.ok ? r.json() : { people: [] }))
      );
      peopleData = shardResults.flatMap(d => d.people || []);
    }
  } catch(e) { /* non-fatal */ }
  peopleLoading = false;
}

// Median/mean/p25/p75 from a raw array of amounts — same percentile math as
// buildTitles(), pulled out so the position trend chart can reuse it when
// deriving type-filtered historical values from peopleData (summary.json's
// pre-aggregated top_titles isn't broken out by office type).
function metricFromAmounts(amounts, metric) {
  if (!amounts.length) return null;
  const s = amounts.slice().sort((a,b) => a-b);
  if (metric === "mean") return s.reduce((a,b) => a+b, 0) / s.length;
  const pctOf = pct => { const i=(s.length-1)*pct/100, lo=Math.floor(i), hi=Math.min(lo+1,s.length-1); return s[lo]+(s[hi]-s[lo])*(i-lo); };
  return pctOf({ median: 50, p25: 25, p75: 75 }[metric] ?? 50);
}

// Per-quarter median/mean/p25/p75 for a title, filtered to one office type,
// derived from each person's own quarterly history — the only way to get a
// type-broken-out historical trend, since top_titles is all-types-combined.
// Returns null if peopleData isn't loaded yet or no one matches.
function positionTrendByType(title, type) {
  if (!peopleData) return null;
  const matches = peopleData.filter(p => (p.title_group || p.title) === title && (!type || p.type === type));
  if (!matches.length) return null;
  return (metric, qf) => filteredQuarters(qf).map(q => {
    const amounts = matches
      .map(p => p.history.find(h => h.quarter === q.id))
      .filter(Boolean)
      .map(h => h.quarterly_pay * 4 * cpiFactorForQuarter(q));
    return metricFromAmounts(amounts, metric);
  });
}

// Full min/p10/p25/median/p75/p90/max/mean/count from a raw amounts array —
// same shape as buildTitles()'s per-title stats, so the position card's own
// header (bar/trio/min-max/count) can be built from this instead when a
// tenure-filtered peopleData slice is available for it.
function fullStatsFromAmounts(amounts) {
  if (!amounts.length) return null;
  const s = amounts.slice().sort((a,b) => a-b);
  const pctOf = pct => { const i=(s.length-1)*pct/100, lo=Math.floor(i), hi=Math.min(lo+1,s.length-1); return s[lo]+(s[hi]-s[lo])*(i-lo); };
  return {
    count: s.length, min: s[0], max: s[s.length-1],
    median: pctOf(50), p10: pctOf(10), p25: pctOf(25), p75: pctOf(75), p90: pctOf(90),
    mean: s.reduce((a,b) => a+b, 0) / s.length,
  };
}

// ── Tenure ──
// Tenure = count of tracked quarters worked, not last-first — staff who
// leave and come back accumulate gaps, and summing quarters present handles
// that correctly where a date subtraction wouldn't.
function personTenureQuarters(p) {
  return p?.history?.length || 0;
}

// summary.quarters is oldest-first; index 0 is the earliest quarter this
// site has ever tracked. If a person's own history reaches back to it, their
// *real* start could be earlier still — SOD data before that point simply
// isn't loaded, not evidence they started exactly then.
function earliestTrackedQuarterId() {
  return summary.quarters[0]?.id;
}
function personTenureCensored(p) {
  return !!(p?.history?.length && p.history[0].quarter === earliestTrackedQuarterId());
}

// Quarters → "2.8 yrs". `censored` turns it into an open-ended floor
// ("10+ yrs") for people whose history runs back to the earliest quarter we
// track, where the real figure is unknown and at least this large.
function fmtTenureQuarters(q, censored) {
  const years = q / 4;
  if (censored) return `${Math.floor(years)}+ yrs`;
  const rounded = Math.round(years * 10) / 10;
  return `${rounded} yr${rounded === 1 ? "" : "s"}`;
}

// People with no tracked history at all (too new — see people.json's 3+
// quarter floor) get null, which callers must handle rather than showing
// "0 yrs".
function tenureLabel(p) {
  const q = personTenureQuarters(p);
  if (!q) return null;
  return fmtTenureQuarters(q, personTenureCensored(p));
}

// Position of a quarter id in the tracked timeline, for comparing two ids by
// recency. Built once and reused — summary.quarters doesn't change after load.
let _qOrdinals = null;
function quarterOrdinal(id) {
  if (!_qOrdinals) {
    _qOrdinals = {};
    summary.quarters.forEach((q, i) => { _qOrdinals[q.id] = i; });
  }
  return _qOrdinals[id];
}

// ── Role tenure ──
// Quarters spent in the title the person holds now, as opposed to their total
// time in the House. person.titles is server-side run-length encoding of the
// title held over each quarter range (see fetch_sod.py), so the current title
// is the last segment's.
//
// Every segment carrying that title counts, not just the trailing run. Two
// reasons: SOD title strings are truncated and drift between quarters (the
// same job can read "Staff Assistant" one quarter and "Staff Assistant/Intern
// Coordin" the next), which would spuriously reset a trailing-run count; and
// it matches how House tenure above already sums quarters present rather than
// subtracting dates. Someone genuinely promoted away from a title and back
// therefore reads as their combined time in it.
//
// A segment's from..to range can span quarters the person was absent for (RLE
// merges across a gap when the title is unchanged), so this counts history
// entries inside the range rather than the range's own width — same
// quarters-actually-worked basis as personTenureQuarters.
const _roleTenureMemo = new WeakMap();
function personRoleTenureQuarters(p) {
  if (!p?.history?.length || !p.titles?.length) return 0;
  if (_roleTenureMemo.has(p)) return _roleTenureMemo.get(p);
  const current = p.titles[p.titles.length - 1].title;
  let n = 0;
  for (const seg of p.titles) {
    if (seg.title !== current) continue;
    const lo = quarterOrdinal(seg.from), hi = quarterOrdinal(seg.to);
    if (lo == null || hi == null) continue;
    for (const h of p.history) {
      const o = quarterOrdinal(h.quarter);
      if (o >= lo && o <= hi) n++;
    }
  }
  _roleTenureMemo.set(p, n);
  return n;
}

// Only House tenure can be left-censored: it's censored when the person's
// history starts at the earliest tracked quarter, and role tenure is censored
// under exactly the same condition (their current title's first segment must
// then also start there) — but only if that first segment *is* the current
// title. Someone who reaches back to the floor under a different title has a
// fully observed start date for the title they hold now.
function personRoleTenureCensored(p) {
  return !!(personTenureCensored(p) && p.titles?.[0]?.title === p.titles?.[p.titles.length - 1]?.title);
}

const TENURE_METRICS = {
  house: { label: "In the House", hint: "Overall length of service", quarters: personTenureQuarters, censored: personTenureCensored },
  role: { label: "In current role", quarters: personRoleTenureQuarters, censored: personRoleTenureCensored },
};

// Tenure-quarter counts for the staff serving in the quarter being viewed,
// optionally narrowed to one job title — same pool shape positionTrendByType
// uses for pay, so the same fullStatsFromAmounts/estimatePercentile pair works
// unmodified. `metric` picks total House time vs. time in the person's own
// current role; under "role" each pool member is measured against their own
// current title, which is what makes "median holder of this title has held it
// N years" work.
//
// The quarter filter matters a lot: peopleData is every person tracked since
// 2016, so pooling all of them mixes in careers that ended years ago, whose
// tenure stopped accruing. That drags the pool down and flatters everyone
// still serving — it moved the all-staff median from 2.8 yrs to 2.0. The
// salary block this sits under compares against a single quarter's roster
// too, so matching it keeps the two halves of the card on one cohort.
function tenurePool(titleFilter, metric) {
  if (!peopleData) return [];
  const of = (TENURE_METRICS[metric] || TENURE_METRICS.house).quarters;
  const qId = viewedQuarter().id;
  return peopleData
    .filter(p => (!titleFilter || (p.title_group || p.title) === titleFilter) && p.history.some(h => h.quarter === qId))
    .map(of)
    .filter(q => q > 0);
}

// The header stats (bar/trio/min-max/count) for a position card, preferring
// the same tenure-filtered peopleData cohort the trend chart uses — that
// excludes each quarter's brand-new hires, which is a *more* accurate read of
// "what does this role pay" than the raw roster snapshot t (from
// buildTitles()/top_titles, no tenure requirement) otherwise gives us. Keyed
// off whatever quarter is currently being viewed, not just the latest one, so
// browsing history stays consistent too. Falls back to t when peopleData
// isn't loaded yet or nobody qualifies.
function positionHeaderStats(t, type) {
  if (!peopleData) return t;
  const matches = peopleData.filter(p => (p.title_group || p.title) === t.title && (!type || p.type === type) && (!partyFilter || partyValueOf(p) === partyFilter));
  if (!matches.length) return t;
  const qId = viewedQuarter().id;
  const amounts = matches
    .map(p => p.history.find(h => h.quarter === qId))
    .filter(Boolean)
    .filter(h => h.quarterly_pay * 4 >= HOUSE_MIN_ANNUAL)
    .map(h => h.quarterly_pay * 4 * cpiFactorForId(qId));
  return fullStatsFromAmounts(amounts) || t;
}

function viewedQuarter() {
  const qs = summary.quarters;
  return viewQIdx < 0 ? qs[qs.length - 1] : qs[viewQIdx];
}

function statsFor(q) {
  const aq = adjQuarter(q);
  // by_type is pre-aggregated with no party breakdown, so a party filter has
  // to be computed client-side from the actual employee rows instead — same
  // idea as positionHeaderStats(), just for the whole population rather than
  // one title.
  if (partyFilter) {
    const isLatest = q.id === summary.quarters[summary.quarters.length - 1].id;
    const f = cpiFactorForQuarter(q);
    const rows = isLatest ? employees : buildHistoricalEmployees(q.id);
    const amounts = rows
      .filter(e => !e.intern && !e.shared && e.annual_equiv >= HOUSE_MIN_ANNUAL && (!officeTypeFilter || e.type === officeTypeFilter) && partyValueOf(e) === partyFilter)
      .map(e => e.annual_equiv * f);
    return fullStatsFromAmounts(amounts) || { median: null, mean: null, count: 0 };
  }
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
      // renderPosResults() just rebuilt the row list, so ".pos-row.active" no
      // longer exists — find the new row for this title by name instead.
      const activeRow = [...document.querySelectorAll(".pos-row")].find(r => r.querySelector(".pos-row-name")?.textContent === currentSelection.titleName);
      // selectTitle() now always prefers peopleData for the trend chart (see
      // its comment) — load it *before* re-rendering so it doesn't have to
      // hide the trend chart and re-add it a moment later (which was causing
      // the staff list to visibly jump up and the chart to flash on/off).
      await loadPeople();
      if (t) selectTitle(t, activeRow);
    } else if (currentSelection.type === "person") {
      // showPerson() (used for actual navigation to a person) force-switches
      // to the All Staff tab as a side effect — wrong here, since this is
      // just refreshing an already-open person detail after some unrelated
      // global filter changed, not a request to go anywhere. The detail row
      // already exists (applyFilters() above just rebuilt the table), so
      // refresh its contents in place instead.
      showPersonInline(currentSelection.personName, currentSelection.personOffice);
    }
  }
  saveState();
}

// Member has D/R/I; Leadership only ever resolves to D/R (see
// leadership_party_for in fetch_sod.py); everything else has no party at all.
function partyOptionsFor(type) {
  if (type === "member") return ["D", "R", "I"];
  if (type === "leadership") return ["D", "R"];
  return [];
}

function updatePartyFilterVisibility() {
  const opts = partyOptionsFor(officeTypeFilter);
  const inline = $("party-filter-inline");
  inline?.classList.toggle("visible", opts.length > 0);
  $("party-filter-i-btn")?.classList.toggle("party-filter-i-hidden", !opts.includes("I"));
  // Keep the pill physically next to whichever type button it's describing
  // (Member or Leadership), not stranded after Administrative regardless of
  // which one is active.
  if (inline && opts.length > 0) {
    const activeTypeBtn = document.querySelector(`.type-filter-btn[data-type="${officeTypeFilter}"]`);
    activeTypeBtn?.insertAdjacentElement("afterend", inline);
  }
}

async function setOfficeTypeFilter(type) {
  officeTypeFilter = type;
  document.querySelectorAll(".type-filter-btn[data-type]").forEach(b => b.classList.toggle("active", (b.dataset.type || "") === type));
  if (partyFilter && !partyOptionsFor(type).includes(partyFilter)) {
    partyFilter = "";
    document.querySelectorAll(".party-filter-btn[data-party]").forEach(b => b.classList.toggle("active", !b.dataset.party));
  }
  updatePartyFilterVisibility();

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

  await refreshOpenSelectionAndSaveState();
}

async function setPartyFilter(party) {
  partyFilter = party;
  document.querySelectorAll(".party-filter-btn[data-party]").forEach(b => b.classList.toggle("active", (b.dataset.party || "") === party));

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

  await refreshOpenSelectionAndSaveState();
}

// Re-render whatever is open in the left panel after a global filter (office
// type, party) changes, then persist the new filter state.
async function refreshOpenSelectionAndSaveState() {
  if (currentSelection) {
    if (currentSelection.type === "title") {
      const t = titles.find(x => x.title === currentSelection.titleName);
      // renderPosResults() just rebuilt the row list, so ".pos-row.active" no
      // longer exists — find the new row for this title by name instead.
      const activeRow = [...document.querySelectorAll(".pos-row")].find(r => r.querySelector(".pos-row-name")?.textContent === currentSelection.titleName);
      // selectTitle() now always prefers peopleData for the trend chart (see
      // its comment) — load it *before* re-rendering so it doesn't have to
      // hide the trend chart and re-add it a moment later (which was causing
      // the staff list to visibly jump up and the chart to flash on/off).
      await loadPeople();
      if (t) selectTitle(t, activeRow); else clearTitle();
    } else if (currentSelection.type === "person") {
      // showPerson() (used for actual navigation to a person) force-switches
      // to the All Staff tab as a side effect — wrong here, since this is
      // just refreshing an already-open person detail after some unrelated
      // global filter changed, not a request to go anywhere. The detail row
      // already exists (applyFilters() above just rebuilt the table), so
      // refresh its contents in place instead.
      showPersonInline(currentSelection.personName, currentSelection.personOffice);
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
  $("type-bars").innerHTML = ""; renderTypeBars();
  if (!isLatestQuarter()) await loadPeople();
  applyFilters();
  renderTrend();

  // Re-render whatever is open in the left panel
  if (currentSelection) {
    if (currentSelection.type === "title") {
      const t = titles.find(x => x.title === currentSelection.titleName);
      // renderPosResults() just rebuilt the row list, so ".pos-row.active" no
      // longer exists — find the new row for this title by name instead.
      const activeRow = [...document.querySelectorAll(".pos-row")].find(r => r.querySelector(".pos-row-name")?.textContent === currentSelection.titleName);
      // selectTitle() now always prefers peopleData for the trend chart (see
      // its comment) — load it *before* re-rendering so it doesn't have to
      // hide the trend chart and re-add it a moment later (which was causing
      // the staff list to visibly jump up and the chart to flash on/off).
      await loadPeople();
      if (t) selectTitle(t, activeRow); else clearTitle();
    } else if (currentSelection.type === "person") {
      // showPerson() (used for actual navigation to a person) force-switches
      // to the All Staff tab as a side effect — wrong here, since this is
      // just refreshing an already-open person detail after some unrelated
      // global filter changed, not a request to go anywhere. The detail row
      // already exists (applyFilters() above just rebuilt the table), so
      // refresh its contents in place instead.
      showPersonInline(currentSelection.personName, currentSelection.personOffice);
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

function computeStatsClient(amounts) {
  const s = amounts.slice().sort((a, b) => a - b);
  const pct = p => { const i = (s.length - 1) * p / 100, lo = Math.floor(i), hi = Math.min(lo + 1, s.length - 1); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  return { count: s.length, median: Math.round(pct(50)), p25: Math.round(pct(25)), p75: Math.round(pct(75)) };
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
  const partyLabel = partyFilter ? ` (${PARTY_NAMES[partyFilter]}s)` : "";
  if (distLabel) distLabel.textContent = `Annual salary equivalent — full-time staff${typeLabel}${partyLabel} — ${q.label}`;

  const distNote = $("dist-type-note");
  const canFilterHere = (!officeTypeFilter && !partyFilter) || isLatestQuarter();
  if (distNote) distNote.style.display = canFilterHere ? "none" : "";

  const dist = ((officeTypeFilter || partyFilter) && isLatestQuarter())
    ? computeDistributionBuckets(employees.filter(e => !e.intern && !e.shared && e.annual_equiv >= HOUSE_MIN_ANNUAL && (!officeTypeFilter || e.type === officeTypeFilter) && (!partyFilter || partyValueOf(e) === partyFilter)).map(e => e.annual_equiv))
    : q.distribution;
  const barColors = dist.map(b => {
    if (b.min < 50000)  return "#e8e5df";
    if (b.min < 80000)  return "#95cd9e";
    if (b.min < 130000) return "#1b6f2c";
    return "#0e3d1a";
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
  const q = adjQuarter(viewedQuarter());
  if (!q) return;
  const max = 220000, pct = v => Math.min(100, v/max*100);
  const c = $("type-bars"); c.innerHTML = "";
  // This tab is for comparing types against each other, so it ignores the
  // global office-type filter on purpose — filtering it down to one type
  // would defeat the point. Inflation adjustment still applies, though —
  // unlike the type filter, that's not something this comparison should skip.
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

    // Member: broken down by caucus (the conference a member actually sits
    // with, not their own registration — a nominal independent who caucuses
    // with a party lands in that party's bucket instead of a meaningless
    // third one). Leadership: broken down by which party holds each office
    // (Speaker/Majority/Minority resolved via the Clerk's majority/minority
    // flag, Democratic Caucus/Republican Conference named outright). Neither
    // applies to Committee — the SOD data doesn't separate majority/minority
    // committee staff into their own office lines, so there's no real signal
    // to bucket on.
    const partyKey = type === "member" ? (e => e.party?.caucus) : type === "leadership" ? (e => e.leadership_party) : null;
    if (partyKey) {
      const src = currentEmployeeSource().filter(e => !e.intern && !e.shared && e.type === type && partyKey(e));
      const sub = document.createElement("div"); sub.className = "type-subrows";
      ["D", "R"].forEach(party => {
        const amts = src.filter(e => partyKey(e) === party).map(e => e.annual_equiv);
        if (!amts.length) return;
        const st = computeStatsClient(amts);
        const ccol = party === "D" ? "#2563eb" : "#dc2626";
        const label = party === "D" ? "Democrats" : "Republicans";
        const subRow = document.createElement("div"); subRow.className = "type-row type-subrow";
        subRow.innerHTML = `
          <div class="type-label">${label}<br><span class="type-label-sub">${st.count.toLocaleString()} staff</span></div>
          <div class="type-track-wrap">
            <div class="type-track type-bg"></div>
            <div class="type-track type-iqr" style="left:${pct(st.p25)}%;width:${pct(st.p75)-pct(st.p25)}%;background:${ccol}"></div>
            <div class="type-track type-needle" style="left:${pct(st.median)}%;background:${ccol}"></div>
          </div>
          <span class="type-val" style="color:${ccol}">${fmtK(st.median)}</span>`;
        sub.appendChild(subRow);
      });
      if (sub.children.length) c.appendChild(sub);
    }
  });
  const leg = document.createElement("div");
  leg.style.cssText = "margin-top:14px;font-size:.7rem;color:#888;display:flex;gap:16px";
  leg.innerHTML = "<span>Bar = 25th–75th percentile</span><span>Line = median</span>";
  c.appendChild(leg);
}

const TYPE_COLORS_TREND = TYPE_COLORS;

function renderTrend() {
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
      id: "overall", label: METRIC_LABELS[trendMetric], color: "#1b6f2c", fill: true,
      data: allQs.map(q => { const aq = adjQuarter(q); return officeTypeFilter ? (aq.by_type[officeTypeFilter]?.[trendMetric] ?? null) : aq.overall[trendMetric]; }),
    }], hlOpts);

  } else if (trendMode === "type") {
    // Always compares all four types against each other regardless of the
    // global office-type filter — that's the point of this view, and
    // narrowing it to one line would just duplicate the Overall chart.
    const datasets = ["member","committee","leadership","administrative"].map(type => ({
      id: type, label: TYPE_LABELS[type],
      data: allQs.map(q => q.by_type[type]?.[trendMetric] ?? null),
      color: TYPE_COLORS_TREND[type], fill: false,
    }));
    drawSvgLineChart($("chart-trend"), labels, datasets, { legend: true, ...hlOpts });
  }
  renderTenureChart();
}

const TENURE_BUCKETS = [
  { label: "<1 yr",    min: 0,  max: 4 },
  { label: "1–3 yrs",  min: 4,  max: 12 },
  { label: "3–5 yrs",  min: 12, max: 20 },
  { label: "5–10 yrs", min: 20, max: 40 },
  { label: "10+ yrs",  min: 40, max: Infinity },
];

// Median pay by tenure bucket, latest quarter only — peopleData (which has
// tenure) only covers non-intern/non-shared staff with 3+ tracked quarters,
// same population the buckets are drawn from, so nobody with 0-2 quarters
// (too new to have a tenure figure at all) silently lands in "<1 yr".
function renderTenureChart() {
  const wrap = $("chart-tenure-wrap");
  if (!wrap) return;
  if (!peopleData) { wrap.innerHTML = `<div style="padding:24px 0;color:var(--ink3);font-size:.85rem">Loading…</div>`; return; }

  const tenureByPerson = new Map();
  peopleData.forEach(p => tenureByPerson.set(`${p.name}|${p.office}`, personTenureQuarters(p)));

  const buckets = TENURE_BUCKETS.map(b => ({ ...b, amounts: [] }));
  employees.filter(e => !e.intern && !e.shared && e.annual_equiv >= HOUSE_MIN_ANNUAL && (!officeTypeFilter || e.type === officeTypeFilter) && (!partyFilter || partyValueOf(e) === partyFilter)).forEach(e => {
    const q = tenureByPerson.get(`${e.name}|${cleanOrg(e.office)}`);
    if (!q) return;
    const bucket = buckets.find(b => q >= b.min && q < b.max);
    if (bucket) bucket.amounts.push(e.annual_equiv);
  });

  if (!buckets.some(b => b.amounts.length)) {
    wrap.innerHTML = `<div style="padding:24px 0;color:var(--ink3);font-size:.85rem">No tenure data for the current filters.</div>`;
    return;
  }

  const stats = buckets.map(b => ({ ...b, stats: fullStatsFromAmounts(b.amounts) }));
  const W = 680, H = 240;
  const pad = { t: 16, r: 16, b: 40, l: 52 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const maxMedian = Math.max(...stats.map(s => s.stats?.median || 0)) || 1;
  const yStep = Math.ceil(maxMedian / 5 / 10000) * 10000 || 10000;
  const yMax = yStep * 5;
  const sy = v => pad.t + ph - (v / yMax) * ph;

  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const v = i * yStep, y = sy(v);
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eeece8" stroke-width="1"/>
            <text x="${(pad.l - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">$${Math.round(v/1000)}k</text>`;
  }).join("");

  const barW = pw / stats.length;
  const barGap = Math.max(1, barW * 0.18);
  const bars = stats.map((s, i) => {
    const median = s.stats?.median || 0;
    const bh = (median / yMax) * ph;
    const x = pad.l + i * barW + barGap / 2;
    const w = barW - barGap;
    const y = pad.t + ph - bh;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" fill="#1b6f2c" rx="2"/>
      <text x="${(x + w/2).toFixed(1)}" y="${(pad.t + ph + 16).toFixed(1)}" text-anchor="middle" font-size="11" fill="#888">${s.label}</text>
      <text x="${(x + w/2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="#555">${s.stats ? fmtK(median) : "—"}</text>`;
  }).join("");

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%">${yTicks}${bars}</svg>`;
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
  const c = $("pos-results");

  // Keyed by title so a re-render (search narrowing, filter/quarter change,
  // or peopleData arriving in the background) can tell which rows are the
  // same position — tween their count/median and slide to their new rank —
  // vs. genuinely new, instead of the whole list popping to a new state.
  const priorRects = new Map(), priorVals = new Map();
  c.querySelectorAll(".pos-row").forEach(row => {
    const key = row.dataset.key;
    if (!key) return;
    priorRects.set(key, row.getBoundingClientRect());
    priorVals.set(key, {
      count: parseInt(row.querySelector(".pos-row-count")?.textContent.replace(/[^\d]/g, ""), 10) || null,
      median: parseShortMoney(row.querySelector(".pos-row-median")?.textContent),
    });
  });

  c.innerHTML = "";
  if (!hits.length) {
    c.innerHTML = `<div style="padding:10px 12px;font-size:.82rem;color:#888">No matches.</div>`;
    return;
  }
  hits.forEach(t => {
    // Same tenure-filtered stats as the card this row opens into (see
    // positionHeaderStats()) — otherwise this preview number and the card's
    // own trio disagree the moment you click through.
    const hs = positionHeaderStats(t, officeTypeFilter);
    const key = esc(t.title);
    const el = document.createElement("div"); el.className = "pos-row pos-row-in"; el.dataset.key = key;
    el.innerHTML = `<span class="pos-row-name">${esc(t.title)}</span><span class="pos-row-count">${hs.count.toLocaleString()} staff</span><span class="pos-row-median" title="Median annual equivalent · full-time staff">${fmtK(hs.median)}</span>`;
    el.addEventListener("click", async () => {
      // selectTitle() always prefers peopleData for the trend chart now, so
      // load it first rather than opening with the top_titles fallback and
      // having the trend numbers visibly tween to different values a moment
      // later once peopleData arrives.
      await loadPeople();
      selectTitle(t, el);
    });
    c.appendChild(el);
  });

  if (priorRects.size) {
    morphKeyedRows(c, ".pos-row", priorRects);
    c.querySelectorAll(".pos-row").forEach(row => {
      const prior = priorVals.get(row.dataset.key);
      if (!prior) return;
      const t = hits.find(x => esc(x.title) === row.dataset.key);
      if (!t) return;
      const hs = positionHeaderStats(t, officeTypeFilter);
      animatePositionNumberText(row.querySelector(".pos-row-count"), prior.count, hs.count, v => `${Math.round(v).toLocaleString()} staff`);
      animatePositionNumberText(row.querySelector(".pos-row-median"), prior.median, hs.median, fmtK);
    });
  }
}

let preTitleTab = null; // tab that was active before a position replaced it, so clearTitle() can restore it
let lastPositionTrend = null; // trend controller for the currently-shown position card, so the next selectTitle() can seed its chart from this one's last view instead of resetting
let lastPersonTrend = null;   // same idea, for the person-detail pay-history chart — {name, office, controller}

// Parses "$75k" / "$4.3k" / "$900" (from fmtSh) back into a raw number so we
// can tween between an old and new displayed value.
function parseShortMoney(str) {
  if (!str) return null;
  const m = String(str).match(/\$([\d.]+)(k)?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] ? n * 1000 : n;
}

// Parses "$358,273" (from fmt(), full precision — used by the staff list, not
// the shorthand fmtSh/fmtK the trio/sidebar use) back into a raw number.
// Matches just the $-prefixed digit group so a leading cap-warn icon's text
// in the same element doesn't confuse it.
function parseFullMoney(str) {
  if (!str) return null;
  const m = String(str).match(/\$([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
}

// FLIP-moves each row in newContainer that has a match in priorRects (keyed
// by data-key) from its old screen position to its new one, and fades/rises
// in any row with no prior match — used so a keyed list re-render reads as
// "these items moved/updated" instead of the whole list popping to a new
// state. priorRects: Map<key, DOMRect>. rowSelector's elements must each
// carry a data-key attribute.
function morphKeyedRows(newContainer, rowSelector, priorRects) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rows = newContainer.querySelectorAll(rowSelector);
  rows.forEach(row => {
    const key = row.dataset.key;
    const priorRect = key && priorRects.get(key);
    if (!priorRect) return; // no match — template's own fade/rise-in animation (if any) plays instead
    row.classList.remove("range-staff-row-in", "pos-row-in");
    const newRect = row.getBoundingClientRect();
    const dy = priorRect.top - newRect.top;
    if (Math.abs(dy) < 1) return;
    row.style.transition = "none";
    row.style.transform = `translateY(${dy}px)`;
    void row.offsetWidth; // force reflow so the "from" position paints before transitioning
    requestAnimationFrame(() => {
      row.style.transition = "transform 380ms cubic-bezier(.4,0,.2,1)";
      row.style.transform = "";
    });
  });
}

// Animates a value-carrying element's text from an explicit old value to a
// new number, formatting each frame with fmtFn. fromVal must be captured
// from the DOM *before* it's overwritten with the new value — by the time
// this runs, el already shows toVal (it was just rendered from a template),
// so we can't read the "from" state off the element itself (unlike the
// hero-stats animateNumberText() above, which animates in place without a
// template swap and so can read its own "from" value).
function animatePositionNumberText(el, fromVal, toVal, fmtFn, duration = 450) {
  if (!el) return;
  if (fromVal == null || toVal == null) { el.textContent = fmtFn(toVal); return; }
  el.textContent = fmtFn(fromVal);
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / duration);
    const e = MINI_EASE_CUBIC(t);
    el.textContent = fmtFn(fromVal + (toVal - fromVal) * e);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function selectTitle(t, el, forcedTrendUI) {
  if (currentSelection?.type !== "title") {
    preTitleTab = document.querySelector(".tab-btn.active")?.dataset.tab || "dist";
  }
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const posView = $("position-view");
  const isUpdate = !reduceMotion && !!posView.querySelector(".range-card");

  // Capture the currently-rendered bar/needle position and numbers before we
  // overwrite the DOM, so the new card can transition/tween from them instead
  // of popping straight to the new state.
  let priorBar = null, priorNums = null;
  if (isUpdate) {
    const fillEl = posView.querySelector(".range-bar-fill");
    const needleEl = posView.querySelector(".range-bar-needle");
    if (fillEl && needleEl) {
      priorBar = { left: fillEl.style.left, width: fillEl.style.width, needleLeft: needleEl.style.left };
    }
    const trioEls = posView.querySelectorAll(".range-trio-val");
    const minMaxEls = posView.querySelectorAll(".range-min-max span");
    const countEl = posView.querySelector(".range-card-count");
    const p10El = posView.querySelector(".range-bar-labels span:first-child .range-bar-label-val");
    const p90El = posView.querySelector(".range-bar-labels span:last-child .range-bar-label-val");
    if (trioEls.length === 3 && minMaxEls.length === 2) {
      priorNums = {
        p25: parseShortMoney(trioEls[0].textContent),
        median: parseShortMoney(trioEls[1].textContent),
        p75: parseShortMoney(trioEls[2].textContent),
        min: parseShortMoney(minMaxEls[0].textContent),
        max: parseShortMoney(minMaxEls[1].textContent),
        count: countEl ? parseInt(countEl.textContent.replace(/,/g, ""), 10) : null,
        p10: p10El ? parseShortMoney(p10El.textContent) : null,
        p90: p90El ? parseShortMoney(p90El.textContent) : null,
      };
    }
  }
  // Keyed by "name|office" so the new staff list can tell which rows are the
  // same person (tween their $ amount, slide to their new rank) vs. genuinely
  // new/removed (fade in/skip) — see morphKeyedRows().
  const priorStaffRects = new Map(), priorStaffAmounts = new Map();
  if (isUpdate) {
    posView.querySelectorAll(".range-staff-row").forEach(row => {
      const key = row.dataset.key;
      if (!key) return;
      priorStaffRects.set(key, row.getBoundingClientRect());
      priorStaffAmounts.set(key, parseFullMoney(row.querySelector(".range-staff-amt")?.textContent));
    });
  }
  const seedTrend = isUpdate ? lastPositionTrend?.getPrev() : null;
  // Preserve the mini trend chart's own metric/quarter-filter selection across
  // a re-render — office-type/quarter/inflation changes (and switching to a
  // different position) rebuild this card from scratch, which was silently
  // snapping an active "Q1" selection back to "All" every time. On a fresh
  // page load there's no prior DOM to read this from, so restoreHash() passes
  // whatever was saved in the URL instead.
  const priorTrendUI = forcedTrendUI || (isUpdate ? {
    metric: posView.querySelector(".mini-pill.active")?.dataset.metric || "median",
    qf: +(posView.querySelector(".mini-q.active")?.dataset.q || 0),
  } : null);

  currentSelection = { type: "title", titleName: t.title };
  document.querySelectorAll(".pos-row").forEach(r => r.classList.remove("active"));
  el?.classList.add("active");
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
  $("tab-position").classList.add("active");
  setHash({ pos: t.title, pmetric: priorTrendUI?.metric, pq: priorTrendUI?.qf });
  // Bar/trio/min-max/count read from hs, not t directly — see
  // positionHeaderStats()'s comment for why the tenure-filtered peopleData
  // cohort is preferred over the raw current-roster snapshot when available.
  // (Requires data/people.json's title/type/office fields to reflect each
  // person's current role, not their oldest — see fetch_sod.py's
  // strip_org_prefix()/people_index comments; regenerated as of this fix.)
  const hs = positionHeaderStats(t, officeTypeFilter);
  const max = Math.max(hs.max||0, 220000), pct = v => Math.min(100, v/max*100);

  // `employees` only ever holds the latest quarter's roster — for a historical
  // quarter this staff list would silently show today's people standing next
  // to that older quarter's percentiles, so it's gated to isLatestQuarter()
  // below instead of rendering a mismatched list.
  const staff = isLatestQuarter() ? employees
    .filter(e => !e.intern && !e.shared && (e.title_group || e.title) === t.title && (!officeTypeFilter || e.type === officeTypeFilter) && (!partyFilter || partyValueOf(e) === partyFilter))
    .sort((a,b) => b.annual_equiv - a.annual_equiv) : [];

  // top_titles (the fast synchronous path, available before peopleData loads)
  // is a full per-quarter population snapshot with no tenure requirement and
  // is never broken out by office type. peopleData is longitudinal — only
  // people with 3+ quarters of tenure — which gives a very different slope
  // even for "All types" (survivorship bias skews it upward). Mixing the two
  // depending on whether a type filter happened to be set made the trend look
  // internally inconsistent (an "All" figure that couldn't be reconciled with
  // its own type breakdown), so once peopleData is available this always
  // switches to it — for every type, including "All" — so the whole chart is
  // drawn from one consistent population.
  let trendGetDataFn = (metric, qf) => filteredQuarters(qf).map(q => {
    const found = (adjQuarter(q).top_titles || []).find(x => x.title === t.title);
    return found ? found[metric] : null;
  });
  let trendData = trendGetDataFn("median", 0);

  const typeTrendFn = positionTrendByType(t.title, officeTypeFilter || null);
  if (typeTrendFn) {
    // This deliberately does NOT match t (the header trio/bar, built from
    // the full current roster with no tenure requirement) — a trend needs a
    // consistent cohort over time, and peopleData's 3+-quarter tenure filter
    // is what makes that possible: it tracks the same people release to
    // release instead of diluting "how has pay changed" with this quarter's
    // brand-new hires, who have no history to show a trend with anyway.
    trendGetDataFn = typeTrendFn;
    trendData = typeTrendFn("median", 0);
  } else if (!peopleData) {
    loadPeople().then(() => {
      if (currentSelection?.type === "title" && currentSelection.titleName === t.title) {
        selectTitle(t, document.querySelector(".pos-row.active"));
      }
    });
  } else if (officeTypeFilter) {
    trendData = []; // peopleData loaded but nobody with this title+type has 3+ quarters of history
  }
  const hasTrend = trendData.filter(v => v != null).length >= 2;

  const staffHtml = staff.length ? `
    <div class="range-staff-list">
      <div class="range-staff-heading">Staff with this title</div>
      ${staff.slice(0,30).map((e, i) => {
        const over = e.annual_equiv > SALARY_CAP;
        const key = `${esc(e.name)}|${esc(cleanOrg(e.office))}`;
        return `<div class="range-staff-row range-staff-row-in" style="--i:${i}" data-key="${key}">
          <span class="range-staff-name person-link" data-name="${esc(e.name)}" data-office="${esc(cleanOrg(e.office))}">${esc(e.name)}</span>
          <span class="range-staff-office office-link" data-office="${esc(cleanOrg(e.office))}">${esc(cleanOrg(e.office))}</span>
          <span class="range-staff-amt">${over?`<span class="cap-warn" title="May include bonus/lump sum">⚠</span> `:""}<span class="range-staff-amt-val">${fmt(e.annual_equiv)}</span></span>
        </div>`;
      }).join("")}
      ${staff.length>30?`<div class="range-staff-more">+${staff.length-30} more</div>`:""}
    </div>` : (isLatestQuarter() ? "" : `<div class="office-detail-empty" style="font-size:.75rem;margin-top:12px">Individual staff data only available for the latest quarter.</div>`);

  posView.innerHTML = `
    <div class="range-card">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div>
        <div class="range-card-title">${esc(t.title)}</div>
        <div class="range-card-sub"><span class="range-card-count">${hs.count.toLocaleString()}</span> employees${(officeTypeFilter && isLatestQuarter()) ? ` · ${TYPE_LABELS[officeTypeFilter]} offices` : ""} · ${isLatestQuarter() ? "latest quarter" : esc(viewedQuarter().label)} · annual equivalent</div>
      </div>
      <button onclick="clearTitle()" style="background:none;border:none;cursor:pointer;color:var(--ink3);font-size:1.1rem;line-height:1;padding:2px;flex-shrink:0;margin-top:2px">&times;</button>
    </div>
    <div class="range-bar-wrap">
      <div class="range-bar-track">
        <div class="range-bar-fill" style="left:${pct(hs.p10)}%;width:${pct(hs.p90)-pct(hs.p10)}%"></div>
        <div class="range-bar-needle" style="left:${pct(hs.median)}%"></div>
      </div>
      <div class="range-bar-labels"><span><span class="range-bar-label-val">${fmtSh(hs.p10)}</span> (P10)</span><span><span class="range-bar-label-val">${fmtSh(hs.p90)}</span> (P90)</span></div>
    </div>
    <div class="range-trio">
      <div class="range-trio-cell"><div class="range-trio-val">${fmtSh(hs.p25)}</div><div class="range-trio-key">25th pct.</div></div>
      <div class="range-trio-cell"><div class="range-trio-val">${fmtSh(hs.median)}</div><div class="range-trio-key">Median</div></div>
      <div class="range-trio-cell"><div class="range-trio-val">${fmtSh(hs.p75)}</div><div class="range-trio-key">75th pct.</div></div>
    </div>
    <div class="range-min-max"><span>Min: ${fmtSh(hs.min)}</span><span>Max: ${fmtSh(hs.max)}</span></div>
    ${hasTrend ? miniTrendHtml("mini-pos-trend-wrap", "Salary trend", priorTrendUI) : ""}
    ${staffHtml}
    </div>`;

  // Transform the range bar in from its previous position/width instead of
  // popping to the new one, when we're updating an already-open card.
  const fillEl = posView.querySelector(".range-bar-fill");
  const needleEl = posView.querySelector(".range-bar-needle");
  if (priorBar && fillEl && needleEl) {
    fillEl.style.transition = "none";
    needleEl.style.transition = "none";
    fillEl.style.left = priorBar.left;
    fillEl.style.width = priorBar.width;
    needleEl.style.left = priorBar.needleLeft;
    void posView.offsetWidth; // force reflow so the "from" state paints before transitioning
    requestAnimationFrame(() => {
      fillEl.style.transition = "left 450ms cubic-bezier(.4,0,.2,1), width 450ms cubic-bezier(.4,0,.2,1)";
      needleEl.style.transition = "left 450ms cubic-bezier(.4,0,.2,1)";
      fillEl.style.left = `${pct(hs.p10)}%`;
      fillEl.style.width = `${pct(hs.p90)-pct(hs.p10)}%`;
      needleEl.style.left = `${pct(hs.median)}%`;
    });
  }

  // Scroll the trio/min/max numbers from their previous values instead of
  // snapping — mirrors the y-axis tick animation in renderDist().
  if (priorNums) {
    const trioEls = posView.querySelectorAll(".range-trio-val");
    animatePositionNumberText(trioEls[0], priorNums.p25, hs.p25, fmtSh);
    animatePositionNumberText(trioEls[1], priorNums.median, hs.median, fmtSh);
    animatePositionNumberText(trioEls[2], priorNums.p75, hs.p75, fmtSh);
    const minMaxEls = posView.querySelectorAll(".range-min-max span");
    animatePositionNumberText(minMaxEls[0], priorNums.min, hs.min, v => `Min: ${fmtSh(v)}`);
    animatePositionNumberText(minMaxEls[1], priorNums.max, hs.max, v => `Max: ${fmtSh(v)}`);
    animatePositionNumberText(posView.querySelector(".range-card-count"), priorNums.count, hs.count, v => Math.round(v).toLocaleString());
    const labelValEls = posView.querySelectorAll(".range-bar-label-val");
    animatePositionNumberText(labelValEls[0], priorNums.p10, hs.p10, fmtSh);
    animatePositionNumberText(labelValEls[1], priorNums.p90, hs.p90, fmtSh);
  }

  // Staff list: rows for the same person slide to their new rank and tween
  // their $ amount instead of the whole list popping to a new state; rows
  // with no prior match keep the template's fade/rise-in.
  if (priorStaffRects.size) {
    morphKeyedRows(posView, ".range-staff-row", priorStaffRects);
    posView.querySelectorAll(".range-staff-row").forEach(row => {
      const key = row.dataset.key;
      if (!priorStaffRects.has(key)) return;
      animatePositionNumberText(row.querySelector(".range-staff-amt-val"), priorStaffAmounts.get(key), staff.find(e => `${esc(e.name)}|${esc(cleanOrg(e.office))}` === key)?.annual_equiv, fmt);
    });
  }

  if (hasTrend) {
    const wrap = document.getElementById("mini-pos-trend-wrap");
    lastPositionTrend = wrap ? makeMiniTrend(wrap, trendGetDataFn, seedTrend) : null;
  } else {
    lastPositionTrend = null;
  }
  if (window.innerWidth <= 900) {
    $("tab-position").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ── Person modal ──
function closePersonDetail() {
  document.querySelectorAll(".emp-detail-row").forEach(row => row.style.display = "none");
  currentSelection = null;
  lastPersonTrend = null;
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

  // The detail opens correctly at this point, but without scrolling to it
  // it renders below the fold (the page is still wherever it was before the
  // tab switch) and looks like nothing happened — same pattern as
  // jumpToOffice/jumpToTitle below.
  const detailId = `emp-detail-${esc(name).replace(/\s+/g,"-").toLowerCase()}`;
  $(detailId)?.scrollIntoView({ behavior: "smooth", block: "center" });
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

  const labelMap = {};
  summary.quarters.forEach(q => labelMap[q.id] = q.label);

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
      const sign = diff >= 0 ? "+" : "−";
      const color = diff >= 0 ? "#059669" : "#dc2626";
      yoyHtml = `<div class="emp-detail-yoy">
        <span style="color:${color};font-weight:700">${sign}${fmtK(Math.abs(diff))} (${sign}${Math.abs(pct)}%)</span>
        <span class="emp-detail-yoy-label">vs. ${labelMap[priorId] || priorId} · same quarter last year</span>
      </div>`;
    }
  }

  // "Previously" — two sources, newest first:
  // 1. Title changes within this same office — person.titles is the
  //    server-side run-length-encoded title history, so a promotion/lateral
  //    move that never left this office shows up directly.
  // 2. Walking backward through every peopleData entry sharing this name,
  //    each time picking the one whose whole tracked stint ended most
  //    recently before the current stint's start, so a person who moved
  //    through several offices shows their full chain, not just one hop.
  //    Same-name matching is inherently best-effort (no ID to key on in the
  //    underlying SOD data), so the chain stops the moment a gap exceeds a
  //    year — a prior stint further back than that reads more like an
  //    unrelated same-name coincidence than an actual career move.
  let prevHtml = "";
  const prevRoleEntries = []; // hoisted out of the `if (person)` block below so the chart-wiring code further down can mark these quarter boundaries too
  if (person) {
    const firstQuarter = p => p.history.reduce((min, h) => h.quarter < min ? h.quarter : min, p.history[0].quarter);
    const lastQuarter = p => p.history.reduce((max, h) => h.quarter > max ? h.quarter : max, p.history[0].quarter);

    const entries = prevRoleEntries;
    // person.titles is precomputed server-side as run-length-encoded title
    // segments (see fetch_sod.py) — every entry but the last is a completed
    // same-office title change.
    const titleSegs = person.titles || [];
    for (let i = 0; i < titleSegs.length - 1; i++) {
      entries.push({ title: titleSegs[i].title, newTitle: titleSegs[i + 1].title, office: officeName, until: titleSegs[i].to });
    }
    entries.reverse();

    const used = new Set([officeName]);
    let cursorFirst = firstQuarter(person);
    for (;;) {
      let best = null;
      (peopleData || []).forEach(p => {
        if (p.name !== name || used.has(p.office) || !p.history.length) return;
        const last = lastQuarter(p);
        if (last < cursorFirst && (!best || last > lastQuarter(best))) best = p;
      });
      if (!best) break;
      const [y, q] = cursorFirst.split("Q");
      if (lastQuarter(best) < `${+y - 1}Q${q}`) break; // gap too big — stop the chain here
      entries.push({ title: best.title, office: best.office, until: lastQuarter(best) });
      used.add(best.office);
      cursorFirst = firstQuarter(best);
    }

    if (entries.length) {
      // Office is always shown as a hover tooltip rather than inline text —
      // spelling out "at HON. SO-AND-SO" for every entry made the line hard
      // to scan, especially once several title changes stack up. The
      // office-link class keeps it clickable/navigable even though it's no
      // longer visible by default.
      prevHtml = `<div class="emp-detail-prev">Previously: ${entries.map(e =>
        `<strong class="office-link" data-office="${esc(e.office)}" title="${esc(e.office)}">${esc(e.title)}</strong> <span class="emp-detail-prev-until">(through ${labelMap[e.until] || e.until})</span>`
      ).join(", ")}</div>`;
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
    chartHtml = `<div class="emp-detail-section">Pay history · annual equivalent</div>${qFilterHtml}<div class="emp-detail-chart mini-chart-wrap" id="emp-detail-chart"></div>`;
  } else {
    chartHtml = `<div style="font-size:.82rem;color:var(--ink3);margin:16px 0">No multi-quarter history — this person may have joined recently or changed offices.</div>`;
  }

  // Comparison section
  const allTitles = summary.quarters[summary.quarters.length - 1]?.top_titles || [];
  const compTitle = latestEmp?.title || person?.title || "";
  const overallStats = adjQuarter(viewedQuarter()).overall;
  const compHtml = latestEmp ? `
    <div class="emp-detail-section">
      Compare to: <span id="ed-comp-title" class="emp-comp-title-link">${esc(compTitle)}</span><button id="ed-comp-undo" class="ed-comp-undo" type="button" style="display:none" title="Back to the previous comparison" aria-label="Back to the previous comparison">&#8592;</button>
    </div>
    <div class="ed-comp-wrap" id="ed-comp-wrap" style="display:none">
      <div class="ed-comp-allstaff" id="ed-comp-allstaff" data-title="${ALL_STAFF_KEY}">
        <span class="ed-comp-result-title">All staff</span><span class="ed-comp-result-med">${fmtK(overallStats.median)}</span>
      </div>
      <input id="ed-comp-search" class="ed-comp-input" placeholder="Search a title…" autocomplete="off" />
      <div id="ed-comp-results" class="ed-comp-results"></div>
    </div>
    <div class="emp-detail-section">Salary</div>
    <div id="ed-comp-stats"></div>
    <div id="ed-tenure-stats"></div>` : "";

  const salaryBlockHtml = latestEmp ? `
    <div class="emp-detail-salary-row">
      <button class="emp-detail-salary" id="ed-salary-val" type="button" title="Click to try a different salary">${over ? `<span class="cap-warn">⚠</span> ` : ""}${fmt(latestEmp.annual_equiv)}<span class="ed-salary-pencil">✎</span></button>
      <span class="emp-detail-salary ed-salary-input-wrap" id="ed-salary-input-wrap" style="display:none">
        <span class="ed-salary-prefix">$</span><input type="text" inputmode="numeric" name="ed-salary-test-${Date.now()}" autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" class="ed-salary-input" id="ed-salary-input" />
      </span>
      <span class="ed-salary-pill" id="ed-salary-pill" style="display:none">Testing <span class="ed-salary-reset" id="ed-salary-reset">✕</span></span>
    </div>
    <div class="emp-detail-salary-sub">est. annual · latest quarter</div>` : "";

  // A little easter egg — this specific (name, office) pair is the site's
  // own author, so their entry gets an actual photo next to it instead of
  // the plain name/office block everyone else gets.
  const isAuthorProfile = name === "Evan M. Hollander" && officeName === "HON. JOHN B. LARSON";
  const nameBlockHtml = `
    <div class="emp-detail-name">${esc(name)}</div>
    <div class="emp-detail-meta"><span class="office-link with-party-badge" data-office="${esc(officeName)}">${esc(officeName)}${officePartyBadge(latestEmp || person || {})}</span>${latestEmp ? ` · <span class="title-link" data-title="${esc(latestEmp.title)}">${esc(latestEmp.title)}</span>` : ""}</div>`;

  detail.innerHTML = `
    ${isAuthorProfile
      ? `<div class="emp-detail-header-row"><img class="emp-detail-photo" src="https://cdn.evanhollander.org/profile.webp" alt="" /><div>${nameBlockHtml}</div></div>`
      : nameBlockHtml}
    ${prevHtml}
    ${salaryBlockHtml}
    ${yoyHtml}
    ${chartHtml}
    ${compHtml}`;

  // Wire chart — makeMiniTrend() is the same value-morph/zoom-transition
  // engine already used for the position card and office trend charts, so
  // switching between All/Q1–Q4 here gets the same animated transition
  // instead of the plain instant swap this used to do.
  //
  // showPersonInline() rebuilds detail.innerHTML from scratch any time
  // something global changes (inflation toggle, quarter nav) while this
  // person's card happens to already be open — including a fresh
  // makeMiniTrend() instance with no memory of the previous one, which is
  // why toggling inflation used to make the chart jump straight to its new
  // values instead of morphing. Seeding the new instance with the old one's
  // last view (same trick used for the position card across a re-render)
  // fixes that — but only when it's genuinely the same person re-rendering,
  // not a fresh navigation to someone else, where an instant first render
  // is correct.
  if (person) {
    const firstTrackedQuarter = person.history.reduce((min, h) => h.quarter < min ? h.quarter : min, person.history[0].quarter);
    const getPersonData = () => summary.quarters.map(q => {
      const h = person.history.find(h => h.quarter === q.id);
      return h ? h.quarterly_pay * 4 * cpiFactorForQuarter(q) : null;
    });
    const seed = (lastPersonTrend && lastPersonTrend.name === name && lastPersonTrend.office === officeName)
      ? lastPersonTrend.controller.getPrev() : null;
    // Title segments for the All-quarters view only — run-length-encodes
    // this person's own tracked history by title, so each stretch of the
    // timeline can be labeled with whichever title applied *during* it
    // (centered in that stretch) rather than repeating "old -> new" at every
    // transition line, which reads fine for one change but stacks into
    // illegible repeated text with two or more. A stint at a *different*
    // office (from the "Previously" chain) falls outside this chart's own
    // timeline and is silently dropped by makeMiniTrend (it only keeps
    // segments whose quarter ids are actually present in the current view).
    const titleSegments = (person.titles || []).map(t => ({ fromId: t.from, toId: t.to, title: t.title }));
    const controller = makeMiniTrend(detail, getPersonData, seed, firstTrackedQuarter, titleSegments, true);
    lastPersonTrend = { name, office: officeName, controller };
  } else {
    lastPersonTrend = null;
  }

  // Wire comparison
  if (latestEmp) {
    // A hypothetical salary the user is trying on — null means "use the real,
    // reported figure". Never written back to latestEmp/data, purely a local
    // what-if so someone can test a raise or sanity-check a correction before
    // it's real.
    let salaryOverride = null;
    let currentCompTitle = compTitle;

    function renderCompStats(titleStr) {
      currentCompTitle = titleStr;
      const ts = titleStr === ALL_STAFF_KEY ? overallStats : allTitles.find(t => t.title === titleStr);
      const el = detail.querySelector("#ed-comp-stats");
      if (!el) return;
      if (!ts) { el.innerHTML = `<div style="font-size:.78rem;color:var(--ink3);padding:6px 0">No salary data for this title.</div>`; return; }
      const you = salaryOverride != null ? salaryOverride : latestEmp.annual_equiv;
      const pctileNum = estimatePercentile(you, ts);
      const pctile = pctileNum != null ? `${ordinal(pctileNum)} percentile` : "";
      const whoLabel = salaryOverride != null ? "Hypothetical" : esc(name);
      const youRow = `<div class="emp-detail-comp-row emp-detail-comp-you${salaryOverride != null ? " emp-detail-comp-you-hypo" : ""}"><span>${whoLabel} ${pctile ? `<span style="font-weight:400;font-size:.72rem;opacity:.7">${pctile}</span>` : ""}</span><span>${fmtK(you)}</span></div>`;
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

    // Tenure — laid out exactly like the salary comparison above (25th /
    // median / 75th of the pool, with this person's own row slotted into
    // where they actually fall), just pooled from peopleData's tracked-quarter
    // counts instead of the precomputed per-title pay stats, since tenure
    // isn't in summary.json. Skipped entirely (not "0 percentile") for anyone
    // without tracked history, per people.json's 3+ quarter floor.
    //
    // There's no "vs. all staff" row: the pool follows the same Compare-to
    // title as the salary block, and that selector already offers All staff.
    //
    // The heading and its toggle live in here rather than the static markup so
    // they disappear along with the rows for anyone with no tracked history —
    // an orphaned heading over nothing is worse than no section at all. That
    // means the toggle's buttons are rebuilt on every render, so the chosen
    // metric is held out here in the closure instead of read back off the DOM.
    let tenureMetric = "house";

    function renderTenureStats(titleStr) {
      const el = detail.querySelector("#ed-tenure-stats");
      if (!el) return;
      const metric = TENURE_METRICS[tenureMetric];
      const you = person ? metric.quarters(person) : 0;
      if (!you) { el.innerHTML = ""; return; }

      const titleFilter = titleStr && titleStr !== ALL_STAFF_KEY ? titleStr : null;
      const ts = fullStatsFromAmounts(tenurePool(titleFilter, tenureMetric));
      const pills = Object.entries(TENURE_METRICS).map(([k, m]) =>
        `<button class="mini-pill${k === tenureMetric ? " active" : ""}" data-tenure-metric="${k}"${m.hint ? ` title="${esc(m.hint)}"` : ""}>${m.label}</button>`).join("");
      const head = `<div class="emp-detail-section-row">
        <div class="emp-detail-section">Tenure</div>
        <div class="mini-pills">${pills}</div>
      </div>`;

      const wire = () => el.querySelectorAll("[data-tenure-metric]").forEach(b =>
        b.addEventListener("click", () => { tenureMetric = b.dataset.tenureMetric; renderTenureStats(currentCompTitle); }));

      if (!ts) {
        el.innerHTML = head + `<div style="font-size:.78rem;color:var(--ink3);padding:6px 0">No tenure data for this title.</div>`;
        wire();
        return;
      }
      const pctileNum = estimatePercentile(you, ts);
      const pctile = pctileNum != null ? `${ordinal(pctileNum)} percentile` : "";
      const youRow = `<div class="emp-detail-comp-row emp-detail-comp-you"><span>${esc(name)} ${pctile ? `<span style="font-weight:400;font-size:.72rem;opacity:.7">${pctile}</span>` : ""}</span><span>${fmtTenureQuarters(you, metric.censored(person))}</span></div>`;
      const r25 = `<div class="emp-detail-comp-row"><span>25th pct.</span><span>${fmtTenureQuarters(ts.p25)}</span></div>`;
      const rMed = `<div class="emp-detail-comp-row"><span>Median</span><span>${fmtTenureQuarters(ts.median)}</span></div>`;
      const r75 = `<div class="emp-detail-comp-row"><span>75th pct.</span><span>${fmtTenureQuarters(ts.p75)}</span></div>`;
      const rows = you < ts.p25
        ? [youRow, r25, rMed, r75]
        : you < ts.median
          ? [r25, youRow, rMed, r75]
          : you < ts.p75
            ? [r25, rMed, youRow, r75]
            : [r25, rMed, r75, youRow];
      el.innerHTML = head + rows.join("");
      wire();
    }
    renderTenureStats(compTitle);

    // Salary editing — click the salary figure itself to turn it into a
    // number input, right where it already sits. Every keystroke updates
    // the comparison below immediately (no separate "commit" step to learn),
    // a small "Testing ✕" pill appears next to it as the one, constant sign
    // something's been overridden, and that pill's ✕ is the only way back.
    //
    // The button and the input both exist in the DOM from the start; editing
    // just toggles which one is visible. An earlier version created the
    // <input> fresh (replaceWith) and focused it inside the same click
    // handler that removed the button — reliable when there was a pause
    // between the click and typing, but a real click-then-immediately-type
    // could race the DOM swap and lose the keystrokes entirely (reproduced
    // firsthand: on a fast click+type the field silently stayed in its
    // button/display state). Toggling visibility on an element that's been
    // sitting in the DOM the whole time removes that race.
    const salaryValBtn = detail.querySelector("#ed-salary-val");
    const salaryInputWrap = detail.querySelector("#ed-salary-input-wrap");
    const salaryInput = detail.querySelector("#ed-salary-input");
    const salaryPillEl = detail.querySelector("#ed-salary-pill");

    function renderSalaryDisplay() {
      salaryPillEl.style.display = salaryOverride != null ? "" : "none";
      const v = salaryOverride != null ? salaryOverride : latestEmp.annual_equiv;
      const overNow = v > SALARY_CAP;
      salaryValBtn.innerHTML = `${overNow ? `<span class="cap-warn">⚠</span> ` : ""}${fmt(v)}<span class="ed-salary-pencil">✎</span>`;
      salaryValBtn.style.display = "";
      salaryInputWrap.style.display = "none";
    }

    // Live-reformatting the field to "$X,XXX" on every keystroke (re-inserting
    // commas as you type) kept fighting the caret badly enough to read as
    // typing being blocked. Simpler and far more robust: a static "$" prefix
    // sits outside the actual input, which holds nothing but plain digits
    // while focused, starting blank (current value shown as a placeholder)
    // rather than pre-filled + select()-ed — nothing to select or replace,
    // every keystroke is just a normal append. Commas return on blur.
    function startSalaryEdit() {
      const startVal = salaryOverride != null ? salaryOverride : latestEmp.annual_equiv;
      salaryInput.value = "";
      salaryInput.placeholder = Math.round(startVal).toLocaleString();
      salaryValBtn.style.display = "none";
      salaryInputWrap.style.display = "";
      salaryInput.focus();
    }
    salaryInput.addEventListener("input", () => {
      const digits = salaryInput.value.replace(/[^\d]/g, "");
      if (salaryInput.value !== digits) salaryInput.value = digits; // strip anything non-numeric, leave the rest alone
      const n = digits ? parseInt(digits, 10) : null;
      salaryOverride = n > 0 ? n : null;
      salaryPillEl.style.display = salaryOverride != null ? "" : "none";
      renderCompStats(currentCompTitle);
    });
    salaryInput.addEventListener("blur", renderSalaryDisplay);
    salaryInput.addEventListener("keydown", e => { if (e.key === "Enter") salaryInput.blur(); });
    salaryValBtn.addEventListener("click", startSalaryEdit);
    salaryPillEl.querySelector("#ed-salary-reset").addEventListener("click", () => {
      salaryOverride = null;
      renderSalaryDisplay();
      renderCompStats(currentCompTitle);
    });

    const titleEl = detail.querySelector("#ed-comp-title"), wrap = detail.querySelector("#ed-comp-wrap"), searchEl = detail.querySelector("#ed-comp-search"), resultsEl = detail.querySelector("#ed-comp-results"), allStaffEl = detail.querySelector("#ed-comp-allstaff"), undoEl = detail.querySelector("#ed-comp-undo");
    if (titleEl) {
      // Every comparison the card has shown, oldest first, so the ← button can
      // walk back one step at a time. It's a stack rather than a plain "reset
      // to their own title" because comparing across two or three titles in a
      // row is the normal way people use this, and losing the intermediate
      // ones would make the button useless in exactly that case. Empty stack
      // means we're still on the person's own title, so the button hides.
      const compHistory = [];
      const showCompTitle = key => { titleEl.textContent = key === ALL_STAFF_KEY ? "All staff" : key; };
      const applyCompTitle = key => {
        wrap.style.display = "none"; resultsEl.style.display = "none";
        showCompTitle(key);
        renderCompStats(key);
        renderTenureStats(key);
        if (undoEl) undoEl.style.display = compHistory.length ? "" : "none";
      };
      const selectCompTitle = key => {
        if (key === currentCompTitle) return;
        compHistory.push(currentCompTitle);
        applyCompTitle(key);
      };

      titleEl.addEventListener("click", () => {
        wrap.style.display = wrap.style.display === "none" ? "block" : "none";
        if (wrap.style.display === "block") { searchEl.value = ""; searchEl.focus(); }
      });
      undoEl?.addEventListener("click", () => {
        if (!compHistory.length) return;
        applyCompTitle(compHistory.pop());
      });
      allStaffEl?.addEventListener("click", () => selectCompTitle(ALL_STAFF_KEY));
      searchEl.addEventListener("input", () => {
        const q = searchEl.value.toLowerCase().trim();
        if (!q) { resultsEl.style.display = "none"; return; }
        const hits = allTitles.filter(t => t.title.toLowerCase().includes(q)).slice(0, 10);
        resultsEl.innerHTML = hits.map(t => `<div class="ed-comp-result" data-title="${esc(t.title)}"><span class="ed-comp-result-title">${esc(t.title)}</span><span class="ed-comp-result-med">${fmtK(t.median)}</span></div>`).join("");
        resultsEl.style.display = hits.length ? "block" : "none";
        resultsEl.querySelectorAll(".ed-comp-result").forEach(row => {
          row.addEventListener("click", () => selectCompTitle(row.dataset.title));
        });
      });
    }
  }
}

function clearTitle() {
  currentSelection = null;
  lastPositionTrend = null;
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
  // Position card's own mini trend-chart selection — persisted alongside the
  // position so reloading with e.g. Q1 selected doesn't silently snap it
  // back to "All".
  if (state.pmetric && state.pmetric !== "median") parts.push("pmetric=" + state.pmetric);
  if (state.pq) parts.push("pq=" + state.pq);
  history.replaceState(null, "", parts.length ? "#" + parts.join("&") : location.pathname);
}

async function restoreHash() {
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
      await loadPeople();
      const forcedTrendUI = (params.pmetric || params.pq) ? { metric: params.pmetric || "median", qf: +(params.pq || 0) } : null;
      selectTitle(t, row, forcedTrendUI);
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
    partyFilter,
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
    trend: { mode: trendMode, metric: trendMetric, qFilter: trendQFilter },
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
  partyFilter = partyOptionsFor(officeTypeFilter).includes(state.partyFilter) ? state.partyFilter : "";
  document.querySelectorAll(".party-filter-btn[data-party]").forEach(b => b.classList.toggle("active", (b.dataset.party || "") === partyFilter));
  updatePartyFilterVisibility();
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
    // "position" mode was removed (redundant with the position lookup sidebar,
    // which has its own trend chart) — fall back to "overall" for sessions
    // that saved it before the removal.
    trendMode = state.trend.mode === "type" ? "type" : "overall";
    trendMetric = state.trend.metric || "median";
    trendQFilter = state.trend.qFilter || 0;
    document.querySelectorAll(".trend-mode").forEach(x => x.classList.toggle("active", x.dataset.mode === trendMode));
    document.querySelectorAll(".pill").forEach(x => x.classList.toggle("active", x.dataset.metric === trendMetric));
    document.querySelectorAll(".trend-q").forEach(x => x.classList.toggle("active", +x.dataset.q === trendQFilter));
    if ($("trend-q-note")) $("trend-q-note").style.display = trendQFilter === 0 ? "" : "none";
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
    // Only used for the tenure sort option — built once per call rather
    // than per-office, since scanning all of peopleData per office would be
    // quadratic in office count for no benefit.
    const tenureByPerson = new Map();
    if (peopleData) peopleData.forEach(p => tenureByPerson.set(`${p.name}|${p.office}`, personTenureQuarters(p)));

    const groups = {};
    employees.filter(e => !e.intern && !e.shared && e.annual_equiv >= HOUSE_MIN_ANNUAL && (!officeTypeFilter || e.type === officeTypeFilter) && (!partyFilter || partyValueOf(e) === partyFilter)).forEach(e => {
      const key = cleanOrg(e.office);
      if (!groups[key]) groups[key] = { name: key, type: e.type, party: e.party, leadership_party: e.leadership_party, amounts: [], tenures: [] };
      groups[key].amounts.push(e.annual_equiv);
      const t = tenureByPerson.get(`${e.name}|${key}`);
      if (t) groups[key].tenures.push(t);
    });
    officeData = Object.values(groups).map(g => {
      const s = g.amounts.slice().sort((a,b) => a-b);
      const p = pct => { const i=(s.length-1)*pct/100; const lo=Math.floor(i),hi=Math.min(lo+1,s.length-1); return s[lo]+(s[hi]-s[lo])*(i-lo); };
      const totalAnnual = Math.round(s.reduce((a,b)=>a+b,0));
      const tq = g.tenures.slice().sort((a,b) => a-b);
      const medianTenureQuarters = tq.length ? (tq.length % 2 ? tq[(tq.length-1)/2] : (tq[tq.length/2 - 1] + tq[tq.length/2]) / 2) : null;
      return { name: g.name, type: g.type, party: g.party, leadership_party: g.leadership_party, count: s.length,
        min: Math.round(s[0]), max: Math.round(s[s.length-1]),
        median: Math.round(p(50)), p25: Math.round(p(25)), p75: Math.round(p(75)),
        mean: Math.round(totalAnnual / s.length),
        totalAnnual, medianTenureQuarters };
    });
  } else {
    // Use pre-aggregated top_offices from that quarter's summary
    officeData = (adjQuarter(viewedQuarter()).top_offices || [])
      .filter(o => !officeTypeFilter || o.type === officeTypeFilter)
      .filter(o => !partyFilter || partyValueOf(o) === partyFilter)
      .map(o => ({
        name: o.name, type: o.type, party: o.party, leadership_party: o.leadership_party, count: o.count,
        min: o.min, max: o.max, median: o.median, p25: o.p25, p75: o.p75,
        mean: o.mean,
        totalAnnual: o.total_quarterly_pay != null ? o.total_quarterly_pay * 4 : null,
      }));
  }
}

const METRIC_LABELS = { median:"Median", mean:"Average", p25:"25th pct.", p75:"75th pct." };

function miniTrendHtml(wrapId, heading, initial) {
  const metric = initial?.metric || "median", qf = initial?.qf || 0;
  const activeIf = cond => cond ? " active" : "";
  return `<div class="mini-trend-wrap" id="${wrapId}">
    <div class="mini-trend-heading">${heading}</div>
    <div class="mini-ctrl-row">
      <div class="mini-pills">
        <button class="mini-pill${activeIf(metric==="median")}" data-metric="median">Median</button>
        <button class="mini-pill${activeIf(metric==="mean")}" data-metric="mean">Avg</button>
        <button class="mini-pill${activeIf(metric==="p25")}" data-metric="p25">P25</button>
        <button class="mini-pill${activeIf(metric==="p75")}" data-metric="p75">P75</button>
      </div>
      <div class="mini-pills">
        <button class="mini-q${activeIf(qf===0)}" data-q="0">All</button>
        <button class="mini-q${activeIf(qf===1)}" data-q="1">Q1</button>
        <button class="mini-q${activeIf(qf===2)}" data-q="2">Q2</button>
        <button class="mini-q${activeIf(qf===3)}" data-q="3">Q3</button>
        <button class="mini-q${activeIf(qf===4)}" data-q="4">Q4</button>
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

// Anchors the tooltip to a fixed page point (a dot's own position) instead of
// the cursor — centered above the point, flipping below/sideways near edges.
function positionTooltipAtPoint(px, py) {
  const tt = $("chart-tooltip");
  if (!tt) return;
  const tw = tt.offsetWidth, th = tt.offsetHeight;
  let x = px - tw / 2, y = py - th - 14;
  if (y < 4) y = py + 14;
  x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
  tt.style.left = x + "px";
  tt.style.top = y + "px";
}

// svgSparkline's markup gets replaced wholesale on every re-render (including
// mid-animation), so rather than re-wiring listeners after each innerHTML
// write, one delegated listener on the document handles every sparkline dot
// for the lifetime of the page — instant tooltip, no native-title hover delay.
let sparklineTooltipsReady = false;
function setupSparklineTooltips() {
  if (sparklineTooltipsReady) return;
  sparklineTooltipsReady = true;
  ensureTooltip();
  document.addEventListener("mouseover", e => {
    const hit = e.target.closest?.(".spark-hit");
    if (!hit) return;
    const tt = $("chart-tooltip");
    tt.innerHTML = `<strong>${hit.dataset.label}</strong><br>${hit.dataset.value}`;
    tt.style.display = "block";
    const dot = hit.previousElementSibling;
    dot?.classList.add("spark-dot-active");
    const dotRect = dot?.getBoundingClientRect();
    if (dotRect) positionTooltipAtPoint(dotRect.left + dotRect.width / 2, dotRect.top + dotRect.height / 2);
    else positionTooltip(e);
  });
  document.addEventListener("mouseout", e => {
    const hit = e.target.closest?.(".spark-hit");
    if (!hit) return;
    $("chart-tooltip").style.display = "none";
    hit.previousElementSibling?.classList.remove("spark-dot-active");
  });
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
function buildTrendChartBody(labels, datasets, yMin, yMax, highlightLabel, xs = null, opacities = null, annualMultiplier = 4) {
  const W = 680, H = 300;
  // Extra left padding — same fix as svgSparkline: the first rotated x-axis
  // label is anchored (text-anchor="end") right at pad.l and tilts up-left
  // from there, so too little padding here clips its leading character.
  const pad = { t: 16, r: 16, b: 60, l: 96 };
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
      const ty = pad.t + ph + 16;
      return `<text text-anchor="end" font-size="10" fill="#888"
        transform="translate(${x.toFixed(1)},${ty.toFixed(1)}) rotate(-45)">${shortAxisLabel(lb)}</text>`;
    }
    return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#888">${lb}</text>`;
  }).join("");

  // Per-dataset paths — a point counts as part of a line segment only while it's
  // (mostly) visible, so fading/appearing points during a zoom detach cleanly.
  const fillGradDefs = [];
  const pathEls = datasets.map(ds => {
    const color = ds.color;
    const segs = [];
    let cur = [];
    ds.data.forEach((v, i) => {
      if (v != null && op(i) > 0.5) cur.push([i, v]);
      else if (cur.length) { segs.push(cur); cur = []; }
    });
    if (cur.length) segs.push(cur);

    const fills = (ds.fill && segs.length) ? (() => {
      const grad = areaFillGradient(color, .16);
      fillGradDefs.push(grad.defs);
      return segs.map(s => {
        if (s.length < 2) return "";
        const d = s.map(([i, v], j) => `${j ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");
        const last = s[s.length - 1], first = s[0];
        return `<path d="${d} L${sx(last[0]).toFixed(1)},${(pad.t + ph).toFixed(1)} L${sx(first[0]).toFixed(1)},${(pad.t + ph).toFixed(1)} Z" fill="url(#${grad.id})" stroke="none"/>`;
      }).join("");
    })() : "";

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

  // Dashed linear-regression trend line per dataset, same idea as the mini
  // sparkline charts (position card / person pay history) — drawn over
  // whichever points are currently visible so it tracks a quarter-filter zoom.
  let soloAnnot = "";
  const trendEls = datasets.map(ds => {
    const pts = [];
    ds.data.forEach((v, i) => { if (v != null && op(i) > 0.5) pts.push([i, v]); });
    if (pts.length < 3) return "";
    const { slope, intercept } = linReg(pts.map(p => p[0]), pts.map(p => p[1]));
    const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    const y0 = sy(slope * x0 + intercept), y1 = sy(slope * x1 + intercept);
    if (datasets.length === 1) {
      const annualSlope = slope * annualMultiplier;
      const sign = annualSlope >= 0 ? "+" : "−";
      const abs = Math.abs(annualSlope);
      const label = `${sign}$${abs >= 1000 ? (abs/1000).toFixed(1)+"k" : Math.round(abs)} / yr trend`;
      soloAnnot = `<text x="${(W - pad.r).toFixed(1)}" y="14" text-anchor="end" font-size="11" fill="#6b7280">${label}</text>`;
    }
    return `<line x1="${sx(x0).toFixed(1)}" y1="${y0.toFixed(1)}" x2="${sx(x1).toFixed(1)}" y2="${y1.toFixed(1)}"
      stroke="${ds.color}" stroke-width="1.2" stroke-dasharray="4 3" opacity=".55" class="trend-regression-line"/>`;
  }).join("");

  const hlIdx = highlightLabel != null ? labels.indexOf(highlightLabel) : -1;
  const hlLine = hlIdx >= 0 ? (() => {
    const x = sx(hlIdx).toFixed(1);
    return `<line x1="${x}" x2="${x}" y1="${pad.t}" y2="${pad.t + ph}" stroke="#1b6f2c" stroke-width="1.5" stroke-dasharray="4 3" opacity=".5"/>
            <text x="${x}" y="${(pad.t - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#1b6f2c" opacity=".8">${labels[hlIdx]}</text>`;
  })() : "";

  const defsBlock = fillGradDefs.length ? `<defs>${fillGradDefs.join("")}</defs>` : "";
  return { svgBody: `${defsBlock}${yTicks}${hlLine}${pathEls}${trendEls}${xLabels}${soloAnnot}`, W, H, pad, ph, sx };
}

function drawSvgLineChart(containerEl, fullLabels, fullDatasets, opts = {}) {
  const { legend = false, highlightLabel = null } = opts;
  const visible = opts.visible || fullLabels.map(() => true);

  const visIdx = [];
  for (let i = 0; i < fullLabels.length; i++) if (visible[i]) visIdx.push(i);
  const labels = visIdx.map(i => fullLabels[i]);
  const datasets = fullDatasets.map(d => ({ ...d, data: visIdx.map(i => d.data[i]) }));
  // Once compacted down to a single calendar quarter's occurrences (e.g. "Q1"
  // across every year), consecutive points are a year apart, not a quarter —
  // the trend annotation's annualizing multiplier needs to reflect that or
  // it comes out 4x too large. Full-timeline renders (with fading via
  // xs/opacities, below) keep genuinely quarterly spacing, so they stay at 4.
  const filteredMultiplier = labels.length === fullLabels.length ? 4 : 1;

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
    const { svgBody, W, H } = buildTrendChartBody(labels, datasets, yMin, yMax, highlightLabel, null, null, filteredMultiplier);
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

  // Two different non-"All" quarter filters with different point counts —
  // e.g. Q1's 6 points (one per year) vs Q2/Q3/Q4's 5 (2026 has no Q2 yet).
  // Neither canMorph (lengths differ) nor isQuarterZoom (neither side is
  // "All") fires here, so without this it fell through to the mode-switch
  // crossfade and just flashed instead of transforming.
  const isSubsetMorph = !canMorph && !isQuarterZoom && prev && prev.datasetSig === datasetSig
    && sameFull && !reduceMotion && prev.labels;
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
      const { svgBody, W, H } = buildTrendChartBody(labels, iDatasets, iYMin, iYMax, highlightLabel, null, null, filteredMultiplier);
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
    // Must match buildTrendChartBody's own pad exactly — it draws the
    // gridlines/axis for every one of these animation frames using its own
    // internal pad, while the point x-positions here are computed
    // separately and passed in as `xs`. A stale pad here doesn't just
    // resize the plot area frame-to-frame, it floats the data points in a
    // completely different horizontal region than the gridlines drawn
    // around them until the animation ends and they snap into alignment.
    const W = 680, H = 300, pad = { t: 16, r: 16, b: 60, l: 96 }, pw = W - pad.l - pad.r;
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
  } else if (isSubsetMorph) {
    // Neither subset is "All", so there's no shared timeline to zoom through
    // and no shared quarter identity to match points by (a given year's Q1 is
    // never also its Q2) — lay each subset's points evenly across the plot
    // width by array index instead. Index 0 always lands at the same x
    // regardless of length, but every later index's spacing shifts as the
    // count changes between the two subsets, and that shift is the slide.
    // Whichever side has fewer points, the excess indices fade in/out at
    // their own natural index position rather than sliding to/from nothing.
    containerEl.style.transform = "";
    const W = 680, H = 300, pad = { t: 16, r: 16, b: 60, l: 96 }, pw = W - pad.l - pad.r;
    const prevLen = prev.labels.length, newLen = labels.length, maxLen = Math.max(prevLen, newLen);
    const oldXAt = i => pad.l + (prevLen <= 1 ? pw / 2 : (i / (prevLen - 1)) * pw);
    const newXAt = i => pad.l + (newLen <= 1 ? pw / 2 : (i / (newLen - 1)) * pw);
    const idx = Array.from({ length: maxLen }, (_, i) => i);
    const fromX = i => i < prevLen ? oldXAt(i) : newXAt(i);
    const toX = i => i < newLen ? newXAt(i) : oldXAt(i);
    const fromOp = i => i < prevLen ? 1 : 0;
    const toOp = i => i < newLen ? 1 : 0;
    const labelsForFrame = idx.map(i => i < newLen ? labels[i] : prev.labels[i]);
    const fromYMin = prev.yMin, fromYMax = prev.yMax;
    const duration = 480;
    const start = performance.now();
    const step = now => {
      if (containerEl.dataset.trendGen !== gen) return;
      const t = Math.min(1, (now - start) / duration);
      const e = easeZoomSine(t);
      const xs = idx.map(i => fromX(i) + (toX(i) - fromX(i)) * e);
      const ops = idx.map(i => fromOp(i) + (toOp(i) - fromOp(i)) * e);
      const iYMin = fromYMin + (yMin - fromYMin) * e;
      const iYMax = fromYMax + (yMax - fromYMax) * e;
      const iDatasets = datasets.map((ds, di) => {
        const fromDS = prev.datasets[di];
        return {
          ...ds,
          data: idx.map(i => {
            const fv = i < prevLen ? fromDS.data[i] : (i < newLen ? ds.data[i] : null);
            const tv = i < newLen ? ds.data[i] : (i < prevLen ? fromDS.data[i] : null);
            if (fv == null || tv == null) return fv ?? tv;
            return fv + (tv - fv) * e;
          }),
        };
      });
      const { svgBody } = buildTrendChartBody(labelsForFrame, iDatasets, iYMin, iYMax, highlightLabel, xs, ops);
      containerEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">${svgBody}</svg>`;
      if (t < 1) requestAnimationFrame(step); else renderStatic(false);
    };
    requestAnimationFrame(step);
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
    fullLabels: fullLabels.slice(), visible: visible.slice(), labels: labels.slice(),
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

// Full labels like "Jan–Mar 2021" are too wide to rotate -45deg without
// running into the left edge — shorten to "Jan '21" for the tilted x-axis
// ticks (tooltips/other UI still use the full label).
function shortAxisLabel(lb) {
  const m = /^([A-Za-z]+)[–-][A-Za-z]+ (\d{4})$/.exec(lb);
  return m ? `${m[1]} '${m[2].slice(2)}` : lb;
}

// annualMultiplier converts "value change per index step" into "value change
// per year": 4 when consecutive points are one quarter apart (the default,
// full timeline), but 1 when the caller has filtered down to a single
// calendar quarter (e.g. "Q1"), since then consecutive points are already a
// full year apart and multiplying by 4 would inflate the trend 4x.
// Shared by svgSparkline and buildSparklineFrame: renders dashed boundary
// lines between title segments, each labeled with the title that applied
// *during* that stretch (centered in its own segment's x-range) instead of
// repeating "old -> new" at every transition — which reads fine for one
// change but stacks into illegible overlapping text with two or more.
// Centering each label within its own segment's width means neighboring
// labels can never collide by construction; a label that's too long for
// its own segment is simply hidden rather than spilling into the next one.
// Greedily wraps `title` into as many lines as it takes to fit maxWidthPx
// (estimated at ~5px/char) — each segment gets its own dedicated column
// below the chart, so unlike the in-plot version this never has to fight
// data points or a neighbor for room; wrapping is the only thing standing
// between a long title and a narrow segment.
function wrapTitle(title, maxWidthPx) {
  const charW = 5.4;
  const words = title.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (cur && test.length * charW > maxWidthPx) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [title];
}

// Whole-title overrides checked before any generic abbreviation logic —
// for titles common enough that a fixed short form reads better than
// whatever the generic word/initials rules would produce.
const TITLE_FULL_ABBR = {
  "administrative assistant": "Admin. Asst.", "budget director": "Budget Dir.",
  "chief of staff": "Chief", "comm dir": "Comms. Dir.", "comm director": "Comms. Dir.",
  "comms dir": "Comms. Dir.", "comms director": "Comms. Dir.",
  "communications advisor": "Comms. Advisor", "communications aide": "Comms. Aide",
  "communications assistant": "Comms. Asst.", "communications director": "Comms. Dir.",
  "congressional aide": "Congr. Aide", "constituent liaison": "Constituent Lias.",
  "constituent serv": "Constituent Services", "constituent service": "Constituent Services",
  "constituent svcs rep": "Constituent Services Rep.", "dc press secretary": "DC Press Sec.",
  "dep chief of staff": "Dep. Chief", "dep press sec": "Dep. Press Sec.",
  "deputy chief": "Dep. Chief", "deputy chief of staff": "Dep. Chief",
  "deputy comm dir": "Dep. Comms. Dir.", "deputy communications dir": "Dep. Comms. Dir.",
  "deputy cos": "Dep. Chief", "deputy district director": "Dep. Dist. Dir.",
  "deputy general counsel": "Dep. Gen. Counsel", "deputy parliamentarian": "Dep. Parli.",
  "deputy scheduler": "Dep. Scheduler", "deputy staff dir": "Dep. Staff Dir.",
  "digital assist": "Digital Asst.", "digital assistant": "Digital Asst.",
  "digital dir": "Digital Dir.", "dir of operations": "Dir. of Ops.",
  "director of casework": "Dir. of Casework", "director of coalitions": "Dir. of Coalitions",
  "director of operations": "Dir. of Ops.", "director of outreach": "Dir. of Outreach",
  "director of policy": "Dir. of Pol.", "director of scheduling": "Dir. of Scheduling",
  "director operations": "Dir. of Ops.", "dist dir": "Dist. Dir.", "dist director": "Dist. Dir.",
  "dist scheduler": "Dist. Scheduler", "district aide": "Dist. Aide",
  "district coordinator": "Dist. Coor.", "district dir": "Dist. Dir.",
  "district director": "Dist. Dir.", "district press": "Dist. Press",
  "district rep": "Dist. Rep.", "district representative": "Dist. Rep.",
  "district sched": "Dist. Scheduler", "district scheduler": "Dist. Scheduler",
  "district staff assistant": "Dist. Staff Asst.", "do scheduler": "Dist. Scheduler",
  "economic development": "Econ. Dev.", "exec assist": "Exec. Asst.",
  "exec assistant": "Exec. Asst.", "exec asst": "Exec. Asst.", "executive": "Exec. Asst.",
  "executive assist": "Exec. Asst.", "executive assistant": "Exec. Asst.",
  "executive asst": "Exec. Asst.", "executive director": "Exec. Dir.",
  "field director": "Field Dir.", "field r": "Field Rep.", "finance director": "Finance Dir.",
  "general counsel": "Gen. Counsel", "grants c": "Grants Coor.", "grants coor": "Grants Coor.",
  "grants coordinato": "Grants Coor.", "grants coordinator": "Grants Coor.",
  "grants director": "Grants Dir.", "immigration specialist": "Imm. Spec.",
  "lc": "LC", "ld": "LD", "leg asst": "LA", "leg corr": "LC", "leg corres": "LC",
  "leg correspondent": "LC", "leg dir": "LD", "leg director": "LD",
  "legis aide": "Leg. Aide", "legis assistant": "LA", "legis asst": "LA",
  "legis corres": "LC", "legis corresp": "LC", "legis correspondent": "LC",
  "legis dir": "LD", "legislative ai": "Leg. Aide", "legislative aide": "Leg. Aide",
  "legislative assist": "LA", "legislative assistant": "LA", "legislative asst": "LA",
  "legislative corr": "LC", "legislative corres": "LC", "legislative correspondent": "LC",
  "legislative counsel": "Leg. Counsel", "legislative dir": "LD",
  "legislative director": "LD", "operations coordinator": "Ops. Coor.",
  "operations manager": "Ops. Manager", "ops coordinator": "Ops. Coor.",
  "outreach coor": "Outreach Coor.", "outreach coord": "Outreach Coor.",
  "outreach coordinator": "Outreach Coor.", "outreach director": "Outreach Dir.",
  "policy aide": "Pol. Aide", "policy analyst": "Pol. Analyst",
  "policy assistant": "Pol. Asst.", "press assist": "Press Asst.",
  "press assistant": "Press Asst.", "press asst": "Press Asst.", "press sec": "Press Sec.",
  "press secretary": "Press Sec.", "professional staff": "PSM",
  "professional staff member": "PSM", "regional director": "Regional Dir.",
  "research assistant": "Research Asst.", "sa": "Staff Asst.",
  "senior advisor": "Sr. Advisor", "senior caseworker": "Sr. Caseworker",
  "senior counsel": "Sr. Counsel", "senior policy advisor": "Sr. Pol. Advisor",
  "special assistant": "Spec. Asst.", "sr advisor": "Sr. Advisor",
  "sr caseworker": "Sr. Caseworker", "sr field rep": "Sr. Field Rep.",
  "sr policy advisor": "Sr. Pol. Advisor", "staff assi": "Staff Asst.",
  "staff assist": "Staff Asst.", "staff assistant": "Staff Asst.",
  "staff asst": "Staff Asst.", "veterans liaison": "Veterans Lias.",
};
// Word-level abbreviations for titles too long to fit their column on one
// line. Preferred over collapsing to bare initials, since acronyms like
// "SLA" for "Scheduler & Legislative Aide" read as a different, unrelated
// term rather than a shortened version of the actual title.
const TITLE_WORD_ABBR = {
  legislative: "Leg.", administrative: "Admin.", administrator: "Admin.",
  correspondent: "Corresp.", correspondence: "Corresp.",
  assistant: "Asst.", scheduler: "Sched.", director: "Dir.",
  coordinator: "Coord.", representative: "Rep.", communications: "Comms.",
  deputy: "Dep.", executive: "Exec.", constituent: "Constit.",
  secretary: "Sec.", manager: "Mgr.", special: "Spec.",
  confidential: "Conf.", systems: "Sys.", district: "Dist.",
  regional: "Reg.", services: "Svcs.", military: "Mil.",
  operations: "Ops.", digital: "Dig.", policy: "Pol.",
  outreach: "Outr.", technology: "Tech.", information: "Info.",
};
// Splits on whitespace and "/" while keeping the separators themselves in
// the output, so a compound like "Clerk/Office" abbreviates each half
// ("Clerk/Office" -> "Clerk/Office" since neither is in the dict, but
// "Administrative/Office" -> "Admin./Office") without losing the slash.
function wordAbbreviateTitle(title) {
  return title.split(/(\s+|\/)/).map(tok => {
    if (/^\s+$/.test(tok) || tok === "/") return tok;
    const key = tok.toLowerCase().replace(/[^a-z]/g, "");
    return TITLE_WORD_ABBR[key] || tok;
  }).join("");
}
// Bare-initials fallback for titles that still don't fit after word-level
// abbreviation. Small filler words are skipped.
const TITLE_ABBR_STOPWORDS = new Set(["and", "of", "the", "to", "&"]);
function abbreviateTitle(title) {
  const initials = title
    .split(/\s+/)
    .filter(w => w && !TITLE_ABBR_STOPWORDS.has(w.toLowerCase()))
    .map(w => w[0].toUpperCase());
  return initials.join("");
}

// Renders dashed boundary lines between title segments, each labeled with
// the title that applied *during* that stretch — in its own row below the
// chart (between the plot and the x-axis date labels) rather than floating
// inside the plot, where it inevitably had to dodge both data points and
// neighboring labels. Each segment gets its own column matching its own
// x-range, so labels can never collide with each other by construction;
// a title too long for its column just wraps onto more lines instead of
// being dropped.
function titleSegmentMarkup(segments, sx, pad, ph) {
  if (!segments || !segments.length) return "";
  const boundaryLines = segments.slice(0, -1).map((s, i) => {
    const x = (sx(s.toIdx) + sx(segments[i + 1].fromIdx)) / 2;
    return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${pad.t}" y2="${(pad.t + ph).toFixed(1)}" stroke="#b8b3a9" stroke-width="1" stroke-dasharray="3,3"/>`;
  }).join("");

  // Word-abbreviation (below) keeps nearly every label to one line, so most
  // charts only need one label row. A second, offset row only kicks in when
  // a label's estimated rendered width would actually overlap the previous
  // one — detected per-pair below rather than always alternating, so a
  // chart with well-spaced segments stays visually compact.
  const rowYs = [pad.t + ph + 18, pad.t + ph + 40];
  const charW = 5.4;
  let prevRight = -Infinity;
  const segLabels = segments.map(s => {
    const x0 = sx(s.fromIdx), x1 = sx(s.toIdx);
    const cx = (x0 + x1) / 2, colW = Math.max(20, x1 - x0);
    // A few px of margin on each side of the column so two adjacent narrow
    // segments' wrapped text reads as separate labels with a real gap
    // between them, not one run-on phrase.
    const fullAbbr = TITLE_FULL_ABBR[s.title.toLowerCase()];
    let lines = wrapTitle(fullAbbr || s.title, colW - 8);
    // A title that doesn't fit its column on one line reads as clutter once
    // several segments are stacked. Try shortening long words first (e.g.
    // "Legislative" -> "Leg."), which keeps the label recognizable; only
    // fall back to bare initials if that's still too long. The full title
    // is always still available via the tooltip.
    if (!fullAbbr && lines.length > 1) {
      const abbrLines = wrapTitle(wordAbbreviateTitle(s.title), colW - 8);
      // A recognizable two-line abbreviation ("Dep. Comms. Dir.") beats an
      // unrecognizable acronym ("DCD") — only fall back to bare initials
      // if word-abbreviation still doesn't fit in two lines.
      lines = abbrLines.length > 2 ? [abbreviateTitle(s.title)] : abbrLines;
    }
    const textW = Math.max(...lines.map(l => l.length)) * charW;
    const left = cx - textW / 2, right = cx + textW / 2;
    const row = left < prevRight + 6 ? 1 : 0;
    prevRight = row === 0 ? right : Math.max(prevRight, right);
    const rowY0 = rowYs[row];
    const text = lines.map((line, li) =>
      `<text x="${cx.toFixed(1)}" y="${(rowY0 + li * 10).toFixed(1)}" text-anchor="middle" font-size="9" fill="#999">${esc(line)}</text>`
    ).join("");
    return `<g><title>${esc(s.title)}</title>${text}</g>`;
  }).join("");
  return boundaryLines + segLabels;
}

function svgSparkline(data, labels, annualMultiplier = 4, excludeIndexFromTrend = null, markers = null) {
  const W = 560, H = 234;
  // Rotated x-axis labels (below) are anchored at their end and tilt up-left
  // from there, so the first tick's label — anchored right at pad.l — was
  // getting its leading character clipped by the viewBox edge. Extra left
  // padding only when there's actually a rotated label to make room for.
  // Extra 24px of bottom padding vs. the old 56 makes room for the title-
  // segment label row between the plot and the date labels (H grew by the
  // same 24px, so the plot itself stays the same size as before).
  const pad = { t: 22, r: 16, b: 90, l: labels.length > 4 ? 92 : 54 };
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

  const markerLines = titleSegmentMarkup(markers, sx, pad, ph);

  // X labels — show ~6 evenly spaced; rotate once there are enough that they'd crowd
  const step = Math.max(1, Math.ceil(labels.length / 6));
  const rotateX = labels.length > 4;
  const xLabels = labels.map((lb, i) => {
    if (i % step !== 0 && i !== labels.length - 1) return "";
    if (rotateX) {
      const ty = pad.t + ph + 58;
      return `<text text-anchor="end" font-size="10" fill="#888"
        transform="translate(${sx(i).toFixed(1)},${ty.toFixed(1)}) rotate(-45)">${shortAxisLabel(lb)}</text>`;
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

  const fillGrad = areaFillGradient("#1b6f2c", .16);
  const fills = segs.map(s => {
    if (s.length < 2) return "";
    const d = s.map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    return `<path d="${d} L${s[s.length-1][0].toFixed(1)},${(pad.t+ph).toFixed(1)} L${s[0][0].toFixed(1)},${(pad.t+ph).toFixed(1)} Z" fill="url(#${fillGrad.id})" stroke="none"/>`;
  }).join("");

  const lines = segs.map(s => {
    const d = s.map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="#1b6f2c" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join("");

  // Hover hit-area is a full-height vertical band around each point, not just
  // a small circle on the dot itself — much easier to land on, same idea as
  // the hoverRect columns in buildTrendChartBody. A native <title> tooltip
  // has a hover delay, so these carry data-* read by the delegated instant
  // tooltip (see setupSparklineTooltips) shared with the rest of the charts.
  const bandW = Math.max(16, Math.min(40, pw / Math.max(data.length - 1, 1)));
  const dots = valid.map(({ v, i }) =>
    `<circle class="spark-dot" cx="${sx(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="4" fill="white" stroke="#1b6f2c" stroke-width="2"/>
     <rect class="spark-hit" x="${(sx(i) - bandW / 2).toFixed(1)}" y="${pad.t}" width="${bandW.toFixed(1)}" height="${ph}" fill="transparent"
       style="cursor:crosshair" data-label="${labels[i]}" data-value="$${Math.round(v).toLocaleString()}"/>`
  ).join("");

  // Trend line + annotation (need ≥3 valid points). A person's first tracked
  // quarter is often a partial/prorated payment (mid-quarter hire), which
  // would otherwise drag the regression down — excluded from the fit itself
  // (by data index, so it's still the right point even under a Q1–Q4
  // filter) but still plotted as a real point on the line.
  let trendEl = "", annotEl = "";
  const trendPts = excludeIndexFromTrend != null && valid.length > 3
    ? valid.filter(d => d.i !== excludeIndexFromTrend)
    : valid;
  if (trendPts.length >= 3) {
    const { slope, intercept } = linReg(trendPts.map(d => d.i), trendPts.map(d => d.v));
    const x0 = trendPts[0].i, x1 = trendPts[trendPts.length - 1].i;
    const ty0 = sy(slope * x0 + intercept), ty1 = sy(slope * x1 + intercept);
    trendEl = `<line x1="${sx(x0).toFixed(1)}" y1="${ty0.toFixed(1)}" x2="${sx(x1).toFixed(1)}" y2="${ty1.toFixed(1)}"
      stroke="#6b7280" stroke-width="1.2" stroke-dasharray="4 3" opacity=".7"/>`;
    const annualSlope = slope * annualMultiplier;
    const sign = annualSlope >= 0 ? "+" : "−";
    const abs = Math.abs(annualSlope);
    const label = `${sign}$${abs >= 1000 ? (abs/1000).toFixed(1)+"k" : Math.round(abs)} / yr trend`;
    annotEl = `<text x="${(W - pad.r).toFixed(1)}" y="14" text-anchor="end" font-size="11" fill="#6b7280">${label}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%"><defs>${fillGrad.defs}</defs>${yTicks}${markerLines}${fills}${lines}${trendEl}${dots}${xLabels}${annotEl}</svg>`;
}

const MINI_EASE_CUBIC = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // value-morph
const MINI_EASE_ZOOM = t => -(Math.cos(Math.PI * t) - 1) / 2; // easeInOutSine — no sudden snap through the middle

// Stripped-down sparkline frame for mid-zoom animation only — no x-axis text or
// trend annotation (those come back once renderStatic() calls the real svgSparkline).
function buildSparklineFrame(fullLabels, fullData, xs, opacities, padL = 54, markers = null) {
  const W = 560, H = 234;
  // Must match svgSparkline's own pad exactly (t:22, r:16, b:80, and l
  // conditional on rotated labels) — this renders every frame *during* a
  // zoom transition, and if its plot rectangle doesn't match the static
  // frame's (svgSparkline) that bookends the animation, the chart visibly
  // jumps/resizes right as the animation starts or ends.
  const pad = { t: 22, r: 16, b: 90, l: padL };
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

  const markerLines = titleSegmentMarkup(markers, sx, pad, ph);

  const segs = [];
  let cur = [];
  fullData.forEach((v, i) => {
    if (v != null && op(i) > 0.5) cur.push([sx(i), sy(v)]);
    else if (cur.length) { segs.push(cur); cur = []; }
  });
  if (cur.length) segs.push(cur);

  const fillGrad = areaFillGradient("#1b6f2c", .16);
  const fills = segs.map(s => {
    if (s.length < 2) return "";
    const d = s.map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    return `<path d="${d} L${s[s.length-1][0].toFixed(1)},${(pad.t+ph).toFixed(1)} L${s[0][0].toFixed(1)},${(pad.t+ph).toFixed(1)} Z" fill="url(#${fillGrad.id})" stroke="none"/>`;
  }).join("");

  const lines = segs.map(s => {
    const d = s.map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="#1b6f2c" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join("");

  const dots = fullData.map((v, i) => {
    if (v == null) return "";
    const o = op(i);
    if (o <= 0.02) return "";
    return `<circle cx="${sx(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="4" fill="white" stroke="#1b6f2c" stroke-width="2" opacity="${o.toFixed(2)}"/>`;
  }).join("");

  // X-axis labels were previously skipped entirely during the animation
  // ("no x-axis text" — see the function comment this replaces) on the
  // assumption that a few hundred ms without them wouldn't be noticed. In
  // practice the whole label row visibly disappearing and then popping back
  // in reads as a much bigger glitch than the value/position tweening it
  // was meant to smooth over. Same layout as svgSparkline's, just driven by
  // the same animated `xs` positions the dots/lines use, so the labels stay
  // correctly aligned with their points throughout instead of only at the
  // two static ends.
  const step = Math.max(1, Math.ceil(n / 6));
  const xLabels = fullLabels.map((lb, i) => {
    if (i % step !== 0 && i !== n - 1) return "";
    if (op(i) <= 0.02) return "";
    const ty = pad.t + ph + 58;
    return `<text text-anchor="end" font-size="10" fill="#888" opacity="${op(i).toFixed(2)}"
      transform="translate(${sx(i).toFixed(1)},${ty.toFixed(1)}) rotate(-45)">${shortAxisLabel(lb)}</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%"><defs>${fillGrad.defs}</defs>${yTicks}${markerLines}${fills}${lines}${dots}${xLabels}</svg>`;
}

function makeMiniTrend(wrapEl, getDataFn, seedView, excludeFirstQuarterId, titleSegments, trimToData) {
  // miniTrendHtml() already rendered the pills with the right "active" class
  // for `initial` — reading it back off the DOM (rather than trusting
  // `initial` directly) keeps this in sync even if the template and this
  // function's defaults ever drift.
  let metric = wrapEl.querySelector(".mini-pill.active")?.dataset.metric || "median";
  let qf = +(wrapEl.querySelector(".mini-q.active")?.dataset.q || 0);
  const chartWrap = wrapEl.querySelector(".mini-chart-wrap");
  let prev = seedView || null; // { fullLabels, fullData, visible, data, labels }
  let gen = 0;

  // Title segments (see showPersonInline) — only meaningful on the
  // unfiltered "All quarters" view (qf===0): a Q1-only view, say, doesn't
  // contain the actual quarter a mid-year title change happened in, so
  // there's nothing sensible to point at. A segment from a stint at a
  // *different* office (outside this chart's own timeline) is dropped
  // automatically since neither of its quarter ids will be found in the
  // current view.
  function segmentsForView(view) {
    if (qf !== 0 || !titleSegments || !titleSegments.length) return null;
    return titleSegments
      .map(s => ({ fromIdx: view.ids.indexOf(s.fromId), toIdx: view.ids.indexOf(s.toId), title: s.title }))
      .filter(s => s.fromIdx >= 0 && s.toIdx >= 0);
  }

  // With the timeline now reaching back to 2016, a series that only covers the
  // recent end of it — a person hired in 2024, say — was being drawn squashed
  // into the right quarter of the plot with years of blank axis to its left.
  // `trimToData` clips the timeline to the span the series actually covers.
  //
  // Interior nulls are deliberately kept: a gap in the middle is someone
  // leaving and coming back, which the chart should show as a gap. Only the
  // empty leading and trailing runs go.
  //
  // The bounds come from the unfiltered (qf=0) series, so the Q1–Q4 filters
  // all clip to the same span rather than each finding their own — otherwise
  // switching between them would rescale the axis under the user.
  function trimBounds(allData) {
    const lo = allData.findIndex(v => v != null);
    if (!trimToData || lo < 0) return [0, allData.length - 1];
    let hi = allData.length - 1;
    while (hi > lo && allData[hi] == null) hi--;
    return [lo, hi];
  }

  function computeView() {
    const allData = getDataFn(metric, 0); // qf=0 -> every quarter, aligned with summary.quarters
    const [lo, hi] = trimBounds(allData);
    const allQs = summary.quarters.slice(lo, hi + 1);
    const fullData = allData.slice(lo, hi + 1);
    const fullLabels = allQs.map(q => q.label);
    const visible = allQs.map(q => !qf || q.quarter === qf);
    const visIdx = [];
    for (let i = 0; i < fullLabels.length; i++) if (visible[i]) visIdx.push(i);
    return {
      fullLabels, fullData, visible,
      labels: visIdx.map(i => fullLabels[i]),
      data: visIdx.map(i => fullData[i]),
      ids: visIdx.map(i => allQs[i].id),
    };
  }

  // Only used by the per-person pay-history chart (see showPersonInline) —
  // their first tracked quarter is often a partial/prorated payment, so it's
  // excluded from the trend-line fit wherever it lands in the current view.
  const excludeIdxFor = view => excludeFirstQuarterId ? view.ids.indexOf(excludeFirstQuarterId) : null;

  function renderStatic(view) {
    if (chartWrap) chartWrap.innerHTML = svgSparkline(view.data, view.labels, qf ? 1 : 4, excludeIdxFor(view) >= 0 ? excludeIdxFor(view) : null, segmentsForView(view));
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
    const sameTimeline = prev && !reduceMotion && prev.fullLabels.join(",") === view.fullLabels.join(",");
    // All <-> one quarter: genuinely a "zoom" — reveal the full timeline (or
    // collapse back into it), a real change in how much of the timeline is
    // shown, not just which slice.
    const isFullReveal = !canMorph && sameTimeline && (prevWasAll || nowIsAll);
    // One quarter -> a different one (Q1 -> Q2, say) with a point-count
    // mismatch: a person's own history doesn't guarantee equal counts across
    // quarters — how many Q1s vs Q2s they've been tracked through can differ
    // by one depending on hire/leave timing. This isn't really a "zoom" (the
    // amount of timeline on screen doesn't change, All is never involved) —
    // detouring through a full-timeline reveal here just to get from one
    // slice to another read as backwards. Handled below by matching points
    // between the two slices by array index (see that branch for why not
    // by quarter identity).
    const isSubsetMorph = !canMorph && sameTimeline && !isFullReveal;

    if (!prev || reduceMotion) {
      renderStatic(view);
    } else if (canMorph) {
      // Same point count — a metric switch (Median -> Average) or a direct switch
      // between two same-size quarter filters: tween each point's value by index.
      const fromData = prev.data;
      const duration = 380;
      const start = performance.now();
      const excludeIdx = excludeIdxFor(view);
      const step = now => {
        if (myGen !== gen) return;
        const t = Math.min(1, (now - start) / duration);
        const e = MINI_EASE_CUBIC(t);
        const iData = view.data.map((v, i) => {
          const fv = fromData[i];
          if (v == null || fv == null) return t < 1 ? (t < .5 ? fv : v) : v;
          return fv + (v - fv) * e;
        });
        chartWrap.innerHTML = svgSparkline(iData, view.labels, qf ? 1 : 4, excludeIdx >= 0 ? excludeIdx : null, segmentsForView(view));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } else if (isFullReveal) {
      // Real zoom: reveal every quarter on the timeline, then push in on the
      // newly-selected slice (or the reverse when returning to "All quarters").
      const n = view.fullLabels.length;
      // Same pad.l svgSparkline itself would use for this many labels — has
      // to match, since this positions the actual data points during the
      // animation and svgSparkline renders the static frames that bookend it.
      const padL = n > 4 ? 92 : 54;
      const pad = { l: padL, r: 16 }, pw = 560 - pad.l - pad.r;
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
          chartWrap.innerHTML = buildSparklineFrame(view.fullLabels, iData, xs, ops, padL, segmentsForView(view));
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
    } else if (isSubsetMorph) {
      // Match points between the old slice and the new one by their actual
      // quarter id, originally — except a quarter-of-year filter (Q1/Q2/Q3/
      // Q4) never shares an actual quarter with a different one (a given
      // year's Q1 is never also its Q3), so id-matching degenerated into
      // pure fades with nothing ever sharing an id to slide between —
      // exactly the "doesn't morph" this was meant to fix. Matching by
      // array index instead: each subset lays its own points evenly
      // spaced, so index 0 sits at the same spot regardless of length, but
      // every later index's spacing shifts as the count changes — that
      // shift *is* the slide. Whichever side has fewer points, its excess
      // indices on the other side fade in/out at their own position rather
      // than sliding from/to somewhere semantically meaningless.
      const padL = view.labels.length > 4 ? 92 : 54;
      const pad = { l: padL, r: 16 }, pw = 560 - pad.l - pad.r;
      const prevLen = prev.data.length, newLen = view.data.length;
      const maxLen = Math.max(prevLen, newLen);
      const oldXAt = i => pad.l + (prevLen <= 1 ? pw / 2 : (i / (prevLen - 1)) * pw);
      const newXAt = i => pad.l + (newLen <= 1 ? pw / 2 : (i / (newLen - 1)) * pw);
      const idx = Array.from({ length: maxLen }, (_, i) => i);
      const fromX = idx.map(i => i < prevLen ? oldXAt(i) : newXAt(Math.min(i, newLen - 1)));
      const toX = idx.map(i => i < newLen ? newXAt(i) : oldXAt(Math.min(i, prevLen - 1)));
      const fromOp = idx.map(i => i < prevLen ? 1 : 0);
      const toOp = idx.map(i => i < newLen ? 1 : 0);
      const fromVal = idx.map(i => i < prevLen ? prev.data[i] : null);
      const toVal = idx.map(i => i < newLen ? view.data[i] : null);
      const labelsForFrame = idx.map(i => i < newLen ? view.labels[i] : prev.labels[i]);

      const duration = 420;
      const start = performance.now();
      const step = now => {
        if (myGen !== gen) return;
        const t = Math.min(1, (now - start) / duration);
        const e = MINI_EASE_ZOOM(t);
        const xs = idx.map(i => fromX[i] + (toX[i] - fromX[i]) * e);
        const ops = idx.map(i => fromOp[i] + (toOp[i] - fromOp[i]) * e);
        const iData = idx.map(i => {
          const fv = fromVal[i], tv = toVal[i];
          if (fv == null || tv == null) return fv ?? tv;
          return fv + (tv - fv) * e;
        });
        chartWrap.innerHTML = buildSparklineFrame(labelsForFrame, iData, xs, ops, padL, segmentsForView(view));
        if (t < 1) requestAnimationFrame(step); else renderStatic(view);
      };
      requestAnimationFrame(step);
    } else {
      renderStatic(view);
    }

    prev = view;
  }

  // Position card only: keep the URL in sync as the user clicks these pills
  // directly, not just when something else triggers a full re-render — a
  // reload right after picking "Q1" needs pq=1 already in the hash, since
  // selectTitle() itself won't run again until the next filter change.
  const syncHash = wrapEl.id === "mini-pos-trend-wrap" && currentSelection?.type === "title"
    ? () => setHash({ pos: currentSelection.titleName, pmetric: metric, pq: qf })
    : () => {};

  wrapEl.querySelectorAll(".mini-pill[data-metric]").forEach(pill => {
    pill.addEventListener("click", () => {
      metric = pill.dataset.metric;
      wrapEl.querySelectorAll(".mini-pill[data-metric]").forEach(p => p.classList.toggle("active", p === pill));
      render();
      syncHash();
    });
  });
  wrapEl.querySelectorAll(".mini-q[data-q]").forEach(btn => {
    btn.addEventListener("click", () => {
      qf = +btn.dataset.q;
      wrapEl.querySelectorAll(".mini-q").forEach(b => b.classList.toggle("active", b === btn));
      render();
      syncHash();
    });
  });

  render();
  return { getPrev: () => prev };
}

function renderOfficeDetail(officeName, el) {
  const trendWrapId = "mini-office-" + officeName.replace(/[^a-z0-9]/gi, "_");
  const hasTrend = summary.quarters.some(q => (q.top_offices || []).find(o => o.name === officeName));

  if (isLatestQuarter()) {
    // Every other stats computation (office list, distribution, title/position
    // stats) excludes shared employees — this one didn't, so an office's own
    // detail panel could show a different median/total/count than its own row
    // in the office list just above it.
    const staff = employees.filter(e => !e.intern && !e.shared && cleanOrg(e.office) === officeName)
      .sort((a,b) => b.annual_equiv - a.annual_equiv);
    if (!staff.length) { el.innerHTML = `<div class="office-detail-empty">No staff data.</div>`; return; }
    const amts = staff.map(e => e.annual_equiv).sort((a,b)=>a-b);
    const p = pct => { const i=(amts.length-1)*pct/100,lo=Math.floor(i),hi=Math.min(lo+1,amts.length-1); return amts[lo]+(amts[hi]-amts[lo])*(i-lo); };
    const median = Math.round(p(50)), p25 = Math.round(p(25)), p75 = Math.round(p(75));
    el.innerHTML = `
      ${memberPhotoHeaderHtml(staff[0]?.party, officeName)}
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
      ${memberPhotoHeaderHtml(o.party, officeName)}
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
  if (sortKey === "tenure") {
    if (o.medianTenureQuarters == null) return `<span class="office-range-tag">no tenure data</span>`;
    const years = Math.round(o.medianTenureQuarters / 4 * 10) / 10;
    return `${years} yr${years === 1 ? "" : "s"}<span class="office-range-tag">median tenure</span>`;
  }
  return `${fmtK(o.min)}<span class="office-range-sep">–</span>${fmtK(o.max)}`;
}

function renderOfficeList() {
  const q = ($("office-search").value || "").toLowerCase().trim();
  officeSortKey = $("office-sort").value;

  // Office type is filtered globally already (officeData is built from it in buildOfficeData())
  let rows = officeData.filter(o => {
    if (q && !fuzzyNameMatch(o.name, q)) return false;
    return true;
  });

  rows.sort((a,b) => {
    if (officeSortKey === "count")  return b.count - a.count;
    if (officeSortKey === "name")   return a.name.localeCompare(b.name);
    if (officeSortKey === "median") return b.median - a.median;
    if (officeSortKey === "mean")   return b.mean - a.mean;
    if (officeSortKey === "total")  return (b.totalAnnual||0) - (a.totalAnnual||0);
    if (officeSortKey === "tenure") return (b.medianTenureQuarters ?? -1) - (a.medianTenureQuarters ?? -1);
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
        <div class="office-name"><span class="office-name-text">${esc(o.name)}</span>${officePartyBadge(o)}</div>
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

function jumpToTitle(titleName) {
  closePersonDetail();
  const search = $("pos-search");
  if (search) { search.value = titleName; search.dispatchEvent(new Event("input", { bubbles: true })); }
  renderPosResults(titleName);
  saveState();
  requestAnimationFrame(() => {
    const row = [...document.querySelectorAll(".pos-row")].find(r => r.querySelector(".pos-row-name")?.textContent === titleName);
    if (row) {
      row.click();
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

// ── Table ──
function buildHistoricalEmployees(qId) {
  if (historicalEmployeesCache[qId]) return historicalEmployeesCache[qId];
  const list = (peopleData || []).reduce((acc, p) => {
    const h = p.history.find(x => x.quarter === qId);
    if (h) acc.push({
      name: p.name, office: p.office, title: p.title, type: p.type, party: p.party, leadership_party: p.leadership_party,
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
    if (partyFilter && partyValueOf(e) !== partyFilter) return false;
    if (q && !fuzzyNameMatch(e.name, q) && !fuzzyNameMatch(e.office, q) && !e.title.toLowerCase().includes(q)) return false;
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
      <td class="td-office" title="${esc(e.office)}"><span class="office-link with-party-badge" data-office="${esc(cleanOrg(e.office))}">${esc(cleanOrg(e.office))}${officePartyBadge(e)}</span></td>
      <td class="td-title">${esc(e.title)}</td>
      <td><span class="badge badge-${e.intern?"intern":e.shared?"shared":e.type}">${e.intern?"Intern":e.shared?"Shared":(TYPE_LABELS[e.type]||e.type)}</span></td>
      <td class="td-amt">${overCap ? `<span class="cap-warn" title="Exceeds $228k staff salary cap — may include a bonus or lump-sum payment">⚠</span> ` : ""}${fmt(e.annual_equiv)}</td>
      <td class="td-chevron"><span class="emp-row-chevron">›</span></td>
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

  // The office-type row is sticky; give it a shadow/border once it's actually
  // pinned to the top, using a 1px sentinel just above it as the trigger.
  const stickySentinel = $("type-filter-sentinel");
  const stickyRow = $("type-filter-row");
  if (stickySentinel && stickyRow) {
    new IntersectionObserver(([entry]) => {
      stickyRow.classList.toggle("is-stuck", !entry.isIntersecting);
    }).observe(stickySentinel);
  }

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
  document.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => setSortKey(th.dataset.sort)));
  document.addEventListener("click", e => {
    const off = e.target.closest(".office-link");
    if (off) { e.preventDefault(); e.stopPropagation(); jumpToOffice(off.dataset.office); return; }

    const tl = e.target.closest(".title-link");
    if (tl) { e.preventDefault(); e.stopPropagation(); jumpToTitle(tl.dataset.title); return; }

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
  document.querySelectorAll(".party-filter-btn[data-party]").forEach(btn => {
    btn.addEventListener("click", () => setPartyFilter(btn.dataset.party || ""));
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
