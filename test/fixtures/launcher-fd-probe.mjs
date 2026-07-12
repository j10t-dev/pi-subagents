import { readdirSync, readlinkSync } from "node:fs";

const forbidden = new Set(process.argv.slice(2));
const inheritedControlDescriptor = readdirSync("/proc/self/fd").some((fd) => {
  try { return forbidden.has(readlinkSync(`/proc/self/fd/${fd}`)); }
  catch { return false; }
});
process.stdout.write(`${JSON.stringify({ inheritedControlDescriptor, launcherTargetInEnvironment: "PI_LAUNCHER_CONTROL_TARGET" in process.env })}\n`);
