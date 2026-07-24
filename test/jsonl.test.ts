import { describe, expect, test } from "bun:test";

import { milliseconds, utf8Bytes, type Utf8Bytes } from "../src/domain.ts";
import { BoundedJsonlDecoder, serializeJsonlRecord } from "../src/jsonl.ts";

const MAX_RECORD_BYTES = utf8Bytes(16 * 1024 * 1024);

const _decoderWithDuration = new BoundedJsonlDecoder({
  // @ts-expect-error duration values cannot be JSONL byte bounds.
  maxRecordBytes: milliseconds(10),
  onRecord: () => {},
  onOversize: () => {},
  onDecodeError: () => {},
});
void _decoderWithDuration;

function collect(maxRecordBytes: Utf8Bytes = MAX_RECORD_BYTES) {
  const records: unknown[] = [];
  const oversized: number[] = [];
  const decodeErrors: string[] = [];
  const metadata: Array<{ type?: string; id?: string; command?: string }> = [];
  const decoder = new BoundedJsonlDecoder({
    maxRecordBytes,
    onRecord: (value) => records.push(value),
    onOversize: (bytes) => oversized.push(bytes),
    onOversizeRecord: (value) => metadata.push(value),
    onDecodeError: (reason) => decodeErrors.push(reason),
  });
  return { decoder, records, oversized, decodeErrors, metadata };
}

