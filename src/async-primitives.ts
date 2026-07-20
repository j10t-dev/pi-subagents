/** A FIFO mutex: callers acquire the lock in the order they requested it. */
export class Mutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => resolve(() => this.release()));
    });
  }

  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.locked = false;
  }
}

/** A one-time reservation returned by `RunSemaphore.tryAcquire()`. Releasing twice is a no-op. */
export interface RunReservation {
  release(): void;
}

/** A bounded, non-blocking counting semaphore used to cap concurrently active runs. */
export class RunSemaphore {
  private active = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`invalid_input: semaphore capacity must be a positive integer: ${capacity}`);
    }
  }

  acquireInherited(): RunReservation {
    this.active += 1;
    return this.reservation();
  }

  tryAcquire(): RunReservation | undefined {
    if (this.active >= this.capacity) {
      return undefined;
    }
    this.active += 1;
    return this.reservation();
  }

  private reservation(): RunReservation {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }

  get activeCount(): number {
    return this.active;
  }
}

/**
 * Serializes appends (and multi-append transactions) through a single-writer mutex so a
 * reserved append group can never be interleaved by another caller's append or group.
 */
export class PersistenceSequencer<TEvent, TResult = void> {
  private readonly mutex = new Mutex();

  constructor(private readonly write: (event: TEvent) => TResult | Promise<TResult>) {}

  append(event: TEvent): Promise<TResult> {
    return this.mutex.runExclusive(() => this.write(event));
  }

  /**
   * Reserves the sequencer for the duration of `fn`, which may call the provided `append`
   * repeatedly. No other append or group can interleave until `fn` settles.
   */
  withGroup<T>(fn: (append: (event: TEvent) => Promise<TResult>) => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(() =>
      fn((event) => Promise.resolve(this.write(event))),
    );
  }
}

export class AbortError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** Resolves after `milliseconds`, or rejects with `AbortError` if `signal` aborts first. */
export function delayWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); });
  return waitWithAbort(delay, signal).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new AbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new AbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error as Error);
      },
    );
  });
}
