import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSessionTranscriptSource } from "../../src/session-transcript-source.ts";
import { agentId, transcriptFileName, type AbsolutePath, type TranscriptRoute } from "../../src/domain.ts";

const agentDir = process.argv[2] as AbsolutePath | undefined;
const cycle = process.argv[3];
if (agentDir === undefined || (cycle !== "self" && cycle !== "two")) {
  throw new Error("usage: cycle-probe <agent-dir> <self|two>");
}

const route: TranscriptRoute = {
  ownerSessionId: agentId("owner-session"),
  childSessionId: agentId("child-session"),
  fileName: transcriptFileName("child-session.jsonl"),
  direct: true,
};
const sessions = join(agentDir, "pi-subagents", route.ownerSessionId, "sessions");
const transcript = join(sessions, route.fileName);
mkdirSync(sessions, { recursive: true });
writeFileSync(transcript, [
  JSON.stringify({ type: "session", version: 2, id: route.childSessionId }),
  JSON.stringify({ type: "message", id: "11111111", parentId: null, message: { role: "user", content: "retained question" } }),
].join("\n") + "\n");

const source = createSessionTranscriptSource(route, {
  agentDir,
  onDiagnostic: () => {},
  filesystem: (await import("../../src/session-transcript-source.ts")).createNodeTranscriptFileSystem(),
  watcher: (await import("../../src/session-transcript-source.ts")).createNodeTranscriptFileWatcherFactory(),
  clock: (await import("../../src/session-transcript-source.ts")).createNodeTranscriptRefreshClock(),
});
const unsubscribe = source.subscribe(() => {});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("probe timeout");
}

await waitFor(() => Number(source.snapshot().revision) > 0);
const records = cycle === "self"
  ? [{ type: "message", id: "aaaaaaaa", parentId: "aaaaaaaa", message: { role: "assistant", content: [] } }]
  : [
      { type: "message", id: "aaaaaaaa", parentId: "bbbbbbbb", message: { role: "assistant", content: [] } },
      { type: "message", id: "bbbbbbbb", parentId: "aaaaaaaa", message: { role: "assistant", content: [] } },
    ];
appendFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
await waitFor(() => source.snapshot().availability === "unavailable");
process.stdout.write(JSON.stringify(source.snapshot()));
unsubscribe();
source.dispose();
