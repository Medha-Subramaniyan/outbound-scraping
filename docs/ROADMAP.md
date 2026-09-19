# What's built, what's next

## Built

The full discover → resolve → score → export path, verified end to end against
live Atlanta venues (130 real events, 15 orgs, in one command).

- **`src/icp.ts`** — the ICP as code: volume band, personas, exclusions, priority metros.
- **`src/lib/fetch.ts`** — polite fetcher, robots.txt, JSON-LD extraction, date validation.
- **`src/services/resolve.ts`** — entity resolution, including co-presenter splitting.
- **`src/services/score.ts`** — the ICP gate, with asymmetric handling of forward calendars.
- **`src/sources/`** — `axs-feed`, `venue-calendar`, `bandsintown`.
- **CLI** — `migrate`, `discover`, `score`, `report`, `export`.
- 32 tests, covering both live-data bugs found during the build.

## Next, in order

### 1. Contact discovery (`src/services/contact.ts`)

The gap between a qualified org and a person to write to. The `people` table and
its persona routing exist; nothing fills them yet.

Order of preference, best first:

1. The venue's or promoter's own `/about`, `/team`, `/contact` — real names, often the GM or buyer directly.
2. The published booking/submissions email. Real, but usually an unread firehose — mark it `role`, not `published`.
3. State business filings for the registered agent of a promotion company.
4. Paid enrichment, last, and only for orgs already qualified.

**The booking email is a trap.** `booking@venue.com` is read by an intern or
nobody. The value is in the named GM or the promoter's own address, so
prioritise sources that yield a human name.

### 2. Venue seed discovery

Right now `--urls` is hand-fed. It should be possible to say "Atlanta" and get a
venue list. Options, roughly in order of ICP purity:

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
