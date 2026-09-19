/**
 * The national run, as a list of metros.
 *
 * ── Why a curated list and not a crawl ───────────────────────────────────────
 *
 * The ICP was never geo-bound — `PRIORITY_METROS` in src/icp.ts is a scoring
 * bonus for warm-intro density, not a filter. So "go national" is not a change
 * to who qualifies. It is purely a seeding problem: the pipeline can only find
 * orgs on sites it is pointed at, and `--urls` was hand-fed.
 *
 * Seeds stay human-curated because seed quality decides everything downstream.
 * A scraped directory brings in comedy clubs, churches and wedding barns, and
 * every one of them costs a full crawl and a scoring pass before being thrown
 * away. A hand-checked line costs a minute once. See docs/ROADMAP.md §2 for the
 * directory-based seeding that may supplement this later.
 *
 * Seed files live in `data/seeds/<slug>.txt`, one domain per line, `#` for
 * comments. They are gitignored — each teammate builds their own, same as the
 * database.
 */

export interface Metro {
  slug: string;
  label: string;
  region: string;
  /** True where warm intros exist. Mirrors PRIORITY_METROS in src/icp.ts. */
  priority: boolean;
}

/**
 * US metros with enough independent live-music activity to be worth a pass.
 *
 * Ordered by priority first, then roughly by market size. The priority flag is
 * duplicated from `isPriorityMetro` deliberately: this list decides *crawl
 * order*, that function decides *score*. Keeping them separate means widening
 * the crawl never silently changes anyone's score.
 */
