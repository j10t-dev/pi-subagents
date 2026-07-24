import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [attemptId, receiptPath, scopePath] = process.argv.slice(2);
const malformedCase = process.env.MALFORMED_WATCHDOG_CASE;
process.stderr.write("bounded-watchdog-diagnostic\n");
if (malformedCase?.startsWith("invalid-launched:") && scopePath !== undefined) {
  process.stdout.write(`${JSON.stringify({ type: "ready", descriptor: { backend: "cgroup-v2", scopePath } })}\n`);
  process.stdin.once("data", () => {
    process.stdout.write(`${JSON.stringify({ type: "authorised" })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "launched", pid: Number(malformedCase.slice("invalid-launched:".length)) })}\n`);
  });
} else if (malformedCase === "oversize") process.stdout.write("x".repeat(1024));
else if (malformedCase === "duplicate-ready") process.stdout.write('{"type":"ready"}\n{"type":"ready"}\n');
else if (malformedCase === "out-of-order") process.stdout.write('{"type":"launched","pgid":123}\n');
else if (malformedCase === "unknown") process.stdout.write('{"type":"wat"}\n');
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
