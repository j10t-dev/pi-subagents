import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { absolutePath } from "../../src/paths.ts";

export function temporaryStateRoot(prefix = "pi-subagents-test-") {
  const path = absolutePath(mkdtempSync(join(tmpdir(), prefix)));
  let cleaned = false;
  return {
    path,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** A temporary state root pre-seeded with empty files at the given root-relative paths. */
export function temporaryTree(relativePaths: readonly string[], prefix?: string) {
  const root = temporaryStateRoot(prefix);
  for (const relativePath of relativePaths) {
    const absolute = join(root.path, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "");
  }
  return root;
}
