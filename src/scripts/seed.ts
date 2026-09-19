/**
 * seed — scaffold the per-metro venue seed files, then report coverage.
 *
 * Run once to create `data/seeds/*.txt`, then fill them in by hand. Existing
 * files are never overwritten.
 */
import { scaffoldSeeds, seedCoverage, seedPath } from '../services/seeds';
import { close } from '../lib/db';
import logger from '../lib/logger';

function main(): void {
  const { created, existing } = scaffoldSeeds();

  if (created.length) logger.info(`Created ${created.length} seed file(s) in data/seeds/`);
  if (existing) logger.info(`${existing} seed file(s) already existed — left alone.`);

  const coverage = seedCoverage();
  const filled = coverage.filter((c) => c.count > 0);
  const total = coverage.reduce((n, c) => n + c.count, 0);

  console.log(`\n  ${total} venue(s) seeded across ${filled.length}/${coverage.length} metros\n`);

  for (const c of filled) {
    console.log(`  ${c.metro.slug.padEnd(16)} ${String(c.count).padStart(4)}`);
  }

  if (!filled.length) {
    console.log(`  Nothing seeded yet. Add domains to ${seedPath('atlanta')} and run:`);
    console.log(`    npm run discover -- --source venue-calendar --metro atlanta\n`);
  } else {
    console.log(`\n  Next: npm run discover -- --source venue-calendar --all-metros\n`);
  }

  close();
}

main();
