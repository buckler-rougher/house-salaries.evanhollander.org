#!/usr/bin/env python3
"""
One-off diagnostic: what percent of current House staff (from data/employees.json)
also appear in the 2016 Q1 SOD DETAIL GRID? Answers whether backfilling SOD data
to 2016 would meaningfully widen the tenure-tracking window, or whether turnover
is so high that almost nobody from 2016 is still around anyway.

Matching is loose (first-name-token, last-name-token) rather than exact string
equality: data/employees.json's "name" field is already reordered to First
[Middle] Last [Suffix] by the production pipeline's fmt_name(), while the raw
2016 CSV is untouched "LAST FIRST [MIDDLE]" / "LAST, FIRST [MIDDLE]" SOD format
— comparing those as literal strings (or worse, re-running a reorder meant for
raw SOD strings on an already-reordered name) produces false negatives/garbage.
Dropping middle names/initials and suffixes trades a little precision for a much
lower false-negative rate, which is the right tradeoff for a feasibility check.

Not part of the regular pipeline — run manually via the tenure-2016-check
workflow, then delete once the question is answered.
"""
import csv, io, json, re, urllib.request

BASE = "https://www.house.gov"
SOD_PAGE = "https://www.house.gov/the-house-explained/open-government/statement-of-disbursements"

# The working Oct-Dec 2016 URL found by the first run's page-scrape fallback
# was "{BASE}/sites/default/files/uploads/documents/OCT-DEC 2016 DETAIL GRID.csv"
# (no "SOD" token, no year-quarter subdirectory — a different convention than
# the 2021+ files). Try the same convention for Jan-Mar first.
CANDIDATE_URLS = [
    f"{BASE}/sites/default/files/uploads/documents/JAN-MAR 2016 DETAIL GRID.csv",
    f"{BASE}/sites/default/files/uploads/documents/JANUARY-MARCH 2016 DETAIL GRID.csv",
    f"{BASE}/sites/default/files/uploads/documents/SODs/2016q1/JAN-MAR-2016-SOD-DETAIL-GRID_REVISED_9_26_16.csv",
    f"{BASE}/sites/default/files/uploads/documents/SODs/2016q1/JAN-MAR-2016-SOD-DETAIL-GRID.csv",
]

NAME_SUFFIXES = {"II", "III", "IV", "JR", "SR"}


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "house-salaries-bot/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_bytes_ok(url, timeout=60):
    """Like fetch() but returns None instead of raising, and requires the
    result to actually look like a DETAIL grid (has ORGANIZATION header)."""
    try:
        raw = fetch(url, timeout)
        if raw.splitlines() and "ORGANIZATION" in raw.splitlines()[0].upper():
            return raw
    except Exception as e:
        print(f"  candidate miss ({url}): {e}", flush=True)
    return None


def find_all_2016_detail_links():
    """Scrape the SOD page (and one hop of linked archive/disbursement pages)
    for every href referencing a 2016 DETAIL grid CSV, for diagnostics and as
    a fallback if the direct candidate URLs are wrong."""
    seen_pages, to_visit, links = set(), [SOD_PAGE], []
    while to_visit and len(seen_pages) < 8:
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
            path = m.group(1)
            if "2016" in path and re.search(r"DETAIL", path, re.I):
                url = path if path.startswith("http") else BASE + path
                if url not in links:
                    links.append(url)
        for m in re.finditer(r'href="([^"]*(?:archive|disbursement)[^"]*)"', html, re.I):
            href = m.group(1)
            full = href if href.startswith("http") else BASE + href
            if "house.gov" in full and full not in seen_pages:
                to_visit.append(full)
    return links


def discover_2016q1():
    for url in CANDIDATE_URLS:
        raw = fetch_bytes_ok(url)
        if raw:
            print(f"  Found via direct candidate: {url}", flush=True)
            return raw

    print("  Direct candidates missed; scraping SOD page for all 2016 DETAIL links...", flush=True)
    links = find_all_2016_detail_links()
    print(f"  Found {len(links)} candidate 2016 DETAIL links:", flush=True)
    for l in links:
        print(f"    - {l}", flush=True)

    # Prefer anything that looks like Jan-Mar / Q1 over other quarters.
    def is_q1(url):
        up = url.upper()
        return any(tok in up for tok in ["JAN-MAR", "JANUARY-MARCH", "JAN_MAR", "JANMAR", "Q1"])

    ordered = sorted(links, key=lambda l: (not is_q1(l), l))
    for url in ordered:
        raw = fetch_bytes_ok(url)
        if raw:
            print(f"  Using: {url} (Q1 match: {is_q1(url)})", flush=True)
            return raw
    raise RuntimeError("Could not locate any working 2016 DETAIL GRID CSV")


