/**
 * An E2B sandbox: a Firecracker microVM in E2B's cloud (E2B_API_KEY), for servers that can't run
 * Docker. Nothing from outside can reach it (allowPublicTraffic: false), and its internet is
 * switched off after npm install, before any of the project's code runs.
 */
import { BASE_ENV, SandboxError, lastLine } from './errors.js';
import { BACKGROUND, aliveScript, logFileOf, logScript, pidFileOf, quote, stopScript } from './processes.js';

const HOME = '/home/user';

export const E2B_ROOT = '/home/user/app';
let sdk = null;
/** Tests hand in a stand-in for the SDK. */
export const useE2BModule = (module) => {
  sdk = module;
};

export class E2BSandbox {
  static async open(settings, lifetimeSeconds) {
    if (!settings.apiKey) throw new SandboxError('חסר מפתח E2B_API_KEY בקובץ server/.env.', 'E2B_API_KEY is not set.');
    let Sandbox;
    try {
      sdk ??= await import('e2b');
      Sandbox = sdk.Sandbox ?? sdk.default;
    } catch {
      throw new SandboxError('ספריית e2b לא מותקנת בשרת (npm install e2b -w server).', 'The e2b package is not installed.');
    }
    const options = { apiKey: settings.apiKey, timeoutMs: lifetimeSeconds * 1000, allowInternetAccess: true, allowPublicTraffic: false, metadata: { app: 'stash' } };
    let box;
    try {
      box = settings.template ? await Sandbox.create(settings.template, options) : await Sandbox.create(options);
    } catch (error) {
      throw new SandboxError(`E2B לא הצליח ליצור סביבה מבודדת: ${error.message}`, `E2B create failed: ${error.message}`);
    }
    const sandbox = new E2BSandbox(box);
    const node = await sandbox.run(`node --version && mkdir -p ${E2B_ROOT}`, { timeoutMs: 30_000, cwd: null });
    if (node.code !== 0) {
      await sandbox.close();
      throw new SandboxError('בתבנית של E2B אין Node.js: בחרו ב-SANDBOX_E2B_TEMPLATE תבנית עם Node 20 ומעלה.', `The E2B template has no Node.js: ${lastLine(node.output)}`);
    }
    return sandbox;
  }

  constructor(box) {
    this.box = box;
    this.label = 'E2B';
    this.root = E2B_ROOT;
    this.networked = true;
  }

  /** @param {Map<string, string>} files */
  async writeFiles(files) {
    const queue = [...files];
    const lane = async () => {
      while (queue.length) {
        const [path, content] = queue.shift();
        await this.box.files.write(`${E2B_ROOT}/${path}`, content);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(8, queue.length || 1) }, lane));
    } catch (error) {
      throw new SandboxError(`לא הצלחתי להעתיק את הקבצים לסביבה המבודדת: ${error.message}`, `E2B file write failed: ${error.message}`);
    }
  }

  async run(command, { cwd = '', timeoutMs = 300_000, env = {} } = {}) {
    const options = { envs: { ...BASE_ENV, ...env }, timeoutMs, ...(cwd === null ? {} : { cwd: cwd ? `${E2B_ROOT}/${cwd}` : E2B_ROOT }) };
    try {
      const result = await this.box.commands.run(command, options);
      return { code: result.exitCode ?? 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, timedOut: false };
    } catch (error) {
      // A non-zero exit is an error in the SDK (CommandExitError), with the result on it.
      const code = error.exitCode ?? error.result?.exitCode;
      if (typeof code === 'number') return { code, output: `${error.stdout ?? error.result?.stdout ?? ''}${error.stderr ?? error.result?.stderr ?? ''}`, timedOut: false };
      if (error.name === 'TimeoutError' || /time(d)? ?out/i.test(error.message)) return { code: 124, output: error.message, timedOut: true };
      throw new SandboxError(`הפקודה בסביבה המבודדת נכשלה: ${error.message}`, `E2B command failed: ${error.message}`);
    }
  }

  async online() {
    if (this.networked || typeof this.box.updateNetwork !== 'function') return;
    await this.box.updateNetwork({ allowInternetAccess: true });
    this.networked = true;
  }

  async offline() {
    if (!this.networked) return true;
    if (typeof this.box.updateNetwork !== 'function') return false;
    await this.box.updateNetwork({ allowInternetAccess: false });
    this.networked = false;
    return true;
  }

  /** Starts a long-running command in the background (a preview's dev server); `id` names it for stop(). */
  async background(id, command, { cwd = '', env = {} } = {}) {
    const script = `setsid sh -c ${quote(BACKGROUND)} stash ${quote(pidFileOf(HOME, id))} ${quote(command)} ${quote(logFileOf(HOME, id))}`;
    try {
      await this.box.commands.run(script, { background: true, envs: { ...BASE_ENV, ...env }, cwd: cwd ? `${E2B_ROOT}/${cwd}` : E2B_ROOT });
    } catch (error) {
      throw new SandboxError(`לא הצלחתי להפעיל את שרת הפיתוח בסביבה המבודדת: ${error.message}`, `E2B background command failed: ${error.message}`);
    }
  }

  async stop(id) {
    await this.run(stopScript(pidFileOf(HOME, id)), { timeoutMs: 15_000 });
  }

  async alive(id) {
    return (await this.run(aliveScript(pidFileOf(HOME, id)), { timeoutMs: 15_000 })).code === 0;
  }

  async log(id) {
    return (await this.run(logScript(logFileOf(HOME, id)), { timeoutMs: 15_000 })).output;
  }

  async removeFiles(paths) {
    if (paths.length) await this.run(`rm -f -- ${paths.map((file) => quote(`${E2B_ROOT}/${file}`)).join(' ')}`, { timeoutMs: 30_000 });
  }

  /** How the preview proxy reaches a port: E2B's private endpoint, with the access token that stays on the server. */
  target(port) {
    return { host: this.box.getHost(port), headers: this.box.trafficAccessToken ? { 'e2b-traffic-access-token': this.box.trafficAccessToken } : {} };
  }

  /** Keeps the sandbox up for `ms` more (a live preview that's still in use). */
  async extend(ms) {
    await Promise.resolve(this.box.setTimeout?.(ms)).catch(() => {});
  }

  async close() {
    await Promise.resolve(this.box.kill?.()).catch(() => {});
  }
}
