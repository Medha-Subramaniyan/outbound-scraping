/**
 * Venue seed files — the input to a national run.
 *
 * One file per metro at `data/seeds/<slug>.txt`, one domain per line, `#` for
 * comments. Gitignored alongside the database: seeds are working state, and a
 * teammate's half-finished Denver list is not something to merge.
 *
 * Deliberately a flat text file rather than a table. Seeds are edited by hand,
 * in bulk, often by pasting from a browser — a format you can open in any
 * editor and diff is worth more here than referential integrity.
 */
import fs from 'fs';
import path from 'path';
import { METROS, type Metro } from '../metros';

const SEED_DIR = process.env.SEED_DIR || 'data/seeds';

export function seedPath(slug: string): string {
  return path.join(SEED_DIR, `${slug}.txt`);
}

/**
 * Read one metro's seeds.
 *
 * Returns [] for a metro with no file yet, which is the normal state for most
 * of the list — the caller decides whether that is worth reporting.
 */
export function readSeeds(slug: string): string[] {
  const file = seedPath(slug);
  if (!fs.existsSync(file)) return [];

  return [
    ...new Set(
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        // Strip trailing comments before anything else. Seeds written by
        // `npm run directory` carry provenance inline —
        //   `eddiesattic.com  # Eddie's Attic — IVW member (https://...)`
        // — and without this the whole comment became part of the hostname.
        .map((l) => l.replace(/\s+#.*$/, '').trim())
        .filter((l) => l && !l.startsWith('#'))
        // Tolerate pasted URLs: strip scheme, `www.`, path and trailing slash,
        // so `https://www.venue.com/events` and `venue.com` are one seed
        // rather than two crawls of the same site. Normalising `www.` matters
        // because the org's domain is keyed off the host later.
        .map((l) =>
          l
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/.*$/, '')
        )
    ),
  ];
}

export interface Coverage {
  metro: Metro;
  count: number;
}

/** Seed counts per metro, priority metros first. */
export function seedCoverage(): Coverage[] {
  return [...METROS]
    .sort((a, b) => Number(b.priority) - Number(a.priority) || a.slug.localeCompare(b.slug))
    .map((metro) => ({ metro, count: readSeeds(metro.slug).length }));
}

/**
 * Create empty, commented seed files for every metro that lacks one.
 *
 * Existing files are never touched — this is scaffolding for hand-editing, and
 * silently rewriting a list someone spent an afternoon building would be the
 * worst possible behaviour here.
 */
export function scaffoldSeeds(): { created: string[]; existing: number } {
  fs.mkdirSync(SEED_DIR, { recursive: true });

  const created: string[] = [];
  let existing = 0;

  for (const metro of METROS) {
    const file = seedPath(metro.slug);
    if (fs.existsSync(file)) {
      existing++;
      continue;
    }
    fs.writeFileSync(
      file,
      `# ${metro.label}, ${metro.region}${metro.priority ? '  (priority metro)' : ''}\n` +
        `#\n` +
        `# One venue or promoter domain per line. Bare domains preferred;\n` +
        `# pasted URLs are tolerated and normalised.\n` +
        `#\n` +
        `#   variety-playhouse.com\n` +
        `#   https://www.terminalwestatl.com/events   <- also fine\n` +
        `#\n` +
        `# Aim for independent rooms: 150–3000 cap, 10–50 shows a year.\n` +
        `# Enterprise chains are filtered at scoring time, so adding them\n` +
        `# only costs crawl budget.\n`
    );
    created.push(file);
  }

  return { created, existing };
}