def raw_sod_name_key(vendor_raw):
    """SOD vendor strings are 'LAST FIRST [MIDDLE...]' or 'LAST, FIRST
    [MIDDLE...]' (see fetch_sod.py's fmt_name doc comment). Extract a loose
    (FIRST_TOKEN, LAST_TOKEN) key without needing full reordering/capitalization
    logic - we only need equality, not a display string."""
    s = re.sub(r"[.,]", " ", vendor_raw.strip().upper())
    tokens = [t for t in s.split() if t and t not in NAME_SUFFIXES]
    if len(vendor_raw.split(",")) >= 2:
        # "LAST [SUFFIX], FIRST [MIDDLE...]" - last name is everything before comma
        last_part, _, rest = vendor_raw.upper().partition(",")
        last_tokens = [t for t in re.sub(r"[.,]", " ", last_part).split() if t not in NAME_SUFFIXES]
        rest_tokens = [t for t in re.sub(r"[.,]", " ", rest).split() if t not in NAME_SUFFIXES]
        if not last_tokens or not rest_tokens:
            return None
        return (rest_tokens[0], last_tokens[-1])
    if len(tokens) < 2:
        return None
    return (tokens[1], tokens[0])  # LAST FIRST [MIDDLE...] -> (FIRST, LAST)


def display_name_key(display_name):
    """data/employees.json names are already 'First [Middle] Last [Suffix]'
    (production fmt_name() output) - just pull first/last tokens, no reorder."""
    s = re.sub(r"[.,]", " ", display_name.strip().upper())
    tokens = [t for t in s.split() if t and t not in NAME_SUFFIXES]
    if len(tokens) < 2:
        return None
    return (tokens[0], tokens[-1])


def extract_2016_keys(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text))
    reader.fieldnames = [f.strip() for f in (reader.fieldnames or [])]
    print(f"  2016 file columns: {reader.fieldnames}", flush=True)
    keys = set()
    sample_raw = []
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
        key = raw_sod_name_key(vendor)
        if key:
            keys.add(key)
            if len(sample_raw) < 10:
                sample_raw.append((vendor, key))
    print("  Sample 2016 raw vendor -> key:", flush=True)
    for v, k in sample_raw:
        print(f"    {v!r} -> {k}", flush=True)
    return keys


def main():
    print("Loading current staff from data/employees.json...", flush=True)
    with open("data/employees.json") as f:
        current = json.load(f)["employees"]
    current_staff = [e for e in current if not e.get("intern") and not e.get("shared")]
    print(f"  {len(current_staff)} current non-intern, non-shared staff", flush=True)
    print("  Sample current display name -> key:", flush=True)
    for e in current_staff[:10]:
        print(f"    {e['name']!r} -> {display_name_key(e['name'])}", flush=True)

    current_keys = {}
    for e in current_staff:
        k = display_name_key(e["name"])
        if k:
            current_keys.setdefault(k, []).append(e["name"])

    print("Fetching 2016 Q1 SOD DETAIL GRID...", flush=True)
    raw_2016 = discover_2016q1()
    keys_2016 = extract_2016_keys(raw_2016)
    print(f"  {len(keys_2016)} unique (first,last) keys in 2016 file", flush=True)

    overlap_keys = set(current_keys.keys()) & keys_2016
    pct = 100 * len(overlap_keys) / len(current_keys) if current_keys else 0

    print("\n=== RESULT ===")
    print(f"Current staff (unique first/last keys): {len(current_keys)}")
    print(f"Also present in 2016 file: {len(overlap_keys)}")
    print(f"Percent of current staff also in 2016: {pct:.2f}%")
    if overlap_keys:
        print("\nSample matches:")
        for k in sorted(overlap_keys)[:25]:
            print(f"  - {current_keys[k][0]}")


if __name__ == "__main__":
    main()
