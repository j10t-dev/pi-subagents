import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { temporaryStateRoot } from "./support/temp-state.ts";

import {
  ensureDurableDirectorySync,
  publishCommittedSync,
  type DurableFileSystem,
} from "../src/durable-fs.ts";

const roots: ReturnType<typeof temporaryStateRoot>[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) root.cleanup();
});

function root(): string {
  const state = temporaryStateRoot("durable-fs-test-");
  roots.push(state);
  return state.path;
}

function retrySyncAdapter(failedParent: string, trace: string[]): DurableFileSystem {
  const descriptorPaths = new Map<number, string>();
  let failed = false;
  return {
    exists: existsSync,
    mkdir(path, mode) { trace.push(`mkdir:${path}`); mkdirSync(path, { mode }); },
    open(path, flags, mode) {
      trace.push(`open:${path}`);
      const fd = openSync(path, flags, mode);
      descriptorPaths.set(fd, path);
      return fd;
    },
    write(fd, data) { writeFileSync(fd, data); },
    sync(fd) {
      const path = descriptorPaths.get(fd)!;
      trace.push(`sync:${path}`);
      if (!failed && path === failedParent) {
        failed = true;
        throw new Error(`injected parent sync failure:${path}`);
      }
      fsyncSync(fd);
    },
    close(fd) {
      const path = descriptorPaths.get(fd)!;
      trace.push(`close:${path}`);
      descriptorPaths.delete(fd);
      closeSync(fd);
    },
    rename: renameSync,
    unlink: unlinkSync,
    readFile: readFileSync,
  };
}

function adapter(trace: string[] = [], fail?: string, cleanupFail = false): DurableFileSystem {
  let destinationDirectory = "";
  const operation = (name: string) => {
    trace.push(name);
    if (name === fail) throw new Error(`primary:${name}`);
  };
  return {
    exists: existsSync,
    mkdir(path, mode) { operation(`mkdir:${path}`); mkdirSync(path, { mode }); },
    open(path, flags, mode) {
      const isDirectory = existsSync(path) && statSync(path).isDirectory();
      if (isDirectory) destinationDirectory = path;
      operation(isDirectory ? "directory:open" : flags === "wx" ? "temporary:open" : "file:open");
      return openSync(path, flags, mode);
    },
    write(fd, data) { operation("write"); writeFileSync(fd, data); },
    sync(fd) {
      const stats = statSync(`/proc/self/fd/${fd}`);
      operation(stats.isDirectory() ? "directory:sync" : "file:sync");
      fsyncSync(fd);
    },
    close(fd) { operation("close"); closeSync(fd); },
    rename(source, destination) { operation("rename"); renameSync(source, destination); },
    unlink(path) {
      trace.push("unlink");
      if (cleanupFail) throw new Error("cleanup failed");
      unlinkSync(path);
    },
    readFile: readFileSync,
  };
}

