/** Element by id, or a clear error naming the missing id. */
export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

/**
 * Runs async jobs one at a time, in call order. Each caller still gets its own
 * result or error; a failed job does not block the ones queued after it.
 */
export function createSerialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>) => {
    const run = tail.then(job);
    tail = run.catch(() => undefined); // the error is delivered through `run`; the queue itself moves on
    return run;
  };
}
