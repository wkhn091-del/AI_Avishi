/**
 * Runs async tasks with a concurrency limit, in the order they were pushed.
 * Used to upload ZIPs one at a time (each one is analysed server-side) and
 * regular files three at a time.
 *
 * @param {number} concurrency
 * @returns {{ push: <T>(task: () => Promise<T>) => Promise<T> }}
 */
export function createTaskQueue(concurrency = 1) {
  const waiting = [];
  let active = 0;

  const next = () => {
    if (active >= concurrency || waiting.length === 0) return;
    const { task, resolve, reject } = waiting.shift();
    active += 1;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };

  return {
    push(task) {
      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject });
        next();
      });
    },
  };
}
