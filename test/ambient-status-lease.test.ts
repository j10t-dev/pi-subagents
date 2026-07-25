import { afterEach, describe, expect, test } from "bun:test";

import { acquireStatusLease, onAmbientStatus, setAmbientStatus } from "../src/ambient-status-lease.ts";

function recorder() {
  const seen: Array<string | undefined> = [];
  const unsubscribe = onAmbientStatus((text) => { seen.push(text); });
  return { seen, unsubscribe };
}

afterEach(() => { setAmbientStatus(undefined); });

describe("ambient status lease", () => {
  test("with no holder, the latest status reaches every listener", () => {
    const r = recorder();
    setAmbientStatus("2 running");
    setAmbientStatus("1 running");
    expect(r.seen).toEqual([undefined, "2 running", "1 running"]);
    r.unsubscribe();
  });

  test("a held lease suppresses the status and release restores the latest", () => {
    setAmbientStatus("2 running");
    const r = recorder();
    const lease = acquireStatusLease();
    setAmbientStatus("3 running");
    expect(r.seen).toEqual(["2 running", undefined]);
    lease.release();
    expect(r.seen.at(-1)).toBe("3 running");
    r.unsubscribe();
  });

  test("acquisition before any status publishes converges on the first publication", () => {
    const lease = acquireStatusLease();
    const r = recorder();
    setAmbientStatus("2 running");
    expect(r.seen).toEqual([undefined]);
    lease.release();
    expect(r.seen.at(-1)).toBe("2 running");
    r.unsubscribe();
  });

  test("acquisition and release are idempotent in either direction", () => {
    setAmbientStatus("2 running");
    const r = recorder();
    const first = acquireStatusLease();
    const second = acquireStatusLease();
    first.release();
    first.release();
    expect(r.seen.at(-1)).toBe(undefined);   // still held by `second`
    second.release();
    expect(r.seen.at(-1)).toBe("2 running");
    r.unsubscribe();
  });

  test("a throwing listener cannot break the others", () => {
    const seen: Array<string | undefined> = [];
    const bad = onAmbientStatus(() => { throw new Error("boom"); });
    const good = onAmbientStatus((text) => { seen.push(text); });
    expect(() => setAmbientStatus("2 running")).not.toThrow();
    expect(seen.at(-1)).toBe("2 running");
    bad(); good();
  });
});
