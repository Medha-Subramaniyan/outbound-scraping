/**
 * Source registry.
 *
 * Adding a platform means writing one adapter and adding it here. The pipeline
 * never names a source directly.
 *
 * Sources are deliberately unequal in value:
 *
 *   axs-feed       — primary. Many independent rooms run their calendar on an
 *                    AXS widget backed by a public JSON feed that names the
 *                    *promoter* on each show. That credit is the ICP signal.
 *   venue-calendar — JSON-LD fallback for rooms not on AXS.
 *   bandsintown    — artist-keyed, so it reaches the manager/agent persona.
 *                    Official API, key required.
 *
 * Still to come, in priority order (docs/ROADMAP.md):
 *   - NIVA / regional presenter association rosters. Low volume, very high ICP
 *     purity — best used to *validate* orgs found elsewhere.
 *   - Ticketing platform listings, subject to each platform's current API terms.
 */
import { venueCalendar } from './venue-calendar';
import { axsFeed } from './axs-feed';
import { bandsintown } from './bandsintown';
import type { Source } from '../types';

export const SOURCES: Source[] = [axsFeed, venueCalendar, bandsintown];

export function getSource(key: string): Source | undefined {
  return SOURCES.find((s) => s.key === key);
}
