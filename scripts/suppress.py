#!/usr/bin/env python3
"""Admin CLI for opt-out requests that can't go through the automated lane —
former staff, and the ~5% of names that don't map to a first.last house.gov
address.

    export SUPPRESSION_PEPPER=...          # same secret as Pages / Actions

    python scripts/suppress.py "Morgan Cintron"     # search, confirm, add
    python scripts/suppress.py --list               # what's suppressed
    python scripts/suppress.py --recheck            # refresh name variants
    python scripts/suppress.py --remove <id>        # undo (reversal request)

Searching by partial name matters: entries are keyed on (name, office) and
nobody should be hand-typing an exact "HON. CHRISTOPHER H. SMITH" to honor a
request. Pick from a list instead.

Every name variant found across the archive is recorded, not just the current
spelling, because SOD punctuation drifts between quarters and a suppression
that only knows one spelling can silently stop matching later.
"""
import argparse
import datetime
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import suppression
from suppression import normalize_name


def load_people():
    """Every person record across the shards. Includes former staff, which is
    the point — they're the population the automated lane can't serve."""
    people = []
    for path in sorted(glob.glob("data/people-[0-9]*.json")):
        with open(path) as f:
            people.extend(json.load(f).get("people", []))
    if not people:
        raise SystemExit("No data/people-N.json found — run the data pipeline first.")
    return people


def group_by_identity(people):
    """Collapse to one entry per real person, keyed the same way fetch_sod.py
    keys people_index, so what's shown here is what will actually match."""
    groups = {}
    for p in people:
        key = suppression.person_key(p["name"], p["office"])
        g = groups.setdefault(key, {"key": key, "office": p["office"], "names": set(),
                                    "titles": set(), "quarters": set()})
        g["names"].add(p["name"])
        g["titles"].add(p.get("title", ""))
        g["quarters"].update(h["quarter"] for h in p.get("history", []))
    return groups


def search(groups, query):
    q = normalize_name(query).split()
    hits = []
    for g in groups.values():
        hay = normalize_name(" ".join(g["names"]))
        if all(tok in hay for tok in q):
            hits.append(g)
    return sorted(hits, key=lambda g: sorted(g["names"])[0])


def describe(g):
    qs = sorted(g["quarters"])
    span = f"{qs[0]}–{qs[-1]}" if qs else "?"
    names = " / ".join(sorted(g["names"]))
    titles = ", ".join(sorted(t for t in g["titles"] if t)) or "?"
    return f"{names}  |  {g['office']}  |  {titles}  |  {span} ({len(qs)} quarters)"


def cmd_add(args, doc, pepper):
    groups = group_by_identity(load_people())
    hits = search(groups, args.query)
    if not hits:
        raise SystemExit(f"No match for {args.query!r}.")
    if len(hits) > 1:
        print(f"{len(hits)} matches for {args.query!r}:\n")
        for i, g in enumerate(hits, 1):
            print(f"  [{i}] {describe(g)}")
        choice = input("\nWhich one? (number, or blank to cancel): ").strip()
        if not choice.isdigit() or not (1 <= int(choice) <= len(hits)):
            raise SystemExit("Cancelled.")
        g = hits[int(choice) - 1]
    else:
        g = hits[0]

    print(f"\n  {describe(g)}\n")
    # Every spelling gets its own digest. normalize_name() already folds
    # punctuation and word order, so in practice these collapse to one — but
    # a future variant it can't fold (a legal name change, a corrected typo)
    # would otherwise break the match silently.
    hashes = sorted({suppression.digest(n, g["office"], pepper) for n in g["names"]})
    existing = next((e for e in doc.get("entries", []) if set(e.get("hashes", [])) & set(hashes)), None)
    if existing:
        # Reporting the id matters: --list deliberately shows no names, so
        # searching by name is the only way to find out which entry belongs to
        # a person who now wants to be listed again.
        raise SystemExit(
            f"Already suppressed as entry {existing['id']} (added {existing.get('added','?')}).\n"
            f"To undo:  python3 scripts/suppress.py --remove {existing['id']}")

    if input("Suppress this person? [y/N] ").strip().lower() != "y":
        raise SystemExit("Cancelled.")

    entry_id = hashes[0][:12]
    doc.setdefault("entries", []).append({
        "id": entry_id,
        "hashes": hashes,
        "added": datetime.date.today().isoformat(),
        "via": args.via,
    })
    suppression.save(doc)
    print(f"\nAdded entry {entry_id} to {suppression.SUPPRESSED_PATH}.")
    print("Commit and push it, then re-run the data pipeline to apply.")


