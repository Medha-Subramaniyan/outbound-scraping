# What's built, what's next

## Built

The full discover → resolve → score → export path, verified end to end against
live Atlanta venues (130 real events, 15 orgs, in one command).

- **`src/icp.ts`** — the ICP as code: volume band, personas, exclusions, priority metros.
- **`src/lib/fetch.ts`** — polite fetcher, robots.txt, JSON-LD extraction, date validation.
- **`src/services/resolve.ts`** — entity resolution, including co-presenter splitting.
- **`src/services/score.ts`** — the ICP gate, with asymmetric handling of forward calendars.
- **`src/sources/`** — `axs-feed`, `venue-calendar`, `bandsintown`.
- **`src/services/contact.ts`** — contact discovery: names, titles and published emails from an org's own pages.
- **`src/lib/render.ts`** — opt-in headless rendering (`--render`) for pages whose contacts mount client-side.
- **`src/metros.ts` / `src/services/seeds.ts`** — 67 US metros and per-metro venue seed files.
- **CLI** — `migrate`, `seed`, `discover`, `score`, `enrich`, `report`, `export`, `csv`.
  `enrich` takes `--render`, `--published-only` and `--band any`; `csv` takes `--published-only`.
- 56 tests, covering the live-data bugs found during both builds.

## Next, in order

### 1. Contact discovery — **built**, sources 1–2 of 4

`npm run enrich` crawls a qualified org's own `/about`, `/team`, `/contact` and
records named people with their persona, plus published and role emails. It runs
only on orgs past the ICP gate, per docs/ETHICS.md, and never guesses an address
— `inferred` is a schema value this code does not write.

Still open from the original ordering:

3. State business filings for the registered agent of a promotion company.
4. Paid enrichment, last, and only for orgs already qualified.

**The booking email is still a trap.** `booking@venue.com` is read by an intern
or nobody, so role addresses are recorded but marked `role` and ranked last.
`--published-only` drops them from a run's output and from `prospects.csv`,
while leaving the rows in the `people` table: a venue whose only listed contact
is `booking@` is then still recoverable without paying for another crawl.

**`--band any` is a bootstrap escape hatch.** It crawls every org with a
domain, scored or not, for the case where a seed list has been probed as
reachable but no show has been observed yet. It warns when used. The default
stays gated on the ICP band, because docs/ETHICS.md's ordering — qualify first,
then collect contact details — is what keeps the number of people in this
database small.

**Rendering, and what it actually bought.** `npm run enrich -- --render`
re-reads a page with a headless browser when the served HTML carried no contact
detail. On the three venues tested it turned 0 named people into 2 — Empty
Bottle's owner and managing partner, both with published addresses — and lifted
the contact count from 4 to 15. Static is still tried first on every page; the
browser only runs where the cheap read came back empty.

**What rendering did not fix.** It does not help *discovery*. Venues like
thecedar.org and tractortavern.com show 96–164 date-shaped strings on their
calendars and publish no `Event` JSON-LD in the DOM either — rendering confirms
the markup genuinely is not there. Counting those shows needs a DOM-based
calendar extractor, which is a different job from rendering and carries a real
risk of miscounting: a wrong date corrupts the show count the whole ICP gate
rests on. That is the next real increment for coverage.

### 2. Venue seed discovery — **partly built**

`npm run seed` scaffolds a seed file per metro and `discover --metro nashville`
/ `--all-metros` reads them, walking priority metros first. The ICP was never
geo-bound — `PRIORITY_METROS` is a scoring bonus, not a filter — so going
national was always a seeding problem, and this is the seeding half.

The lists are still hand-curated, because seed quality decides everything
downstream: a scraped directory brings in comedy clubs and wedding barns, and
each one costs a full crawl before being discarded. Automating the list is the
remaining work, roughly in order of ICP purity:

- **NIVA member directory** and regional presenter associations — explicitly
  independent-venue lists, so very high purity at low volume. Best used to
  *validate* orgs found elsewhere as much as to seed.
- AXS skin-id enumeration within a metro.
- State arts council grantee lists.

### 3. Artist → manager extraction

The `bandsintown` source is registered but seeded by hand. The artists are
already sitting in `events.title` from the venue runs — extract them, look each
one up, and the agent/manager persona falls out of the answer.

### 4. Longitudinal re-runs

Show count gets more trustworthy every time discovery runs, and `watch` orgs
resolve into verdicts as the evidence widens. This wants to be on a schedule
(seobot's `scheduler.ts` is the pattern) rather than run by hand.

Practically: the first run gives candidates, the fourth month gives a qualified
list. Plan for that rather than expecting the first export to be the deliverable.

### 5. Outreach status

The `outreach` table and its state machine exist; nothing writes to them. Worth
doing once sending actually starts, so reply rates can be split by persona tier —
which is the one measurement that can disprove the ICP.

## Known limits

- **`venue-calendar` is weak on JS-rendered sites.** It reads JSON-LD; sites that
  render client-side and publish no markup return zero events, which is
  indistinguishable from "no shows". `axs-feed` exists because the first two
  venues tried were exactly this case. Assume other widget vendors need the same
  treatment.
- **Capacity is never populated.** The scorer uses it when present, but no source
  fills it yet.
- **`kind` is inferred from the presenter credit only.** An org seen solely as a
  venue is tagged `venue` even if it also promotes elsewhere.
- **One metro tested.** The ICP is not geo-bound, but only Atlanta venues have
  been run so far.
