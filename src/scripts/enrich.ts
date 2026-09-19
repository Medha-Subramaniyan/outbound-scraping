/**
 * enrich — find people at orgs that already passed the ICP gate.
 *
 * Runs after `score`, never before. That ordering is a commitment in
 * docs/ETHICS.md, not an optimisation: the fewer people whose contact details
 * sit in this database, the smaller the thing being looked after. Scraping
 * contacts for all 3,000 orgs a national run turns up, then filtering to the
 * 200 that qualify, would collect 2,800 people's details for nothing.
 *
 * Usage:
 *   npm run enrich                          qualified orgs with a domain
 *   npm run enrich -- --band watch          widen to the watch list
 *   npm run enrich -- --band any            every org with a domain, scored or not
 *   npm run enrich -- --limit 25            cap the run
 *   npm run enrich -- --recheck             revisit orgs already enriched
 *   npm run enrich -- --render              use a browser where static HTML is empty
 *   npm run enrich -- --published-only      skip role mailboxes (booking@, info@)
 */
import { parseArgs } from 'util';
import { db, close } from '../lib/db';
import { findContacts, saveContact } from '../services/contact';
import { closeBrowser } from '../lib/render';
import logger from '../lib/logger';

interface Target {
  id: string;
  name: string;
  domain: string;
  enriched_at: string | null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      band: { type: 'string' },
      limit: { type: 'string' },
      recheck: { type: 'boolean' },
      render: { type: 'boolean' },
      'published-only': { type: 'boolean' },
    },
  });

  const band = values.band ?? 'qualified';
  const limit = values.limit ? Number(values.limit) : undefined;

  // Orgs with no domain cannot be crawled. They are a real work item — find the
  // site by hand — but not one this script can do anything about, so they are
  // counted and reported rather than silently dropped.
  // `--band any` crawls every org with a domain, scored or not. It exists for
  // the bootstrap case: a seed list of venues that have been probed as
  // reachable but never observed putting on a show, so they carry no band yet.
  // Ordinary runs stay gated on the ICP band, per docs/ETHICS.md — contact
  // discovery is meant to follow qualification, not precede it.
  const anyBand = band === 'any';

  const all = db()
    .prepare(
      anyBand
        ? `SELECT id, name, domain, enriched_at FROM orgs
           WHERE domain IS NOT NULL AND domain != ''
           ORDER BY icp_score DESC NULLS LAST, name`
        : `SELECT id, name, domain, enriched_at FROM orgs
           WHERE icp_band = ? AND domain IS NOT NULL AND domain != ''
           ORDER BY icp_score DESC`
    )
    .all(...(anyBand ? [] : [band])) as Target[];

  if (anyBand) {
    logger.warn(
      'Crawling orgs that have not passed the ICP gate (--band any). ' +
        'Prefer scoring first: it keeps fewer people in the database.'
    );
  }

  const domainless = (
    db()
      .prepare(
        anyBand
          ? `SELECT COUNT(*) AS n FROM orgs WHERE domain IS NULL OR domain = ''`
          : `SELECT COUNT(*) AS n FROM orgs
             WHERE icp_band = ? AND (domain IS NULL OR domain = '')`
      )
      .get(...(anyBand ? [] : [band])) as { n: number }
  ).n;

  // Skip orgs already attempted, unless asked to recheck.
  //
  // Keyed on `enriched_at` — the attempt — rather than on whether a people row
  // exists. Most venues publish no reachable contact at all, so keying off the
  // result meant every barren org was re-crawled on every run: 93 of 139 orgs
  // here, at nine polite requests and several browser renders each. The work
  // grew with the seed list instead of with the number of new venues.
  const targets = values.recheck ? all : all.filter((o) => !o.enriched_at);

  const queue = limit ? targets.slice(0, limit) : targets;

  if (queue.length === 0) {
    logger.warn(
      `Nothing to enrich in band '${band}'. ` +
        `${all.length} org(s) with a domain, ${domainless} without one.` +
        (all.length && !values.recheck ? ' All already attempted — use --recheck.' : '')
    );
    close();
    return;
  }

  logger.info(
    `Enriching ${queue.length} org(s) in band '${band}'${values.render ? ' (with rendering)' : ''}...`
  );
  if (domainless) logger.warn(`${domainless} org(s) in band have no domain — find those by hand.`);

  let people = 0;
  let named = 0;
  let withEmail = 0;
  let skipped = 0;

  for (const org of queue) {
    try {
      const all = await findContacts(org.domain, { render: values.render });

      // `published` means a personal address; `role` is a functional mailbox
      // like booking@. Filtering here rather than in the scraper keeps the
      // role rows in the database, so a venue whose only listed contact is
      // booking@ is still recoverable without re-crawling the site.
      const contacts = values['published-only']
        ? all.filter((c) => c.emailSource === 'published')
        : all;

      skipped += all.length - contacts.length;

      for (const c of contacts) {
        saveContact(org.id, c, 'site-crawl');
        people++;
        if (c.fullName) named++;
        if (c.email) withEmail++;
      }
      // Stamp the attempt even when it found nobody — that is the whole point
      // of the column.
      db().prepare(`UPDATE orgs SET enriched_at = datetime('now') WHERE id = ?`).run(org.id);

      const n = contacts.filter((c) => c.fullName).length;
      logger.info(`  ${org.name}: ${contacts.length} contact(s), ${n} named`);
    } catch (err) {
      // One unreachable site must not end a run that may span hours.
      logger.error(`  ${org.name}: ${(err as Error).message}`);
    }
  }

  logger.info(`Done: ${people} contact(s), ${named} named, ${withEmail} with an email.`);
  if (skipped) logger.info(`${skipped} role mailbox(es) skipped (--published-only).`);
  if (!named && !values.render) {
    logger.info(`No named people found. Many venue sites render contacts client-side — retry with --render.`);
  }
  logger.info(`Next: npm run export`);

  // The browser is a process, not a handle: leaving it open hangs the CLI.
  await closeBrowser();
  close();
}

main();
