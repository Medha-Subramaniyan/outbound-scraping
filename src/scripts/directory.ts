/**
 * directory — build seed files from the Independent Venue Week member list.
 *
 * Replaces hand-written seeds with a sourced list. Every domain this writes
 * carries a comment naming the IVW page it came from, so a venue in a seed
 * file can be traced back to the association that listed it rather than to
 * somebody's recollection.
 *
 *   npm run directory -- --state georgia      one state, for a quick look
 *   npm run directory -- --all                every state (~50 + N requests)
 *   npm run directory -- --all --write        also write data/seeds/*.txt
 *
 * Without --write it only reports, because a full pass takes a while and the
 * first thing to check is whether the parse is finding sensible names.
 */
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { listStates, venuePagesForState, readVenuePage, type DirectoryVenue } from '../sources/ivw-directory';
import { METROS } from '../metros';
import { close } from '../lib/db';
import logger from '../lib/logger';

const SEED_DIR = process.env.SEED_DIR || 'data/seeds';

/**
 * Which metro seed file a venue belongs in.
 *
 * Matched on the venue's own city first, and only then on its state.
 *
 * State alone is not good enough: this pipeline's metros are cities, and a
 * state routinely holds several — Texas has four, California five. Filing by
 * state would have put every Texas venue under Austin and every Californian
 * one under Los Angeles, which is wrong for most of them and quietly destroys
 * the metro targeting the seed files exist to provide.
 *
 * A venue in a state with no metro at all (Wyoming, Delaware, ten others) has
 * nowhere to go. Those are collected into `_unmapped.txt` rather than dropped:
 * the venue is real and IVW-listed, and the only thing missing is a metro
 * entry in src/metros.ts.
 *
 * ── Known limit of the state fallback ────────────────────────────────────────
 *
 * About 5% of IVW pages list no address, so those venues fall back to their
 * state's *first* metro in src/metros.ts. That is right when the first metro
 * is the state's dominant one and wrong otherwise: two Kansas City venues
 * (minibarkc.com, lemonadeparkkc.com) were filed under St. Louis this way,
 * because Missouri lists st-louis before kansas-city.
 *
 * The cost is a misfiled seed, not a bad contact — the crawl still reaches the
 * right site and the emails are correct, only the metro label is wrong. Fixing
 * it properly means geocoding the venue name, which is a bigger dependency
 * than the error justifies. A cheap improvement would be to read the city from
 * the venue's own site during enrichment, where we are already fetching pages.
 */
function metroForVenue(v: DirectoryVenue): string | null {
  if (v.city) {
    const city = v.city.toLowerCase().trim();
    const byCity = METROS.find((m) => m.label.toLowerCase() === city);
    if (byCity) return byCity.slug;

    // Suburbs: "Decatur" is Atlanta's metro but is not itself a metro. Fall
    // through to the state match rather than inventing a new one.
  }
  return metroForState(v.state);
}

function metroForState(stateSlug: string): string | null {
  const stateName = stateSlug.replace(/-/g, ' ');
  const abbrev: Record<string, string> = {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
    colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
    hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
    kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
    massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
    missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
    oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
    virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
    wyoming: 'WY', 'washington dc': 'DC', 'district of columbia': 'DC',
  };

  const region = abbrev[stateName];
  if (!region) return null;
  return METROS.find((m) => m.region === region)?.slug ?? null;
}

function writeSeeds(venues: DirectoryVenue[]): void {
  fs.mkdirSync(SEED_DIR, { recursive: true });

  const byMetro = new Map<string, DirectoryVenue[]>();
  let unmapped = 0;

  for (const v of venues) {
    if (!v.domain) continue;
    const metro = metroForVenue(v) ?? '_unmapped';
    if (metro === '_unmapped') unmapped++;
    if (!byMetro.has(metro)) byMetro.set(metro, []);
    byMetro.get(metro)!.push(v);
  }

  let written = 0;
  for (const [metro, list] of byMetro) {
    const file = path.join(SEED_DIR, `${metro}.txt`);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

    // One line per *domain*, not per listing. A venue with several rooms gets
    // a separate IVW page each — The Masquerade lists Heaven, Hell and
    // Purgatory — but they are one website and one booking office, so seeding
    // the domain three times would triple the crawl for one org.
    const lines: string[] = [];
    const seenHere = new Set<string>();

    for (const v of list) {
      if (!v.domain || existing.includes(v.domain) || seenHere.has(v.domain)) continue;
      seenHere.add(v.domain);

      const rooms = list.filter((o) => o.domain === v.domain);
      const label = rooms.length > 1 ? `${v.name} (+${rooms.length - 1} more room(s))` : v.name;
      const where = v.city ? `${v.city}, ${v.state}` : v.state;
      const cap = v.capacity ? `, cap ${v.capacity}` : '';
      lines.push(`${v.domain}  # ${label} — ${where}${cap} — IVW member (${v.sourceUrl})`);
      written++;
    }

    if (lines.length) {
      const header = existing.includes('# from Independent Venue Week')
        ? ''
        : `\n# from Independent Venue Week (independentvenueweek.com), read ${new Date().toISOString().slice(0, 10)}\n`;
      fs.appendFileSync(file, header + lines.join('\n') + '\n');
    }
  }

  logger.info(`Wrote ${written} new seed(s) across ${byMetro.size} metro file(s).`);
  if (unmapped) {
    logger.warn(
      `${unmapped} venue(s) had no matching metro — written to ${SEED_DIR}/_unmapped.txt. ` +
        `Add a metro to src/metros.ts to route them.`
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      state: { type: 'string' },
      all: { type: 'boolean' },
      write: { type: 'boolean' },
      limit: { type: 'string' },
    },
  });

  const states = values.state ? [values.state] : values.all ? await listStates() : [];

  if (!states.length) {
    console.log('\n  Pass --state <name> or --all.\n');
    close();
    return;
  }

  logger.info(`Reading ${states.length} state page(s) from Independent Venue Week...`);

  const venues: DirectoryVenue[] = [];
  const limit = values.limit ? Number(values.limit) : undefined;

  for (const state of states) {
    const pages = await venuePagesForState(state);
    if (!pages.length) continue;

    logger.info(`  ${state}: ${pages.length} venue page(s)`);

    for (const page of pages) {
      if (limit && venues.length >= limit) break;
      const v = await readVenuePage(page, state);
      if (v) venues.push(v);
    }
    if (limit && venues.length >= limit) break;
  }

  const withSite = venues.filter((v) => v.domain);
  logger.info(`${venues.length} venue(s) read, ${withSite.length} with their own website.`);

  for (const v of withSite.slice(0, 20)) {
    console.log(`  ${(v.domain ?? '').padEnd(34)} ${v.name}  [${v.state}]`);
  }

  if (values.write) writeSeeds(venues);
  else console.log(`\n  Re-run with --write to add these to data/seeds/.\n`);

  close();
}

main();
