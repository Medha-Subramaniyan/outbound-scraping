/**
 * Persistence. Every write is idempotent, because discovery is meant to be
 * re-run — that is how the observation window widens and 'watch' orgs resolve
 * into 'qualified' ones.
 */
import { db } from '../lib/db';
import { slugify, orgId, eventId, splitPresenters } from './resolve';
import type { DiscoveredEvent, Org, OrgKind } from '../types';

/**
 * Ticketing and aggregator hosts, which are never an org's own site.
 *
 * An event scraped from an AXS feed or a Bandsintown API carries that
 * platform's host in `sourceUrl`. Recording it as the venue's domain would
 * point contact discovery at ticketmaster.com for a hundred different venues —
 * crawling a site that has no team page for any of them, and filling the
 * database with one aggregator's support address.
 */
const AGGREGATOR_HOSTS = [
  'axs.com', 'ticketmaster.com', 'livenation.com', 'bandsintown.com',
  'eventbrite.com', 'seetickets.us', 'etix.com', 'dice.fm', 'songkick.com',
  'ticketweb.com', 'tixr.com', 'seatgeek.com', 'stubhub.com', 'prekindle.com',
  'showclix.com', 'universe.com', 'freshtix.com', 'eventvesta.com',
];

/** The bare host of a URL, or null when it is an aggregator or unparseable. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (AGGREGATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * True when a domain plausibly belongs to the named org.
 *
 * Compares the domain's second-level label against the org name with all
 * non-alphanumerics removed, in both directions: "Nectar Lounge" matches
 * nectarlounge.com, and "The Crocodile" matches thecrocodile.com, while
 * "Neumos" does not match nectarlounge.com.
 */
export function domainMatchesName(domain: string, name: string): boolean {
  const label = domain.split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!label || !org) return false;

  // Drop a leading "the" on either side before comparing, so "The Crocodile"
  // and "crocodile.com" still agree.
  const strip = (s: string) => (s.startsWith('the') && s.length > 5 ? s.slice(3) : s);
  const a = strip(label);
  const b = strip(org);

  return a.includes(b) || b.includes(a);
}

/**
 * Find or create an org, returning its id.
 *
 * City is folded into the slug, so an org first seen without a city and later
 * with one would fork. Resolved by backfilling city onto the existing row when
 * the slug matches, and only treating city as identifying once known.
 */
export function upsertOrg(
  name: string,
  kind: OrgKind,
  city?: string | null,
  region?: string | null,
  domain?: string | null
): string {
  const d = db();
  const slug = slugify(name, city);
  const id = orgId(slug);

  d.prepare(
    `INSERT INTO orgs (id, name, slug, kind, city, region, domain)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       -- Never downgrade a known kind back to 'unknown', and fill blanks only.
       kind       = CASE WHEN orgs.kind = 'unknown' THEN excluded.kind ELSE orgs.kind END,
       city       = COALESCE(orgs.city, excluded.city),
       region     = COALESCE(orgs.region, excluded.region),
       domain     = COALESCE(orgs.domain, excluded.domain),
       updated_at = datetime('now')`
  ).run(id, name.trim(), slug, kind, city ?? null, region ?? null, domain ?? null);

  const row = d.prepare(`SELECT id FROM orgs WHERE slug = ?`).get(slug) as { id: string };
  return row.id;
}

/**
 * Record one event, attributing it to the right org.
 *
 * Attribution rule: a named presenter owns the show, and the venue is recorded
 * alongside. Where no presenter is named, the venue is presumed to be
 * self-presenting. This is what separates a promoter's show count from the
 * count of the room they rented, and getting it backwards would credit every
 * independent promoter's work to the venue.
 */
