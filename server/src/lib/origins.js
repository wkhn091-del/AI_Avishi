/**
 * The browser app's origins when it's served from somewhere else (CORS_ORIGINS; the app on Vercel and this API on
 * Render, say): exact origins, or with * standing for part of one host label, for preview deployments
 * (https://stash-*-me.vercel.app). config.js refuses a * that is a whole label (https://*.vercel.app would be every
 * site anyone deploys there).
 */
import { config } from '../config.js';

const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = config.corsOrigins.map((origin) => new RegExp(`^${origin.split('*').map(escape).join('[a-z0-9-]*')}$`));

/** Whether a request's Origin header is one of CORS_ORIGINS. */
export const trustedOrigin = (origin) => Boolean(origin) && PATTERNS.some((pattern) => pattern.test(String(origin).toLowerCase()));
