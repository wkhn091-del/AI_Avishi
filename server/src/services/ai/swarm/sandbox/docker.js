/**
 * A Docker sandbox, through the docker command line (SANDBOX_DOCKER_CLI; podman works too). One
 * container per project: not root, no capabilities, limited memory, CPUs and processes, and a
 * lifetime of its own (it removes itself after 30 minutes even if Stash stops). The network is
 * there for npm install only: it's disconnected before any of the project's code runs.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BASE_ENV, SandboxError, lastLine } from './errors.js';
import { Duplex } from 'node:stream';
import { BACKGROUND, aliveScript, logFileOf, logScript, pidFileOf, quote, stopScript } from './processes.js';
import { tarOf } from './tar.js';

export const DOCKER_ROOT = '/home/node/app';
const HOME = '/home/node';
// Inside the container, a relay from stdin/stdout to a port on its loopback: how Stash reaches a preview's dev
// server with no network between them (one `docker exec` per connection).
const RELAY = "const s=require('net').connect(+process.argv[1],'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));";
const MAX_OUTPUT = 256 * 1024;

/** Runs the CLI once: resolves to its exit code and output (stdout and stderr, the start and the end kept). */
export function dockerCli(bin, args, { input = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const chunks = [];
    let size = 0;
    const keep = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      // Keep the first 64 KB and the last 192 KB: errors are usually at one end or the other.
      while (size > MAX_OUTPUT && chunks.length > 2) size -= chunks.splice(1, 1)[0].length;
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new SandboxError(`Docker לא מותקן בשרת (הפקודה ${bin} לא נמצאה).`, `The ${bin} command was not found.`) : error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output: Buffer.concat(chunks).toString('utf8'), timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

export class DockerSandbox {
  static async open(settings, lifetimeSeconds) {
    const bin = settings.cli;
    const version = await dockerCli(bin, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 });
    if (version.code !== 0) throw new SandboxError(`השרת לא מצליח להתחבר ל-Docker: ${lastLine(version.output)}`, `Docker is not reachable: ${lastLine(version.output)}`);
    const name = `stash-sandbox-${randomUUID().slice(0, 8)}`;
    const started = await dockerCli(
      bin,
      [
        'run', '-d', '--rm', '--name', name, '--label', 'stash.sandbox=1', '--init', '--user', 'node', '--workdir', '/home/node',
        `--memory=${settings.memoryMb}m`, `--memory-swap=${settings.memoryMb}m`, `--cpus=${settings.cpus}`, '--pids-limit=512',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', `--network=${settings.network}`,
        ...(settings.runtime ? [`--runtime=${settings.runtime}`] : []),
        settings.image, 'sh', '-c', `mkdir -p ${DOCKER_ROOT} && exec sleep ${lifetimeSeconds}`,
      ],
      // The first run pulls the image, which can take a few minutes.
      { timeoutMs: 600_000 },
    );
    if (started.code !== 0) throw new SandboxError(`Docker לא הצליח להפעיל את הסביבה המבודדת: ${lastLine(started.output)}`, `docker run failed: ${lastLine(started.output)}`);
    const sandbox = new DockerSandbox(bin, name, settings);
    // The folder is made by the container's own command: wait until it's there.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await sandbox.exec(['test', '-d', DOCKER_ROOT], 10_000)).code === 0) return sandbox;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await sandbox.close();
    throw new SandboxError('Docker הפעיל את הסביבה, אבל היא לא מוכנה לעבודה.', 'The sandbox container did not become ready.');
  }

  constructor(bin, name, settings) {
    this.bin = bin;
    this.name = name;
    this.settings = settings;
    this.label = 'Docker';
    this.root = DOCKER_ROOT;
    this.networked = settings.network !== 'none';
  }

  exec(command, timeoutMs, { cwd = '', env = {}, input = null } = {}) {
    const vars = Object.entries({ ...BASE_ENV, ...env }).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    return dockerCli(this.bin, ['exec', ...(input ? ['-i'] : []), '-u', 'node', '-w', cwd ? `${DOCKER_ROOT}/${cwd}` : DOCKER_ROOT, ...vars, this.name, ...command], { input, timeoutMs });
  }

  /** @param {Map<string, string>} files */
  async writeFiles(files) {
    const result = await this.exec(['tar', '-x', '-f', '-', '-C', DOCKER_ROOT], 120_000, { input: tarOf(files) });
    if (result.code !== 0) throw new SandboxError(`לא הצלחתי להעתיק את הקבצים לסביבה המבודדת: ${lastLine(result.output)}`, `tar into the sandbox failed: ${lastLine(result.output)}`);
  }

  /** A shell command in the project (or one of its folders), stopped inside the container at the time limit. */
  async run(command, { cwd = '', timeoutMs = 300_000, env = {} } = {}) {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const result = await this.exec(['timeout', '-k', '5', String(seconds), 'sh', '-c', command], timeoutMs + 20_000, { cwd, env });
    return { code: result.code, output: result.output, timedOut: result.code === 124 };
  }

  /** Puts the network back, for an install in a later round. */
  async online() {
    if (this.networked || this.settings.network === 'none') return;
    const result = await dockerCli(this.bin, ['network', 'connect', this.settings.network, this.name], { timeoutMs: 30_000 });
    if (result.code !== 0 && !/already exists|already connected/i.test(result.output)) throw new SandboxError(`לא הצלחתי לחבר את הסביבה המבודדת לרשת: ${lastLine(result.output)}`, `network connect failed: ${lastLine(result.output)}`);
    this.networked = true;
  }

  /** Cuts the network; false when there was none to cut. */
  async offline() {
    if (!this.networked) return true;
    const result = await dockerCli(this.bin, ['network', 'disconnect', this.settings.network, this.name], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new SandboxError(`לא הצלחתי לנתק את הסביבה המבודדת מהרשת: ${lastLine(result.output)}`, `network disconnect failed: ${lastLine(result.output)}`);
    this.networked = false;
    return true;
  }

  /** Starts a long-running command in the background (a preview's dev server); `id` names it for stop(). */
  async background(id, command, { cwd = '', env = {} } = {}) {
    const vars = Object.entries({ ...BASE_ENV, ...env }).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    const workdir = cwd ? `${DOCKER_ROOT}/${cwd}` : DOCKER_ROOT;
    const result = await dockerCli(this.bin, ['exec', '-d', '-u', 'node', '-w', workdir, ...vars, this.name, 'setsid', 'sh', '-c', BACKGROUND, 'stash', pidFileOf(HOME, id), command, logFileOf(HOME, id)], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new SandboxError(`לא הצלחתי להפעיל את שרת הפיתוח בסביבה המבודדת: ${lastLine(result.output)}`, `docker exec -d failed: ${lastLine(result.output)}`);
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
    if (paths.length) await this.run(`rm -f -- ${paths.map((file) => quote(`${DOCKER_ROOT}/${file}`)).join(' ')}`, { timeoutMs: 30_000 });
  }

  /** How the preview proxy reaches a port inside the container: a relayed connection, no network. */
  target(port) {
    return { connect: () => this.connect(port) };
  }

  connect(port) {
    const child = spawn(this.bin, ['exec', '-i', '-u', 'node', this.name, 'node', '-e', RELAY, String(port)], { stdio: ['pipe', 'pipe', 'ignore'] });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const stop = () => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    };
    stream.once('close', stop);
    child.once('error', (error) => stream.destroy(error));
    // What Node's HTTP client asks of a socket.
    for (const method of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref']) stream[method] = () => stream;
    return stream;
  }

  /** A container's lifetime is set when it starts (see openSandbox): a preview ends before it does. */
  async extend() {}

  async close() {
    await dockerCli(this.bin, ['rm', '-f', this.name], { timeoutMs: 30_000 }).catch(() => {});
  }
}
