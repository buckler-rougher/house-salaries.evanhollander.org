#!/usr/bin/env python3
"""
Download and process House Statement of Disbursements CSVs.
Outputs salary data to data/summary.json and data/employees.json.

Key column notes (from actual CSVs):
- Column headers have trailing spaces; strip all keys
- Personnel rows: SORT SUBTOTAL DESCRIPTION == "PERSONNEL COMPENSATION"
- DESCRIPTION field contains job title (e.g. "LEGISLATIVE ASSISTANT", "CHIEF OF STAFF")
- AMOUNT is the quarterly payment in dollars
"""
import csv, json, io, re, os, sys, urllib.request
from collections import defaultdict

BASE = "https://www.house.gov"

QUARTERS = [
    {"id": "2026Q1", "label": "Jan–Mar 2026", "year": 2026, "q": 1, "url": f"{BASE}/sites/default/files/2026-05/grids/JAN-MAR%202026%20SOD%20DETAIL%20GRID-FINAL.csv"},
    {"id": "2025Q4", "label": "Oct–Dec 2025", "year": 2025, "q": 4, "url": f"{BASE}/sites/default/files/2026-02/OCT-DEC-2025-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2025Q3", "label": "Jul–Sep 2025", "year": 2025, "q": 3, "url": f"{BASE}/sites/default/files/2025-11/grids/JULY-SEPTEMBER%202025%20SOD%20DETAIL%20GRID-FINAL.csv"},
    {"id": "2025Q2", "label": "Apr–Jun 2025", "year": 2025, "q": 2, "url": f"{BASE}/sites/default/files/2025-08/APRIL-JUNE%202025%20SOD%20DETAIL%20GRID-FINAL.csv"},
    {"id": "2025Q1", "label": "Jan–Mar 2025", "year": 2025, "q": 1, "url": f"{BASE}/sites/default/files/2025-05/JANUARY-MARCH-2025-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2024Q4", "label": "Oct–Dec 2024", "year": 2024, "q": 4, "url": f"{BASE}/sites/default/files/2025-02/OCTOBER-DECEMBER-2024-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2024Q3", "label": "Jul–Sep 2024", "year": 2024, "q": 3, "url": f"{BASE}/sites/default/files/2024-11/JULY-SEPTEMBER_2024_SOD_DETAIL_GRID-FINAL.csv"},
    {"id": "2024Q2", "label": "Apr–Jun 2024", "year": 2024, "q": 2, "url": f"{BASE}/sites/default/files/2024-08/APRIL-JUNE-2024-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2024Q1", "label": "Jan–Mar 2024", "year": 2024, "q": 1, "url": f"{BASE}/sites/default/files/2024-05/JAN-MAR-2024-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2023Q4", "label": "Oct–Dec 2023", "year": 2023, "q": 4, "url": f"{BASE}/sites/default/files/2024-02/OCT-DEC-2023-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2023Q3", "label": "Jul–Sep 2023", "year": 2023, "q": 3, "url": f"{BASE}/sites/default/files/2023-11/JULY-SEPTEMBER-2023-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2023Q2", "label": "Apr–Jun 2023", "year": 2023, "q": 2, "url": f"{BASE}/sites/default/files/2023-08/APRIL-JUNE%202023%20SOD%20DETAIL%20GRID-FINAL.csv"},
    {"id": "2023Q1", "label": "Jan–Mar 2023", "year": 2023, "q": 1, "url": f"{BASE}/sites/default/files/2023-05/JAN-MAR-2023-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2022Q4", "label": "Oct–Dec 2022", "year": 2022, "q": 4, "url": f"{BASE}/sites/default/files/2023-02/OCT-DEC-2022-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2022Q3", "label": "Jul–Sep 2022", "year": 2022, "q": 3, "url": f"{BASE}/sites/default/files/2022-11/JULY-SEPT-2022-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2022Q2", "label": "Apr–Jun 2022", "year": 2022, "q": 2, "url": f"{BASE}/sites/default/files/2022-08/APR-JUNE-2022-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2022Q1", "label": "Jan–Mar 2022", "year": 2022, "q": 1, "url": f"{BASE}/sites/default/files/2022-05/JAN-MAR-2022-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2021Q4", "label": "Oct–Dec 2021", "year": 2021, "q": 4, "url": f"{BASE}/sites/default/files/uploads/documents/SODs/2021q4/OCT-DEC-2021-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2021Q3", "label": "Jul–Sep 2021", "year": 2021, "q": 3, "url": f"{BASE}/sites/default/files/uploads/documents/SODs/2021q3/JULY-2021-SOD-DETAIL-GRID-FINAL.csv"},
    {"id": "2021Q2", "label": "Apr–Jun 2021", "year": 2021, "q": 2, "url": f"{BASE}/sites/default/files/uploads/documents/SODs/2021q2/APR-JUN%202021%20SOD%20DETAIL%20GRID_FINAL.csv"},
    {"id": "2021Q1", "label": "Jan–Mar 2021", "year": 2021, "q": 1, "url": f"{BASE}/sites/default/files/uploads/documents/SODs/2021q1/JAN_MAR_2021_SOD_DETAIL_GRID_FINAL.csv"},
]

