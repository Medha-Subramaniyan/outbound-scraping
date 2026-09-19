/**
 * Persistence. Every write is idempotent, because discovery is meant to be
 * re-run — that is how the observation window widens and 'watch' orgs resolve
 * into 'qualified' ones.
 */
import { db } from '../lib/db';
import { slugify, orgId, eventId, splitPresenters } from './resolve';
import type { DiscoveredEvent, Org, OrgKind } from '../types';

/**
 * Find or create an org, returning its id.
 *
 * City is folded into the slug, so an org first seen without a city and later
 * with one would fork. Resolved by backfilling city onto the existing row when
 * the slug matches, and only treating city as identifying once known.
 */
export function upsertOrg(name: string, kind: OrgKind, city?: string | null, region?: string | null): string {
  const d = db();
  const slug = slugify(name, city);
  const id = orgId(slug);

  d.prepare(
    `INSERT INTO orgs (id, name, slug, kind, city, region)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       -- Never downgrade a known kind back to 'unknown', and fill blanks only.
       kind       = CASE WHEN orgs.kind = 'unknown' THEN excluded.kind ELSE orgs.kind END,
       city       = COALESCE(orgs.city, excluded.city),
       region     = COALESCE(orgs.region, excluded.region),
       updated_at = datetime('now')`
  ).run(id, name.trim(), slug, kind, city ?? null, region ?? null);

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

  const venueOrgId = e.venueName ? upsertOrg(e.venueName, 'venue', e.city, e.region) : null;

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
