export const DEFAULT_WRITE_CONCURRENCY = 2;
export const DEFAULT_READ_CONCURRENCY = 8;

export interface SemaphoreLease {
  release(): void;
}

interface Waiter {
  resolve: (lease: SemaphoreLease) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

export class SemaphoreAcquireAbortedError extends Error {
  constructor() {
    super("semaphore acquisition was cancelled");
    this.name = "SemaphoreAcquireAbortedError";
  }
}

export class FifoSemaphore {
  readonly capacity: number;
  #inUse = 0;
  readonly #waiters: Waiter[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("semaphore capacity must be a positive integer");
    }
    this.capacity = capacity;
  }

  get in_use(): number {
    return this.#inUse;
  }

  get pending(): number {
    return this.#waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<SemaphoreLease> {
    if (signal?.aborted === true) {
      throw new SemaphoreAcquireAbortedError();
    }
    return await new Promise<SemaphoreLease>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index < 0) return;
          this.#waiters.splice(index, 1);
          reject(new SemaphoreAcquireAbortedError());
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#dispatch();
    });
  }

  #dispatch(): void {
    while (
      this.#inUse < this.capacity
      && this.#waiters.length > 0
    ) {
      const waiter = this.#waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted === true) {
        waiter.reject(new SemaphoreAcquireAbortedError());
        continue;
      }
      this.#inUse += 1;
      let released = false;
      waiter.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.#inUse -= 1;
          this.#dispatch();
        },
      });
    }
  }
}