HOUSE_MIN_ANNUAL = 45000  # House minimum salary (set 2022)
HOUSE_MIN_QUARTERLY = HOUSE_MIN_ANNUAL / 4  # ~$11,250

def is_intern(title):
    t = title.upper()
    return "INTERN" in t

def classify_office(org):
    s = re.sub(r"^\d{4}\s+", "", org.upper())
    if s.startswith("HON.") or "REPRESENTATIVE" in s:
        return "member"
    if "COMMITTEE" in s:
        return "committee"
    if any(x in s for x in ["SPEAKER", "MAJORITY LEADER", "MINORITY LEADER",
                              "MAJORITY WHIP", "MINORITY WHIP", "REPUBLICAN CONFERENCE",
                              "DEMOCRATIC CAUCUS", "DEMOCRATIC CONFERENCE",
                              "REPUBLICAN STUDY"]):
        return "leadership"
    return "administrative"

NAME_SUFFIXES = {"II", "III", "IV", "V", "JR", "SR"}

def cap_part(p):
    """Capitalize a name segment, handling hyphens."""
    if "-" in p:
        return "-".join(seg.capitalize() for seg in p.split("-"))
    return p.capitalize()

def fmt_name(raw):
    """SOD format is LAST FIRST [MIDDLE [SUFFIX]] — output First [Middle] Last [Suffix]."""
    raw = raw.strip()
    if "," in raw:
        last, rest = raw.split(",", 1)
        parts = [p.strip() for p in rest.split() if p.strip()]
        return " ".join(cap_part(p) for p in parts) + " " + cap_part(last)
    parts = raw.split()
    if not parts:
        return raw
    # Pull trailing suffix (II, III, Jr., Sr.)
    suffix = None
    if len(parts) > 1 and parts[-1].upper().rstrip(".") in NAME_SUFFIXES:
        raw_suf = parts[-1].upper().rstrip(".")
        suffix = raw_suf if raw_suf not in {"JR", "SR"} else raw_suf.capitalize() + "."
        parts = parts[:-1]
    if len(parts) >= 2:
        last, first_middle = parts[0], parts[1:]
        result = " ".join(cap_part(p) for p in first_middle) + " " + cap_part(last)
        return result + (" " + suffix if suffix else "")
    return cap_part(parts[0])

TITLE_SMALL = {"of","the","a","an","and","or","but","in","on","at","to","for","with","by","from","vs","via"}
KEEP_UPPER = {"DC","LA","IT","PR","HR","VA","MD","NY","CA","TX","FL","OH","PA","US","GOP","DNC","FBI","DOJ","CBO","OMB"}