export const METROS: Metro[] = [
  // ── Southeast: warm-intro territory, crawl first ──
  { slug: 'atlanta', label: 'Atlanta', region: 'GA', priority: true },
  { slug: 'athens', label: 'Athens', region: 'GA', priority: true },
  { slug: 'savannah', label: 'Savannah', region: 'GA', priority: true },
  { slug: 'nashville', label: 'Nashville', region: 'TN', priority: true },
  { slug: 'memphis', label: 'Memphis', region: 'TN', priority: true },
  { slug: 'knoxville', label: 'Knoxville', region: 'TN', priority: true },
  { slug: 'chattanooga', label: 'Chattanooga', region: 'TN', priority: true },
  { slug: 'birmingham', label: 'Birmingham', region: 'AL', priority: true },
  { slug: 'charlotte', label: 'Charlotte', region: 'NC', priority: true },
  { slug: 'asheville', label: 'Asheville', region: 'NC', priority: true },
  { slug: 'raleigh', label: 'Raleigh', region: 'NC', priority: true },
  { slug: 'durham', label: 'Durham', region: 'NC', priority: true },
  { slug: 'charleston', label: 'Charleston', region: 'SC', priority: true },
  { slug: 'columbia', label: 'Columbia', region: 'SC', priority: true },
  { slug: 'greenville', label: 'Greenville', region: 'SC', priority: true },
  { slug: 'jacksonville', label: 'Jacksonville', region: 'FL', priority: true },
  { slug: 'orlando', label: 'Orlando', region: 'FL', priority: true },
  { slug: 'tampa', label: 'Tampa', region: 'FL', priority: true },
  { slug: 'miami', label: 'Miami', region: 'FL', priority: true },
  { slug: 'new-orleans', label: 'New Orleans', region: 'LA', priority: true },

  // ── The rest of the country ──
  { slug: 'austin', label: 'Austin', region: 'TX', priority: false },
  { slug: 'dallas', label: 'Dallas', region: 'TX', priority: false },
  { slug: 'houston', label: 'Houston', region: 'TX', priority: false },
  { slug: 'san-antonio', label: 'San Antonio', region: 'TX', priority: false },
  { slug: 'denver', label: 'Denver', region: 'CO', priority: false },
  { slug: 'boulder', label: 'Boulder', region: 'CO', priority: false },
  { slug: 'phoenix', label: 'Phoenix', region: 'AZ', priority: false },
  { slug: 'tucson', label: 'Tucson', region: 'AZ', priority: false },
  { slug: 'las-vegas', label: 'Las Vegas', region: 'NV', priority: false },
  { slug: 'salt-lake-city', label: 'Salt Lake City', region: 'UT', priority: false },
  { slug: 'los-angeles', label: 'Los Angeles', region: 'CA', priority: false },
  { slug: 'san-diego', label: 'San Diego', region: 'CA', priority: false },
  { slug: 'san-francisco', label: 'San Francisco', region: 'CA', priority: false },
  { slug: 'oakland', label: 'Oakland', region: 'CA', priority: false },
  { slug: 'sacramento', label: 'Sacramento', region: 'CA', priority: false },
  { slug: 'portland', label: 'Portland', region: 'OR', priority: false },
  { slug: 'seattle', label: 'Seattle', region: 'WA', priority: false },
  { slug: 'boise', label: 'Boise', region: 'ID', priority: false },
  { slug: 'minneapolis', label: 'Minneapolis', region: 'MN', priority: false },
  { slug: 'chicago', label: 'Chicago', region: 'IL', priority: false },
  { slug: 'milwaukee', label: 'Milwaukee', region: 'WI', priority: false },
  { slug: 'madison', label: 'Madison', region: 'WI', priority: false },
  { slug: 'detroit', label: 'Detroit', region: 'MI', priority: false },
  { slug: 'ann-arbor', label: 'Ann Arbor', region: 'MI', priority: false },
  { slug: 'columbus', label: 'Columbus', region: 'OH', priority: false },
  { slug: 'cleveland', label: 'Cleveland', region: 'OH', priority: false },
  { slug: 'cincinnati', label: 'Cincinnati', region: 'OH', priority: false },
  { slug: 'indianapolis', label: 'Indianapolis', region: 'IN', priority: false },
  { slug: 'louisville', label: 'Louisville', region: 'KY', priority: false },
  { slug: 'st-louis', label: 'St. Louis', region: 'MO', priority: false },
  { slug: 'kansas-city', label: 'Kansas City', region: 'MO', priority: false },
  { slug: 'omaha', label: 'Omaha', region: 'NE', priority: false },
  { slug: 'oklahoma-city', label: 'Oklahoma City', region: 'OK', priority: false },
  { slug: 'tulsa', label: 'Tulsa', region: 'OK', priority: false },
  { slug: 'little-rock', label: 'Little Rock', region: 'AR', priority: false },
  { slug: 'richmond', label: 'Richmond', region: 'VA', priority: false },
  { slug: 'washington-dc', label: 'Washington DC', region: 'DC', priority: false },
  { slug: 'baltimore', label: 'Baltimore', region: 'MD', priority: false },
  { slug: 'philadelphia', label: 'Philadelphia', region: 'PA', priority: false },
  { slug: 'pittsburgh', label: 'Pittsburgh', region: 'PA', priority: false },
  { slug: 'new-york', label: 'New York', region: 'NY', priority: false },
  { slug: 'brooklyn', label: 'Brooklyn', region: 'NY', priority: false },
  { slug: 'buffalo', label: 'Buffalo', region: 'NY', priority: false },
  { slug: 'boston', label: 'Boston', region: 'MA', priority: false },
  { slug: 'providence', label: 'Providence', region: 'RI', priority: false },
  { slug: 'portland-me', label: 'Portland', region: 'ME', priority: false },
  { slug: 'burlington', label: 'Burlington', region: 'VT', priority: false },

  // ── Added to route Independent Venue Week members ──
  //
  // Each of these states had IVW-listed venues and no metro here, so their
  // venues had nowhere to be filed. They are smaller markets than the list
  // above, but an independent room in Des Moines is exactly the ICP — the
  // reason they were missing is that the original list was written from
  // memory of big music cities, not from a directory.
  { slug: 'des-moines', label: 'Des Moines', region: 'IA', priority: false },
  { slug: 'hartford', label: 'Hartford', region: 'CT', priority: false },
  { slug: 'wichita', label: 'Wichita', region: 'KS', priority: false },
  { slug: 'asbury-park', label: 'Asbury Park', region: 'NJ', priority: false },
  { slug: 'missoula', label: 'Missoula', region: 'MT', priority: false },
  { slug: 'manchester', label: 'Manchester', region: 'NH', priority: false },
  { slug: 'albuquerque', label: 'Albuquerque', region: 'NM', priority: false },
  { slug: 'jackson', label: 'Jackson', region: 'MS', priority: false },
  { slug: 'anchorage', label: 'Anchorage', region: 'AK', priority: false },
  { slug: 'wilmington', label: 'Wilmington', region: 'DE', priority: false },
  { slug: 'honolulu', label: 'Honolulu', region: 'HI', priority: false },
  { slug: 'sioux-falls', label: 'Sioux Falls', region: 'SD', priority: false },
  { slug: 'fargo', label: 'Fargo', region: 'ND', priority: false },
  { slug: 'charleston-wv', label: 'Charleston', region: 'WV', priority: false },
];

export function getMetro(slug: string): Metro | undefined {
  return METROS.find((m) => m.slug === slug.toLowerCase());
}
