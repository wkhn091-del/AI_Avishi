/**
 * Long-running processes in a sandbox (a live preview's dev server and the servers beside it), the same way in
 * Docker and in E2B: each in a process group of its own, so stopping it stops everything it started, with
 * its PID and its log in a folder of the sandbox's home.
 * BACKGROUND runs as `setsid sh -c BACKGROUND stash <pid file> <command> <log file>`.
 */
export const BACKGROUND = 'mkdir -p "$(dirname "$1")"; echo $$ > "$1"; exec sh -c "$2" > "$3" 2>&1';
export const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
export const pidFileOf = (home, id) => `${home}/.stash/${id}.pid`;
export const logFileOf = (home, id) => `${home}/.stash/${id}.log`;
/** Stops the group, waits up to three seconds for it to go (so its port is free again), then kills what's left. */
export const stopScript = (pid) =>
  `pid=$(cat ${quote(pid)} 2>/dev/null) || exit 0; kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done; kill -KILL -"$pid" 2>/dev/null; rm -f ${quote(pid)}; exit 0`;
export const aliveScript = (pid) => `kill -0 "$(cat ${quote(pid)} 2>/dev/null)" 2>/dev/null`;
export const logScript = (log) => `tail -n 40 ${quote(log)} 2>/dev/null; exit 0`;