def _cap_word(w, force=False):
    """Capitalize a single word segment, respecting abbreviations and small words."""
    if "/" in w:
        return "/".join(_cap_word(p, force=True) for p in w.split("/"))
    up = w.upper()
    if up in KEEP_UPPER:
        return up
    if not force and w.lower() in TITLE_SMALL:
        return w.lower()
    return w.capitalize()

def title_case(s):
    """Smart title case: lowercase prepositions, preserve abbreviations, capitalize after /."""
    words = s.split()
    return " ".join(_cap_word(w, force=(i == 0)) for i, w in enumerate(words))

def normalize_title(desc):
    """Normalize job title for grouping."""
    return desc.strip().upper()

def percentile(data, p):
    if not data:
        return 0
    s = sorted(data)
    idx = (len(s) - 1) * p / 100
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)

def compute_stats(amounts):
    if not amounts:
        return {"count": 0, "median": 0, "p25": 0, "p75": 0, "p10": 0, "p90": 0, "mean": 0, "min": 0, "max": 0}
    s = sorted(amounts)
    return {
        "count": len(s),
        "median": round(percentile(s, 50)),
        "p25": round(percentile(s, 25)),
        "p75": round(percentile(s, 75)),
        "p10": round(percentile(s, 10)),
        "p90": round(percentile(s, 90)),
        "mean": round(sum(s) / len(s)),
        "min": round(s[0]),
        "max": round(s[-1]),
    }

def distribution_buckets(amounts, bucket_size=10000, max_val=250000):
    buckets = []
    for lo in range(0, max_val, bucket_size):
        hi = lo + bucket_size
        count = sum(1 for a in amounts if lo <= a < hi)
        buckets.append({"min": lo, "max": hi, "count": count})
    overflow = sum(1 for a in amounts if a >= max_val)
    if overflow:
        buckets.append({"min": max_val, "max": None, "count": overflow})
    return buckets

