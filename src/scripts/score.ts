/**
 * score — apply the ICP gate to every org that has events.
 *
 * Cheap and idempotent: re-run it after every discovery pass. Contact
 * discovery is gated on the band this sets, so nothing expensive happens to an
 * org until it has earned it.
 */
import { orgsForScoring, saveScore } from '../services/store';
import { scoreOrg } from '../services/score';
import { close } from '../lib/db';
import logger from '../lib/logger';

function main(): void {
  const orgs = orgsForScoring();
  if (orgs.length === 0) {
    logger.warn('No orgs with events yet — run `npm run discover` first.');
    close();
    return;
  }

  const tally: Record<string, number> = {};

  for (const org of orgs) {
    const result = scoreOrg({
      name: org.name,
      city: org.city,
      region: org.region,
      capacity: org.capacity,
      eventDates: org.eventDates,
      distinctVenues: org.distinctVenues,
    });

    saveScore(org.id, result);
    tally[result.band] = (tally[result.band] ?? 0) + 1;
  }

  logger.info(`Scored ${orgs.length} orgs:`);
  for (const band of ['qualified', 'watch', 'out-of-band', 'excluded']) {
    if (tally[band]) logger.info(`  ${band.padEnd(12)} ${tally[band]}`);
  }

  if (tally.watch) {
    logger.info(
      `\n  ${tally.watch} org(s) are in band but observed too briefly to trust.\n` +
        `  Re-run discovery over the coming weeks to widen the window.`
    );
  }

  logger.info(`\nNext: npm run report`);
  close();
}

main();
