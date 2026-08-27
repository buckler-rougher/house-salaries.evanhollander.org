# House Staff Salaries — Project Rules

## Deploy & commit rules
- Every change must be committed AND pushed in the same step
- Deploy via `git push` only → Cloudflare Pages Git integration
- Cache-bust: bump `?v=YYYYMMDD+letter` on `styles.css` and `app.js` in `index.html` for every static file change
- Version format: `YYYYMMDD` + sequential letter (a, b, c…), e.g. `20260629a`
- Commit trailer: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

## Never do
- Never recommend paid APIs or services
- Never use curl or external API calls to verify code fixes — reason from local code only
- External API calls and curl are allowed for research and data fetching

## Architecture
- Cloudflare Pages — static except for `functions/`, which are Pages Functions
  (the opt-out endpoints; everything else is prebuilt JSON read by the browser)
- Pages env vars: `HMAC` (suppression pepper + derived link-signing key),
  `smtp` (Proton SMTP token), `GITHUB_TOKEN` (commits opt-outs). Production and
  Preview are separate scopes — variables set on one do not exist on the other.
- `SUPPRESSION_PEPPER` in GitHub Actions secrets must equal Cloudflare's `HMAC`,
  or the build can't tell who opted out and fails rather than republishing them
- Data pipeline: `scripts/fetch_sod.py` downloads SOD CSVs from house.gov, outputs `data/summary.json` and `data/employees.json`
- GitHub Actions (`update-data.yml`) runs the pipeline quarterly and commits updated JSON
- Frontend reads pre-built JSON — no backend at runtime

## Data source
- Statement of Disbursements of the House: https://www.house.gov/the-house-explained/open-government/statement-of-disbursements
- CSV column headers have trailing whitespace — always strip keys when parsing
- Personnel rows: `SORT SUBTOTAL DESCRIPTION == "PERSONNEL COMPENSATION"` and `SORT SEQUENCE == "DETAIL"`
- `DESCRIPTION` field contains the employee's job title
- Amounts are quarterly payments; multiply × 4 for annual equivalent (not all staff work full quarters)
- Quarter URLs are hardcoded in `scripts/fetch_sod.py` — add new entries when a new SOD is published
