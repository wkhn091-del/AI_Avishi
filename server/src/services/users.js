/**
 * The signed-in person's row in the users table: created the first time they use the chat or the
 * memory (both keep rows that belong to them), and refreshed at most every few minutes.
 */
import { Prisma } from '@prisma/client';
import { db } from '../lib/db.js';
import { isMissingSchema, warnMissingSchema } from '../lib/migrations.js';
import { databaseProblem, warnDatabase } from '../lib/dbErrors.js';

const REFRESH_MS = 5 * 60_000;
const seen = new Map(); // user id → when the row was last written

export async function ensureUser(user) {
  if (Date.now() - (seen.get(user.id) ?? 0) < REFRESH_MS) return;
  const prisma = db();
  const profile = { email: user.email || `${user.id}@users.invalid`, name: user.name ?? null, avatarUrl: user.avatarUrl ?? null };
  try {
    await prisma.user.upsert({ where: { id: user.id }, create: { id: user.id, ...profile }, update: { ...profile, lastSeenAt: new Date() } });
  } catch (error) {
    // The email belongs to an older account (deleted in Supabase, then made again): that account keeps
    // its rows, under a changed email, and the new one gets the address.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    const previous = await prisma.user.findUnique({ where: { email: profile.email } });
    if (previous && previous.id !== user.id) await prisma.user.update({ where: { id: previous.id }, data: { email: `replaced-${previous.id}-${profile.email}` } });
    await prisma.user.upsert({ where: { id: user.id }, create: { id: user.id, ...profile }, update: { ...profile, lastSeenAt: new Date() } });
  }
  seen.set(user.id, Date.now());
  if (seen.size > 10_000) seen.delete(seen.keys().next().value);
}

/** The profile the app shows: from the token, with the plan from the users table when there is one. */
export async function profileOf(user) {
  let plan = null;
  try {
    await ensureUser(user);
    plan = (await db().user.findUnique({ where: { id: user.id }, select: { plan: true } }))?.plan ?? null;
  } catch (error) {
    const problem = databaseProblem(error);
    if (isMissingSchema(error)) warnMissingSchema('Reading the profile');
    else if (problem) warnDatabase(problem, 'Reading the profile');
    else console.warn(`[auth] Reading the profile failed: ${error.message}`);
  }
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, isAdmin: user.isAdmin, plan };
}
