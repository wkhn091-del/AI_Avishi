#!/usr/bin/env node
/**
 * An account's credits, by email (with DATABASE_URL from server/.env, like the server):
 *   npm run credits -w server -- --email someone@example.com             the balance
 *   npm run credits -w server -- --email someone@example.com --add 100   add (a negative number takes away)
 *   npm run credits -w server -- --email someone@example.com --set 50    set
 */
import { closeDb } from '../src/lib/db.js';
import { adjustCredits } from '../src/services/credits.js';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? '');
};
const email = option('--email');
const add = option('--add');
const set = option('--set');
const USAGE = 'Usage: npm run credits -w server -- --email someone@example.com [--add <number> | --set <number>]';

if (!email || (add !== null && set !== null) || (add !== null && !/^-?\d+$/.test(add)) || (set !== null && !/^\d+$/.test(set))) {
  console.error(USAGE);
  process.exit(1);
}
try {
  const result = await adjustCredits(email, { add: add === null ? null : Number(add), set: set === null ? null : Number(set) });
  if (!result) {
    console.error(`No account has the email ${email}. (An account is created the first time its owner signs in.)`);
    process.exitCode = 1;
  } else if (add === null && set === null) console.log(`${result.email}: ${result.after} credits`);
  else console.log(`${result.email}: ${result.before} → ${result.after} credits`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
