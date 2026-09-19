/**
 * discover — run a source adapter and record what it finds.
 *
 * Re-run this. Show count is a trailing-window measurement, so each run widens
 * the observation window and moves 'watch' orgs toward a verdict.
 *
 * Usage:
 *   npm run discover -- --source venue-calendar --urls terminalwesthatl.com,variety-playhouse.com
 *   npm run discover -- --source venue-calendar --urls-file data/venues.txt --limit 200
 *   npm run discover -- --list
 */
import fs from 'fs';
import { parseArgs } from 'util';
import { SOURCES, getSource } from '../sources';
import { recordEvent, startRun, finishRun } from '../services/store';
import { close } from '../lib/db';
import logger from '../lib/logger';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      urls: { type: 'string' },
      'urls-file': { type: 'string' },
      location: { type: 'string' },
      limit: { type: 'string' },
      list: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.list || !values.source) {
    console.log('\nSources:\n');
    for (const s of SOURCES) {
      console.log(`  ${s.key.padEnd(18)} ${s.label}${s.available() ? '' : '  (unavailable — missing API key)'}`);
    }
    console.log('\nFor venue-calendar, pass venue domains via --urls or --urls-file.');
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

  const urls = [
    ...(values.urls ? values.urls.split(',').map((u) => u.trim()).filter(Boolean) : []),
    ...(values['urls-file']
      ? fs.readFileSync(values['urls-file'], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      : []),
  ];

  const runId = startRun(source.key);
  const touched = new Set<string>();
  let seen = 0;

  try {
    logger.info(`Discovering via ${source.label}...`);

    const events = await source.discover({
      urls,
      location: values.location,
      limit: values.limit ? Number(values.limit) : undefined,
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
    close();
  }
}

main();
