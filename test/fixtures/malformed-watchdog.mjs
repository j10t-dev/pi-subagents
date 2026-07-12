import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [attemptId, receiptPath] = process.argv.slice(2);
process.stderr.write("bounded-watchdog-diagnostic\n");
if (process.env.MALFORMED_WATCHDOG_CASE === "oversize") process.stdout.write("x".repeat(1024));
else if (process.env.MALFORMED_WATCHDOG_CASE === "duplicate-ready") process.stdout.write('{"type":"ready"}\n{"type":"ready"}\n');
else if (process.env.MALFORMED_WATCHDOG_CASE === "out-of-order") process.stdout.write('{"type":"launched","pgid":123}\n');
else if (process.env.MALFORMED_WATCHDOG_CASE === "unknown") process.stdout.write('{"type":"wat"}\n');
else process.stdout.write(`${JSON.stringify({ type: "ready", extra: true })}\n`);
process.stdin.once("end", finish);
process.stdin.resume();
process.on("SIGTERM", finish);
let finished = false;
function finish() {
  if (finished) return; finished = true;
  mkdirSync(dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, attemptId, pgid: null, outcome: "no_process", timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(temporary, receiptPath);
  if (process.env.MALFORMED_WATCHDOG_CLOSE_MARKER) {
    setTimeout(() => {
      writeFileSync(process.env.MALFORMED_WATCHDOG_CLOSE_MARKER, "closing\n");
      process.exit(0);
    }, 100);
  } else process.exit(0);
}
