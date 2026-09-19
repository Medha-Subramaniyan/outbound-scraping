/**
 * The ICP, as code.
 *
 * This is the only file that encodes who we are selling to. Everything else —
 * sources, scoring, export — reads from here. When the ICP moves, it moves in
 * one place and the whole pipeline follows.
 *
 * ── The central problem ──────────────────────────────────────────────────────
 *
 * The buyer is a 1–3 person booking function running 10–50 shows a year. That
 * is a *behavioural* definition, and the obvious way to find them — filter a
 * contact database on job title — cannot see it.
 *
 * Title search is circular. It finds people who have already self-identified
 * into a formal role at an organisation large enough to have formal roles,
 * which is the segment directly *above* this ICP. The independent promoter
 * running 14 shows a year has "Founder" on LinkedIn, or nothing at all. The
 * venue GM whose booking team is two people has the same title as the GM whose
 * booking team is thirty. Neither the title nor the company headcount
 * distinguishes them, because the thing that distinguishes them is the size of
 * the booking function and the number of shows — and no directory carries
 * either field.
 *
 * What *is* public, structurally and continuously, is the show itself. Selling
 * tickets requires publishing the date, the venue, and usually the presenter.
 * So the pipeline runs backwards from the evidence: find shows, group them by
 * who is putting them on, count them over a trailing year, and only then go
 * looking for the human. Show count is measured, not guessed, and it is the
 * qualifier the contact databases cannot sell you.
 *
 * Titles still matter — but as a *routing* signal once an org already
 * qualifies, deciding who to write to and which persona's pain to lead with.
 * They are not the filter. See `PERSONAS`.
 */

// ── Volume band ──────────────────────────────────────────────────────────────

/**
 * Shows per year, measured over a trailing 12 months.
 *
 * Below the floor is a side hustle that has not outgrown a spreadsheet, so
 * there is no pain to sell against. At or above the ceiling there is a
 * dedicated ops/finance department and a procurement layer, which is both a
 * longer sale and a different product. The band between is the whole thesis:
 * too big for a spreadsheet, too small for enterprise event management.
 */
export const SHOWS_PER_YEAR_MIN = 10;
export const SHOWS_PER_YEAR_MAX = 50;

/**
 * Above this, an org is enterprise regardless of what else it looks like.
 *
 * Kept separate from SHOWS_PER_YEAR_MAX because the two answer different
 * questions. 51 shows is out of band but still worth a research interview;
 * 300 is Live Nation and should never surface in any list.
 */
export const ENTERPRISE_SHOWS_PER_YEAR = 150;

/**
 * Venue capacity band, used only as a weak corroborating signal.
 *
 * A 20,000-seat amphitheatre is not this ICP whatever its calendar says, and a
 * 60-capacity coffee house is below the floor. But capacity is frequently
 * unpublished or wrong, so it never decides an org on its own — it nudges a
 * score that show count has already established.
 */
export const CAPACITY_MIN = 150;
export const CAPACITY_MAX = 3000;

// ── Industry classification ──────────────────────────────────────────────────

/**
 * SIC and NAICS codes that define the industry.
 *
 * These are not used to query anything — this pipeline discovers orgs from
 * event listings, which carry no classification codes. They are here because
 * they are the precise, agreed definition of the industry, they make the ICP
 * legible to anyone who has worked from the Apollo-side filters, and they are
 * what an org gets tagged with if a classification ever arrives from an
 * enrichment source.
 */
export const SIC_CODES = {
  '7929': 'Entertainers & Entertainment Groups',
  '7922': 'Theatrical Producers & Services',
} as const;

export const NAICS_CODES = {
  '711320': 'Promoters of Performing Arts, Sports, and Similar Events with Facilities',
  '711310': 'Promoters of Performing Arts, Sports, and Similar Events without Facilities',
  '711410': 'Agents and Managers for Artists, Athletes, Entertainers, and Other Public Figures',
} as const;

// ── Personas ─────────────────────────────────────────────────────────────────

export type PersonaTier = 'primary' | 'secondary' | 'tertiary';

export interface Persona {
  key: string;
  tier: PersonaTier;
  label: string;
  /** Lowercased substrings matched against a scraped job title. */
  titlePatterns: string[];
  /** Why this persona is worth reaching — drives message selection downstream. */
  rationale: string;
}

/**
 * Personas in priority order.
 *
 * Tier drives outreach ordering and, more importantly, reply-rate measurement:
 * because every person carries the persona that matched, reply rates split by
 * persona without extra bookkeeping. That is the point of tracking tier at all
 * — it turns the ICP from an assertion into something the pipeline can
 * disprove.
 */
