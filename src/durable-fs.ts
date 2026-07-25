import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export interface DurableFileSystem {
  exists(path: string): boolean;
  mkdir(path: string, mode: number): void;
  open(path: string, flags: string | number, mode?: number): number;
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  write(fd: number, data: string | Uint8Array): void;
  sync(fd: number): void;
  close(fd: number): void;
  rename(source: string, destination: string): void;
  unlink(path: string): void;
  readFile(path: string): Buffer;
  realpath(path: string): string;
}

export interface CommittedPublication {
  destination: string;
  data?: string | Uint8Array;
  promotionSource?: string;
}

export const systemDurableFileSystem: DurableFileSystem = {
  exists: existsSync,
  mkdir: (path, mode) => mkdirSync(path, { mode }),
  open: openSync,
  lstat: lstatSync,
  write: (fd, data) => writeFileSync(fd, data),
  sync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  unlink: unlinkSync,
  readFile: readFileSync,
  realpath: realpathSync,
};

export function ensureDurableDirectorySync(path: string, fs = systemDurableFileSystem): void {
  const missing: string[] = [];
  const target = resolve(path);
  let cursor = target;
  while (!fs.exists(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`output_error: no existing ancestor for ${path}`);
    cursor = parent;
  }
  const ancestorParent = dirname(cursor);
  if (ancestorParent !== cursor) {
    // The nearest existing entry may be from an earlier mkdir whose parent sync failed.
    syncDirectory(ancestorParent, fs);
  }
  for (const directory of missing.reverse()) {
    fs.mkdir(directory, 0o700);
    syncDirectory(dirname(directory), fs);
  }
}

export function publishCommittedSync(spec: CommittedPublication, fs = systemDurableFileSystem): void {
  const rewrite = spec.data !== undefined;
  if (rewrite === (spec.promotionSource !== undefined)) {
    throw new Error("invalid_input: committed publication requires exactly one of data and promotionSource");
  }

  ensureDurableDirectorySync(dirname(spec.destination), fs);
  let temporary: string | undefined;
  try {
    if (rewrite) {
      temporary = join(dirname(spec.destination), `.tmp-${randomUUID()}`);
      writeSyncedFile(temporary, spec.data!, fs);
      fs.rename(temporary, spec.destination);
      temporary = undefined;
    } else {
      syncFile(spec.promotionSource!, fs);
      fs.rename(spec.promotionSource!, spec.destination);
    }
    syncDirectory(dirname(spec.destination), fs);
  } catch (error) {
    if (temporary !== undefined) {
      try {
        if (fs.exists(temporary)) fs.unlink(temporary);
      } catch { /* cleanup probing and unlink must retain the publication failure */ }
    }
    throw error;
  }
}

export function syncPublishedFileSync(destination: string, fs = systemDurableFileSystem): void {
  syncFile(destination, fs);
  syncDirectory(dirname(destination), fs);
}

function writeSyncedFile(path: string, data: string | Uint8Array, fs: DurableFileSystem): void {
  let fd: number | undefined;
  let primary: unknown;
  try {
    fd = fs.open(path, "wx", 0o600);
    fs.write(fd, data);
    fs.sync(fd);
  } catch (error) {
    primary = error;
  } finally {
    if (fd !== undefined) {
      try { fs.close(fd); } catch (error) { primary ??= error; }
    }
  }
  if (primary !== undefined) throw primary;
}

function syncFile(path: string, fs: DurableFileSystem): void {
  syncDescriptor(path, fs);
}

function syncDirectory(path: string, fs: DurableFileSystem): void {
  syncDescriptor(path, fs);
}

function syncDescriptor(path: string, fs: DurableFileSystem): void {
  let fd: number | undefined;
  let primary: unknown;
  try {
    fd = fs.open(path, "r");
    fs.sync(fd);
  } catch (error) {
    primary = error;
  } finally {
    if (fd !== undefined) {
      try { fs.close(fd); } catch (error) { primary ??= error; }
    }
  }
  if (primary !== undefined) throw primary;
}
