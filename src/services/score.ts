/**
 * The ICP gate.
 *
 * Runs over orgs that discovery has already filled with events, and decides
 * which are worth spending contact-discovery effort on. Everything it needs is
 * measured from the events table — nothing here trusts a self-reported field.
 *
 * ── The observation-window trap ──────────────────────────────────────────────
 *
 * Show count is a *rate*, and a rate needs a denominator. The obvious
 * implementation — count the events we have, compare to 10–50 — is wrong in a
 * way that quietly produces a garbage list.
 *
 * A venue calendar shows the next 60 days. Fifteen shows there is not fifteen
 * shows a year; it is roughly ninety, which is enterprise. Meanwhile a promoter
 * whose 18 annual shows we have only seen the last month of looks like a
 * 2-show side hustle and gets dropped. Both errors come from reading a window
 * as a year.
 *
 * ── What a calendar actually is ──────────────────────────────────────────────
 *
 * Measured against live AXS feeds: 139 of 140 scraped events were in the
 * *future*. A venue calendar is a forward booking window, not a history. The
 * span between its first and last event measures **how far ahead an org has
 * announced**, which is a booking-lead-time signal, not an activity rate.
 *
 * Annualising naively against that span is badly wrong in the direction that
 * costs real prospects. Zero Mile Presents — a genuine independent Atlanta
 * promoter, exactly this ICP — has 65 shows announced across the next 4.5
 * months. Dividing gives ~174/yr and excludes them as enterprise. They are not
 * enterprise; they simply book further out than the arithmetic assumed.
 *
 * So the annualisation is *asymmetric*, and deliberately so:
 *
 *   - A forward window is a **lower bound** on the year. 65 shows already on
 *     the books cannot become fewer than 65. It is scaled up only cautiously,
 *     and never far enough to push an org over the enterprise line on
 *     extrapolation alone.
 *   - A backward window is a genuine measurement of elapsed activity and is
 *     annualised normally.
 *
 * An org whose forward count alone already exceeds the ICP ceiling is out of
 * band on counted shows, not on a projection — that much is safe to conclude.
 * Everything below the ceiling gets the benefit of the doubt, because the cost
 * of wrongly excluding a real promoter is losing them entirely, while the cost
 * of wrongly including one is a single wasted look.
 */
import {
  SHOWS_PER_YEAR_MIN,
  SHOWS_PER_YEAR_MAX,
  ENTERPRISE_SHOWS_PER_YEAR,
  CAPACITY_MIN,
  CAPACITY_MAX,
  isExcludedOrg,
  isPriorityMetro,
} from '../icp';
import type { IcpBand } from '../types';

/**
 * Minimum observed window before an annualised rate is trusted enough to
 * qualify an org.
 *
 * 90 days is a judgement call: long enough that a single busy month cannot
 * treble the estimate, short enough that a first useful export does not take
 * half a year. Below it, orgs go to 'watch' rather than being judged.
 */
export const MIN_OBSERVATION_DAYS = 90;

export interface ScoreInput {
  name: string;
  city: string | null;
  region: string | null;
  capacity: number | null;
  /** Events observed, with dates. Undated events are excluded upstream. */
  eventDates: string[];
  /** Distinct venues this org has presented at — separates promoters from venues. */
  distinctVenues: number;
}

export interface ScoreResult {
  showsTrailing12m: number;
  observationDays: number;
  /** Annualised rate; the number actually compared to the ICP band. */
  annualisedShows: number;
  score: number;
  band: IcpBand;
  reasons: string[];
}

const DAY_MS = 86_400_000;