export const PERSONAS: Persona[] = [
  {
    key: 'promoter-buyer',
    tier: 'primary',
    label: 'Promoter / talent buyer',
    titlePatterns: [
      'talent buyer',
      'talent buying',
      'buyer',
      'promoter',
      'booking manager',
      'booker',
      'head of booking',
      'director of booking',
      'talent manager',
      'artist manager',
      'artist relations',
      'booking agent',
      'agent',
    ],
    rationale:
      'Negotiates the deal terms. Feels the pain at the point of negotiation, which is where the product acts.',
  },
  {
    key: 'owner-principal',
    tier: 'primary',
    label: 'Owner / principal at a small entertainment company',
    titlePatterns: ['owner', 'founder', 'co-founder', 'principal', 'partner', 'president'],
    rationale:
      'No procurement layer to route around — signs and uses the product. Highest-value title, but only at a small org: at a large one the same title is unreachable.',
  },
  {
    key: 'venue-ops',
    tier: 'secondary',
    label: 'Venue ops / finance',
    titlePatterns: [
      'venue manager',
      'general manager',
      'gm',
      'director of event strategy',
      'event operations',
      'operations manager',
      'director of operations',
      'settlement',
      'controller',
    ],
    rationale:
      'Settles the show after the fact rather than negotiating it. Validates reconciliation pain; rarely the buyer.',
  },
  {
    key: 'partnerships-marketing',
    tier: 'tertiary',
    label: 'Partnerships / marketing / digital',
    titlePatterns: [
      'partnership activation',
      'partnerships',
      'digital strategy',
      'event marketing',
      'marketing coordinator',
      'marketing manager',
    ],
    rationale:
      'Speaks to friction across departments. Useful colour for the narrative; lowest outreach priority.',
  },
];

/**
 * Match a scraped job title to a persona.
 *
 * Longest pattern first, so "booking manager" wins over the bare "booker" and
 * "director of event strategy" over "gm". Without that ordering the match
 * depends on array position, which is a silent way to mis-tier people.
 */
export function matchPersona(title: string): Persona | null {
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9&/ ]/g, ' ').replace(/\s+/g, ' ')} `;

  let best: { persona: Persona; length: number } | null = null;
  for (const persona of PERSONAS) {
    for (const pattern of persona.titlePatterns) {
      if (t.includes(` ${pattern} `) && (!best || pattern.length > best.length)) {
        best = { persona, length: pattern.length };
      }
    }
  }
  return best?.persona ?? null;
}

// ── Exclusions ───────────────────────────────────────────────────────────────

/**
 * Organisations that are never this ICP, however their calendar scores.
 *
 * Two kinds, deliberately together: enterprise promoters and major agencies.
 * Both have dedicated ops departments and existing internal systems, so the
 * spreadsheet-outgrown pitch lands on nobody.
 *
 * Matched as whole words against a normalised name. Substring matching was the
 * first attempt and it excluded "Live Oak Music Hall" for containing "live"
 * and any agency with "caa" inside a longer word.
 */
export const EXCLUDED_ORGS = [
  'live nation',
  'livenation',
  'ticketmaster',
  'aeg',
  'aeg presents',
  'aeg live',
  'goldenvoice',
  'c3 presents',
  'insomniac',
  'rolling loud',
  'superfly',
  'danny wimmer',
  'msg entertainment',
  'madison square garden',
  'oak view group',
  'ovg',
  'feld entertainment',
  'wme',
  'william morris',
  'caa',
  'creative artists agency',
  'uta',
  'united talent',
  'paradigm',
  'wasserman',
  'aeg worldwide',
];

/**
 * Event categories outside the ICP.
 *
 * The deck's ICP is concert promoters and venue talent buyers. Wedding,
 * corporate and conference planners are an adjacent market worth testing — but
 * as a *separate* list, so reply rates stay comparable by persona. Blended into
 * the same export they would quietly contaminate every measurement made from
 * it.
 */
export const EXCLUDED_CATEGORIES = [
  'wedding',
  'bridal',
  'corporate retreat',
  'conference',
  'convention',
  'trade show',
  'career fair',
  'networking mixer',
  'webinar',
  'workshop',
  'class',
  'seminar',
  'fundraiser gala',
];

const normalise = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;

/** True when an org name matches a known enterprise promoter or major agency. */
export function isExcludedOrg(name: string): boolean {
  const n = normalise(name);
  return EXCLUDED_ORGS.some((e) => n.includes(` ${e} `));
}

/** True when an event looks like the wedding/corporate/conference market. */
export function isExcludedCategory(text: string): boolean {
  const n = normalise(text);
  return EXCLUDED_CATEGORIES.some((c) => n.includes(` ${c} `));
}

// ── Geography ────────────────────────────────────────────────────────────────

/**
 * The ICP is not geo-bound, but warm intros are.
 *
 * Atlanta and the Southeast are where the warm-intro density is, so orgs there
 * get a scoring bonus rather than an exclusive filter. A promoter in Denver who
 * fits the band should still surface — just below an equally good one in
 * Atlanta, because the Atlanta one can be reached through someone.
 */
export const PRIORITY_METROS = [
  'atlanta',
  'athens',
  'savannah',
  'birmingham',
  'nashville',
  'charlotte',
  'asheville',
  'raleigh',
  'durham',
  'charleston',
  'columbia',
  'jacksonville',
  'orlando',
  'tampa',
  'miami',
  'new orleans',
  'memphis',
  'knoxville',
  'chattanooga',
  'greenville',
];

export function isPriorityMetro(location: string): boolean {
  const n = normalise(location);
  return PRIORITY_METROS.some((m) => n.includes(` ${m} `));
}