describe("durable filesystem publication", () => {
  test("syncs a rewrite before rename and syncs its directory afterwards", () => {
    const base = root();
    const directory = join(base, "nested");
    mkdirSync(directory, { mode: 0o700 });
    const destination = join(directory, "result.committed");
    const trace: string[] = [];
    publishCommittedSync({ destination, data: "authoritative" }, adapter(trace));

    expect(trace.indexOf("file:sync")).toBeLessThan(trace.indexOf("rename"));
    expect(trace.indexOf("rename")).toBeLessThan(trace.lastIndexOf("directory:sync"));
    expect(readFileSync(destination, "utf8")).toBe("authoritative");
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(destination)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(destination)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  test("creates a nested chain one component at a time and durably publishes each parent entry", () => {
    const base = root();
    const destination = join(base, "one", "two", "three");
    const trace: string[] = [];
    ensureDurableDirectorySync(destination, adapter(trace));

    const mkdirs = trace.map((event, index) => ({ event, index })).filter(({ event }) => event.startsWith("mkdir:"));
    expect(mkdirs).toHaveLength(3);
    for (let index = 0; index < mkdirs.length; index++) {
      const current = mkdirs[index]!;
      const nextIndex = mkdirs[index + 1]?.index ?? trace.length;
      expect(trace.slice(current.index + 1, nextIndex)).toEqual(["directory:open", "directory:sync", "close"]);
    }
  });

  test.each([
    ["first component", ["a", "b"], 0],
    ["middle component", ["a", "b", "c"], 1],
  ] as const)("retry re-proves a failed %s parent sync before creating remaining components", (_case, components, failureIndex) => {
    const base = root();
    const target = join(base, ...components);
    const failedParent = failureIndex === 0 ? base : join(base, ...components.slice(0, failureIndex));
    const failedDirectory = join(base, ...components.slice(0, failureIndex + 1));
    const nextDirectory = join(base, ...components.slice(0, failureIndex + 2));
    const destination = join(target, "result");
    const trace: string[] = [];
    const fs = retrySyncAdapter(failedParent, trace);

    expect(() => publishCommittedSync({ destination, data: "authoritative" }, fs)).toThrow("injected parent sync failure");
    expect(existsSync(failedDirectory)).toBeTrue();

    trace.length = 0;
    publishCommittedSync({ destination, data: "authoritative" }, fs);

    expect(trace.slice(0, 3)).toEqual([
      `open:${failedParent}`,
      `sync:${failedParent}`,
      `close:${failedParent}`,
    ]);
    expect(trace.indexOf(`sync:${failedParent}`)).toBeLessThan(trace.indexOf(`mkdir:${nextDirectory}`));
    expect(readFileSync(destination, "utf8")).toBe("authoritative");
  });

  test("an existing target re-proves its entry without creating a component", () => {
    const target = root();
    const trace: string[] = [];

    ensureDurableDirectorySync(target, adapter(trace));

    expect(trace).toEqual(["directory:open", "directory:sync", "close"]);
    expect(trace.some((event) => event.startsWith("mkdir:"))).toBeFalse();
  });

  test("the filesystem root has no parent entry to re-prove", () => {
    const trace: string[] = [];

    ensureDurableDirectorySync("/", adapter(trace));

    expect(trace).toEqual([]);
  });

  test("promotion syncs the source, renames it, and syncs the destination directory", () => {
    const base = root();
    const source = join(base, "candidate");
    const destination = join(base, "result");
    writeFileSync(source, "candidate", { mode: 0o600 });
    const trace: string[] = [];
    publishCommittedSync({ destination, promotionSource: source }, adapter(trace));
    expect(trace.indexOf("file:sync")).toBeLessThan(trace.indexOf("rename"));
    expect(trace.indexOf("rename")).toBeLessThan(trace.lastIndexOf("directory:sync"));
    expect(readFileSync(destination, "utf8")).toBe("candidate");
  });

  test.each(["temporary:open", "write", "file:sync", "rename"])(
    "a pre-publication %s failure preserves the destination and removes rewrite temporaries",
    (failure) => {
      const base = root();
      const destination = join(base, "result");
      writeFileSync(destination, "previous", { mode: 0o600 });
      expect(() => publishCommittedSync({ destination, data: "next" }, adapter([], failure))).toThrow(`primary:${failure}`);
      expect(readFileSync(destination, "utf8")).toBe("previous");
      expect(readdirSync(base).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    },
  );

  test.each(["directory:open", "directory:sync"])("reports post-rename %s failure", (failure) => {
    const base = root();
    const destination = join(base, "result");
    expect(() => publishCommittedSync({ destination, data: "next" }, adapter([], failure))).toThrow(`primary:${failure}`);
  });

  test("cleanup and close failures never replace the primary publication error", () => {
    const base = root();
    const destination = join(base, "result");
    const fs = adapter([], "write", true);
    const close = fs.close;
    fs.close = (fd) => {
      const isDirectory = statSync(`/proc/self/fd/${fd}`).isDirectory();
      try { close(fd); } finally { if (!isDirectory) throw new Error("close failed"); }
    };
    expect(() => publishCommittedSync({ destination, data: "next" }, fs)).toThrow("primary:write");
  });

  test("a throwing cleanup existence probe never replaces the primary publication error", () => {
    const base = root();
    const destination = join(base, "result");
    const fs = adapter([], "write");
    const exists = fs.exists;
    fs.exists = (path) => {
      if (path.includes(".tmp-")) throw new Error("cleanup probe failed");
      return exists(path);
    };

    expect(() => publishCommittedSync({ destination, data: "next" }, fs)).toThrow("primary:write");
  });

  test("requires exactly one publication source", () => {
    const destination = join(root(), "result");
    expect(() => publishCommittedSync({ destination })).toThrow(/exactly one/);
    expect(() => publishCommittedSync({ destination, data: "x", promotionSource: "y" })).toThrow(/exactly one/);
  });
});
