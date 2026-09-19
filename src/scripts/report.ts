/**
 * report — what the pipeline currently believes, in the terminal.
 */
import { db, close } from '../lib/db';
import { MIN_OBSERVATION_DAYS } from '../services/score';
import type { Org } from '../types';

function main(): void {
  const d = db();

  const counts = d
    .prepare(`SELECT icp_band AS band, COUNT(*) AS n FROM orgs WHERE icp_band IS NOT NULL GROUP BY icp_band`)
    .all() as { band: string; n: number }[];

  const events = (d.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const orgs = (d.prepare(`SELECT COUNT(*) AS n FROM orgs`).get() as { n: number }).n;
  const unscored = (d.prepare(`SELECT COUNT(*) AS n FROM orgs WHERE icp_band IS NULL`).get() as { n: number }).n;

  console.log(`\n  ${events} events  ·  ${orgs} orgs\n`);

  if (counts.length === 0) {
    console.log('  Nothing scored yet. Run `npm run score`.\n');
    close();
    return;
  }

  for (const c of counts) console.log(`  ${c.band.padEnd(12)} ${c.n}`);
  if (unscored) console.log(`  ${'unscored'.padEnd(12)} ${unscored}`);

  const qualified = d
    .prepare(
      `SELECT * FROM orgs WHERE icp_band = 'qualified' ORDER BY icp_score DESC LIMIT 20`
    )
    .all() as Org[];

  if (qualified.length) {
    console.log(`\n  ── Top qualified ──\n`);
    for (const o of qualified) {
      const where = [o.city, o.region].filter(Boolean).join(', ') || '—';
      console.log(`  ${String(o.icp_score).padStart(5)}  ${o.name}`);
      console.log(`         ${where}  ·  ${o.shows_trailing_12m} shows over ${o.observation_days}d  ·  ${o.kind}`);
      for (const r of JSON.parse(o.score_reasons ?? '[]') as string[]) console.log(`         · ${r}`);
      console.log('');
    }
  }

  const watch = (d.prepare(`SELECT COUNT(*) AS n FROM orgs WHERE icp_band = 'watch'`).get() as { n: number }).n;
  if (watch) {
    console.log(
      `  ${watch} org(s) on watch — in band, but under ${MIN_OBSERVATION_DAYS} days observed.\n` +
        `  Re-run discovery to widen the window before trusting their rate.\n`
    );
  }

  close();
}

main();
