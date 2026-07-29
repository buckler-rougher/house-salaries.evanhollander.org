#!/usr/bin/env python3
"""
One-off diagnostic: find every 2016-2020 SOD DETAIL GRID CSV on house.gov,
verify each against the schema fetch_sod.py's parser expects, and print
ready-to-paste QUARTERS entries for scripts/fetch_sod.py.

The 2016-2020 files don't always follow the "SODs/YYYYqN/...SOD-DETAIL..."
naming convention the 2021+ entries use (e.g. 2016's files live flat under
uploads/documents/ with no "SOD" token in the name at all), so this scrapes
broadly rather than guessing per-year URL patterns.

Not part of the regular pipeline - run manually via a one-off workflow,
then delete once QUARTERS has been backfilled.
"""
import re
import sys
import os
import urllib.request
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_sod import MONTH_TO_Q, Q_LABELS, BASE, SOD_PAGE  # noqa: E402

TARGET_YEARS = range(2016, 2021)  # 2016..2020 inclusive


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "house-salaries-bot/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_year_quarter(path):
    """Best-effort (year, quarter) from a DETAIL grid filename/path. Handles
    both 'JAN-MAR' style month-range names and anything with a single month
    token plus a 4-digit year.

    Must unquote %-encoding first: "%20" (an encoded space) directly abutting
    a year, e.g. "...MAR%202026%20SOD...", is the literal digit run "202026"
    once decoded-as-text — regex \\d{4} then greedily grabs "2020" as a false
    4-digit token instead of the real "2026". Every %20-encoded filename whose
    real year starts with "20" (i.e. any 2000s year) collides with the target
    2016-2020 range this way, so this isn't a rare edge case - it silently
    mismatches most modern-looking filenames unless decoded first.

    Returns None if it can't confidently tell."""
    path = urllib.parse.unquote(path)
    tokens = re.findall(r"[A-Z]+|\d{4}", path.upper())
    year = next((int(t) for t in tokens if len(t) == 4 and t.isdigit() and 2016 <= int(t) <= 2020), None)
    if not year:
        return None
    q = next((MONTH_TO_Q[t] for t in tokens if t in MONTH_TO_Q), None)
    if not q:
        return None
    return year, q


def crawl_for_links():
    seen_pages, to_visit, links = set(), [SOD_PAGE], []
    while to_visit and len(seen_pages) < 20:
        page = to_visit.pop()
        if page in seen_pages:
            continue
        seen_pages.add(page)
        try:
            html = fetch(page)
        except Exception as e:
            print(f"  ! failed to fetch {page}: {e}", flush=True)
            continue
        for m in re.finditer(r'href="([^"]*\.csv)"', html, re.I):
            path = urllib.parse.unquote(m.group(1))
            if re.search(r"DETAIL", path, re.I) and any(str(y) in path for y in TARGET_YEARS):
                url = path if path.startswith("http") else BASE + path
                if url not in links:
                    links.append(url)
        for m in re.finditer(r'href="([^"]*(?:archive|disbursement|statement-of-disbursements|page=)[^"]*)"', html, re.I):
            href = m.group(1)
            full = href if href.startswith("http") else BASE + href
            if "house.gov" in full and full not in seen_pages and full not in to_visit:
                to_visit.append(full)
    return links


def main():
    print(f"Crawling {SOD_PAGE} for 2016-2020 DETAIL grid links...", flush=True)
    links = crawl_for_links()
    print(f"Found {len(links)} raw candidate links:", flush=True)
    for l in links:
        print(f"  - {l}", flush=True)

    by_yq = {}
    for url in links:
        yq = parse_year_quarter(url)
        if not yq:
            print(f"  ? could not parse year/quarter from: {url}", flush=True)
            continue
        year, q = yq
        # Prefer the first-seen link for a given (year, q); verify it actually
        # has the expected header before accepting it.
        if (year, q) in by_yq:
            continue
        try:
            raw = fetch(url)
        except Exception as e:
            print(f"  ! fetch failed for {url}: {e}", flush=True)
            continue
        header = raw.splitlines()[0].upper() if raw.splitlines() else ""
        ok = all(col in header for col in ["ORGANIZATION", "VENDOR NAME", "SORT SUBTOTAL DESCRIPTION", "SORT SEQUENCE", "AMOUNT"])
        print(f"  {year}Q{q}: {url}", flush=True)
        print(f"    header ok: {ok}", flush=True)
        if ok:
            by_yq[(year, q)] = url

    print("\n=== MISSING QUARTERS ===")
    missing = []
    for year in TARGET_YEARS:
        for q in (1, 2, 3, 4):
            if (year, q) not in by_yq:
                missing.append((year, q))
    for year, q in missing:
        print(f"  {year}Q{q} - NOT FOUND")

    print("\n=== QUARTERS ENTRIES (paste into fetch_sod.py, newest-first) ===")
    for (year, q), url in sorted(by_yq.items(), reverse=True):
        rel = url.replace(BASE, "")
        print(f'    {{"id": "{year}Q{q}", "label": "{Q_LABELS[q]} {year}", "year": {year}, "q": {q}, "url": f"{{BASE}}{rel}"}},')

    print(f"\nFound {len(by_yq)} / {len(TARGET_YEARS) * 4} target quarters.")


if __name__ == "__main__":
    main()
