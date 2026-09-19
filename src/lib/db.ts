/**
 * SQLite, on purpose.
 *
 * The alternative was the hosted Postgres this pipeline's sibling project uses.
 * That would mean provisioning a shared instance and handing every teammate a
 * connection string — credential distribution for a dataset that is already
 * sensitive (real people's contact details) and that each person is going to
 * scrape for themselves anyway. A local file means `git clone && npm run
 * migrate` and you are working.
 *
 * The schema is written in plain SQL that Postgres would also accept, so if
 * this ever needs to be shared state rather than per-machine state, the move is
 * a connection swap rather than a rewrite.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DATABASE_PATH || 'data/prospects.db';

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;

  const dir = path.dirname(DB_PATH);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  instance = new Database(DB_PATH);

  // WAL so a long discovery run does not block a concurrent read-only report.
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');

  return instance;
}

export function close(): void {
  instance?.close();
  instance = null;
}
