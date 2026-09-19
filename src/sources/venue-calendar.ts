/**
 * Venue calendars — the primary source.
 *
 * Crawls a venue's own /events or /calendar page. This skews *toward* the ICP
 * for a structural reason: the venues that have outgrown a spreadsheet but not
 * bought enterprise software are exactly the ones running their own site with a
 * hand-maintained or lightly-integrated calendar. The rooms on full enterprise
 * ticketing stacks are the ones this pipeline wants to exclude anyway.
 *
 * Reads JSON-LD Event markup first, because venues publish it for Google and it
 * arrives already typed. HTML heuristics are the fallback, and they are
 * deliberately conservative: a wrong date silently corrupts a show count, so an
 * unparseable listing is better dropped than guessed at.
 */
import { fetchPage, extractJsonLd, textOf, parseEventDate } from '../lib/fetch';
import logger from '../lib/logger';
import { isExcludedCategory } from '../icp';
import type { DiscoveredEvent, DiscoverOptions, Source } from '../types';

/** Paths a venue's calendar usually lives at, in order of likelihood. */
const CALENDAR_PATHS = ['/events', '/calendar', '/shows', '/upcoming', '/tickets', '/'];

interface JsonLdEvent {
  '@type'?: string | string[];
  name?: string;
  startDate?: string;
  url?: string;
  location?: { name?: string; address?: Record<string, string> | string };
  organizer?: { name?: string } | { name?: string }[];
  performer?: unknown;
  eventStatus?: string;
}

function isEventType(t: unknown): boolean {
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === 'string' && /Event$/i.test(x));
}

function addressPart(
  loc: JsonLdEvent['location'],
  key: 'addressLocality' | 'addressRegion'
): string | null {
  if (!loc || typeof loc === 'string') return null;
  const addr = loc.address;
  if (!addr || typeof addr === 'string') return null;
  return addr[key] ?? null;
}

function organizerName(org: JsonLdEvent['organizer']): string | null {
  if (!org) return null;
  const first = Array.isArray(org) ? org[0] : org;
  return first?.name ?? null;
}

function fromJsonLd(blocks: unknown[], pageUrl: string): DiscoveredEvent[] {
  const out: DiscoveredEvent[] = [];

  for (const block of blocks) {
    const e = block as JsonLdEvent;
    if (!e || typeof e !== 'object' || !isEventType(e['@type'])) continue;
    if (!e.name) continue;

    // A cancelled show was still booked and still negotiated, so it counts as
    // evidence of activity. A *postponed* one may be double-counted when it
    // reappears with a new date, which is acceptable noise at this precision.
    if (e.eventStatus && /Cancelled/i.test(e.eventStatus)) continue;

    const venueName = typeof e.location === 'string' ? e.location : e.location?.name ?? null;

    if (isExcludedCategory(`${e.name} ${venueName ?? ''}`)) continue;

    const url = e.url ?? pageUrl;

    out.push({
      title: e.name.trim(),
      eventDate: parseEventDate(e.startDate),
      venueName,
      city: addressPart(e.location, 'addressLocality'),
      region: addressPart(e.location, 'addressRegion'),
      presentedBy: organizerName(e.organizer),
      source: 'venue-calendar',
      sourceUrl: url,
      // Prefer the event's own URL as the natural key. Falling back to
      // title+date keeps re-runs idempotent when a listing has no stable link.
      sourceUid: e.url ?? `${pageUrl}#${e.name}|${e.startDate ?? ''}`,
      raw: { jsonld: true },
    });
  }

  return out;
}

/**
 * Fallback: look for date-like text near link text.
 *
 * Intentionally weak. It exists to tell us a page *has* a calendar worth a
 * human look, not to produce authoritative counts — anything it returns is
 * marked so the scorer can see the provenance.
 */
function fromHtmlHeuristic(html: string, pageUrl: string): DiscoveredEvent[] {
  const text = textOf(html);

  // Count date-shaped strings. Presence, not extraction.
  const dateish = text.match(
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/gi
  );

  if (!dateish || dateish.length < 4) return [];

  logger.info(
    `  ${pageUrl}: no JSON-LD, but ${dateish.length} date-like strings — flagging for review`
  );
  return [];
}

async function discoverOne(baseUrl: string): Promise<DiscoveredEvent[]> {
  let origin: string;
  try {
    origin = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`).origin;
  } catch {
    logger.warn(`  not a URL: ${baseUrl}`);
    return [];
  }

  for (const path of CALENDAR_PATHS) {
    const url = `${origin}${path}`;
    const html = await fetchPage(url);
    if (!html) continue;

    const events = fromJsonLd(extractJsonLd(html), url);
    if (events.length > 0) {
      logger.info(`  ${url}: ${events.length} events`);
      return events;
    }

    fromHtmlHeuristic(html, url);
  }

  logger.info(`  ${origin}: no machine-readable calendar found`);
  return [];
}

export const venueCalendar: Source = {
  key: 'venue-calendar',
  label: 'Venue calendars (direct)',

  // Needs no API key — it reads public pages.
  available: () => true,

  async discover(opts: DiscoverOptions): Promise<DiscoveredEvent[]> {
    const urls = opts.urls ?? [];
    if (urls.length === 0) {
      logger.warn('venue-calendar: no --urls given, nothing to crawl');
      return [];
    }

    const all: DiscoveredEvent[] = [];
    for (const url of urls) {
      all.push(...(await discoverOne(url)));
      if (opts.limit && all.length >= opts.limit) break;
    }
    return opts.limit ? all.slice(0, opts.limit) : all;
  },
};
