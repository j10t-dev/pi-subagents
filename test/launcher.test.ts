import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const children = new Set<ChildProcess>();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    const closed = child.stdio.every((endpoint) => endpoint === null || endpoint === undefined || endpoint.destroyed)
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdin?.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    for (const endpoint of child.stdio) {
      if (endpoint !== null && endpoint !== undefined && !endpoint.destroyed) endpoint.destroy();
    }
  }));
  children.clear();
  Bun.gc(true);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("launcher membership barrier", () => {
  test("does not expose an environment-controlled filesystem write before initialisation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-launcher-environment-"));
    directories.push(directory);
    const marker = join(directory, "forbidden-marker.json");
    const child = spawn(process.execPath, [join(import.meta.dir, "../launcher.mjs")], {
      env: { ...process.env, PI_SUBAGENTS_TEST_LAUNCHER_MARKER: marker },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    await Bun.sleep(50);
    expect(existsSync(marker)).toBeFalse();
    child.stdin.end();
    await exited(child);
  });

  test("does not spawn Pi before authorisation and reports its prepared PID", async () => {
    const fixture = launchFixture(markerCommand());
    fixture.send({ type: "prepare", spec: fixture.spec });

    expect(await fixture.next()).toEqual({ type: "prepared", pid: fixture.child.pid });
    await Bun.sleep(150);
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("authorisation emits spawned then exact exit after creating Pi", async () => {
    const fixture = launchFixture(markerCommand());
    fixture.send({ type: "prepare", spec: fixture.spec });
    await fixture.next();

    fixture.send({ type: "authorize" });

    const spawned = await fixture.next();
    expect(spawned).toEqual({ type: "spawned", pid: expect.any(Number) });
    expect(await fixture.next()).toEqual({ type: "exit", code: 0, signal: null });
    expect(readFileSync(fixture.marker, "utf8")).toBe("spawned");
  });

  test.each([
    ["EOF", ""],
    ["malformed", "not-json\n"],
    ["malformed prepare", `${JSON.stringify({ type: "prepare", spec: null })}\n`],
  ])("%s before authorisation exits non-zero without spawning Pi", async (_name, input) => {
    const fixture = launchFixture(markerCommand());
    fixture.send({ type: "prepare", spec: fixture.spec });
    await fixture.next();
    if (input.length === 0) fixture.child.stdin.end();
    else fixture.child.stdin.write(input);

    const result = await exited(fixture.child);

    expect(result.code).not.toBe(0);
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("out-of-order authorisation before preparation exits non-zero without spawning Pi", async () => {
    const fixture = launchFixture(markerCommand());
    fixture.send({ type: "authorize" });

    expect((await exited(fixture.child)).code).not.toBe(0);
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("duplicate prepare before authorisation exits non-zero without spawning Pi", async () => {
    const fixture = launchFixture(markerCommand());
    fixture.send({ type: "prepare", spec: fixture.spec });
    await fixture.next();
    fixture.send({ type: "prepare", spec: fixture.spec });

    expect((await exited(fixture.child)).code).not.toBe(0);
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("EOF after authorisation terminates the direct Pi process", async () => {
    const fixture = launchFixture({
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify("PID_MARKER")}, String(process.pid)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)`],
      replaceMarker: true,
    });
    fixture.send({ type: "prepare", spec: fixture.spec });
    await fixture.next();
    fixture.send({ type: "authorize" });
    const spawned = await fixture.next() as { type: string; pid: number };
    await waitUntil(() => existsSync(fixture.marker));

    fixture.child.stdin.end();
    await exited(fixture.child);

    expect(processExists(spawned.pid)).toBeFalse();
  });

  test("Pi inherits only RPC descriptors 3/4/5 and not launcher control", async () => {
    const fixture = launchFixture({
      args: [join(import.meta.dir, "fixtures/launcher-fd-probe.mjs"), "CONTROL_TARGET"],
    });
    fixture.spec.args[1] = readlinkSync(`/proc/${fixture.child.pid}/fd/0`);
    const rpcOutput: Buffer[] = [];
    fixture.child.stdio[4]?.on("data", (chunk: Buffer) => rpcOutput.push(chunk));
    fixture.send({ type: "prepare", spec: fixture.spec });
    await fixture.next();
    fixture.send({ type: "authorize" });
    await fixture.next();
    await fixture.next();

    expect(JSON.parse(Buffer.concat(rpcOutput).toString("utf8"))).toEqual({
      inheritedControlDescriptor: false,
      launcherTargetInEnvironment: false,
    });
  });

  test("rejects a control record larger than 256 KiB", async () => {
    const fixture = launchFixture(markerCommand());
    fixture.child.stdin.write("x".repeat(256 * 1024 + 1));

    expect((await exited(fixture.child)).code).not.toBe(0);
    expect(existsSync(fixture.marker)).toBeFalse();
  });
});

function launchFixture(command: { args: string[]; replaceMarker?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), "pi-launcher-barrier-"));
  directories.push(directory);
  const marker = join(directory, "marker");
  const args = command.replaceMarker
    ? command.args.map((value) => value.replace("PID_MARKER", marker))
    : command.args;
  const child = spawn(process.execPath, [join(import.meta.dir, "../launcher.mjs")], {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  children.add(child);
  const records = jsonRecords(child);
  return {
    child,
    marker,
    spec: { command: process.execPath, args, cwd: directory, env: process.env, shell: false as const },
    send: (value: object) => child.stdin.write(`${JSON.stringify(value)}\n`),
    next: () => records.next(),
  };
}

function markerCommand(): { args: string[] } {
  return { args: ["-e", `require('node:fs').writeFileSync('marker', 'spawned')`] };
}

function jsonRecords(child: ChildProcess): { next(): Promise<Record<string, unknown>> } {
  const values: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const value = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) values.push(value); else waiter(value);
    }
  });
  return { next: () => {
    const value = values.shift();
    return value === undefined ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(value);
  } };
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await Bun.sleep(10);
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
