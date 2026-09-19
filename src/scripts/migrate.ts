/**
 * Create the schema. Safe to re-run — every statement is IF NOT EXISTS.
 */
import fs from 'fs';
import path from 'path';
import { db, close } from '../lib/db';
import logger from '../lib/logger';

function main(): void {
  const schemaPath = path.join(__dirname, '../../db/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  db().exec(sql);

  const tables = db()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];

  logger.info(`Schema ready: ${tables.map((t) => t.name).join(', ')}`);
  close();
}

main();
