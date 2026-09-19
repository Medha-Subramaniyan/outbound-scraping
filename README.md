# outbound-scraping

Finds independent promoters, venue talent buyers, and boutique artist managers
**by what they actually do** — not by what their job title says.

```bash
npm install
cp .env.example .env          # set CRAWLER_CONTACT
npm run migrate

npm run discover -- --source axs-feed --urls terminalwestatl.com,variety-playhouse.com
npm run score
npm run report
npm run export                # → exports/qualified-*.csv
```

---

## Why this isn't a title search

The ICP is a **1–3 person booking function running 10–50 shows a year**. That is
a behavioural definition, and filtering a contact database on job title cannot
see it.

Title search is circular: it finds people who have already self-identified into
a formal role at an organisation big enough to have formal roles — the segment
directly *above* this ICP. The independent promoter running 14 shows a year has
"Founder" on LinkedIn, or nothing. The venue GM whose booking team is two people
has the same title as the one whose booking team is thirty. No directory carries
"size of booking function" or "shows per year", which are the only two fields
that actually separate them.

What *is* public, continuously, is the show itself — selling tickets requires
publishing the date, the venue, and usually the presenter. So the pipeline runs
backwards from the evidence:

```
discover → resolve → SCORE (the ICP gate) → enrich → contact
   events        orgs          band            people
```

Show count is **measured**, not asserted. Contact discovery — the expensive,
sensitive step — only happens after an org passes the gate.

---

## What a first real run looks like

Two Atlanta venues, one command:

```
130 events across 15 orgs

  Zero Mile                  promoter   64 shows
  Variety Playhouse          venue      49 shows   qualified
  The Masquerade             promoter    4 shows   watch
  Rival Entertainment        promoter    1 show
  Speakeasy Promotions       promoter    1 show
```

Zero Mile Presents and Rival Entertainment are real independent Atlanta
promoters. Neither was found by searching for a title — they were found because
their name appears in the `presentedBy` credit on shows they booked.

---

## The bands

| Band | Meaning |
|---|---|
| `qualified` | In the 10–50 band on counted shows. Ready for contact discovery. |
| `watch` | In band only by projection, on too little evidence. Re-run discovery. |
| `out-of-band` | Too few shows (still on a spreadsheet) or too many (has an ops team). |
| `excluded` | Live Nation / AEG / WME-scale, or enterprise by counted volume. |

**`watch` is not a rejection.** It resolves itself as repeated runs widen the
evidence, which is why this is built to be re-run rather than run once.

---

## Sources

| Source | Needs a key | Notes |
|---|---|---|
| `axs-feed` | no | **Primary.** Many independent rooms run their calendar on an AXS widget backed by a public JSON feed that names the *promoter* per show. That credit is the ICP signal. |
| `venue-calendar` | no | JSON-LD `Event` fallback for rooms not on AXS. |
| `bandsintown` | yes | Artist-keyed, so it reaches the manager/agent persona. Official API. |

Add a source by writing one file in `src/sources/` and registering it in
`src/sources/index.ts`. The pipeline never names a source directly.

---

## Personas

Titles do not *find* anyone here — they **route** someone once their org already
qualifies, and they let reply rates be measured per persona. Exports are split
by tier for exactly that reason: blended into one file, the personas contaminate
each other's numbers.

- **Primary** — Talent Buyer, Booking Manager, Promoter, Artist Manager, Booking Agent; Owner / Founder / Principal at a small entertainment company.
- **Secondary** — Venue Manager, GM, Director of Event Strategy, Event Operations. Reconciliation-pain validators more than buyers.
- **Tertiary** — Partnership Activation, Digital Strategy, Event Marketing.

Wedding, corporate and conference planners are **deliberately excluded**. They
are a separate market worth testing as its own list, not blended into this one.

Everything above lives in [`src/icp.ts`](src/icp.ts) — one file, so the ICP moves
in one place and the pipeline follows.

---

## Two traps this repo already fell into

Both were found by running against live data, and both are locked in by tests.

**1. A calendar is a forward booking window, not a history.**
139 of the first 140 scraped events were in the *future*. The span between first
and last event measures how far ahead an org has *announced*, not how often it
plays. Annualising naively against it gave Zero Mile ~174 shows/yr and excluded
a real ICP promoter as "enterprise". Forward windows are now treated as a lower
bound, and nothing is excluded on extrapolation — only on counted shows.

**2. Bad dates corrupt the number everything rests on.**
Live feeds contained `"TBD"` and a typo'd `2083` date. One 2083 row stretched an
observation window to 57 years, which *divides* the annualised rate down and
makes a busy venue look like it sits inside the band — manufacturing false
positives. Dates are now validated on ingest.

---

## Scope

Reads public event listings at one request per host per 1.5s, obeying
robots.txt, identifying itself with a contact address. It does not touch
LinkedIn, contact databases, or anything behind a login. See
[docs/ETHICS.md](docs/ETHICS.md).

## Layout

```
src/icp.ts             the ICP, as code — bands, personas, exclusions
src/lib/fetch.ts       polite fetcher, robots.txt, date validation
src/services/resolve.ts entity resolution — the hardest part
src/services/score.ts  the ICP gate
src/sources/           one file per discovery source
src/scripts/           the CLI: migrate, discover, score, report, export
```
