/**
 * Entity resolution — deciding when two names are one organisation.
 *
 * This is the load-bearing problem of the whole pipeline. Show count is the ICP
 * qualifier, and show count is a GROUP BY. Get resolution wrong and the
 * measurement is wrong in the direction that matters most: "The EARL", "the
 * earl atl" and "The Earl - East Atlanta" as three orgs turn one qualified
 * 24-show venue into three unqualified 8-show ones, and it drops out of the
 * export silently, looking like nothing was ever there.
 *
 * Over-merging is the opposite failure and is worse, because it is invisible:
 * two unrelated "The Loft"s in different cities merged into one org invent a
 * qualified prospect that does not exist. So the rule is to merge only on
 * strong evidence, and to let city break ties.
 */
import crypto from 'crypto';

/** Words that carry no identity and vary freely between listings. */
const NOISE = new Set([
  'the', 'a', 'an', 'and', '&', 'at', 'of', 'in', 'on',
  'llc', 'inc', 'ltd', 'co', 'corp', 'company', 'group', 'productions',
  'production', 'presents', 'presenting', 'entertainment', 'events', 'event',
  'management', 'agency',
]);

/**
 * Venue-type words, stripped only when something else remains.
 *
 * "The Masquerade Music Hall" and "Masquerade" are one venue. But "Music Hall"
 * or "The Venue" as a whole name would reduce to nothing, so the caller keeps
 * the unstripped form when stripping empties it.
 */
const VENUE_WORDS = new Set([
  'venue', 'theatre', 'theater', 'hall', 'club', 'lounge', 'bar', 'room',
  'stage', 'amphitheater', 'amphitheatre', 'arena', 'ballroom', 'music',
  'live', 'center', 'centre', 'house', 'tavern', 'pub',
]);

/**
 * City suffixes listings append to disambiguate, which we strip because the
 * city lives in its own column. "The Earl East Atlanta" and "The Earl" are the
 * same venue; the East Atlanta part is an address, not a name.
 */
const LOCATION_SUFFIX =
  /\s*[-–—(,]\s*(east|west|north|south|downtown|midtown|uptown)?\s*[a-z\s]{2,20}$/i;

/**
 * City names and their colloquial abbreviations, dropped from the identity key.
 *
 * "the earl atl" and "The EARL" are one venue — the "atl" is the poster telling
 * you which city, which we already know from the city column. Left in, it forks
 * the identity and halves the venue's show count, which is the exact failure
 * this module exists to prevent.
 *
 * Only removed when something identifying survives, so a venue genuinely called
 * "Atlanta Room" keeps its name.
 */
const CITY_TOKENS = new Set([
  'atl', 'atlanta', 'nyc', 'bk', 'brooklyn', 'la', 'lax', 'sf', 'chi', 'chicago',
  'nash', 'nashville', 'nola', 'philly', 'philadelphia', 'dc', 'pdx', 'portland',
  'sea', 'seattle', 'austin', 'atx', 'denver', 'dfw', 'dallas', 'houston', 'hou',
  'miami', 'mia', 'boston', 'bos', 'detroit', 'dtw', 'minneapolis', 'mpls',
]);

export function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The resolution key. Two orgs with the same slug are the same org.
 *
 * Built by removing everything that varies between listings of the same place
 * and sorting what remains, so word order ("Terminal West" / "West Terminal")
 * does not fork an identity.
 */
export function slugify(name: string, city?: string | null): string {
  const n = normaliseName(name.replace(LOCATION_SUFFIX, ''));

  const words = n.split(' ').filter((w) => w && !NOISE.has(w));

  // Drop venue and city words, but only while something identifying survives —
  // otherwise "Music Hall" or "Atlanta Room" would reduce to nothing.
  const stripped = words.filter((w) => !VENUE_WORDS.has(w) && !CITY_TOKENS.has(w));
  const core = stripped.length > 0 ? stripped : words;

  if (core.length === 0) return normaliseName(name).replace(/ /g, '-') || 'unknown';

  const key = [...core].sort().join('-');

  // City qualifies the key so two unrelated "The Loft"s stay apart. Without
  // this, over-merging invents prospects, which is the failure that does not
  // announce itself.
  return city ? `${key}__${normaliseName(city).replace(/ /g, '-')}` : key;
}

export function orgId(slug: string): string {
  return crypto.createHash('sha1').update(slug).digest('hex').slice(0, 16);
}

export function eventId(source: string, uid: string): string {
  return crypto.createHash('sha1').update(`${source}:${uid}`).digest('hex').slice(0, 16);
}

/**
 * Strip a promoter credit down to the organisation.
 *
 * Listings write this freely: "Presented by Rival Entertainment", "RIVAL
 * ENTERTAINMENT presents", "An Evening With ... / presented by Rival". All
 * three should land on the same org.
 */
export function cleanPresenter(raw: string): string | null {
  const cleaned = raw
    .replace(/^\s*(an?\s+)?(evening\s+with)?\s*/i, '')
    .replace(/presented\s+by\s*/gi, '')
    .replace(/\s*presents\b.*$/i, '')
    .replace(/\s*\bin\s+association\s+with\b.*$/i, '')
    .replace(/^[\s:–—-]+|[\s:–—-]+$/g, '')
    .trim();

  // A credit that reduces to nothing, or to something implausibly long, is
  // marketing prose rather than an org name.
  if (cleaned.length < 2 || cleaned.length > 80) return null;
  return cleaned;
}

/**
 * Split a co-presented credit into its constituent organisations.
 *
 * Real credits observed on live feeds: "Speakeasy & Zero Mile present",
 * "Rival Entertainment & Zero Mile Present", "Speakeasy, Triple D's, Zero Mile
 * present". Treating each of those as one org invents three phantom promoters
 * and — worse — takes the shows away from the real ones, pushing genuinely
 * qualified promoters below the volume floor. Co-promotion is normal at this
 * tier, so this is the common case, not an edge case.
 *
 * Every named org gets full credit for the show. That is deliberate: they each
 * negotiated it, which is the activity the product addresses.
 */
export function splitPresenters(raw: string): string[] {
  const base = cleanPresenter(raw);
  if (!base) return [];

  const parts = base
    .split(/\s*(?:,|&|\+|\band\b|\/)\s*/i)
    .map((p) => p.replace(/\s*\bpresents?\b\s*$/i, '').trim())
    .filter((p) => p.length >= 2 && p.length <= 80);

  // A name containing a genuine ampersand ("Smith & Jones Presents") would be
  // shredded by the split. If splitting produced fragments that are mostly too
  // short to be org names, keep the original.
  if (parts.length > 1 && parts.some((p) => p.length < 4)) return [base];

  return parts.length ? [...new Set(parts)] : [base];
}
