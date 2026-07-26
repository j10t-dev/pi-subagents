import { describe, expect, test } from "bun:test";

import { admitBoundedTranscriptJson, admitSafePresentationJson } from "../src/schemas.ts";
import {
  MAX_TOOL_JSON_BYTES,
  MAX_TOOL_JSON_DEPTH,
  MAX_TOOL_JSON_NODES,
  MAX_TOOL_JSON_STRING_BYTES,
} from "../src/constants.ts";

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe("admitBoundedTranscriptJson", () => {
  test("admits an ordinary bounded tool argument object", () => {
    const admitted = admitBoundedTranscriptJson({ file: "/home/child/src/main.ts", limit: 200, all: false });
    expect(JSON.stringify(admitted)).toBe(JSON.stringify({ file: "/home/child/src/main.ts", limit: 200, all: false }));
  });

  test("returns a frozen deep copy, so later mutation of the source cannot change it", () => {
    const source: Record<string, unknown> = { file: "/a" };
    const admitted = admitBoundedTranscriptJson(source);
    source.file = "/b";
    expect(JSON.stringify(admitted)).toBe(JSON.stringify({ file: "/a" }));
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  test.each([
    ["depth", nested(MAX_TOOL_JSON_DEPTH + 1)],
    ["nodes", Array.from({ length: MAX_TOOL_JSON_NODES + 1 }, (_, index) => index)],
    ["string bytes", { text: "x".repeat(MAX_TOOL_JSON_STRING_BYTES + 1) }],
    ["total bytes", { text: Array.from({ length: 64 }, () => "y".repeat(MAX_TOOL_JSON_STRING_BYTES - 1)) }],
  ])("rejects a value that exceeds the %s limit", (_label, value) => {
    expect(admitBoundedTranscriptJson(value)).toBeUndefined();
  });

  test("rejects cycles, functions, undefined and non-finite numbers", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(admitBoundedTranscriptJson(cyclic)).toBeUndefined();
    expect(admitBoundedTranscriptJson({ run: () => undefined })).toBeUndefined();
    expect(admitBoundedTranscriptJson({ missing: undefined })).toBeUndefined();
    expect(admitBoundedTranscriptJson({ ratio: Number.NaN })).toBeUndefined();
  });

  test("rejects a value carrying control or ANSI sequences", () => {
    expect(admitBoundedTranscriptJson({ text: "a\u001b[31mb" })).toBeUndefined();
    expect(admitBoundedTranscriptJson({ "\u0007key": "b" })).toBeUndefined();
  });

  test("rejects values whose escaped JSON representation exceeds the total byte limit", () => {
    const value = {
      quotes: '"'.repeat(4_096),
      first: "a".repeat(4_000),
      second: "b".repeat(4_000),
      third: "c".repeat(4_000),
    };
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(MAX_TOOL_JSON_BYTES);
    expect(admitBoundedTranscriptJson(value)).toBeUndefined();
  });

  test.each([
    new Date("2026-01-01T00:00:00.000Z"),
    new Map([["key", "value"]]),
    new Set(["value"]),
    Object.assign(new class { field = "value" }(), { extra: "data" }),
  ])("rejects non-plain JSON objects", (value) => {
    expect(admitBoundedTranscriptJson(value)).toBeUndefined();
  });

  test("rejects unsupported own properties instead of silently dropping them", () => {
    const withSymbol = { value: "kept", [Symbol("unsupported")]: "dropped" };
    const withHidden = { value: "kept" };
    Object.defineProperty(withHidden, "hidden", { value: "dropped", enumerable: false });
    expect(admitBoundedTranscriptJson(withSymbol)).toBeUndefined();
    expect(admitBoundedTranscriptJson(withHidden)).toBeUndefined();
  });

  test("returns undefined instead of throwing for hostile or revoked proxies", () => {
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("hostile inspection");
      },
    });
    const revocable = Proxy.revocable({ value: "revoked" }, {});
    revocable.revoke();
    expect(() => admitBoundedTranscriptJson(hostile)).not.toThrow();
    expect(() => admitBoundedTranscriptJson(revocable.proxy)).not.toThrow();
    expect(admitBoundedTranscriptJson(hostile)).toBeUndefined();
    expect(admitBoundedTranscriptJson(revocable.proxy)).toBeUndefined();
  });

  test("total byte accounting is charged before the value is retained", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`k${index}`, "z".repeat(1_024)]),
    );
    const encoded = new TextEncoder().encode(JSON.stringify(wide)).byteLength;
    expect(admitBoundedTranscriptJson(wide) === undefined).toBe(encoded > MAX_TOOL_JSON_BYTES);
  });
});

describe("admitSafePresentationJson", () => {
  const sensitive = new Set(["3f2a91cc", "/state/pi-subagents/3f2a91cc/sessions", "child.jsonl"]);

  test("admits bounded JSON containing only child-local project values", () => {
    const bounded = admitBoundedTranscriptJson({ file: "/home/child/project/src/main.ts", pattern: "todo" });
    expect(bounded).toBeDefined();
    expect(JSON.stringify(admitSafePresentationJson(bounded!, sensitive))).toBe(
      JSON.stringify({ file: "/home/child/project/src/main.ts", pattern: "todo" }),
    );
  });

  test.each([
    ["a string value", { file: "/state/pi-subagents/3f2a91cc/sessions/child.jsonl" }],
    ["an object key", { "3f2a91cc": "value" }],
    ["a nested array element", { items: ["ok", "child.jsonl"] }],
    ["a substring of a longer value", { note: "see 3f2a91cc for detail" }],
  ])("rejects the whole value when %s carries a sensitive value", (_label, value) => {
    const bounded = admitBoundedTranscriptJson(value);
    expect(bounded).toBeDefined();
    expect(admitSafePresentationJson(bounded!, sensitive)).toBeUndefined();
  });

  test("never rewrites: rejection is total, admission is identical", () => {
    const bounded = admitBoundedTranscriptJson({ keep: "a", drop: "3f2a91cc" });
    expect(admitSafePresentationJson(bounded!, sensitive)).toBeUndefined();
  });

  test("an empty sensitive set admits any bounded value", () => {
    const bounded = admitBoundedTranscriptJson({ any: "3f2a91cc" });
    expect(JSON.stringify(admitSafePresentationJson(bounded!, new Set()))).toBe(
      JSON.stringify({ any: "3f2a91cc" }),
    );
  });
});
