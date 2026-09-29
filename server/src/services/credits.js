/**
 * Credits: what each person may still spend on AI. A new account starts with 50 (the users table's
 * default). A premium answer costs CREDITS_PER_ANSWER (1); the development team costs CREDITS_PER_FILE
 * (1) for each file of its blueprint instead; the media studio costs CREDITS_PER_MEDIA (1) an item.
 * The free workspace costs nothing, but, like everything that calls a model, it needs a balance
 * above zero.
 *
 * Credits are reserved when work starts and given back when it fails, so the net effect is a charge
 * after success. Every reservation is one conditional UPDATE (credits = credits - n WHERE credits >= n):
 * two requests at once can't spend the same credits, and the database refuses a negative balance
 * besides. Admins (ADMIN_EMAILS) aren't charged, and CREDITS=off turns credits off.
 */
import { config } from '../config.js';
import { db } from '../lib/db.js';
import { HttpError } from '../lib/httpError.js';
import { ensureUser } from './users.js';

export const OUT_OF_CREDITS = 'נגמרו לך הקרדיטים. אנא שדרג את החשבון.';
export const creditsText = (count) => (count === 1 ? 'קרדיט אחד' : `${count} קרדיטים`);

/** Whether a person uses the AI without being charged: an admin, or credits turned off. */
export const unlimited = (user) => !config.credits.enabled || Boolean(user?.isAdmin);

/**
 * 402 Payment Required. With nothing left the message is the plain one; with some credits but not
 * enough, it says what `what` needs ("לפרויקט הזה (7 קבצים)") and what there is.
 */
export class CreditError extends HttpError {
  constructor({ balance, needed, what = 'לפעולה הזו' }) {
    const short = balance > 0;
    super(402, short ? `${what} צריך ${creditsText(needed)}, ויש לך ${creditsText(balance)}. אנא שדרג את החשבון.` : OUT_OF_CREDITS, short ? 'CREDITS_INSUFFICIENT' : 'CREDITS_EXHAUSTED', {
      credits: balance,
      needed,
    });
    this.name = 'CreditError';
    this.credits = balance;
    this.needed = needed;
  }
}

const balanceById = async (id) => (await db().user.findUnique({ where: { id }, select: { credits: true } }))?.credits ?? 0;

/** The person's balance, or null when their use is unlimited. */
export async function balanceOf(user) {
  if (unlimited(user)) return null;
  await ensureUser(user);
  return balanceById(user.id);
}

/** What the app shows about credits (null when they're off): the balance, the prices, where to upgrade. */
export async function creditsOf(user) {
  if (!config.credits.enabled) return null;
  const { perAnswer, perFile, perMedia, upgradeUrl } = config.credits;
  return { balance: await balanceOf(user), unlimited: unlimited(user), pricing: { answer: perAnswer, file: perFile, media: perMedia }, upgradeUrl: upgradeUrl || null };
}

/** Credits held for work in progress: resized when the price is known, given back when the work fails. */
class Hold {
  constructor(user, free) {
    this.user = user;
    this.free = free;
    this.amount = 0;
  }

  /** Makes the reservation `total` credits: takes the difference atomically, or gives the excess back. */
  async resize(total, { what } = {}) {
    if (this.free) return;
    const delta = total - this.amount;
    if (delta > 0) {
      const { count } = await db().user.updateMany({ where: { id: this.user.id, credits: { gte: delta } }, data: { credits: { decrement: delta } } });
      // What this hold already has counts as the person's: with it, they had `balance + amount`.
      if (!count) throw new CreditError({ balance: (await balanceById(this.user.id)) + this.amount, needed: total, what });
    } else if (delta < 0) {
      await db().user.update({ where: { id: this.user.id }, data: { credits: { increment: -delta } } });
    }
    this.amount = total;
  }

  /** Gives everything back: the work failed, or was stopped before it was delivered. */
  async release() {
    if (this.free || !this.amount) return;
    try {
      await this.resize(0);
    } catch (error) {
      console.warn(`[credits] Giving back ${this.amount} credits failed: ${error.message}`);
    }
  }
}

/**
 * Checks that the person has at least `minimum` credits and reserves `amount`, or throws a
 * CreditError (402). The hold is resized once the price is known, and released if the work fails.
 */
export async function reserveCredits(user, amount, { minimum = 1, what } = {}) {
  const hold = new Hold(user, unlimited(user));
  if (hold.free) return hold;
  await ensureUser(user);
  const needed = Math.max(minimum, amount);
  const balance = await balanceById(user.id);
  if (balance < needed) throw new CreditError({ balance, needed, what });
  await hold.resize(amount, { what });
  return hold;
}

/** The gate alone: at least `minimum` credits, nothing reserved. */
export const requireCredits = (user, minimum = 1) => reserveCredits(user, 0, { minimum });

/** For `npm run credits`: an account's balance by email, changed by `add` or set to `set`. Null when there's no such account. */
export async function adjustCredits(email, { add = null, set = null } = {}) {
  const prisma = db();
  const user = await prisma.user.findFirst({ where: { email: { equals: email.trim(), mode: 'insensitive' } }, select: { id: true, email: true, credits: true } });
  if (!user) return null;
  if (add === null && set === null) return { email: user.email, before: user.credits, after: user.credits };
  const target = set ?? user.credits + add;
  if (!Number.isInteger(target) || target < 0) throw new Error(`A balance can't go below zero (${user.email} has ${user.credits}).`);
  const updated = await prisma.user.update({ where: { id: user.id }, data: { credits: set !== null ? set : { increment: add } }, select: { credits: true } });
  return { email: user.email, before: user.credits, after: updated.credits };
}
