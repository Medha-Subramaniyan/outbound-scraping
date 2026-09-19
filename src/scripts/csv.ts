/**
 * csv — mirror the whole database to CSV, for looking at.
 *
 * This is a one-way dump, not a two-way sync: the .db stays the source of
 * truth and these files are a disposable view of it. Editing a CSV here
 * changes nothing, and the next run overwrites it. That asymmetry is the
 * point — a spreadsheet that silently diverges from the database it was
 * exported from is worse than no spreadsheet.
 *
 * Distinct from `npm run export`, which is the outreach artefact: one band,
 * split per persona so reply rates stay comparable. This is every table,
 * unfiltered, for answering "what is actually in there".
 *
 *   npm run csv                        once
 *   npm run csv -- --published-only    prospects.csv carries personal addresses only
 *   npm run csv -- --watch   re-dump whenever the database changes
 */
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { db, close } from '../lib/db';
import logger from '../lib/logger';

const csv = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The joined view. Mirroring the tables alone leaves the interesting question
 * — who is qualified, and why — spread across three files and a foreign key,
 * so it gets assembled here as well.
 *
 * LEFT JOIN on people for the same reason `export` does it: an org with no
 * contact yet is a work item, not an absence, and dropping it would hide it.
 */
const PROSPECTS_SQL = `
  SELECT o.name AS org_name, o.kind, o.city, o.region, o.domain, o.capacity,
         o.icp_band, o.icp_score, o.shows_trailing_12m, o.observation_days,
         o.score_reasons AS why, o.scored_at,
         p.full_name, p.title, p.persona_key, p.persona_tier,
         p.email, p.email_source, p.profile_url,
         x.status AS outreach_status, x.sent_at, x.replied_at
  FROM orgs o
  LEFT JOIN people p   ON p.org_id = o.id AND (:publishedOnly = 0 OR p.email_source = 'published')
  LEFT JOIN outreach x ON x.person_id = p.id
  ORDER BY o.icp_score DESC NULLS LAST, o.name
`;

function writeCsv(file: string, columns: string[], rows: Record<string, unknown>[]): void {
  const lines = [columns.map(csv).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csv(row[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function dump(outDir: string, publishedOnly: boolean): void {
  fs.mkdirSync(outDir, { recursive: true });
  const d = db();

  // Read the table list from the database rather than hardcoding it, so a new
  // table in schema.sql shows up here without anyone remembering to add it.
  const tables = d
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as { name: string }[];

  for (const { name } of tables) {
    const columns = (d.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
      (c) => c.name
    );
    const rows = d.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
    writeCsv(path.join(outDir, `${name}.csv`), columns, rows);
    logger.info(`${name}.csv  (${rows.length} rows)`);
  }

  const stmt = d.prepare(PROSPECTS_SQL);
  const prospects = stmt.all({ publishedOnly: publishedOnly ? 1 : 0 }) as Record<string, unknown>[];
  const columns = stmt.columns().map((c) => c.name);
  writeCsv(path.join(outDir, 'prospects.csv'), columns, prospects);
  logger.info(`prospects.csv  (${prospects.length} rows)`);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      watch: { type: 'boolean' },
      'published-only': { type: 'boolean' },
    },
  });

  const outDir = values.out ?? 'data/csv';
  const publishedOnly = values['published-only'] ?? false;
  dump(outDir, publishedOnly);

  if (!values.watch) {
    close();
    return;
  }

  const dbPath = process.env.DATABASE_PATH || 'data/prospects.db';

  // Watch the directory, not the file: under WAL the writes land in
  // prospects.db-wal and only reach the .db itself at checkpoint, so watching
  // the .db alone would sit silent through an entire discovery run.
  let pending: NodeJS.Timeout | null = null;
  fs.watch(path.dirname(dbPath), (_event, filename) => {
    if (filename && !filename.startsWith(path.basename(dbPath))) return;
    // Coalesce: one logical write touches the -wal and -shm files in quick
    // succession, and re-dumping on each would thrash.
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      try {
        dump(outDir, publishedOnly);
      } catch (err) {
        logger.error(`Re-dump failed: ${(err as Error).message}`);
      }
    }, 300);
  });

  logger.info(`Watching ${dbPath} — Ctrl-C to stop.`);
}

main();
