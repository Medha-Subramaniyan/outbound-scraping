/**
 * Bandsintown — official API, artist-keyed.
 *
 * Bandsintown indexes by artist rather than by city, so this source answers
 * "where has this artist played" and the venues fall out of the answer. That
 * makes it the natural way in to the *artist manager / booking agent* persona:
 * the other side of every deal is on the bill.
 *
 * It is registered but not wired to a discovery strategy yet — the artist seed
 * list has to come from somewhere, and the honest answer is that it should come
 * from artists already appearing in `events` once the venue sources have run.
 * That is the next increment; see docs/ROADMAP.md.
 *
 * Uses the documented public API with an app_id, not scraping. Without a key
 * the source reports unavailable rather than falling back to the HTML site.
 */
import { fetchJson, parseEventDate } from '../lib/fetch';
import logger from '../lib/logger';
import { isExcludedCategory } from '../icp';
import type { DiscoveredEvent, DiscoverOptions, Source } from '../types';

interface BitEvent {
  id: string;
  url?: string;
  datetime?: string;
  title?: string;
  lineup?: string[];
  venue?: {
    name?: string;
    city?: string;
    region?: string;
    country?: string;
  };
}

async function eventsForArtist(artist: string, appId: string): Promise<DiscoveredEvent[]> {
  const url =
    `https://rest.bandsintown.com/artists/${encodeURIComponent(artist)}/events` +
    `?app_id=${encodeURIComponent(appId)}`;

  const rows = await fetchJson<BitEvent[]>(url);
  if (!Array.isArray(rows)) {
    logger.warn(`  bandsintown: no events for ${artist}`);
    return [];
  }

  return rows
    .filter((r) => !isExcludedCategory(`${r.title ?? ''} ${r.venue?.name ?? ''}`))
    .map((r) => ({
      title: r.title || `${artist} at ${r.venue?.name ?? 'unknown venue'}`,
      eventDate: parseEventDate(r.datetime),
      venueName: r.venue?.name ?? null,
      city: r.venue?.city ?? null,
      region: r.venue?.region ?? null,
      // Bandsintown does not carry a promoter credit. Venue-presented is the
      // safe assumption; a listing source that names a presenter will correct
      // it when the same show is seen there.
      presentedBy: null,
      source: 'bandsintown',
      sourceUrl: r.url ?? null,
      sourceUid: r.id,
      raw: { lineup: r.lineup ?? [] },
    }));
}

export const bandsintown: Source = {
  key: 'bandsintown',
  label: 'Bandsintown (official API)',

  available: () => Boolean(process.env.BANDSINTOWN_APP_ID),

  async discover(opts: DiscoverOptions): Promise<DiscoveredEvent[]> {
    const appId = process.env.BANDSINTOWN_APP_ID;
    if (!appId) {
      logger.warn('bandsintown: BANDSINTOWN_APP_ID not set — skipping');
      return [];
    }

    // Seeded by artist name via --urls until artist extraction from `events`
    // lands. Reusing the flag is a deliberate placeholder, and it is called out
    // in the CLI help rather than left to be discovered.
    const artists = opts.urls ?? [];
    if (artists.length === 0) {
      logger.warn('bandsintown: pass artist names via --urls (placeholder seeding)');
      return [];
    }

    const all: DiscoveredEvent[] = [];
    for (const artist of artists) {
      all.push(...(await eventsForArtist(artist, appId)));
      if (opts.limit && all.length >= opts.limit) break;
    }
    return opts.limit ? all.slice(0, opts.limit) : all;
  },
};
