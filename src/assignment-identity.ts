import { runIdFromEntry, type RunId } from "./domain.ts";

export type AssignmentIdentityResult =
  | { kind: "pending" }
  | { kind: "matched"; runId: RunId }
  | { kind: "invalid" };

export function classifyAssignmentEntries(
  entries: readonly unknown[],
  literalAssignment: string,
): AssignmentIdentityResult {
  const users: Array<{ runId: RunId; text: string } | undefined> = [];
  for (const value of entries) {
    if (!isRecord(value) || value.type !== "message" || !isRecord(value.message) || value.message.role !== "user") continue;
    const nativeId = typeof value.id === "string"
      ? runIdFromEntry({ id: value.id, type: value.type, message: { role: value.message.role } })
      : undefined;
    const text = nativeId === undefined ? undefined : exactUserText(value.message.content);
    users.push(nativeId === undefined || text === undefined ? undefined : { runId: nativeId, text });
  }
  if (users.length === 0) return { kind: "pending" };
  if (users.length !== 1 || users[0] === undefined || users[0].text !== literalAssignment) return { kind: "invalid" };
  return { kind: "matched", runId: users[0].runId };
}

function exactUserText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let text = "";
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
    text += block.text;
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
