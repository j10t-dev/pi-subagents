import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [file, depth = "0"] = process.argv.slice(2);
const stat = (pid) => Number(requireStat(pid).split(" ")[4]);
function requireStat(pid) { return (awaitRead(`/proc/${pid}/stat`)); }
function awaitRead(path) { return process.getBuiltinModule("node:fs").readFileSync(path, "utf8"); }
appendFileSync(file, JSON.stringify({ pid: process.pid, pgid: stat(process.pid), depth: Number(depth) }) + "\n");
if (Number(depth) < 2) spawn(process.execPath, [new URL(import.meta.url).pathname, file, String(Number(depth) + 1)], { stdio: "ignore" });
process.on("SIGTERM", process.env.PROCESS_TREE_IGNORE_TERM === "1" ? () => {} : () => process.exit(0));
setInterval(() => {}, 1000);
