import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";

import {
  AbortError,
  Mutex,
  PersistenceSequencer,
  RunSemaphore,
  delayWithAbort,
  waitWithAbort,
} from "../src/async-primitives.ts";
import { delegationDepth, milliseconds, runCapacity } from "../src/domain.ts";
import { testBarrier } from "./support/barriers.ts";

// @ts-expect-error semaphore capacity cannot be a delegation depth.
const _semaphoreWithDepth = new RunSemaphore(delegationDepth(1));
void _semaphoreWithDepth;

describe("Mutex", () => {
  test("grants the lock in FIFO order", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const release0 = await mutex.acquire();
    const p1 = mutex.acquire().then((release) => {
      order.push(1);
      release();
    });
    const p2 = mutex.acquire().then((release) => {
      order.push(2);
      release();
    });
    const p3 = mutex.acquire().then((release) => {
      order.push(3);
      release();
    });

    order.push(0);
    release0();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  test("runExclusive serializes concurrent callers", async () => {
    const mutex = new Mutex();
    let active = 0;
    let maxActive = 0;
    const held = testBarrier("mutex-critical-section");
    const task = () => mutex.runExclusive(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
    });
    const first = mutex.runExclusive(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await held.enterAndWait();
      active -= 1;
    });
    await held.entered;
    const competitors = [task(), task(), task()];
    held.release();
    await Promise.all([first, ...competitors]);

    expect(maxActive).toBe(1);
  });
});

describe("RunSemaphore", () => {
  test("caps concurrent tryAcquire() at capacity", () => {
    const semaphore = new RunSemaphore(runCapacity(4));
    const reservations = [
      semaphore.tryAcquire(),
      semaphore.tryAcquire(),
      semaphore.tryAcquire(),
      semaphore.tryAcquire(),
    ];
    expect(reservations.every((r) => r !== undefined)).toBe(true);
    expect(semaphore.tryAcquire()).toBeUndefined();
  });

  test("release is one-time; a second release does not free an extra slot", () => {
    const semaphore = new RunSemaphore(runCapacity(1));
    const reservation = semaphore.tryAcquire();
    expect(reservation).toBeDefined();
    reservation?.release();
    reservation?.release();
    expect(semaphore.activeCount).toBe(0);

    const second = semaphore.tryAcquire();
    expect(second).toBeDefined();
    expect(semaphore.tryAcquire()).toBeUndefined();
  });

  test("releasing frees a slot for a subsequent tryAcquire()", () => {
    const semaphore = new RunSemaphore(runCapacity(1));
    const first = semaphore.tryAcquire();
    expect(semaphore.tryAcquire()).toBeUndefined();
    first?.release();
    expect(semaphore.tryAcquire()).toBeDefined();
  });

  test("rejects a non-positive-integer capacity", () => {
    expect(() => runCapacity(0)).toThrow(/invalid_input/);
    expect(() => runCapacity(-1)).toThrow(/invalid_input/);
    expect(() => runCapacity(1.5)).toThrow(/invalid_input/);
  });
});

describe("PersistenceSequencer", () => {
  test("append groups remain contiguous under concurrent callers", async () => {
    const written: string[] = [];
    const sequencer = new PersistenceSequencer<string>((event) => {
      written.push(event);
    });
    const held = testBarrier("persistence-group-a");

    const groupA = sequencer.withGroup(async (append) => {
      await append("a1");
      await held.enterAndWait();
      await append("a2");
    });
    await held.entered;
    const groupB = sequencer.withGroup(async (append) => {
      await append("b1");
      await append("b2");
    });
    held.release();

    await Promise.all([groupA, groupB]);

    const isContiguous =
      (written[0] === "a1" && written[1] === "a2" && written[2] === "b1" && written[3] === "b2") ||
      (written[0] === "b1" && written[1] === "b2" && written[2] === "a1" && written[3] === "a2");
    expect(isContiguous).toBe(true);
  });
});

describe("waitWithAbort", () => {
  test("rejects with AbortError and removes its listener when the signal aborts first", async () => {
    const controller = new AbortController();
    const never = new Promise<void>(() => {});

    const waiting = waitWithAbort(never, controller.signal);
    expect(getEventListeners(controller.signal, "abort").length).toBe(1);

    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AbortError);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  test("removes its listener when the promise settles first", async () => {
    const controller = new AbortController();
    const resolved = Promise.resolve(42);

    const result = await waitWithAbort(resolved, controller.signal);
    expect(result).toBe(42);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  test("delayWithAbort rejects immediately when the launch deadline aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delayWithAbort(milliseconds(25), controller.signal)).rejects.toBeInstanceOf(AbortError);
  });
});
