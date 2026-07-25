import { expect, test } from "bun:test";

import { RELAY_FLUSH_WINDOW_MS } from "../src/constants.ts";
import { milliseconds } from "../src/domain.ts";
import { createCoalescer, type CoalescerTimer } from "../src/coalescer.ts";

test("coalesces requests, recovers after runner failure, and disposal owns its timer", () => {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  const timer: CoalescerTimer = {
    schedule: (callback, delay) => {
      expect(delay).toBe(Number(RELAY_FLUSH_WINDOW_MS));
      const id = nextId++;
      pending.set(id, callback);
      return () => { pending.delete(id); };
    },
  };
  let calls = 0;
  const subject = createCoalescer(() => {
    calls += 1;
    if (calls === 2) throw new Error("runner failure");
  }, timer);
  const runNext = (): void => {
    const entry = pending.entries().next().value;
    if (entry === undefined) throw new Error("expected pending callback");
    const [id, callback] = entry;
    pending.delete(id);
    callback();
  };

  subject.request();
  subject.request();
  expect(pending.size).toBe(1);
  expect(calls).toBe(0);
  runNext();
  expect(calls).toBe(1);

  subject.request();
  runNext();
  expect(calls).toBe(2);
  subject.request();
  runNext();
  expect(calls).toBe(3);

  subject.request();
  expect(pending.size).toBe(1);
  subject.dispose();
  expect(pending.size).toBe(0);
  subject.request();
  expect(pending.size).toBe(0);
});

test("uses its supplied coalescing window", () => {
  let scheduledDelay: number | undefined;
  const timer: CoalescerTimer = {
    schedule: (_callback, delay) => {
      scheduledDelay = delay;
      return () => {};
    },
  };

  createCoalescer(() => {}, timer, milliseconds(50)).request();

  expect(scheduledDelay).toBe(50);
});
