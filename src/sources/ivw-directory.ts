/**
 * Independent Venue Week — a seed *directory*, not an event source.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Every other file in src/sources/ answers "what shows is this org putting on".
 * This one answers the question upstream of that: "which orgs are worth
 * looking at at all". Until now that list was hand-written, which made the
 * pipeline's weakest input the one with no provenance — a list of venues
 * somebody remembered, filtered only by whether the domain returned a 200.
 *
 * IVW is a trade association for independent venues. Membership is the
 * organisation's own assertion that a room is independently owned, which is
 * exactly the property src/icp.ts cares about and cannot measure from a
 * calendar. That makes this list high *purity*: everything on it is plausibly
 * in-ICP, even though the show-count gate still has to be passed on evidence.
 *
 * ── Structure it reads ───────────────────────────────────────────────────────
 *
 *   /us/venues/                  → links to 50 state pages
 *   /us/country/<state>/         → <article> per venue, linking to a detail page
 *   /us/venues-us/<venue-slug>/  → the venue's own website, if they listed one
 *
 * Three levels, so a full pass is ~50 + N requests against one host at the
 * standard 1.5s spacing. It is meant to be run rarely and the output committed
 * to seed files, not re-crawled on every discovery run.
 *
 * robots.txt at independentvenueweek.com is `User-agent: * / Disallow:` —
 * an explicit blanket allow — and the fetcher re-checks it anyway.
 */
import { fetchPage } from '../lib/fetch';
import logger from '../lib/logger';

const BASE = 'https://independentvenueweek.com';

/** Hosts that appear on every page: the site's own chrome and its sponsors. */
const NON_VENUE_HOSTS =
  /independentvenueweek|facebook|twitter|instagram|youtube|tiktok|spotify|linkedin|google|gmpg|fontawesome|jotform|hellomerch|marauder|podlink|digitalrenovators|ilikethesound|hearby|w3\.org|bandcamp|eventbrite|dice\.fm/i;

export interface DirectoryVenue {
  /** Venue name as IVW lists it. */
  name: string;
  /** Bare domain of the venue's own site, when they listed one. */
  domain: string | null;
  state: string;
  /** City parsed from the listed street address, when there is one. */
  city: string | null;
  /** Full address as listed, kept for the rows where the parse is unsure. */
  address: string | null;
  /**
   * Capacity as IVW lists it. Worth capturing because src/icp.ts has a
   * capacity band (150–3000) it can otherwise almost never evaluate — venue
   * calendars do not publish it.
   */
  capacity: number | null;
  /** The IVW page this came from, so a row can be traced back. */
  sourceUrl: string;
}

/**
 * Pull the street address out of a venue page.
 *
 * IVW renders it in an Elementor icon-list item flagged with a map-marker
 * icon, e.g. `515 N McDonough St, Decatur, Georgia 30030`. Taking the city
 * from here rather than from the state page matters: a state maps to several
 * metros in this pipeline (Texas has four), so state alone would file every
 * Texas venue under Austin.
 */
function parseAddress(html: string): { address: string | null; city: string | null } {
  const marker = html.match(
    /fa-map-marker-alt[\s\S]{0,400}?<span class="elementor-icon-list-text">([^<]+)<\/span>/i
  );
  if (!marker) return { address: null, city: null };

  const address = marker[1].replace(/\s+/g, ' ').trim();

  // "<street>, <city>, <state> <zip>" — the city is the second-to-last part
  // once the "<state> <zip>" tail is dropped. Falls back to null rather than
  // guessing when the shape does not match.
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  const city = parts.length >= 3 ? parts[parts.length - 2] : null;

  return { address, city };
}

/** Capacity, when the page states one. */
function parseCapacity(html: string): number | null {
  const m = html.match(
    /fa-users?[\s\S]{0,400}?<span class="elementor-icon-list-text">\s*([\d,]+)\s*<\/span>/i
  );
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** State slugs, read from the index rather than hardcoded. */
export async function listStates(): Promise<string[]> {
  const html = await fetchPage(`${BASE}/us/venues/`);
  if (!html) {
    logger.warn('IVW: could not read the venue index');
    return [];
  }

  const slugs = [
    ...new Set(
      [...html.matchAll(/\/us\/country\/([a-z-]+)\//g)].map((m) => m[1])
    ),
  ];
  return slugs;
}

/** Venue detail-page URLs listed for one state. */
export async function venuePagesForState(state: string): Promise<string[]> {
  const html = await fetchPage(`${BASE}/us/country/${state}/`);
  if (!html) return [];

  return [
    ...new Set(
      [...html.matchAll(/https:\/\/independentvenueweek\.com\/us\/venues-us\/[a-z0-9-]+\//g)].map(
        (m) => m[0]
      )
    ),
  ];
}

/**
 * Read one venue's detail page for its name and its own website.
 *
 * A venue that listed no website yields `domain: null` rather than being
 * dropped — the name and state are still worth recording, because finding the
 * site by hand is a smaller job than finding the venue.
 */
export async function readVenuePage(url: string, state: string): Promise<DirectoryVenue | null> {
  const html = await fetchPage(url);
  if (!html) return null;

  // The <title> is "<Venue Name> - Independent Venue Week US". Entities are
  // decoded: the raw title carries `Eddie&#039;s Attic`, and a seed comment
  // full of numeric escapes is harder to read than the name it stands for.
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const rawName = titleMatch
    ? titleMatch[1].replace(/\s*[-|]\s*Independent Venue Week.*$/i, '').trim()
    : url.replace(/.*\/venues-us\/|\/$/g, '').replace(/-/g, ' ');

  const name = rawName
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&nbsp;/gi, ' ')
    .trim();

  const hosts = [
    ...new Set(
      [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)]
        .map((m) => m[1])
        .filter((u) => !NON_VENUE_HOSTS.test(u))
        .map((u) => {
          try {
            return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
          } catch {
            return null;
          }
        })
        .filter((h): h is string => Boolean(h))
    ),
  ];

  const { address, city } = parseAddress(html);

  return {
    name,
    domain: hosts[0] ?? null,
    state,
    city,
    address,
    capacity: parseCapacity(html),
    sourceUrl: url,
  };
}
