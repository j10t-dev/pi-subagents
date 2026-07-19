import { describe, expect, test } from "bun:test";

import { testBarrier } from "./support/barriers.ts";

describe("test support barriers", () => {
  test("exposes entry before release", async () => {
    const gate = testBarrier("barrier-self-test");
    let finished = false;
    const blocked = gate.enterAndWait().then(() => { finished = true; });
    await gate.entered;
    expect(finished).toBe(false);
    gate.release();
    await blocked;
    expect(finished).toBe(true);
  });
});
