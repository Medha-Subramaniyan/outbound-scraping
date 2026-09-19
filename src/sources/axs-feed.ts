/**
 * AXS venue feeds — the highest-yield source found so far.
 *
 * A large number of independent and mid-size rooms run their calendar on an AXS
 * widget, which loads from a public JSON feed:
 *
 *   https://aegwebprod.blob.core.windows.net/json/events/<skin>/events.json
 *
 * The feed is what the venue's own /calendar page fetches to render itself — the
 * same public data, read in the format it is already published in, without
 * executing the page's JavaScript. No key, no auth, no login.
 *
 * ── Why this beats JSON-LD ──────────────────────────────────────────────────
 *
 * The venue-calendar source looks for schema.org Event markup, and on the AXS
 * rooms it finds nothing: the HTML ships CSS class names and the events arrive
 * client-side. Worse, those pages were *silently* returning zero events, which
 * looks identical to "this venue has no shows".
 *
 * The feed carries the one field that matters most here and that JSON-LD almost
 * never has: `presentedByText`, the promoter credit. That is the difference
 * between knowing a room hosted 46 shows and knowing *Zero Mile Presents* put
 * on 46 shows at it — the second is the ICP, the first is just a building.
 *
 * ── Finding the skin id ─────────────────────────────────────────────────────
 *
 * The numeric id is in the venue's calendar HTML. `discoverFeedUrl` extracts it,
 * so callers can pass a venue domain and let the adapter find the feed.
 */
import { fetchPage, fetchJson, parseEventDate } from '../lib/fetch';
import logger from '../lib/logger';
import { isExcludedCategory } from '../icp';
import type { DiscoveredEvent, DiscoverOptions, Source } from '../types';

const FEED_RE = /https?:\/\/aegwebprod\.blob\.core\.windows\.net\/json\/events\/(\d+)\/events\.json/;

interface AxsEvent {
  eventId: string;
  active?: boolean;
  private?: boolean;
  title?: {
    presentedByText?: string | null;
    headlinersText?: string | null;
    eventTitleText?: string | null;
  };
  eventDateTimeISO?: string | null;
  eventDateTime?: string | null;
  venue?: {
    title?: string;
    city?: string;
    state?: string;
  };
  links?: { eventUrl?: string };
}

interface AxsFeed {
  meta?: { total?: number };
  events?: AxsEvent[];
}

/** Strip the HTML AXS embeds in its own title fields. */
const clean = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

/**
 * Locate a venue's AXS feed from its calendar page.
 *
 * Tries /calendar first because that is where the widget lives; the homepage
 * usually references the search-query feed rather than the events feed.
 */
export async function discoverFeedUrl(domain: string): Promise<string | null> {
  const origin = domain.startsWith('http') ? domain : `https://${domain}`;

  for (const path of ['/calendar', '/events', '/shows', '/']) {
    const html = await fetchPage(`${origin}${path}`);
    const m = html?.match(FEED_RE);
    if (m) {
      logger.info(`  ${origin}: AXS feed ${m[1]}`);
      return m[0];
    }
  }
  return null;
}

function toEvents(feed: AxsFeed, feedUrl: string): DiscoveredEvent[] {
  const rows = feed.events ?? [];
  const out: DiscoveredEvent[] = [];

  for (const e of rows) {
    if (e.active === false || e.private === true) continue;

    const title = clean(e.title?.headlinersText) ?? clean(e.title?.eventTitleText);
    if (!title) continue;

    const venueName = clean(e.venue?.title);

    if (isExcludedCategory(`${title} ${venueName ?? ''}`)) continue;

    const iso = e.eventDateTimeISO ?? e.eventDateTime ?? null;

    out.push({
      title,
      eventDate: parseEventDate(iso),
      venueName,
      city: clean(e.venue?.city),
      region: clean(e.venue?.state),
      presentedBy: clean(e.title?.presentedByText),
      source: 'axs-feed',
      sourceUrl: e.links?.eventUrl ?? feedUrl,
      sourceUid: e.eventId,
      raw: { venueId: e.venue?.title },
    });
  }

  return out;
}

export const axsFeed: Source = {
  key: 'axs-feed',
  label: 'AXS venue feeds (public JSON)',

  available: () => true,

  async discover(opts: DiscoverOptions): Promise<DiscoveredEvent[]> {
    const domains = opts.urls ?? [];
    if (domains.length === 0) {
      logger.warn('axs-feed: no --urls given, nothing to crawl');
      return [];
    }

    const all: DiscoveredEvent[] = [];

    for (const domain of domains) {
      // Accept a feed URL directly, so a known venue can skip the lookup.
      const feedUrl = FEED_RE.test(domain) ? domain : await discoverFeedUrl(domain);

      if (!feedUrl) {
        logger.info(`  ${domain}: no AXS feed — try the venue-calendar source`);
        continue;
      }

      const feed = await fetchJson<AxsFeed>(feedUrl);
      if (!feed) {
        logger.warn(`  ${domain}: feed did not parse`);
        continue;
      }

      const events = toEvents(feed, feedUrl);
      logger.info(`  ${domain}: ${events.length} events`);
      all.push(...events);

      if (opts.limit && all.length >= opts.limit) break;
    }

    return opts.limit ? all.slice(0, opts.limit) : all;
  },
};
