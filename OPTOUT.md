# Handling removal requests by hand

Most staff never need this — anyone with a working House address can remove
themselves from their own listing page. This is the path for everyone else:
former staff, and the ~5% of names that don't reduce to a `first.last`
house.gov address.

---

## Before either procedure

Once per terminal window.

**1. Open a terminal.** On a Mac: `⌘ Space`, type *Terminal*, press Enter.

**2. Go to the project folder.**

```sh
cd ~/house-salaries.evanhollander.org
```

Type `ls` to check — you should see `app.js`, `data`, and `scripts`.

**3. Get the latest copy.**

```sh
git pull
```

This matters. Skip it and you may be editing an old version; the push at the
end will be rejected.

**4. Give the terminal the secret key.** Replace `PASTE_IT_HERE` with the
value of the `HMAC` variable from Cloudflare Pages settings.

```sh
export SUPPRESSION_PEPPER=PASTE_IT_HERE
```

Nothing visible happens — that's correct. The key is what turns a name into
the scrambled code stored in the file; without it the tool refuses to run.
**It only lasts for that one terminal window.**

---

## Taking someone off

**1. Search by name.** Partial is fine; you don't need their office or exact
spelling.

```sh
python3 scripts/suppress.py "Jane Smith"
```

**2. Pick the right person.** If several match, you get a numbered list with
each one's office, title, and service span. Type the number, press Enter.
Blank Enter cancels.

**3. Confirm.** It shows the single person it's about to remove:

```
Suppress this person? [y/N] y
```

**4. Publish.** Nothing has reached the live site yet.

```sh
git add data/suppressed.json
git commit -m "Honor opt-out request"
git push
```

**5. Wait ~2 minutes.** Pushing triggers a rebuild that strips them from the
published data. Check the **Actions** tab on GitHub — green tick means done,
red cross means see *When something goes wrong*.

**6. Check the site.** Search their name. If they're still showing, refresh —
your browser may be holding a cached copy.

---

## Putting someone back

You do **not** need the secret key for the removal step itself, so if that's
all you're doing you can skip setup step 4.

**1. Find their entry number.** The file stores no names on purpose, so you
can't read it directly. Search by name and the tool will recognise them:

```
$ python3 scripts/suppress.py "Jane Smith"
Already suppressed as entry 3f9a1c22b7e0 (added 2026-08-14).
To undo:  python3 scripts/suppress.py --remove 3f9a1c22b7e0
```

That step *does* need the key, because it has to scramble the name to look it
up. If there has only ever been one removal, `python3 scripts/suppress.py
--list` shows entry numbers without the key — but with several entries it
can't tell you which is which, which is the whole point of storing no names.

**2. Remove the entry.** Run exactly what it printed.

**3. Publish.**

```sh
git add data/suppressed.json
git commit -m "Reverse opt-out at request"
git push
```

**4. Wait and check**, same as above.

---

## When something goes wrong

Everything here is recoverable. Nothing loses data.

| Symptom | Fix |
| --- | --- |
| `SUPPRESSION_PEPPER is not set` | You skipped setup step 4, or you're in a new terminal window. Paste the `export` line again. |
| Actions run red, an entry "matched nobody" | Someone's name is spelled differently in the newest data than when they opted out, so the record no longer finds them. Run `python3 scripts/suppress.py --recheck`, then commit and push. The build stopping is deliberate — it refuses to republish someone rather than quietly putting them back. |
| "Updates were rejected" on push | Something else changed the repo since your pull. `git pull`, then `git push`. |
| Nothing changed after 5 minutes | Check the Actions tab. No new run means the push didn't land — check `git status`. |
| You removed the wrong person | Follow *Putting someone back*. Nothing is destroyed. |

---

## What removal actually does

They disappear from the staff table, search, their office's list, and the
position pages. Their detail card stops existing and their pay history goes
with it.

Site-wide figures — medians, percentiles, the distribution chart — are
computed **before** anyone is removed, so they don't shift. One visible side
effect: an office's headline staff count reads one higher than the number of
people listed under it.

Two limits worth stating to anyone who asks:

- **It doesn't reach house.gov.** House salaries are published by law in the
  quarterly Statement of Disbursements, which stays public regardless.
- **It isn't retroactive.** Earlier versions of the data remain in this
  repository's history, which is public.

---

See `scripts/suppression.py` for why the list holds digests rather than names,
and `scripts/fetch_sod.py` (`apply_suppressions`) for where removals are
applied in the build.
