import { describe, expect, it } from "vitest";
import {
  DEFAULT_READ_CONCURRENCY,
  DEFAULT_WRITE_CONCURRENCY,
  FifoSemaphore,
  SemaphoreAcquireAbortedError,
} from "./semaphore.js";

describe("FIFO semaphore", () => {
  it("defaults machine write and read limits to two and eight", () => {
    expect(DEFAULT_WRITE_CONCURRENCY).toBe(2);
    expect(DEFAULT_READ_CONCURRENCY).toBe(8);
  });

  it("never exceeds capacity and grants queued waiters in FIFO order", async () => {
    const semaphore = new FifoSemaphore(2);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    const order: string[] = [];
    const thirdPromise = semaphore.acquire().then((lease) => {
      order.push("third");
      return lease;
    });
    const fourthPromise = semaphore.acquire().then((lease) => {
      order.push("fourth");
      return lease;
    });

    expect(semaphore.in_use).toBe(2);
    expect(semaphore.pending).toBe(2);
    second.release();
    const third = await thirdPromise;
    expect(order).toEqual(["third"]);
    expect(semaphore.in_use).toBe(2);
    expect(semaphore.pending).toBe(1);

    first.release();
    const fourth = await fourthPromise;
    expect(order).toEqual(["third", "fourth"]);
    third.release();
    fourth.release();
    expect(semaphore.in_use).toBe(0);
  });

  it("removes a cancelled waiter without disturbing FIFO order", async () => {
    const semaphore = new FifoSemaphore(1);
    const active = await semaphore.acquire();
    const cancelled = new AbortController();
    const cancelledPromise = semaphore.acquire(cancelled.signal);
    const nextPromise = semaphore.acquire();

    expect(semaphore.pending).toBe(2);
    cancelled.abort();
    await expect(cancelledPromise).rejects.toBeInstanceOf(
      SemaphoreAcquireAbortedError,
    );
    expect(semaphore.pending).toBe(1);

    active.release();
    const next = await nextPromise;
    expect(semaphore.in_use).toBe(1);
    expect(semaphore.pending).toBe(0);
    next.release();
  });

  it("rejects invalid capacities and already-aborted acquisition", async () => {
    expect(() => new FifoSemaphore(0)).toThrow(/positive integer/);
    const semaphore = new FifoSemaphore(1);
    const aborted = new AbortController();
    aborted.abort();
    await expect(semaphore.acquire(aborted.signal)).rejects.toBeInstanceOf(
      SemaphoreAcquireAbortedError,
    );
  });
});
