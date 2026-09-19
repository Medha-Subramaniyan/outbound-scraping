/**
 * reclassify — re-run the email classifier over rows already in the database.
 *
 * The role list and the junk-domain list grow every time a crawl meets a new
 * shape of mailbox in the wild. Rows written before a rule existed keep their
 * old provenance, so `published` in the table can mean "classified by a rule
 * set that no longer exists". That matters: `published` is the column the
 * export trusts to mean "a person reads this".
 *
 * This walks every stored address, applies the current rules, and reports what
 * moved. Deletions are limited to addresses the classifier now rejects
 * outright — domain-broker sales addresses from parked venue sites, image
 * filenames — because those are not contacts at all.
 *
 *   npm run reclassify            report only, change nothing
 *   npm run reclassify -- --apply write the changes
 */
import { parseArgs } from 'util';
import { db, close } from '../lib/db';
import { classifyEmail, isUsableEmail } from '../services/contact';
import logger from '../lib/logger';

interface Row {
  id: string;
  email: string;
  email_source: string;
  full_name: string | null;
}

function main(): void {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' } } });

  const rows = db()
    .prepare(`SELECT id, email, email_source, full_name FROM people WHERE email IS NOT NULL`)
    .all() as Row[];

  const reclassified: { row: Row; to: string }[] = [];
  const junk: Row[] = [];

  for (const row of rows) {
    if (!isUsableEmail(row.email)) {
      junk.push(row);
      continue;
    }
    const now = classifyEmail(row.email);
    if (now !== row.email_source) reclassified.push({ row, to: now });
  }

  if (!reclassified.length && !junk.length) {
    logger.info(`${rows.length} contact(s) checked; all provenance is current.`);
    close();
    return;
  }

  for (const { row, to } of reclassified) {
    console.log(`  ${row.email_source} → ${to}   ${row.email}`);
  }
  for (const row of junk) {
    console.log(`  DELETE (not a contact)   ${row.email}`);
  }

  if (!values.apply) {
    console.log(`\n  ${reclassified.length} to reclassify, ${junk.length} to delete.`);
    console.log(`  Re-run with --apply to write.\n`);
    close();
    return;
  }

  const update = db().prepare(`UPDATE people SET email_source = ? WHERE id = ?`);
  const remove = db().prepare(`DELETE FROM people WHERE id = ?`);

  const tx = db().transaction(() => {
    for (const { row, to } of reclassified) update.run(to, row.id);
    for (const row of junk) remove.run(row.id);
  });
  tx();

  logger.info(`Reclassified ${reclassified.length}, deleted ${junk.length}.`);
  close();
}

main();
