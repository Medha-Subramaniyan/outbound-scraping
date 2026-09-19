# outbound-scraping

Finds independent promoters, venue talent buyers, and boutique artist managers
**by what they actually do** — not by what their job title says. Then finds a
published email address for them.

Current database: **419 published contacts across 138 venues**, 463 orgs, 272
events, 81 metros seeded.

---

## Get running in five minutes

```bash
git clone <this repo> && cd outbound-scraping
npm install

cp .env.example .env
# Open .env and set CRAWLER_CONTACT to your email address. This goes in the
# User-Agent of every request so a site owner who notices the traffic can ask
# us to stop. Nothing should be run against a real site without it.

npm run migrate        # creates data/prospects.db
npm run seed           # creates data/seeds/*.txt, one file per metro
```

You now have an empty database and empty seed files. **Your copy starts empty
on purpose** — the database and the scraped contacts are gitignored, because
they are real people's contact details and they stay on the machine that
scraped them. See [docs/ETHICS.md](docs/ETHICS.md).

To fill it, the fastest path is the Independent Venue Week directory:

```bash
npm run directory -- --all --write    # ~400 venues, all 50 states (~35 min)
npm run targets -- --probe --write    # turn seeds into crawlable org rows
npm run enrich -- --band any --render --published-only
npm run csv -- --published-only       # → data/csv/prospects.csv
```

That last file is the working list. Open it in a spreadsheet.

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
seed → discover → resolve → SCORE → enrich → export
 who    what shows   which    the ICP   find a   your
 to      are they     org      gate     person   list
 look    putting on?  is it?
 at?
