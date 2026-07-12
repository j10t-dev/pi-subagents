/**
 * Strict LF-only JSONL framing for the bounded RPC transport.
 *
 * Deliberately uses direct LF scanning so framing remains byte-bounded and deterministic.
 * additional Unicode line separators (U+2028, U+2029) that are valid inside JSON string values,
 * and cumulative buffer splitting re-scans bytes already consumed. Framing here operates on raw
 * bytes so a record is never considered complete until an actual `\n` (0x0A) byte arrives;
 * multi-byte UTF-8 sequences never contain that byte, so byte-level scanning is always safe.
 */

export interface BoundedJsonlDecoderOptions {
  /** Maximum bytes retained for one buffered (LF-terminated) record before it is discarded. */
  maxRecordBytes: number;
  /** Called with the parsed value of each complete, in-bound, valid-UTF-8, valid-JSON record. */
  onRecord: (value: unknown) => void;
  /** Called when a record's buffered size would exceed `maxRecordBytes`; it is discarded through the next LF. */
  onOversize: (approxBytes: number) => void;
  /** Called at the LF with bounded top-level metadata recovered while discarding an oversized record. */
  onOversizeRecord?: (metadata: OversizedRecordMetadata) => void;
  /** Called with a bounded, non-payload-bearing reason when a record fails to decode or parse. */
  onDecodeError: (reason: string) => void;
}

export interface OversizedRecordMetadata { type?: string; id?: string; command?: string }

/** Splits input strictly on LF, never retaining more than `maxRecordBytes` per pending record. */
export class BoundedJsonlDecoder {
  private buffered = new Uint8Array(0);
  private bufferedBytes = 0;
  private discarding = false;
  private ended = false;
  private readonly metadata = new TopLevelMetadataScanner();

  constructor(private readonly options: BoundedJsonlDecoderOptions) {
    if (!Number.isInteger(options.maxRecordBytes) || options.maxRecordBytes <= 0) {
      throw new RangeError("maxRecordBytes must be a positive integer");
    }
  }

  /** Bytes currently buffered for the in-progress (not yet LF-terminated) record. Test/diagnostic use only. */
  get pendingBytes(): number {
    return this.bufferedBytes;
  }

  /** Backing allocations retained for pending fragments. Test/diagnostic use only. */
  get retainedAllocationBytes(): number {
    return this.buffered.byteLength;
  }

  /** Number of backing objects retained for the pending record. Test/diagnostic use only. */
  get retainedFragmentCount(): number {
    return this.buffered.byteLength === 0 ? 0 : 1;
  }

  /** Feeds another chunk of raw bytes. May be as small as a single byte. */
  push(chunk: Uint8Array): void {
    if (this.ended) {
      throw new Error("invalid_state: decoder already ended");
    }
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        this.consumeSlice(chunk.subarray(start, i));
        this.finishLine();
        start = i + 1;
      }
    }
    if (start < chunk.length) {
      this.consumeSlice(chunk.subarray(start));
    }
  }

  /** Signals end of input, processing an in-bound complete UTF-8/JSON trailing record. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.discarding && this.bufferedBytes > 0) {
      this.finishLine();
    }
    this.buffered = new Uint8Array(0);
    this.bufferedBytes = 0;
    this.discarding = false;
  }

  private consumeSlice(slice: Uint8Array): void {
    if (slice.length === 0) {
      return;
    }
    this.metadata.push(slice);
    if (this.discarding) return;
    const projected = this.bufferedBytes + slice.length;
    if (projected > this.options.maxRecordBytes) {
      this.discarding = true;
      this.bufferedBytes = 0;
      this.options.onOversize(projected);
      return;
    }
    this.ensureCapacity(projected);
    this.buffered.set(slice, this.bufferedBytes);
    this.bufferedBytes = projected;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.buffered.byteLength) return;
    let capacity = Math.max(1, this.buffered.byteLength);
    while (capacity < required) {
      capacity = Math.min(this.options.maxRecordBytes, capacity * 2);
    }
    const replacement = new Uint8Array(capacity);
    replacement.set(this.buffered.subarray(0, this.bufferedBytes));
    this.buffered = replacement;
  }

  private finishLine(): void {
    if (this.discarding) {
      this.options.onOversizeRecord?.(this.metadata.finish());
      this.metadata.reset();
      this.discarding = false;
      return;
    }
    const lineBytes = this.buffered.subarray(0, this.bufferedBytes);
    this.bufferedBytes = 0;
    this.metadata.reset();
    const trimmed = trimTrailingCr(lineBytes);
    if (trimmed.length === 0) {
      return;
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(trimmed);
    } catch {
      this.options.onDecodeError("invalid utf-8 in rpc record");
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.options.onDecodeError("invalid json in rpc record");
      return;
    }

    this.options.onRecord(value);
  }
}

/** Bounded JSON lexical scanner: captures only top-level string discriminants, irrespective of order. */
class TopLevelMetadataScanner {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private stringBytes: number[] = [];
  private capture = false;
  private expectingKey = true;
  private key: string | undefined;
  private result: OversizedRecordMetadata = {};

  push(bytes: Uint8Array): void {
    for (const byte of bytes) this.byte(byte);
  }

  finish(): OversizedRecordMetadata { return { ...this.result }; }

  reset(): void {
    this.depth = 0; this.inString = false; this.escaped = false; this.stringBytes = [];
    this.capture = false; this.expectingKey = true; this.key = undefined; this.result = {};
  }

  private byte(byte: number): void {
    if (this.inString) {
      if (this.capture && this.stringBytes.length < 512) this.stringBytes.push(byte);
      if (this.escaped) { this.escaped = false; return; }
      if (byte === 0x5c) { this.escaped = true; return; }
      if (byte !== 0x22) return;
      this.inString = false;
      if (!this.capture) return;
      this.stringBytes.pop();
      const value = decodeJsonString(this.stringBytes);
      this.stringBytes = [];
      if (this.expectingKey) { this.key = value; this.expectingKey = false; }
      else if (this.key === "type" || this.key === "id" || this.key === "command") {
        if (value !== undefined) this.result[this.key] = value;
        this.key = undefined;
      }
      return;
    }
    if (byte === 0x22) {
      this.inString = true;
      this.capture = this.depth === 1 && (this.expectingKey || this.key === "type" || this.key === "id" || this.key === "command");
      this.stringBytes = [];
      return;
    }
    if (byte === 0x7b || byte === 0x5b) { this.depth++; return; }
    if (byte === 0x7d || byte === 0x5d) { this.depth--; return; }
    if (this.depth === 1 && byte === 0x2c) { this.expectingKey = true; this.key = undefined; }
  }
}

function decodeJsonString(bytes: number[]): string | undefined {
  try { return JSON.parse(`"${new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))}"`) as string; }
  catch { return undefined; }
}

function trimTrailingCr(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) {
    return bytes.subarray(0, bytes.length - 1);
  }
  return bytes;
}

/** Serializes a value as one strict LF-terminated JSONL record for writing to a child's stdin. */
export function serializeJsonlRecord(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
