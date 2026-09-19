import type { PersonaTier } from '../icp';

export type OrgKind = 'venue' | 'promoter' | 'agency' | 'unknown';
export type IcpBand = 'qualified' | 'watch' | 'out-of-band' | 'excluded';
export type EmailSource = 'published' | 'role' | 'inferred';
export type OutreachStatus = 'draft' | 'sent' | 'replied' | 'won' | 'lost' | 'bounced';

export interface Org {
  id: string;
  name: string;
  slug: string;
  kind: OrgKind;
  domain: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  capacity: number | null;
  sic_code: string | null;
  naics_code: string | null;
  shows_trailing_12m: number | null;
  observation_days: number | null;
  icp_score: number | null;
  icp_band: IcpBand | null;
  score_reasons: string | null;
  scored_at: string | null;
  first_seen_at: string;
  updated_at: string;
}

/**
 * One show, as a source adapter saw it.
 *
 * `orgName` is what the listing called the presenter — raw, unresolved. Entity
 * resolution happens on the way into the database, not in the adapter, so every
 * source stays a thin translation of its own format.
 */
export interface DiscoveredEvent {
  title: string;
  eventDate: string | null;
  venueName: string | null;
  city: string | null;
  region: string | null;
  /** Raw "Presented by ___" credit, when the listing carries one. */
  presentedBy: string | null;
  source: string;
  sourceUrl: string | null;
  /**
   * The page this event was crawled from, as opposed to where the listing
   * points. A venue's JSON-LD usually sets `url` to the ticketing platform, so
   * `sourceUrl` is a tixr.com or eventbrite link while the venue's own domain
   * appears nowhere in the event. This field keeps it, and it is what contact
   * discovery later crawls for a team page.
   */
  discoveredOn?: string | null;
  sourceUid: string;
  raw?: Record<string, unknown>;
}

export interface Person {
  id: string;
  org_id: string;
  full_name: string | null;
  title: string | null;
  persona_key: string | null;
  persona_tier: PersonaTier | null;
  email: string | null;
  email_source: EmailSource | null;
  phone: string | null;
  profile_url: string | null;
  source: string;
  source_url: string | null;
  found_at: string;
}

/**
 * A discovery source.
 *
 * Every adapter is this shape, so adding a platform means writing one file and
 * registering it — not touching the pipeline. `available()` lets a source that
 * needs a key bow out cleanly instead of failing mid-run.
 */
export interface Source {
  key: string;
  label: string;
  available(): boolean;
  discover(opts: DiscoverOptions): Promise<DiscoveredEvent[]>;
}

export interface DiscoverOptions {
  /** Metro or region to search, e.g. "atlanta". */
  location?: string;
  /** Cap on events returned, so a first run is cheap to try. */
  limit?: number;
  /** Explicit seed URLs, for the venue-calendar source. */
  urls?: string[];
  /**
   * Re-read a calendar page with a headless browser when the served HTML had
   * no Event markup. Costly, so callers opt in. See src/lib/render.ts.
   */
  render?: boolean;
}
