/** A sandbox that can't be used (not installed, no key, busy): the reason is shown to the reader, in Hebrew. */
export class SandboxError extends Error {
  constructor(message, log = message) {
    super(message);
    this.name = 'SandboxError';
    this.log = log;
  }
}
// Every command: no colors, no prompts, CI behavior (test runners run once instead of watching).
export const BASE_ENV = Object.freeze({ CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' });
export const lastLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? '';
