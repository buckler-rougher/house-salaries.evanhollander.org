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

def fmt_name(raw):
    """SMITH JOHN → John Smith (handles LAST, FIRST and LAST FIRST forms)"""
    raw = raw.strip()
    if "," in raw:
        parts = raw.split(",", 1)
        return f"{parts[1].strip().capitalize()} {parts[0].strip().capitalize()}"
    parts = raw.split()
    if len(parts) >= 2:
        # Likely LAST FIRST format — put first name first
        return " ".join(p.capitalize() for p in reversed(parts))
    return raw.capitalize()

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
        key = (vendor, org)
        payments[key]["amount"] += amount
        payments[key]["org"] = org
        if not payments[key]["title"]:
            payments[key]["title"] = title

    employees = []
    for (vendor, org), data in payments.items():
        total = data["amount"]
        if total <= 0:
            continue
        employees.append({
            "name": fmt_name(vendor),
            "office": org,
            "type": classify_office(org),
            "title": data["title"].title(),  # Title-case
            "quarterly_pay": round(total),
            "annual_equiv": round(total * 4),
        })

    return employees

def process_all(quarters_to_process=None):
    qs = quarters_to_process or QUARTERS
    quarter_summaries = []
    all_employees_latest = None
    latest_id = None

    for q in qs:
        employees = fetch_quarter(q)
        if employees is None:
            continue

        annual_amts = [e["annual_equiv"] for e in employees]
        by_type = defaultdict(list)
        by_title = defaultdict(list)
        for e in employees:
            by_type[e["type"]].append(e["annual_equiv"])
            if e["title"]:
                by_title[e["title"]].append(e["annual_equiv"])

        # Top titles by count (min 5 employees)
        top_titles = sorted(
            [(t, compute_stats(v)) for t, v in by_title.items() if len(v) >= 5],
            key=lambda x: -x[1]["count"]
        )[:50]

        summary = {
            "id": q["id"],
            "label": q["label"],
            "year": q["year"],
            "quarter": q["q"],
            "overall": compute_stats(annual_amts),
            "distribution": distribution_buckets(annual_amts),
            "by_type": {t: compute_stats(v) for t, v in by_type.items()},
            "top_titles": [{"title": t, **s} for t, s in top_titles],
        }
        quarter_summaries.append(summary)

        if all_employees_latest is None:
            all_employees_latest = employees
            latest_id = q["id"]

        print(f"    → {len(employees)} employees, median annual equiv ${summary['overall']['median']:,}", flush=True)

    return quarter_summaries, all_employees_latest, latest_id

def main():
    os.makedirs("data", exist_ok=True)

    print("Processing quarters...", flush=True)
    quarter_summaries, latest_employees, latest_id = process_all()

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

if __name__ == "__main__":
    main()
