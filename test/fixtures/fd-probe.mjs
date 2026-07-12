import { readdirSync, readlinkSync } from "node:fs";
const target = process.env.PI_WATCHDOG_CONTROL_TARGET;
const inheritedControlDescriptor = readdirSync("/proc/self/fd").some((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`) === target; } catch { return false; } });
process.stdout.write(`${JSON.stringify({ inheritedControlDescriptor })}\n`);