def fetch_quarter(q):
    print(f"  Fetching {q['id']} ({q['label']})...", flush=True)
    req = urllib.request.Request(q["url"], headers={"User-Agent": "house-salaries-bot/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  ERROR: {e}", flush=True)
        return None

    reader = csv.DictReader(io.StringIO(raw))
    # Strip trailing whitespace from all column names (CSV has padded headers)
    reader.fieldnames = [f.strip() for f in (reader.fieldnames or [])]

    # key = (vendor_name, organization) → {amount, title}
    payments = defaultdict(lambda: {"amount": 0.0, "title": "", "org": ""})

    for row in reader:
        row = {k.strip(): v.strip() for k, v in row.items()}
        if row.get("SORT SUBTOTAL DESCRIPTION") != "PERSONNEL COMPENSATION":
            continue
        if row.get("SORT SEQUENCE") != "DETAIL":
            continue
        try:
            amount = float(row.get("AMOUNT", "0").replace(",", ""))
        except ValueError:
            continue
        if amount <= 0:
            continue
        vendor = row.get("VENDOR NAME", "").strip()
        org = row.get("ORGANIZATION", "").strip()
        title = normalize_title(row.get("DESCRIPTION", ""))
        if not vendor or not org:
            continue
        # Normalize org: strip leading year so "2025 HON. X" and "2026 HON. X" merge
        org_key = re.sub(r"^\d{4}\s+", "", org).upper().strip()
        key = (vendor, org_key)
        payments[key]["amount"] += amount
        payments[key]["org"] = org  # keep most recent raw name for display
        if not payments[key]["title"]:
            payments[key]["title"] = title

    # Detect shared employees: same vendor name appears under multiple offices
    vendor_orgs = defaultdict(set)
    for (vendor, org) in payments:
        vendor_orgs[vendor].add(org)
    shared_vendors = {v for v, orgs in vendor_orgs.items() if len(orgs) > 1}

    employees = []
    for (vendor, org), data in payments.items():
        total = data["amount"]
        if total <= 0:
            continue
        title = title_case(data["title"])
        employees.append({
            "name": fmt_name(vendor),
            "office": data["org"],
            "type": classify_office(data["org"]),
            "title": title,
            "intern": is_intern(title),
            "shared": vendor in shared_vendors,
            "quarterly_pay": round(total),
            "annual_equiv": round(total * 4),
        })

    return employees

def process_all(quarters_to_process=None):
    qs = quarters_to_process or QUARTERS
    quarter_summaries = []
    all_employees_latest = None
    latest_id = None
    # key: (fmt_name, org_key) → {meta, history:[]}
    people_index = defaultdict(lambda: {"name":"","office":"","title":"","type":"","history":[]})

    for q in qs:
        employees = fetch_quarter(q)
        if employees is None:
            continue

        # Separate interns from regular staff; exclude shared employees from stats
        interns = [e for e in employees if e["intern"]]
        staff = [e for e in employees if not e["intern"] and not e["shared"] and e["annual_equiv"] >= HOUSE_MIN_ANNUAL]

        staff_amts = [e["annual_equiv"] for e in staff]
        by_type = defaultdict(list)
        by_title = defaultdict(list)
        for e in staff:
            by_type[e["type"]].append(e["annual_equiv"])
            if e["title"]:
                by_title[e["title"]].append(e["annual_equiv"])

        # Top titles by count (min 2 staff)
        top_titles = sorted(
            [(t, compute_stats(v)) for t, v in by_title.items() if len(v) >= 2],
            key=lambda x: -x[1]["count"]
        )[:200]

        # Top offices by staff count (for trend charts)
        by_office = defaultdict(list)
        for e in staff:
            key = re.sub(r"^FISCAL YEAR \d{4}\s*", "", re.sub(r"^\d{4}\s+", "", e["office"])).strip()
            by_office[key].append(e["annual_equiv"])
        by_office_pay = defaultdict(float)
        for e in staff:
            key = re.sub(r"^FISCAL YEAR \d{4}\s*", "", re.sub(r"^\d{4}\s+", "", e["office"])).strip()
            by_office_pay[key] += e["quarterly_pay"]
        top_offices = sorted(
            [{"name": name, "type": classify_office(name),
              "total_quarterly_pay": round(by_office_pay[name]), **compute_stats(v)}
             for name, v in by_office.items()],
            key=lambda x: -x["count"]
        )

        summary = {
            "id": q["id"],
            "label": q["label"],
            "year": q["year"],
            "quarter": q["q"],
            "overall": compute_stats(staff_amts),
            "intern_count": len(interns),
            "total_count": len(employees),
            "distribution": distribution_buckets(staff_amts),
            "by_type": {t: compute_stats(v) for t, v in by_type.items()},
            "top_titles": [{"title": t, **s} for t, s in top_titles],
            "top_offices": top_offices,
        }
        quarter_summaries.append(summary)

        # Build people history index (non-intern, non-shared only)
        for e in employees:
            if e["intern"] or e["shared"]:
                continue
            org_key = re.sub(r"^FISCAL YEAR \d{4}\s*", "", re.sub(r"^\d{4}\s+", "", e["office"])).strip()
            pk = (e["name"], org_key)
            p = people_index[pk]
            p["name"] = e["name"]
            p["office"] = org_key
            p["title"] = e["title"]
            p["type"] = e["type"]
            p["history"].append({"quarter": q["id"], "quarterly_pay": e["quarterly_pay"]})

        if all_employees_latest is None:
            all_employees_latest = employees
            latest_id = q["id"]

        print(f"    → {len(employees)} employees, median annual equiv ${summary['overall']['median']:,}", flush=True)

    # Only keep people who appear in 3+ quarters (history is in reverse-chron order from QUARTERS list)
    people_list = [
        {**v, "history": list(reversed(v["history"]))}
        for v in people_index.values() if len(v["history"]) >= 3
    ]
    people_list.sort(key=lambda p: p["name"])

    return quarter_summaries, all_employees_latest, latest_id, people_list

def main():
    os.makedirs("data", exist_ok=True)

    print("Processing quarters...", flush=True)
    quarter_summaries, latest_employees, latest_id, people_list = process_all()

    quarter_summaries.sort(key=lambda q: (q["year"], q["quarter"]))

    summary = {
        "updated": __import__("datetime").date.today().isoformat(),
        "latest_quarter": latest_id,
        "quarters": quarter_summaries,
    }

    with open("data/summary.json", "w") as f:
        json.dump(summary, f, separators=(",", ":"))
    print(f"Wrote data/summary.json ({os.path.getsize('data/summary.json'):,} bytes)", flush=True)

    if latest_employees:
        latest_employees.sort(key=lambda e: -e["annual_equiv"])
        with open("data/employees.json", "w") as f:
            json.dump({"quarter": latest_id, "employees": latest_employees}, f, separators=(",", ":"))
        print(f"Wrote data/employees.json ({os.path.getsize('data/employees.json'):,} bytes)", flush=True)

    with open("data/people.json", "w") as f:
        json.dump({"people": people_list}, f, separators=(",", ":"))
    print(f"Wrote data/people.json ({os.path.getsize('data/people.json'):,} bytes, {len(people_list):,} people)", flush=True)

def add_quarter(url):
    """
    Add a new quarter to the top of the QUARTERS list in this file.
    Infers quarter id and label from the URL (e.g. JAN-MAR-2026 → 2026Q1).
    """
    import ast, textwrap

    MONTH_TO_Q = {
        "JAN": 1, "JANUARY": 1, "FEB": 1, "FEBRUARY": 1, "MAR": 1, "MARCH": 1,
        "APR": 2, "APRIL": 2, "MAY": 2, "JUN": 2, "JUNE": 2,
        "JUL": 3, "JULY": 3, "AUG": 3, "AUGUST": 3, "SEP": 3, "SEPT": 3, "SEPTEMBER": 3,
        "OCT": 4, "OCTOBER": 4, "NOV": 4, "NOVEMBER": 4, "DEC": 4, "DECEMBER": 4,
    }
    Q_LABELS = {1: "Jan–Mar", 2: "Apr–Jun", 3: "Jul–Sep", 4: "Oct–Dec"}

    # Pull year and first month from url
    tokens = re.findall(r'[A-Z]+|\d{4}', url.upper())
    year = next((int(t) for t in tokens if len(t) == 4 and t.isdigit()), None)
    q = next((MONTH_TO_Q[t] for t in tokens if t in MONTH_TO_Q), None)
    if not year or not q:
        print("ERROR: could not infer quarter from URL. Check URL format.", file=sys.stderr)
        sys.exit(1)

    qid = f"{year}Q{q}"
    label = f"{Q_LABELS[q]} {year}"

    # Check not already present
    if any(x["id"] == qid for x in QUARTERS):
        print(f"{qid} already in QUARTERS list.")
        return

    # Validate URL fetches OK
    print(f"Validating {url} …", flush=True)
    try:
        with urllib.request.urlopen(url) as r:
            r.read(512)
    except Exception as e:
        print(f"ERROR: could not fetch URL: {e}", file=sys.stderr)
        sys.exit(1)

    entry = f'    {{"id": "{qid}", "label": "{label}", "year": {year}, "q": {q}, "url": f"{{BASE}}{url.replace(BASE, "")}"}},\n'

    # Rewrite this file, inserting after "QUARTERS = ["
    path = os.path.abspath(__file__)
    src = open(path).read()
    marker = "QUARTERS = [\n"
    idx = src.index(marker) + len(marker)
    new_src = src[:idx] + entry + src[idx:]
    open(path, "w").write(new_src)
    print(f"Added {qid} ({label}) to QUARTERS in {path}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--add-quarter", metavar="URL",
                        help="Add a new quarter CSV URL to the top of QUARTERS, then exit")
    args = parser.parse_args()
    if args.add_quarter:
        add_quarter(args.add_quarter)
    else:
        main()
