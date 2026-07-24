import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import type {
  AbsolutePath,
  ContainmentReceiptPath,
  DiagnosticsPath,
  OutputPath,
  SessionPath,
} from "../src/domain.ts";
import {
  absolutePath,
  containedPath,
  isContainedPath,
  realContainedPath,
  restoredContainmentReceiptPath,
  restoredDiagnosticsPath,
  restoredOutputPath,
  restoredSessionPath,
  restoredStatePath,
  writeOwnerOnlyFile,
} from "../src/paths.ts";
import { temporaryStateRoot } from "./support/temp-state.ts";

describe("paths", () => {
  test("a sibling directory with a shared prefix is never contained", () => {
    expect(isContainedPath("/trusted/project", "/trusted/project2")).toBe(false);
    expect(isContainedPath("/trusted/project", "/trusted/project2/file.txt")).toBe(false);
  });

  test("a nested path is contained", () => {
    expect(isContainedPath("/trusted/project", "/trusted/project/sub/file.txt")).toBe(true);
    expect(isContainedPath("/trusted/project", "/trusted/project")).toBe(true);
  });

  test("containedPath throws on escape via ..", () => {
    expect(() => containedPath("/trusted/project", "../escape")).toThrow(/invalid_input/);
  });

  test("containedPath accepts a nested relative child", () => {
    const result = containedPath("/trusted/project", "sub/file.txt");
    expect(result as string).toBe("/trusted/project/sub/file.txt");
  });

  test("realContainedPath rejects a symlink that escapes the parent", () => {
    const state = temporaryStateRoot("pi-subagents-paths-");
    try {
      const root: string = state.path;
      const parent = join(root, "parent");
      const outside = join(root, "outside");
      const escapeLink = join(parent, "escape");

      mkdirSync(parent, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, escapeLink);

      expect(() => realContainedPath(parent, "escape")).toThrow(/invalid_input/);
    } finally {
      state.cleanup();
    }
  });

  test("realContainedPath accepts a symlink that stays within the parent", () => {
    const state = temporaryStateRoot("pi-subagents-paths-");
    try {
      const root: string = state.path;
      const parent = join(root, "parent");
      const target = join(parent, "real-target");
      const insideLink = join(parent, "inside-link");

      mkdirSync(target, { recursive: true });
      symlinkSync(target, insideLink);

      const result = realContainedPath(parent, "inside-link");
      expect(result as string).toBe(realpathSync(target));
    } finally {
      state.cleanup();
    }
  });

  test("restoredStatePath rejects an existing symlink escape after lexical containment", () => {
    const stateRoot = temporaryStateRoot("pi-subagents-restored-paths-");
    try {
      const root: string = stateRoot.path;
      const state = absolutePath(join(root, "state")); const outside = join(root, "outside");
      mkdirSync(state); mkdirSync(outside);
      const escape = join(state, "escape"); symlinkSync(outside, escape);
      expect(() => restoredStatePath(state, escape)).toThrow(/invalid_input/);
    } finally {
      stateRoot.cleanup();
    }
  });

  test("restored path specialisations return their expected contained types", () => {
    const stateRoot = temporaryStateRoot("pi-subagents-restored-specialisations-");
    try {
      const root = stateRoot.path;
      const session: SessionPath = restoredSessionPath(root, join(root, "sessions", "a.jsonl"));
      const output: OutputPath = restoredOutputPath(root, join(root, "output", "a.committed"));
      const diagnostics: DiagnosticsPath = restoredDiagnosticsPath(root, join(root, "diagnostics", "a.log"));
      const receipt: ContainmentReceiptPath = restoredContainmentReceiptPath(root, join(root, "receipts", "a.json"));
      expect(String(session)).toBe(join(root, "sessions", "a.jsonl"));
      expect(String(output)).toBe(join(root, "output", "a.committed"));
      expect(String(diagnostics)).toBe(join(root, "diagnostics", "a.log"));
      expect(String(receipt)).toBe(join(root, "receipts", "a.json"));
    } finally {
      stateRoot.cleanup();
    }
  });

  test.each([
    ["session", restoredSessionPath],
    ["output", restoredOutputPath],
    ["diagnostics", restoredDiagnosticsPath],
    ["receipt", restoredContainmentReceiptPath],
  ] as const)("restored %s paths reject lexical escapes", (_name, restore) => {
    const stateRoot = temporaryStateRoot("pi-subagents-restored-lexical-");
    try {
      expect(() => restore(stateRoot.path, join(stateRoot.path, "..", "outside"))).toThrow(/escapes/);
    } finally {
      stateRoot.cleanup();
    }
  });

  test.each([
    ["session", restoredSessionPath],
    ["output", restoredOutputPath],
    ["diagnostics", restoredDiagnosticsPath],
    ["receipt", restoredContainmentReceiptPath],
  ] as const)("restored %s paths reject realpath escapes", (_name, restore) => {
    const stateRoot = temporaryStateRoot("pi-subagents-restored-realpath-");
    try {
      const root = absolutePath(join(stateRoot.path, "state"));
      const outside = join(stateRoot.path, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      const escape = join(root, "escape");
      symlinkSync(outside, escape);
      expect(() => restore(root, escape)).toThrow(/escapes/);
    } finally {
      stateRoot.cleanup();
    }
  });

  test("writeOwnerOnlyFile creates owner-only files and directories", () => {
    const state = temporaryStateRoot("pi-subagents-paths-");
    try {
      const root: string = state.path;
      const nested: AbsolutePath = absolutePath(join(root, "state", "child", "file.json"));

      writeOwnerOnlyFile(nested, '{"ok":true}');

      const fileMode = statSync(nested).mode & 0o777;
      const dirMode = statSync(join(root, "state", "child")).mode & 0o777;
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    } finally {
      state.cleanup();
    }
  });
});
