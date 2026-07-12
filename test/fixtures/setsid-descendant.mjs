import { spawn } from "node:child_process";

const [pidPath, setsidPath] = process.argv.slice(2);
if (pidPath === undefined || setsidPath === undefined || !setsidPath.startsWith("/")) {
  throw new Error("setsid descendant fixture requires an absolute setsid executable and PID record path");
}

const detachedSource = `
  const { spawn } = require("node:child_process");
  const path = process.argv[1];
  const launcher = Number(process.argv[2]);
  const grandchild = \`
    const { readFileSync, renameSync, writeFileSync } = require("node:fs");
    const path = process.argv[1];
    const launcher = Number(process.argv[2]);
    const child = Number(process.argv[3]);
    const membership = (pid) => readFileSync("/proc/" + pid + "/cgroup", "utf8");
    const record = { launcher, child, detached: process.pid, cgroups: {
      launcher: membership(launcher), child: membership(child), detached: membership(process.pid),
    }};
    writeFileSync(path + ".tmp", JSON.stringify(record));
    renameSync(path + ".tmp", path);
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
  \`;
  const descendant = spawn(process.execPath, ["-e", grandchild, path, String(launcher), String(process.pid)], {
    detached: false,
    stdio: "ignore",
  });
  if (descendant.pid === undefined) throw new Error("setsid descendant fixture could not start grandchild");
  setInterval(() => {}, 1_000);
`;

const child = spawn(setsidPath, [process.execPath, "-e", detachedSource, pidPath, String(process.ppid)], {
  detached: false,
  stdio: "ignore",
});
if (child.pid === undefined) throw new Error("setsid descendant fixture could not start");
