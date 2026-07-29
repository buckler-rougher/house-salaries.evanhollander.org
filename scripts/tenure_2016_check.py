#!/usr/bin/env python3
"""
One-off diagnostic: what percent of current House staff (from data/employees.json)
also appear in the 2016 Q1 SOD DETAIL GRID? Answers whether backfilling to 2016
would meaningfully widen the tenure-tracking window, or whether turnover is so
high that almost nobody from 2016 is still around anyway.

Not part of the regular pipeline — run manually via the tenure-2016-check
workflow, then delete once the question is answered.
"""
import csv, io, json, re, urllib.request

BASE = "https://www.house.gov"
SOD_PAGE = "https://www.house.gov/the-house-explained/open-government/statement-of-disbursements"

# Filename found via web research for the 2016 Q1 DETAIL GRID; kept as a list
# since house.gov renames/moves these files without warning across years.
CANDIDATE_URLS = [
    f"{BASE}/sites/default/files/uploads/documents/SODs/2016q1/JAN-MAR-2016-SOD-DETAIL-GRID_REVISED_9_26_16.csv",
    f"{BASE}/sites/default/files/uploads/documents/SODs/2016q1/JAN-MAR-2016-SOD-DETAIL-GRID.csv",
    f"{BASE}/sites/default/files/uploads/documents/SODs/2016q1/JAN_MAR_2016_SOD_DETAIL_GRID_FINAL.csv",
]


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "house-salaries-bot/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def discover_2016q1_url():
    """Try known candidate filenames first; fall back to scraping the SOD page
    (and any linked archive page) for a href containing '2016' + 'DETAIL'."""
    for url in CANDIDATE_URLS:
        try:
            raw = fetch(url)
            if "ORGANIZATION" in raw.splitlines()[0].upper():
                print(f"  Found via candidate URL: {url}", flush=True)
                return raw
        except Exception as e:
            print(f"  candidate miss ({url}): {e}", flush=True)

    print("  Falling back to scraping SOD page for a 2016 Q1 link...", flush=True)
    seen_pages, to_visit = set(), [SOD_PAGE]
    while to_visit:
        page = to_visit.pop()
        if page in seen_pages:
            continue
        seen_pages.add(page)
        try:
            html = fetch(page)
        except Exception as e:
            print(f"    ! failed to fetch {page}: {e}", flush=True)
            continue
        for m in re.finditer(r'href="([^"]*\.csv)"', html, re.I):
            path = m.group(1)
            if "2016" in path and re.search(r"DETAIL", path, re.I):
                url = path if path.startswith("http") else BASE + path
                try:
                    raw = fetch(url)
                    if "ORGANIZATION" in raw.splitlines()[0].upper():
                        print(f"  Found via page scrape: {url}", flush=True)
                        return raw
                except Exception as e:
                    print(f"    ! scrape candidate failed ({url}): {e}", flush=True)
        if len(seen_pages) < 6:
            for m in re.finditer(r'href="([^"]*(?:archive|disbursement)[^"]*)"', html, re.I):
                href = m.group(1)
                full = href if href.startswith("http") else BASE + href
                if "house.gov" in full and full not in seen_pages:
                    to_visit.append(full)
    raise RuntimeError("Could not locate a 2016 Q1 DETAIL GRID CSV by any method")


def fmt_name(raw):
    """Same LAST FIRST [MIDDLE] -> normalized-for-matching key as fetch_sod.py's
    fmt_name, but simplified to just a comparable uppercase key (we only need
    to know if two rows refer to the same person, not a display string)."""
    raw = re.sub(r"\s+", " ", raw.strip().upper())
    raw = re.sub(r"\b(II|III|IV|JR\.?|SR\.?)\b", "", raw).strip()
    if "," in raw:
        last, rest = raw.split(",", 1)
        return f"{rest.strip()} {last.strip()}".strip()
    return raw


def extract_names(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text))
    reader.fieldnames = [f.strip() for f in (reader.fieldnames or [])]
    names = set()
    for row in reader:
        row = {k.strip(): (v or "").strip() for k, v in row.items()}
        if row.get("SORT SUBTOTAL DESCRIPTION") != "PERSONNEL COMPENSATION":
            continue
        if row.get("SORT SEQUENCE") != "DETAIL":
            continue
        vendor = row.get("VENDOR NAME", "")
        if not vendor:
            continue
        try:
            amount = float(row.get("AMOUNT", "0").replace(",", ""))
        except ValueError:
            continue
        if amount <= 0:
            continue
        names.add(fmt_name(vendor))
    return names


def main():
    print("Loading current staff from data/employees.json...", flush=True)
    with open("data/employees.json") as f:
        current = json.load(f)["employees"]
    current_staff = [e for e in current if not e.get("intern") and not e.get("shared")]
    current_names = {fmt_name(e["name"]) for e in current_staff}
    print(f"  {len(current_staff)} current non-intern, non-shared staff ({len(current_names)} unique names)", flush=True)

    print("Fetching 2016 Q1 SOD DETAIL GRID...", flush=True)
    raw_2016 = discover_2016q1_url()
    names_2016 = extract_names(raw_2016)
    print(f"  {len(names_2016)} unique personnel names in 2016 Q1", flush=True)

    overlap = current_names & names_2016
    pct = 100 * len(overlap) / len(current_names) if current_names else 0

    print("\n=== RESULT ===")
    print(f"Current staff: {len(current_names)}")
    print(f"Present in 2016 Q1: {len(overlap)}")
    print(f"Percent of current staff also in 2016 Q1: {pct:.2f}%")
    if overlap:
        print("\nSample matches:")
        for n in sorted(overlap)[:20]:
            print(f"  - {n}")


if __name__ == "__main__":
    main()
