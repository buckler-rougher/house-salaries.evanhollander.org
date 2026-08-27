#!/usr/bin/env python3
"""Opt-out suppression: who has asked to be left off the site, and how that
list is stored so the list itself doesn't leak.

WHAT GETS REMOVED
-----------------
Row-level only. fetch_sod.py applies this after process_all() has already
computed every aggregate, so medians, percentiles and distributions are
calculated over the full roster and never move when someone opts out. What
disappears is the person's row in employees.json and their record in the
people-N.json shards — the name, the salary line, the detail card.

Anything less is not an opt-out. Blanking a name while keeping office, title
and salary re-identifies someone immediately in a 14-person office.

WHY THE LIST IS HMAC'd, NOT HASHED
----------------------------------
data/suppressed.json is committed to a public repo, so it must not be a
readable list of people who asked for privacy — that would be worse than the
listing they objected to. A plain salted hash doesn't help either: the SOD
name list is public, so anyone can hash all ~8,600 names and match. It takes
a secret pepper (SUPPRESSION_PEPPER, never committed) to make the digests
genuinely opaque.

WHY THE KEY IS NORMALIZED FIRST
-------------------------------
SOD name spellings drift between quarters — the same person appears as
"A Brode Kimberly" and "Kimberly A Brode", with and without middle initials
and Jr/III suffixes. Hashing the raw string would mean a suppression silently
stops matching the next time the spelling changes, and the person quietly
reappears. Nobody would notice until they complained a second time.

So the key is normalized to be order- and punctuation-independent before
hashing (see person_key). Office goes through the same strip_org_prefix +
person_merge_key path tenure uses, so a committee being renamed mid-service
doesn't break a suppression either.

Normalization can't catch everything, which is why apply() reports entries
that matched nobody and the build treats that as fatal — see check_stale().
"""
import hashlib
import hmac
import json
import os
import re

SUPPRESSED_PATH = "data/suppressed.json"
PEPPER_ENV = "SUPPRESSION_PEPPER"

def normalize_name(name):
    """Case-, punctuation- and word-order-independent form of a name.

    Sorting the tokens is what makes "Alvarez Claudia Rondon" and "Claudia
    Rondon Alvarez" agree — the SOD reorders surnames unpredictably and a
    positional key would treat those as two different people.

    Middle initials and generational suffixes are deliberately KEPT. Dropping
    them looks appealing (it reunites another 51 records across the archive)
    but it merges people who are genuinely distinct: "Louis Miller Jr." and
    "Louis Miller III" are two people at the same office, as are "Robert C.
    Johnson" and "Robert L Johnson Jr.". Punctuation and word order alone
    account for 1,301 of the 1,352 available merges with zero such
    collisions, which is the right side of that trade — a false merge here
    would suppress the wrong person, or fuse two careers into one.

    Apostrophes are deleted rather than turned into spaces, so "O'Connor"
    normalizes to one token and can't collide with a surname "Connor".
    """
    words = re.sub(r"[^a-z ]", " ", name.lower().replace("'", "")).split()
    return " ".join(sorted(words))


def person_key(name, office_key):
    """Canonical (name, office) identity string. `office_key` must already be
    through strip_org_prefix(); callers in fetch_sod.py additionally apply
    person_merge_key() so a renamed committee stays one office."""
    return f"{normalize_name(name)}|{office_key.strip().upper()}"


def get_pepper(required=True):
    pepper = os.environ.get(PEPPER_ENV, "").strip()
    if not pepper and required:
        raise SystemExit(
            f"{PEPPER_ENV} is not set. Suppressions cannot be applied without it.\n"
            "Set it from the same secret stored in the Pages/Actions environment."
        )
    return pepper


def digest(name, office_key, pepper):
    return hmac.new(pepper.encode(), person_key(name, office_key).encode(), hashlib.sha256).hexdigest()


def load(path=SUPPRESSED_PATH):
    """Returns the suppression file, or an empty one if it doesn't exist yet."""
    if not os.path.exists(path):
        return {"version": 1, "entries": []}
    with open(path) as f:
        return json.load(f)


def save(doc, path=SUPPRESSED_PATH):
    doc["note"] = (
        "Opaque HMAC-SHA256 digests of (normalized name, office) for people who "
        "asked to be left off the site. Not reversible without the secret pepper. "
        "Managed by scripts/suppress.py — see scripts/suppression.py."
    )
    with open(path, "w") as f:
        json.dump(doc, f, indent=2, sort_keys=True)
        f.write("\n")


def all_hashes(doc):
    """Every digest across every entry. An entry can carry several — one per
    name variant seen in the data — so a spelling the CSV hasn't used yet
    still matches when it turns up."""
    out = set()
    for e in doc.get("entries", []):
        out.update(e.get("hashes", []))
    return out


def apply(rows, doc, pepper, name_of, office_of):
    """Drop suppressed people from `rows`.

    `name_of` / `office_of` pull the name and the already-prefix-stripped
    office key off whatever row shape is being filtered (employees.json rows
    and people-shard records differ). Returns (kept_rows, matched_hashes) so
    the caller can tell which entries actually hit something.
    """
    wanted = all_hashes(doc)
    if not wanted:
        return rows, set()
    kept, matched = [], set()
    for row in rows:
        h = digest(name_of(row), office_of(row), pepper)
        if h in wanted:
            matched.add(h)
        else:
            kept.append(row)
    return kept, matched


def check_stale(doc, matched):
    """Entries whose every digest matched nobody.

    This is a privacy failure, not a warning: it means someone who opted out
    is being published again, most likely because their name is now spelled
    differently in the source data. Callers should treat a non-empty result
    as fatal rather than deploying.
    """
    stale = []
    for e in doc.get("entries", []):
        if not (set(e.get("hashes", [])) & matched):
            stale.append(e)
    return stale
