/**
 * export — write the qualified list to CSV.
 *
 * Personas are exported as separate files by default. Blending them would make
 * reply rates incomparable across personas, which is the one measurement that
 * can actually disprove the ICP.
 */
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { db, close } from '../lib/db';
import logger from '../lib/logger';

interface Row {
  org_name: string;
  city: string | null;
  region: string | null;
  kind: string;
  domain: string | null;
  icp_score: number;
  shows_trailing_12m: number;
  observation_days: number;
  full_name: string | null;
  title: string | null;
  persona_key: string | null;
  persona_tier: string | null;
  email: string | null;
  email_source: string | null;
  score_reasons: string;
}

const csv = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function main(): void {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      band: { type: 'string' },
      'include-contactless': { type: 'boolean' },
    },
  });

  const outDir = values.out ?? 'exports';
  const band = values.band ?? 'qualified';
  fs.mkdirSync(outDir, { recursive: true });

  // LEFT JOIN so orgs without a contact yet still appear — they are a real work
  // item (find someone there), not an absence.
  const rows = db()
    .prepare(
      `SELECT o.name AS org_name, o.city, o.region, o.kind, o.domain,
              o.icp_score, o.shows_trailing_12m, o.observation_days, o.score_reasons,
              p.full_name, p.title, p.persona_key, p.persona_tier, p.email, p.email_source
       FROM orgs o
       LEFT JOIN people p ON p.org_id = o.id
       WHERE o.icp_band = ?
       ORDER BY o.icp_score DESC, o.name`
    )
    .all(band) as Row[];

  if (rows.length === 0) {
    logger.warn(`No orgs in band '${band}'. Run discover + score first.`);
    close();
    return;
  }

  const header = [
    'org_name', 'city', 'region', 'kind', 'domain', 'icp_score',
    'shows_trailing_12m', 'observation_days', 'full_name', 'title',
    'persona_key', 'persona_tier', 'email', 'email_source', 'why',
  ];

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.persona_tier ?? 'no-contact';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  for (const [tier, group] of groups) {
    const lines = [header.join(',')];
    for (const r of group) {
      lines.push(
        [
          r.org_name, r.city, r.region, r.kind, r.domain, r.icp_score,
          r.shows_trailing_12m, r.observation_days, r.full_name, r.title,
          r.persona_key, r.persona_tier, r.email, r.email_source,
          (JSON.parse(r.score_reasons ?? '[]') as string[]).join('; '),
        ].map(csv).join(',')
      );
    }

    const file = path.join(outDir, `${band}-${tier}.csv`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    logger.info(`${file}  (${group.length} rows)`);
  }

  close();
}

main();
