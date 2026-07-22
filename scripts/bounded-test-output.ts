export const CAPTURE_HEAD_BYTES = 256 * 1024;
export const CAPTURE_TAIL_BYTES = 768 * 1024;

export interface CaptureLimits {
  readonly headBytes: number;
  readonly tailBytes: number;
}

const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  headBytes: CAPTURE_HEAD_BYTES,
  tailBytes: CAPTURE_TAIL_BYTES,
};

export class BoundedTestOutput {
  private readonly limits: CaptureLimits;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;
  private headFollowingBytes = Buffer.alloc(0);
  private tailPrecedingBytes = Buffer.alloc(0);

  constructor(limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS) {
    if (!Number.isInteger(limits.headBytes) || limits.headBytes < 0 ||
        !Number.isInteger(limits.tailBytes) || limits.tailBytes < 0 ||
        limits.headBytes + limits.tailBytes === 0) {
      throw new TypeError("capture limits must be non-negative integers with a positive sum");
    }
    this.limits = limits;
  }

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.totalBytes += bytes.byteLength;

    const headRemaining = this.limits.headBytes - this.head.byteLength;
    const headLength = Math.min(headRemaining, bytes.byteLength);
    if (headLength > 0) {
      this.head = Buffer.concat([this.head, bytes.subarray(0, headLength)]);
    }

    const remainder = bytes.subarray(headLength);
    if (remainder.byteLength === 0) return;

    if (this.headFollowingBytes.byteLength < 3 && this.head.byteLength === this.limits.headBytes) {
      const contextLength = Math.min(3 - this.headFollowingBytes.byteLength, remainder.byteLength);
      this.headFollowingBytes = Buffer.concat([
        this.headFollowingBytes,
        remainder.subarray(0, contextLength),
      ]);
    }

    const combined = Buffer.concat([this.tail, remainder]);
    const retainedStart = Math.max(0, combined.byteLength - this.limits.tailBytes);
    if (retainedStart > 0) {
      this.tailPrecedingBytes = Buffer.from(
        combined.subarray(Math.max(0, retainedStart - 3), retainedStart),
      );
    }
    this.tail = Buffer.from(combined.subarray(retainedStart));
  }

  render(): string {
    if (this.discardedBytes === 0) {
      return Buffer.concat([this.head, this.tail]).toString("utf8");
    }

    const removedHeadBytes = splitScalarPrefixLength(this.head, this.headFollowingBytes);
    const removedTailBytes = splitScalarSuffixLength(this.tailPrecedingBytes, this.tail);
    const head = this.head.subarray(0, this.head.byteLength - removedHeadBytes);
    const tail = this.tail.subarray(removedTailBytes);
    const truncatedBytes = this.discardedBytes + removedHeadBytes + removedTailBytes;
    return `${head.toString("utf8")}\n... [truncated ${truncatedBytes} bytes] ...\n${tail.toString("utf8")}`;
  }

  get discardedBytes(): number {
    return this.totalBytes - this.head.byteLength - this.tail.byteLength;
  }
}

export function formatTestGroupOutput(
  groupName: string,
  stdout: BoundedTestOutput,
  stderr: BoundedTestOutput,
  signal?: NodeJS.Signals,
  stderrDiagnostic?: string,
): string {
  const stdoutText = stdout.render();
  const capturedStderrText = stderr.render();
  const stderrText = stderrDiagnostic === undefined
    ? capturedStderrText
    : `${capturedStderrText}${capturedStderrText === "" || capturedStderrText.endsWith("\n") ? "" : "\n"}${stderrDiagnostic}`;
  const sections = [
    stdoutText === "" ? "" : `--- stdout ---\n${stdoutText}${stdoutText.endsWith("\n") ? "" : "\n"}`,
    stderrText === "" ? "" : `--- stderr ---\n${stderrText}${stderrText.endsWith("\n") ? "" : "\n"}`,
    signal === undefined ? "" : `--- signal ---\ntest group terminated by ${signal}\n`,
  ].filter((section) => section !== "");
  return `===== test group: ${groupName} =====\n${sections.join("")}===== end test group: ${groupName} =====\n`;
}

function splitScalarPrefixLength(head: Buffer, following: Buffer): number {
  const headContext = head.subarray(Math.max(0, head.byteLength - 3));
  const context = Buffer.concat([headContext, following]);
  const boundary = headContext.byteLength;
  for (let start = 0; start < boundary; start += 1) {
    const length = validScalarLength(context, start);
    if (length !== 0 && start + length > boundary && start + length <= context.byteLength) {
      return boundary - start;
    }
  }
  return 0;
}

function splitScalarSuffixLength(preceding: Buffer, tail: Buffer): number {
  const tailContext = tail.subarray(0, 3);
  const context = Buffer.concat([preceding, tailContext]);
  const boundary = preceding.byteLength;
  for (let start = 0; start < boundary; start += 1) {
    const length = validScalarLength(context, start);
    if (length !== 0 && start + length > boundary && start + length <= context.byteLength) {
      return start + length - boundary;
    }
  }
  return 0;
}

function validScalarLength(bytes: Buffer, start: number): number {
  const first = bytes[start];
  if (first === undefined) return 0;
  if (first >= 0xc2 && first <= 0xdf) {
    return isContinuation(bytes[start + 1]) ? 2 : 0;
  }
  if (first >= 0xe0 && first <= 0xef) {
    const second = bytes[start + 1];
    const secondValid = second !== undefined && (
      first === 0xe0 ? second >= 0xa0 && second <= 0xbf :
      first === 0xed ? second >= 0x80 && second <= 0x9f :
      second >= 0x80 && second <= 0xbf
    );
    return secondValid && isContinuation(bytes[start + 2]) ? 3 : 0;
  }
  if (first >= 0xf0 && first <= 0xf4) {
    const second = bytes[start + 1];
    const secondValid = second !== undefined && (
      first === 0xf0 ? second >= 0x90 && second <= 0xbf :
      first === 0xf4 ? second >= 0x80 && second <= 0x8f :
      second >= 0x80 && second <= 0xbf
    );
    return secondValid && isContinuation(bytes[start + 2]) && isContinuation(bytes[start + 3]) ? 4 : 0;
  }
  return 0;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}