```

Show count is **measured**, not asserted.

---

## The two halves, and why they are currently disconnected

This is the most important thing to understand before you extend the tool.

**Half one — contact discovery — works well.** Point it at a venue's website,
it finds published email addresses. 419 of them so far.

**Half two — ICP scoring — barely runs**, because it needs *events*, and most
venue websites do not publish machine-readable calendars. Of ~450 venues
crawled, only a handful yielded parseable events.

The consequence: **most of the 419 contacts are at orgs that were never
scored.** They sit at `icp_band = NULL` with `score_reasons` saying
`"never scored — no events measured for this org"`. That is deliberate and
honest — they are addresses at real independent venues, not qualified
prospects. Do not treat the two as the same thing in outreach.

Closing that gap is the highest-value work available. See
[Where to help](#where-to-help).

---

## Every command

Run any of these with `--help`-ish curiosity: most print usage when given no
arguments.

| Command | What it does |
|---|---|
| `npm run migrate` | Create the schema. Safe to re-run. |
| `npm run seed` | Scaffold `data/seeds/<metro>.txt` for all 81 metros. Never overwrites. |
| `npm run directory -- --all --write` | Crawl the Independent Venue Week member directory into seed files. The main way to get venues. |
| `npm run targets -- --probe --write` | Turn seed domains into `orgs` rows. `--probe` checks each domain responds first. |
| `npm run discover -- --source venue-calendar --metro atlanta` | Find events. `--all-metros` for everything, `--render` to use a browser. |
| `npm run score` | Apply the ICP gate to orgs that have events. |
| `npm run enrich -- --render --published-only` | Find people at qualified orgs. **The contact scraper.** |
| `npm run reclassify` | Re-apply current email rules to stored rows. `--apply` to write. |
| `npm run report` | What the pipeline currently believes, in the terminal. |
| `npm run csv -- --published-only` | Mirror the whole DB to `data/csv/*.csv`. |
| `npm run export` | The outreach artefact: one band, split per persona. |
| `npm test` / `npm run typecheck` / `npm run lint` | 72 tests. Run before pushing. |

### Flags worth knowing

`enrich` is the one you will use most:

- `--band any` — crawl every org with a domain, scored or not. **Needed for
  directory-sourced venues**, which have no band yet. It warns, because the
  ethical default is to qualify first and collect contacts second.
- `--render` — use a headless browser where the served HTML has no contact
  details. Roughly doubles the yield on modern venue sites; costs ~20× a plain
  fetch, so it only fires on pages the cheap read could not answer.
- `--published-only` — skip `booking@`/`info@` role mailboxes. They are still
  written to the database, just kept out of your working list.
- `--recheck` — re-crawl orgs already attempted. Without it, each org is
  crawled once ever (tracked in `orgs.enriched_at`).

---

## How email provenance works

Every address carries where it came from. This is the column your outreach
should key on.

| `email_source` | Meaning | Use it? |
|---|---|---|
| `published` | A personal address the org published — `erin@mercylounge.com` | Yes |
| `role` | A functional mailbox — `booking@`, `info@`, `boxoffice@` | Last resort; usually unread |
| `inferred` | Pattern-guessed | **Never written by this code** |

That last row matters: the schema allows `inferred`, and nothing in this repo
produces it. A guessed address that is wrong is spam sent to an uninvolved
stranger. If it was not published, we do not have it.

The classifier lives in `src/services/contact.ts`. It will need new rules as you
meet new sites — when you add one, run `npm run reclassify` so old rows get the
new rule too, otherwise `published` silently means "whatever the rules were the
day this row was written."

---

## The bands

| Band | Meaning |
|---|---|
| `qualified` | In the 10–50 band on counted shows. Ready for contact discovery. |
| `watch` | In band only by projection, on too little evidence. Re-run discovery. |
| `out-of-band` | Too few shows (still on a spreadsheet) or too many (has an ops team). |
| `excluded` | Live Nation / AEG / WME-scale, or enterprise by counted volume. |
| `NULL` | Never scored — no events measured. **Most rows are currently here.** |

**`watch` is not a rejection.** It resolves itself as repeated runs widen the
evidence, which is why this is built to be re-run rather than run once.

---

## Sources

| Source | Needs a key | Notes |
|---|---|---|
| `ivw-directory` | no | **Seeding, not events.** The Independent Venue Week member list — ~400 venues with city, capacity and website. Membership is an independent-ownership signal a calendar cannot give you. |
| `axs-feed` | no | Many independent rooms run their calendar on an AXS widget backed by a public JSON feed that names the *promoter* per show. That credit is the ICP signal. |
| `venue-calendar` | no | JSON-LD `Event` fallback for rooms not on AXS. Works on maybe 1 venue in 20 — see below. |
| `bandsintown` | yes | Artist-keyed, so it reaches the manager/agent persona. Official API. |

Add a source by writing one file in `src/sources/` and registering it in
`src/sources/index.ts`. The pipeline never names a source directly.

---

## Where to help

Ranked by how much they would improve the tool this semester.

### 1. A DOM-based calendar extractor (biggest win by far)

`venue-calendar` only reads JSON-LD `Event` markup. Most independent venues
don't publish it — their calendars are plain HTML. The crawler can *see* this
and says so:

```
https://thecedar.org/events: no JSON-LD, but 164 date-like strings — flagging for review
https://tractortavern.com/calendar: no JSON-LD, but 96 date-like strings
```

164 date-shaped strings is a real calendar the parser can't read. Headless
rendering does **not** fix this — I checked, the markup genuinely has no Event
data in the DOM either.

Writing a DOM extractor (find repeated card structures, pull date + title +
presenter) would unlock scoring for hundreds of already-seeded venues, which
converts "contacts at venues" into "contacts at *qualified* venues."

**Be careful:** a wrong date silently corrupts the show count the entire ICP
gate rests on. Read the two traps at the bottom of this file before starting,
and add tests.

### 2. Bind names to addresses

Only **21 of 419** contacts have a name attached. The rest are clearly personal
(`daniel@unionstage.com`) but the extractor couldn't tie them to a person, so
you know the address and not who reads it.

`extractPeople()` in `src/services/contact.ts` reads name/title pairs out of
team-page markup. It's deliberately conservative — it would rather miss someone
than invent "Privacy Policy, Director" — but it's leaving a lot on the table.
Better structural parsing (staff cards, `mailto:` links adjacent to headings)
would raise that ratio a lot.

### 3. More seed directories

IVW is one association. State arts-council grantee lists, NIVA, and regional
presenter associations would all add sourced venues. Model the adapter on
`src/sources/ivw-directory.ts` and write seeds with provenance comments.

**Please don't hand-write seed lists from memory.** An earlier version of this
repo did, and it produced parked domains, an AEG-owned venue that `icp.ts`
explicitly excludes, and a broker's sales address (`interested@domainmarket.com`)
recorded as a live venue contact. Every seed should be traceable to a source.

### 4. Fix the metro fallback

~5% of IVW pages list no address, so those venues fall back to their state's
*first* metro in `src/metros.ts`. Two Kansas City venues are currently filed
under St. Louis. The contacts are correct; the city label isn't. Reading the
city from the venue's own site during enrichment would fix it cheaply.

---

## Data files and what's gitignored

```
data/prospects.db     the database          gitignored
data/seeds/*.txt      venue seeds per metro gitignored
data/csv/*.csv        readable mirror       gitignored
exports/*.csv         outreach artefacts    gitignored
.env                  your crawler contact  gitignored
```

**Nothing with contact data enters git.** Each teammate scrapes their own copy.
Don't commit the database, don't paste contact rows into a shared doc that
outlives the campaign, and don't work around the gitignore.

Seed files are gitignored too, which means you each build your own — run
`npm run directory -- --all --write` after cloning. If the team wants to share
a vetted seed list, that's a reasonable thing to discuss, since seeds are
business addresses rather than personal ones.

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

A third, from the contact-scraping work: **the crawler once reported
`robots.txt disallows` for every URL on every site** while actually crashing.
A non-ASCII character in the User-Agent made Node reject every request, and the
`catch` turned the crash into "disallowed". If output looks uniformly negative,
suspect the tool before the sites.

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

## Scope

Reads public event listings and venue contact pages at one request per host per
1.5s, obeying robots.txt, identifying itself with a contact address. It does not
touch LinkedIn, contact databases, or anything behind a login or a bot wall.

If a site returns 403 or puts up a Cloudflare challenge, that is an answer —
don't work around it. See [docs/ETHICS.md](docs/ETHICS.md) before adding a
source.

---

## Layout

```
src/icp.ts                    the ICP, as code — bands, personas, exclusions
src/metros.ts                 81 US metros, crawl order
src/lib/fetch.ts              polite fetcher, robots.txt, date validation
src/lib/render.ts             headless browser, for client-rendered pages
src/services/resolve.ts       entity resolution — the hardest part
src/services/score.ts         the ICP gate
src/services/contact.ts       email extraction + provenance classification
src/services/seeds.ts         seed file reading
src/sources/                  one file per discovery source
src/scripts/                  the CLI
tests/                        72 tests; most encode a bug found in live data
docs/ETHICS.md                read before adding a source
docs/ROADMAP.md               what's built, what's next
```
