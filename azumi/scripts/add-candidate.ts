/**
 * Manually add a candidate to the SQL candidates table.
 * Usage: npx tsx scripts/add-candidate.ts "Full Name" "+79991234567"
 * Or:    npm run db:add-candidate -- "Full Name" "+79991234567"
 *
 * Loads .env from azumi root. Run from azumi directory.
 */
import 'dotenv/config';
import { initDb, saveCandidate } from '../db-pg';

const name = process.argv[2];
const phone = process.argv[3];

if (!name || !phone) {
  console.error('Usage: npx tsx scripts/add-candidate.ts "Full Name" "+79991234567"');
  process.exit(1);
}

async function main() {
  await initDb();
  const id = await saveCandidate({ name, phone });
  console.log('Added candidate:', { id, name, phone });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
