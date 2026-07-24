import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type {
  AbsolutePath,
  ContainmentReceiptPath,
  DiagnosticsPath,
  OutputPath,
  SessionPath,
} from "./domain.ts";

/** Brands an already-resolved absolute path. Resolves `value` against `cwd` if relative. */
export function absolutePath(value: string, cwd = process.cwd()): AbsolutePath {
  if (value.includes("\0") || cwd.includes("\0")) {
    throw new Error("invalid_input: absolute path must not contain NUL");
  }
  const resolved = resolve(cwd, value);
  return resolved as AbsolutePath;
}

/**
 * True when `child` is lexically equal to, or nested inside, `parent`. Compares resolved path
 * *components* via `node:path.relative`, never raw string prefixes, so `/trusted/project2` is
 * never considered contained within `/trusted/project`.
 */
export function isContainedPath(parent: string, child: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  const rel = relative(parentResolved, childResolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolves `child` beneath `parent` lexically, throwing `invalid_input` if it escapes. */
export function containedPath(parent: string, child: string): AbsolutePath {
  const parentResolved = resolve(parent);
  const childResolved = resolve(parent, child);
  if (!isContainedPath(parentResolved, childResolved)) {
    throw new Error(`invalid_input: path escapes its parent: ${child}`);
  }
  return childResolved as AbsolutePath;
}

/**
 * Resolves `child` beneath `parent` using real (symlink-resolved) paths, throwing
 * `invalid_input` if the real path escapes the real parent. Both paths must already exist.
 */
export function realContainedPath(parent: string, child: string): AbsolutePath {
  const parentReal = realpathSync(parent);
  const childReal = realpathSync(resolve(parent, child));
  if (!isContainedPath(parentReal, childReal)) {
    throw new Error(`invalid_input: path escapes its parent via symlink: ${child}`);
  }
  return childReal as AbsolutePath;
}

/** Validates persisted state lexically, then resolves symlinks whenever the target exists. */
export function restoredStatePath(stateRoot: AbsolutePath, candidate: string): AbsolutePath {
  const lexical = containedPath(stateRoot, candidate);
  if (!existsSync(lexical)) return lexical;
  const real = realContainedPath(stateRoot, lexical);
  return real;
}

/** Restores a session path only after proving containment beneath the persisted state root. */
export function restoredSessionPath(root: AbsolutePath, candidate: string): SessionPath {
  return restoredStatePath(root, candidate) as SessionPath;
}

/** Restores an output candidate only after proving containment beneath the persisted state root. */
export function restoredOutputPath(root: AbsolutePath, candidate: string): OutputPath {
  return restoredStatePath(root, candidate) as OutputPath;
}

/** Restores a diagnostics path only after proving containment beneath the persisted state root. */
export function restoredDiagnosticsPath(root: AbsolutePath, candidate: string): DiagnosticsPath {
  return restoredStatePath(root, candidate) as DiagnosticsPath;
}

/** Restores a receipt path only after proving containment beneath the persisted state root. */
export function restoredContainmentReceiptPath(
  root: AbsolutePath,
  candidate: string,
): ContainmentReceiptPath {
  return restoredStatePath(root, candidate) as ContainmentReceiptPath;
}

export function sessionPath(parent: string, child: string): SessionPath {
  return containedPath(parent, child) as SessionPath;
}

export function diagnosticsPath(parent: string, child: string): DiagnosticsPath {
  return containedPath(parent, child) as DiagnosticsPath;
}

export function outputPath(parent: string, child: string): OutputPath {
  return containedPath(parent, child) as OutputPath;
}

export function containmentReceiptPath(parent: string, child: string): ContainmentReceiptPath {
  return containedPath(parent, child) as ContainmentReceiptPath;
}

/** Writes `data` to `path` with owner-only permissions, creating owner-only parent directories. */
export function writeOwnerOnlyFile(path: AbsolutePath, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
}
