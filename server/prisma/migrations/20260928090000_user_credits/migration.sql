-- Credits: what each person may still spend on AI (server/src/services/credits.js).
-- Existing accounts get the same 50 credits as new sign-ups.
ALTER TABLE "users" ADD COLUMN "credits" INTEGER NOT NULL DEFAULT 50;

-- A balance never goes below zero: charges are conditional updates, and the database refuses anything else.
ALTER TABLE "users" ADD CONSTRAINT "users_credits_not_negative" CHECK ("credits" >= 0);
