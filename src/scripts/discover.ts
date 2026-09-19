/**
 * discover — run a source adapter and record what it finds.
 *
 * Re-run this. Show count is a trailing-window measurement, so each run widens
 * the observation window and moves 'watch' orgs toward a verdict.
 *
 * Usage:
 *   npm run discover -- --source venue-calendar --urls terminalwesthatl.com,variety-playhouse.com
 *   npm run discover -- --source venue-calendar --urls-file data/venues.txt --limit 200
 *   npm run discover -- --source venue-calendar --metro nashville
 *   npm run discover -- --source venue-calendar --all-metros --limit 500
 *   npm run discover -- --source venue-calendar --metro chicago --render
 *   npm run discover -- --metros          list metros and seed coverage
 *   npm run discover -- --list
 */
import fs from 'fs';
import { parseArgs } from 'util';
import { SOURCES, getSource } from '../sources';
import { METROS, getMetro } from '../metros';
import { readSeeds, seedPath, seedCoverage } from '../services/seeds';
import { recordEvent, startRun, finishRun } from '../services/store';
import { close } from '../lib/db';
import { closeBrowser } from '../lib/render';
import logger from '../lib/logger';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      urls: { type: 'string' },
      'urls-file': { type: 'string' },
      metro: { type: 'string' },
      'all-metros': { type: 'boolean' },
      metros: { type: 'boolean' },
      location: { type: 'string' },
      limit: { type: 'string' },
      render: { type: 'boolean' },
      list: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.metros) {
    const coverage = seedCoverage();
    const total = coverage.reduce((n, c) => n + c.count, 0);
    console.log(`\nMetros (${METROS.length}), ${total} seeded venue(s):\n`);
    for (const c of coverage) {
      const flag = c.metro.priority ? '★' : ' ';
      const count = c.count ? `${c.count}` : '—';
      console.log(
        `  ${flag} ${c.metro.slug.padEnd(16)} ${`${c.metro.label}, ${c.metro.region}`.padEnd(22)} ${count.padStart(4)}`
      );
    }
    console.log(`\n  ★ = priority metro (warm-intro bonus at scoring time)`);
    console.log(`  Add venues to data/seeds/<slug>.txt, one domain per line.\n`);
    close();
    return;
  }

  if (values.list || !values.source) {
    console.log('\nSources:\n');
    for (const s of SOURCES) {
      console.log(`  ${s.key.padEnd(18)} ${s.label}${s.available() ? '' : '  (unavailable — missing API key)'}`);
    }
    console.log('\nFor venue-calendar, pass venue domains via --urls, --urls-file, or --metro.');
    console.log('Run --metros to see which metros have seeds.');
    console.log('For bandsintown, --urls currently carries artist names (placeholder seeding).\n');
    close();
    return;
  }

  const source = getSource(values.source);
  if (!source) {
    logger.error(`Unknown source: ${values.source}`);
    process.exitCode = 1;
    close();
    return;
  }

  if (!source.available()) {
    logger.error(`${source.key} is unavailable — check the API key in .env`);
    process.exitCode = 1;
    close();
    return;
  }

  // Metro seeds. `--all-metros` walks priority metros first, so a run that is
  // cut short by --limit or by Ctrl-C has spent its budget on the orgs that can
  // actually be reached through someone.
  const metroSlugs = values['all-metros']
    ? [...METROS].sort((a, b) => Number(b.priority) - Number(a.priority)).map((m) => m.slug)
    : values.metro
      ? values.metro.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

  const fromMetros: string[] = [];
  for (const slug of metroSlugs) {
    const metro = getMetro(slug);
    if (!metro) {
      logger.error(`Unknown metro: ${slug} — run --metros to list them.`);
      process.exitCode = 1;
      close();
      return;
    }
    const seeds = readSeeds(slug);
    // An empty seed file is expected on a metro nobody has filled in yet, and
    // is worth saying out loud on a single-metro run — otherwise the run just
    // reports zero events and looks like a crawl failure.
    if (!seeds.length && !values['all-metros']) {
      logger.warn(`No seeds for ${metro.label} — add domains to ${seedPath(slug)}`);
    }
    fromMetros.push(...seeds);
  }

  const urls = [
    ...new Set([
      ...(values.urls ? values.urls.split(',').map((u) => u.trim()).filter(Boolean) : []),
      ...(values['urls-file']
        ? fs.readFileSync(values['urls-file'], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
        : []),
      ...fromMetros,
    ]),
  ];

  if (metroSlugs.length) {
    const seeded = metroSlugs.filter((s) => readSeeds(s).length).length;
    logger.info(`${urls.length} venue(s) from ${seeded}/${metroSlugs.length} seeded metro(s).`);
  }

  const runId = startRun(source.key);
  const touched = new Set<string>();
  let seen = 0;

  try {
    logger.info(`Discovering via ${source.label}...`);

    const events = await source.discover({
      urls,
      location: values.location,
      limit: values.limit ? Number(values.limit) : undefined,
      render: values.render,
    });

    for (const e of events) {
      const { orgIds } = recordEvent(e);
      seen++;
      for (const id of orgIds) touched.add(id);
    }

    finishRun(runId, seen, touched.size);
    logger.info(`Done: ${seen} events across ${touched.size} orgs.`);
    logger.info(`Next: npm run score`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishRun(runId, seen, touched.size, msg);
    logger.error(`Discovery failed: ${msg}`);
    process.exitCode = 1;
  } finally {
    // A rendering run leaves a browser process alive; without this the CLI
    // never exits.
    await closeBrowser();
    close();
  }
}

main();
