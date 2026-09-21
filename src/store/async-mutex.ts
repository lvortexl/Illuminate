/**
 * A minimal in-process mutex: queues async work so overlapping callers of
 * runExclusive() execute strictly one at a time, in call order. This is
 * what makes read-modify-write against a single JSON state file safe under
 * concurrent request handlers (fan-out answers, concurrent pollers) --
 * later phases' actual read-modify-write call sites build on this, they do
 * not reinvent it. Zero dependencies.
 */
export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
