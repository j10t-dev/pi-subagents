import { describe, expect, test } from "bun:test";

import { classifyAssignmentEntries } from "../src/assignment-identity.ts";
import { runId } from "../src/domain.ts";

const user = (id: string, content: unknown) => ({
  type: "message",
  id,
  message: { role: "user", content },
});

const invalidCases: ReadonlyArray<[string, readonly unknown[]]> = [
  ["transformed", [user("deadbeef", "changed")]],
  ["matching then competing", [user("deadbeef", "literal"), user("cafebabe", "other")]],
  ["competing then matching", [user("cafebabe", "other"), user("deadbeef", "literal")]],
  ["identical duplicate", [user("deadbeef", "literal"), user("cafebabe", "literal")]],
  ["image", [user("deadbeef", [{ type: "image", data: "x", mimeType: "image/png" }])]],
  ["mixed content", [user("deadbeef", [{ type: "text", text: "literal" }, { type: "image" }])]],
  ["malformed user id", [{ type: "message", id: 7, message: { role: "user", content: "literal" } }]],
  ["malformed user content", [user("deadbeef", [{ type: "text", text: 7 }])]],
];

describe("classifyAssignmentEntries", () => {
  test("matches an exact string user entry", () => {
    expect(classifyAssignmentEntries([user("deadbeef", "literal")], "literal"))
      .toEqual({ kind: "matched", runId: runId("deadbeef") });
  });

  test("matches concatenated text-only blocks without normalisation", () => {
    expect(classifyAssignmentEntries([
      user("deadbeef", [{ type: "text", text: "lit" }, { type: "text", text: "eral" }]),
    ], "literal")).toEqual({ kind: "matched", runId: runId("deadbeef") });
  });

  test("returns pending when no user evidence is visible", () => {
    expect(classifyAssignmentEntries([
      { type: "custom", id: "aaaaaaaa" },
      { type: "message", id: "bbbbbbbb", message: { role: "assistant" } },
    ], "literal")).toEqual({ kind: "pending" });
  });

  test.each(invalidCases)("rejects %s evidence", (_name, entries) => {
    expect(classifyAssignmentEntries(entries, "literal")).toEqual({ kind: "invalid" });
  });
});