export function scoreOrg(input: ScoreInput): ScoreResult {
  const reasons: string[] = [];

  // ── Hard exclusions, before any arithmetic ──
  if (isExcludedOrg(input.name)) {
    return {
      showsTrailing12m: 0,
      observationDays: 0,
      annualisedShows: 0,
      score: 0,
      band: 'excluded',
      reasons: ['Known enterprise promoter or major agency — has a dedicated ops layer'],
    };
  }

  // ── Measure the window ──
  const now = Date.now();
  const cutoff = now - 365 * DAY_MS;

  const times = input.eventDates
    .map((d) => Date.parse(d))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);

  // Trailing 12 months, counting future-dated listings: an announced show is a
  // show. A calendar is mostly forward-looking, so ignoring future dates would
  // throw away the bulk of the evidence.
  const inWindow = times.filter((t) => t >= cutoff);

  if (inWindow.length === 0) {
    return {
      showsTrailing12m: 0,
      observationDays: 0,
      annualisedShows: 0,
      score: 0,
      band: 'out-of-band',
      reasons: ['No dated events in the trailing 12 months'],
    };
  }

  const observationDays = Math.max(
    1,
    Math.round((inWindow[inWindow.length - 1] - inWindow[0]) / DAY_MS)
  );
  const shows = inWindow.length;

  // How much of the window is announcement rather than history. A calendar is
  // almost entirely forward-looking, so this is usually near 1.
  const futureShows = inWindow.filter((t) => t > now).length;
  const forwardRatio = futureShows / shows;
  const mostlyForward = forwardRatio > 0.6;

  let annualisedShows: number;

  if (observationDays >= 365) {
    annualisedShows = shows;
  } else if (mostlyForward) {
    // A forward window is a lower bound: these shows are already booked. Scale
    // up gently and cap at the ceiling, so an org can never be *excluded* as
    // enterprise on the strength of an extrapolation — only on counted shows.
    const projected = (shows / observationDays) * 365;
    annualisedShows = Math.round(Math.min(projected, Math.max(shows, ENTERPRISE_SHOWS_PER_YEAR - 1)));
  } else {
    annualisedShows = Math.round((shows / observationDays) * 365);
  }

  // ── Enterprise ceiling ──
  // Counted shows, not projected ones. An org with 150+ already on the books in
  // a 12-month window is enterprise by observation.
  if (shows >= ENTERPRISE_SHOWS_PER_YEAR) {
    return {
      showsTrailing12m: shows,
      observationDays,
      annualisedShows,
      score: 0,
      band: 'excluded',
      reasons: [`${shows} shows counted — enterprise scale, has an ops department`],
    };
  }

  // ── Volume, the primary axis ──
  let score = 0;

  /**
   * The number the band test is applied to.
   *
   * For a forward calendar, counted shows are the honest figure: they are
   * booked facts, where the annualised number is a projection built on how far
   * ahead this org happens to publish. Using the projection here is what
   * excluded Zero Mile — 65 real shows read as "~174/yr, enterprise".
   *
   * Counted shows are only used while they clear the floor. Below it there is
   * nothing to stand on and the projection is all we have, which is exactly the
   * case the 'watch' band exists to hold.
   */
  const bandBasis =
    mostlyForward && shows >= SHOWS_PER_YEAR_MIN ? shows : annualisedShows;

  const inBand = bandBasis >= SHOWS_PER_YEAR_MIN && bandBasis <= SHOWS_PER_YEAR_MAX;

  if (inBand) {
    // Peak at the middle of the band. An org at 28 shows/yr is more centrally
    // this ICP than one at 11 or 49, both of which are near a boundary they
    // might cross either way.
    const mid = (SHOWS_PER_YEAR_MIN + SHOWS_PER_YEAR_MAX) / 2;
    const halfWidth = (SHOWS_PER_YEAR_MAX - SHOWS_PER_YEAR_MIN) / 2;
    const centrality = 1 - Math.abs(bandBasis - mid) / halfWidth;
    score += 50 + 10 * centrality;
    reasons.push(
      mostlyForward && shows >= SHOWS_PER_YEAR_MIN
        ? `${shows} shows already booked — inside the ${SHOWS_PER_YEAR_MIN}–${SHOWS_PER_YEAR_MAX} band`
        : `~${bandBasis} shows/yr — inside the ${SHOWS_PER_YEAR_MIN}–${SHOWS_PER_YEAR_MAX} band`
    );
  } else if (bandBasis < SHOWS_PER_YEAR_MIN) {
    reasons.push(`~${bandBasis} shows/yr — below the floor, likely still fine on a spreadsheet`);
  } else {
    reasons.push(`~${bandBasis} shows/yr — above the ceiling, likely has dedicated ops`);
  }

  // ── Corroborating signals ──
  if (input.capacity != null) {
    if (input.capacity >= CAPACITY_MIN && input.capacity <= CAPACITY_MAX) {
      score += 10;
      reasons.push(`Capacity ${input.capacity} — independent-room scale`);
    } else {
      score -= 10;
      reasons.push(`Capacity ${input.capacity} — outside the independent-room range`);
    }
  }

  // Presenting across several venues is what a promoter does; it is also the
  // clearest signal that deal terms are being negotiated per show rather than
  // being fixed by a house arrangement.
  if (input.distinctVenues >= 3) {
    score += 12;
    reasons.push(`Presents at ${input.distinctVenues} venues — negotiates deals per show`);
  } else if (input.distinctVenues === 2) {
    score += 5;
  }

  const where = [input.city, input.region].filter(Boolean).join(' ');
  if (where && isPriorityMetro(where)) {
    score += 8;
    reasons.push(`${input.city ?? where} — warm-intro territory`);
  }

  // ── Band assignment ──
  let band: IcpBand;

  if (!inBand) {
    band = 'out-of-band';
  } else if (shows >= SHOWS_PER_YEAR_MIN) {
    // Enough shows are on the books to clear the floor on counted evidence
    // alone. No extrapolation is doing the work, so the window length does not
    // matter — a promoter with 14 shows announced has 14 shows.
    band = 'qualified';
  } else if (observationDays < MIN_OBSERVATION_DAYS) {
    // Below the floor on counted shows, and the window is too short to trust
    // the projection that lifted it into band.
    band = 'watch';
    reasons.push(
      `Only ${shows} show(s) counted over ${observationDays} days — in band by projection only; re-run discovery to confirm`
    );
  } else {
    band = 'qualified';
  }

  return {
    showsTrailing12m: shows,
    observationDays,
    annualisedShows,
    score: Math.max(0, Math.round(score * 10) / 10),
    band,
    reasons,
  };
}