export function recordEvent(e: DiscoveredEvent): { orgIds: string[]; created: boolean } {
  const d = db();

  // The page an event was scraped from is the venue's own site, so it is also
  // the venue's domain — which is what contact discovery later crawls. It is
  // attached to the *venue* only: a promoter credited on someone else's
  // calendar has not thereby told us their own website.
  //
  // `discoveredOn` is preferred over `sourceUrl` because a venue's JSON-LD
  // normally sets the event `url` to wherever tickets are sold. Reading the
  // domain off that gives tixr.com or eventbrite.com for every venue on the
  // platform, which `hostOf` then correctly discards — leaving no domain at
  // all. The crawled page is the one that actually belongs to the venue.
  const crawledDomain = hostOf(e.discoveredOn) ?? hostOf(e.sourceUrl);

  // Only claim the domain for the venue whose site we were actually on.
  //
  // Calendars routinely carry other rooms' shows: Nectar Lounge's calendar
  // lists Hidden Hall and Neumos dates, so attributing the crawled host to
  // every venue named on the page gave three different companies the same
  // domain. Contact discovery would then crawl Nectar's team page and file
  // its staff as working at Neumos — a wrong name against a real person,
  // which is exactly the error outreach cannot recover from.
  //
  // The check is deliberately loose (a slugified containment either way)
  // because "Nectar Lounge" lives at nectarlounge.com. When it does not
  // match, the org simply gets no domain and shows up in `enrich` as needing
  // a hand-found site.
  const venueDomain =
    crawledDomain && e.venueName && domainMatchesName(crawledDomain, e.venueName)
      ? crawledDomain
      : null;

  const venueOrgId = e.venueName
    ? upsertOrg(e.venueName, 'venue', e.city, e.region, venueDomain)
    : null;

  // Co-promotion is normal at this tier, and each named org negotiated the
  // show, so each is credited with it.
  const presenters = e.presentedBy ? splitPresenters(e.presentedBy) : [];

  const venueSlug = e.venueName ? slugify(e.venueName, e.city) : null;
  const promoterIds = presenters
    // A credit naming the venue itself is not a promoter relationship.
    .filter((p) => slugify(p, e.city) !== venueSlug)
    .map((p) => upsertOrg(p, 'promoter', e.city, e.region));

  // No named promoter means the venue is presenting its own show.
  const credited = promoterIds.length > 0 ? promoterIds : venueOrgId ? [venueOrgId] : [];

  const insert = d.prepare(
    `INSERT INTO events
       (id, org_id, venue_org_id, title, event_date, venue_name, city, region,
        presented_by, source, source_url, source_uid, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, source_uid) DO UPDATE SET
       -- A listing that gains a date or a presenter credit should improve the
       -- record, not be ignored as a duplicate.
       event_date   = COALESCE(excluded.event_date, events.event_date),
       presented_by = COALESCE(excluded.presented_by, events.presented_by),
       org_id       = COALESCE(events.org_id, excluded.org_id)`
  );

  let created = false;

  for (const orgIdForRow of credited.length ? credited : [null]) {
    // One row per credited org. The source_uid is suffixed so co-presented
    // shows do not collide on the UNIQUE(source, source_uid) key — without
    // that, the second promoter's credit would be silently swallowed by the
    // upsert and their show count would be wrong.
    const uid = credited.length > 1 ? `${e.sourceUid}::${orgIdForRow}` : e.sourceUid;
    const res = insert.run(
      eventId(e.source, uid),
      orgIdForRow,
      venueOrgId,
      e.title,
      e.eventDate,
      e.venueName,
      e.city,
      e.region,
      e.presentedBy,
      e.source,
      e.sourceUrl,
      uid,
      e.raw ? JSON.stringify(e.raw) : null
    );
    if (res.changes > 0) created = true;
  }

  return { orgIds: credited, created };
}

export interface OrgWithEvents extends Org {
  eventDates: string[];
  distinctVenues: number;
}

/** Orgs that have at least one event, with the evidence needed to score them. */
export function orgsForScoring(): OrgWithEvents[] {
  const d = db();

  const orgs = d
    .prepare(`SELECT * FROM orgs WHERE id IN (SELECT DISTINCT org_id FROM events WHERE org_id IS NOT NULL)`)
    .all() as Org[];

  const dates = d.prepare(
    `SELECT event_date FROM events WHERE org_id = ? AND event_date IS NOT NULL`
  );
  const venues = d.prepare(
    `SELECT COUNT(DISTINCT venue_org_id) AS n FROM events WHERE org_id = ? AND venue_org_id IS NOT NULL`
  );

  return orgs.map((o) => ({
    ...o,
    eventDates: (dates.all(o.id) as { event_date: string }[]).map((r) => r.event_date),
    distinctVenues: (venues.get(o.id) as { n: number }).n,
  }));
}

export function saveScore(
  id: string,
  s: { showsTrailing12m: number; observationDays: number; score: number; band: string; reasons: string[] }
): void {
  db()
    .prepare(
      `UPDATE orgs SET
         shows_trailing_12m = ?, observation_days = ?, icp_score = ?,
         icp_band = ?, score_reasons = ?, scored_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(s.showsTrailing12m, s.observationDays, s.score, s.band, JSON.stringify(s.reasons), id);
}

export function startRun(source: string): string {
  const id = `${source}-${Date.now()}`;
  db().prepare(`INSERT INTO runs (id, source) VALUES (?, ?)`).run(id, source);
  return id;
}

export function finishRun(id: string, eventsSeen: number, orgsTouched: number, error?: string): void {
  db()
    .prepare(
      `UPDATE runs SET finished_at = datetime('now'), events_seen = ?, orgs_touched = ?, error = ?
       WHERE id = ?`
    )
    .run(eventsSeen, orgsTouched, error ?? null, id);
}
