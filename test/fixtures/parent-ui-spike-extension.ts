/**
 * Real-Pi UI-forwarding spike extension (subtask 2.3).
 *
 * Two modes, selected by `PI_UI_SPIKE_MODE` (default "direct"):
 *
 * - "direct": starts a fake child-RPC event source (a plain timer standing in for an
 *   asynchronous child event arriving mid-turn) from `agent_start`, waits until the slow
 *   provider is mid-stream, then invokes the captured real `ctx.ui.confirm()` directly from
 *   that asynchronous callback.
 * - "broker": queues the same fake child request at the same mid-stream moment, but only
 *   invokes `ctx.ui.confirm()` once the parent's `agent_settled` event fires, modelling a
 *   drain-the-FIFO-on-settle architecture.
 *
 * Events are prefixed with a process-local sequence number so the runner can assert ordering.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const RESULT_FILE = process.env.PI_UI_SPIKE_RESULT_FILE;
const MODE = process.env.PI_UI_SPIKE_MODE === "broker" ? "broker" : "direct";
const MID_STREAM_DELAY_MS = Number(process.env.PI_UI_SPIKE_MID_STREAM_DELAY_MS ?? "800");
const MAX_REASON_BYTES = 500;

function record(line: string): void {
  if (RESULT_FILE === undefined) {
    return;
  }
  appendFileSync(RESULT_FILE, `${++sequence} ${line}\n`);
}

let sequence = 0;

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_REASON_BYTES ? `${message.slice(0, MAX_REASON_BYTES)}...` : message;
}

async function openDialog(ctx: ExtensionContext): Promise<void> {
  record("dialog_opened");
  try {
    const confirmed = await ctx.ui.confirm(
      "pi-subagents UI spike",
      "A fake child agent needs your confirmation to continue.",
    );
    record(`dialog_resolved confirmed=${confirmed}`);
  } catch (error) {
    record(`callback_error ${boundedReason(error)}`);
  }
}

const factory: ExtensionFactory = (pi) => {
  let queuedForSettle: (() => void) | undefined;

  pi.on("agent_start", (_event, ctx) => {
    setTimeout(() => {
      record("callback_started");
      if (MODE === "direct") {
        void openDialog(ctx);
        return;
      }
      queuedForSettle = () => void openDialog(ctx);
    }, MID_STREAM_DELAY_MS);
  });

  if (MODE === "broker") {
    pi.on("agent_settled", () => {
      queuedForSettle?.();
      queuedForSettle = undefined;
    });
  }

  pi.on("agent_settled", () => {
    record("agent_settled");
  });
};

export default factory;
