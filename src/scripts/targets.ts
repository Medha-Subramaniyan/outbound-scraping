/**
 * targets — turn seed domains into crawlable org rows.
 *
 * Sits between `directory` (which writes seed files) and `enrich` (which
 * crawls orgs). Seeds are a flat list of domains; `enrich` reads the `orgs`
 * table. This is the step that moves one into the other.
 *
 * ── What these rows are, and are not ─────────────────────────────────────────
 *
 * Every org created here is a *crawl target*, not a qualified prospect. It has
 * no measured shows, so `icp_band` stays NULL and `score_reasons` says plainly
 * that it was never scored. That distinction matters: this pipeline's whole
 * argument (src/icp.ts) is that orgs qualify by counted show volume, and a row
 * that arrived from a directory has not done that. It is a place to look, not
 * a verdict.
 *
 *   npm run targets              report what would be created
 *   npm run targets -- --write   create the rows
 *   npm run targets -- --probe   check each domain resolves first (slower)
 */
import https from 'https';
import crypto from 'crypto';
import { parseArgs } from 'util';
import { db, close } from '../lib/db';
import { METROS } from '../metros';
import { readSeeds } from '../services/seeds';
import logger from '../lib/logger';

const NEVER_SCORED =
  '["contact-discovery target; never scored — no events measured for this org"]';

/** A cheap HEAD-ish check that a domain answers at all. */
function resolves(domain: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://${domain}/`,
      { timeout: timeoutMs, headers: { 'User-Agent': 'outbound-scraping/0.1 (+prospect research)' } },
      (res) => {
        res.resume();
        // Any answer at all, including a redirect, means the host is live.
        resolve((res.statusCode ?? 0) < 500);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Derive a display name from a domain, for rows with no better source. */
function nameFromDomain(domain: string): string {
  return domain
    .replace(/\.(com|org|net|us|co|live|club|bar|fm)$/i, '')
    .replace(/[-_.]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { write: { type: 'boolean' }, probe: { type: 'boolean' }, limit: { type: 'string' } },
  });

  const d = db();

  // Domain → metro, from the seed files themselves. The seed file a domain
  // lives in *is* its metro, so nothing needs to be inferred.
  const pairs: { domain: string; metro: string; city: string; region: string }[] = [];
  for (const metro of METROS) {
    for (const domain of readSeeds(metro.slug)) {
      pairs.push({ domain, metro: metro.slug, city: metro.label, region: metro.region });
    }
  }

  const known = new Set(
    (d.prepare(`SELECT domain FROM orgs WHERE domain IS NOT NULL AND domain != ''`).all() as {
      domain: string;
    }[]).map((r) => r.domain.toLowerCase())
  );

  let fresh = pairs.filter((p) => !known.has(p.domain.toLowerCase()));
  if (values.limit) fresh = fresh.slice(0, Number(values.limit));

  logger.info(`${pairs.length} seeded domain(s); ${fresh.length} not yet in the database.`);

  if (!fresh.length) {
    close();
    return;
  }

  let candidates = fresh;

  if (values.probe) {
    logger.info(`Probing ${fresh.length} domain(s)...`);
    const live: typeof fresh = [];
    // Probed in small batches: this is one request per host to different
    // hosts, so it parallelises safely, but not so wide that it looks like a
    // scan.
    const BATCH = 10;
    for (let i = 0; i < fresh.length; i += BATCH) {
      const slice = fresh.slice(i, i + BATCH);
      const results = await Promise.all(slice.map((p) => resolves(p.domain)));
      slice.forEach((p, n) => results[n] && live.push(p));
    }
    logger.info(`${live.length}/${fresh.length} domain(s) answered.`);
    candidates = live;
  }

  if (!values.write) {
    for (const p of candidates.slice(0, 25)) console.log(`  ${p.domain.padEnd(36)} ${p.city}, ${p.region}`);
    console.log(`\n  ${candidates.length} target(s) would be created. Re-run with --write.\n`);
    close();
    return;
  }

  const insert = d.prepare(
    `INSERT OR IGNORE INTO orgs (id, name, slug, kind, city, region, domain, score_reasons)
     VALUES (?, ?, ?, 'venue', ?, ?, ?, ?)`
  );

  let created = 0;
  const tx = d.transaction(() => {
    for (const p of candidates) {
      const slug = p.domain.replace(/\.[a-z]+$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const id = crypto.createHash('sha1').update(slug).digest('hex').slice(0, 16);
      created += insert.run(
        id, nameFromDomain(p.domain), slug, p.city, p.region, p.domain, NEVER_SCORED
      ).changes;
    }
  });
  tx();

  logger.info(`Created ${created} crawl target(s).`);
  logger.info(`Next: npm run enrich -- --band any --render --published-only`);
  close();
}

main();