def cmd_list(doc):
    entries = doc.get("entries", [])
    if not entries:
        print("No suppressions.")
        return
    print(f"{len(entries)} suppression(s):\n")
    for e in entries:
        print(f"  {e['id']}  added {e.get('added','?'):10}  via {e.get('via','?'):6}  "
              f"{len(e.get('hashes', []))} name variant(s)")
    print("\nNames aren't recoverable from this file by design — that's the point.")
    print("Use --recheck to confirm each entry still matches somebody.")


def cmd_recheck(doc, pepper):
    """Re-scan the data for each entry and pick up spellings added since.

    This is the repair path for the fatal build error: if the source data now
    spells someone differently, their entry stops matching and the build
    refuses to deploy rather than republishing them.
    """
    groups = group_by_identity(load_people())
    live = {}
    for g in groups.values():
        for n in g["names"]:
            live[suppression.digest(n, g["office"], pepper)] = g

    changed = unmatched = 0
    for e in doc.get("entries", []):
        hit = next((live[h] for h in e.get("hashes", []) if h in live), None)
        if not hit:
            unmatched += 1
            print(f"  !! {e['id']} matches NOBODY — they may be republished. "
                  "Re-add them by name.")
            continue
        fresh = sorted({suppression.digest(n, hit["office"], pepper) for n in hit["names"]})
        if set(fresh) - set(e["hashes"]):
            e["hashes"] = sorted(set(fresh) | set(e["hashes"]))
            changed += 1
            print(f"  ++ {e['id']} picked up {len(set(fresh) - set(e['hashes']))} new variant(s)")

    if changed:
        suppression.save(doc)
        print(f"\nUpdated {changed} entry/entries. Commit, push, rebuild.")
    else:
        print(f"\nAll entries current. {unmatched} unmatched." if unmatched else "\nAll entries current.")
    return 1 if unmatched else 0


def cmd_remove(doc, entry_id):
    """Un-suppress. A reversal request needs the same verification as the
    original opt-out — this only performs it, it doesn't authorize it."""
    before = len(doc.get("entries", []))
    doc["entries"] = [e for e in doc.get("entries", []) if e.get("id") != entry_id]
    if len(doc["entries"]) == before:
        raise SystemExit(f"No entry {entry_id!r}.")
    suppression.save(doc)
    print(f"Removed {entry_id}. Commit, push, rebuild — they will be listed again.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("query", nargs="?", help="partial name to search for")
    ap.add_argument("--via", default="manual", choices=["manual", "auto"], help="how the request arrived")
    ap.add_argument("--list", action="store_true", help="show current suppressions")
    ap.add_argument("--recheck", action="store_true", help="refresh name variants; exits 1 if any entry matches nobody")
    ap.add_argument("--remove", metavar="ID", help="remove a suppression entry")
    args = ap.parse_args()

    doc = suppression.load()
    if args.list:
        return cmd_list(doc)
    # Reversal doesn't need the pepper — it deletes an entry by id and never
    # computes a digest. Gating it behind the secret only meant that undoing a
    # mistaken suppression was harder than making one, which is backwards.
    if args.remove:
        return cmd_remove(doc, args.remove)
    pepper = suppression.get_pepper()
    if args.recheck:
        return cmd_recheck(doc, pepper)
    if not args.query:
        ap.print_help()
        return 2
    return cmd_add(args, doc, pepper)


if __name__ == "__main__":
    sys.exit(main() or 0)
