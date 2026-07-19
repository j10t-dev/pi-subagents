import { deferred } from "./async.ts";

export interface TestBarrier {
  readonly name: string;
  readonly entered: Promise<void>;
  enterAndWait(): Promise<void>;
  release(): void;
}

export function testBarrier(name: string): TestBarrier {
  const entered = deferred<void>();
  const released = deferred<void>();
  let enteredOnce = false;
  let releasedOnce = false;
  return {
    name,
    entered: entered.promise,
    async enterAndWait() {
      if (!enteredOnce) {
        enteredOnce = true;
        entered.resolve();
      }
      await released.promise;
    },
    release() {
      if (releasedOnce) return;
      releasedOnce = true;
      released.resolve();
    },
  };
}