describe("BoundedJsonlDecoder", () => {

  test("decodes a record fed byte-by-byte", () => {
    const { decoder, records } = collect();
    const line = `${JSON.stringify({ type: "agent_settled" })}\n`;
    const bytes = new TextEncoder().encode(line);
    for (const byte of bytes) {
      decoder.push(Uint8Array.of(byte));
    }
    expect(records).toEqual([{ type: "agent_settled" }]);
  });

  test("normalises CRLF line endings", () => {
    const { decoder, records } = collect();
    const line = `${JSON.stringify({ type: "agent_settled" })}\r\n`;
    decoder.push(new TextEncoder().encode(line));
    expect(records).toEqual([{ type: "agent_settled" }]);
  });

  test("preserves embedded U+2028/U+2029 inside a JSON string value", () => {
    const { decoder, records } = collect();
    const payload = { type: "text_delta", delta: "line sep end" };
    decoder.push(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
    expect(records).toEqual([payload]);
  });

  test("emits an in-bound valid final unterminated record", () => {
    const { decoder, records } = collect();
    decoder.push(new TextEncoder().encode(JSON.stringify({ type: "agent_settled" })));
    decoder.end();
    expect(records).toEqual([{ type: "agent_settled" }]);
  });

  test("discards an unterminated final record with incomplete UTF-8", () => {
    const { decoder, records, decodeErrors } = collect();
    decoder.push(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3]));
    decoder.end();
    expect(records).toEqual([]);
    expect(decodeErrors).toHaveLength(1);
  });

  test("discards an oversized unterminated final record", () => {
    const { decoder, records, oversized } = collect(utf8Bytes(8));
    decoder.push(new TextEncoder().encode('{"value":"too large"}'));
    decoder.end();
    expect(records).toEqual([]);
    expect(oversized).toHaveLength(1);
  });

  test("reports a decode error for malformed JSON after valid records", () => {
    const { decoder, records, decodeErrors } = collect();
    decoder.push(new TextEncoder().encode(`${JSON.stringify({ type: "a" })}\nnot json at all\n`));
    expect(records).toEqual([{ type: "a" }]);
    expect(decodeErrors).toHaveLength(1);
    expect(decodeErrors[0]).not.toContain("not json at all");
  });

  test("reports a decode error for invalid UTF-8", () => {
    const { decoder, decodeErrors } = collect();
    const invalid = new Uint8Array([0xff, 0xfe, 0x0a]);
    decoder.push(invalid);
    expect(decodeErrors).toHaveLength(1);
  });

  test("discards an oversized record through the next LF and recovers on the following record", () => {
    const { decoder, records, oversized } = collect(utf8Bytes(64));
    const bigValue = "x".repeat(200);
    const bigLine = `${JSON.stringify({ type: "big", value: bigValue })}\n`;
    const smallLine = `${JSON.stringify({ type: "agent_settled" })}\n`;
    decoder.push(new TextEncoder().encode(bigLine + smallLine));
    expect(oversized).toHaveLength(1);
    expect(records).toEqual([{ type: "agent_settled" }]);
  });

  test("a 16 MiB + 1 byte record is discarded, then a small agent_settled record still parses", () => {
    const { decoder, records, oversized } = collect();
    const hugeString = "a".repeat(MAX_RECORD_BYTES + 1);
    const hugeLine = `${JSON.stringify({ type: "huge", value: hugeString })}\n`;
    const smallLine = `${JSON.stringify({ type: "agent_settled" })}\n`;
    decoder.push(new TextEncoder().encode(hugeLine));
    decoder.push(new TextEncoder().encode(smallLine));
    expect(oversized).toHaveLength(1);
    expect(records).toEqual([{ type: "agent_settled" }]);
  });

  test("never retains more than maxRecordBytes plus one UTF-8 decoder carry while buffering", () => {
    const { decoder } = collect(utf8Bytes(1024));
    const chunk = new Uint8Array(512).fill(0x61);
    decoder.push(chunk);
    expect(decoder.pendingBytes).toBeLessThanOrEqual(1024);
    decoder.push(chunk);
    expect(decoder.pendingBytes).toBeLessThanOrEqual(1024);
    // Crossing the bound discards rather than growing further.
    decoder.push(chunk);
    expect(decoder.pendingBytes).toBe(utf8Bytes(0));
  });

  test("retained fragments do not pin an arbitrarily large caller chunk", () => {
    const { decoder } = collect();
    const hugeChunk = new Uint8Array(64 * 1024 * 1024);
    hugeChunk.fill(0x20);
    hugeChunk[1024] = 0x0a;
    decoder.push(hugeChunk);
    expect(decoder.retainedAllocationBytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
  });

  test("one-byte chunking retains a bounded number of backing objects", () => {
    const { decoder } = collect(MAX_RECORD_BYTES);
    const payloadBytes = MAX_RECORD_BYTES;
    const byte = Uint8Array.of(0x61);
    for (let index = 0; index < payloadBytes; index++) {
      decoder.push(byte);
    }

    expect(decoder.pendingBytes).toBe(payloadBytes);
    expect(decoder.retainedFragmentCount).toBeLessThanOrEqual(1);
    expect(decoder.retainedAllocationBytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
  });

  test("handles chunk boundaries that split a multi-byte UTF-8 character", () => {
    const { decoder, records } = collect();
    const line = `${JSON.stringify({ type: "text_delta", delta: "café" })}\n`;
    const bytes = new TextEncoder().encode(line);
    const splitPoint = bytes.indexOf(0xa9); // second byte of the 2-byte "é" sequence
    decoder.push(bytes.subarray(0, splitPoint));
    decoder.push(bytes.subarray(splitPoint));
    expect(records).toEqual([{ type: "text_delta", delta: "café" }]);
  });

  test("recovers reordered top-level metadata after an arbitrarily large leading field", () => {
    const { decoder, metadata } = collect(utf8Bytes(64));
    const line = `{"payload":"${"x".repeat(20_000)}","command":"get_entries","id":"request-1","type":"response"}\n`;
    for (const byte of new TextEncoder().encode(line)) decoder.push(Uint8Array.of(byte));
    expect(metadata).toEqual([{ type: "response", id: "request-1", command: "get_entries" }]);
    expect(decoder.retainedAllocationBytes).toBeLessThanOrEqual(64);
  });

  test("does not mistake nested discriminants or escaped string content for top-level metadata", () => {
    const { decoder, metadata } = collect(utf8Bytes(80));
    decoder.push(new TextEncoder().encode(`${JSON.stringify({ huge: "x".repeat(1000), nested: { type: "response" }, note: "\\\"type\\\":\\\"response\\\"", type: "ordinary" })}\n`));
    expect(metadata).toEqual([{ type: "ordinary" }]);
  });
});

describe("serializeJsonlRecord", () => {
  test("round-trips through BoundedJsonlDecoder", () => {
    const { decoder, records } = collect();
    decoder.push(new TextEncoder().encode(serializeJsonlRecord({ type: "prompt", id: "1" })));
    expect(records).toEqual([{ type: "prompt", id: "1" }]);
  });
});
