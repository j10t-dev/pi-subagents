import {
  CHILD_CAPACITY_ENV,
  CHILD_DEPTH_ENV,
  CHILD_MARKER_ENV,
  CHILD_MAX_DEPTH_ENV,
  MAX_MAX_DEPTH,
  MAX_TREE_CHILD_PROCESSES,
} from "./constants.ts";

export interface DelegationLimits {
  readonly maxDepth: number;
  readonly maxConcurrentRuns: number;
}

export type ExtensionLaunchContext =
  | { readonly kind: "root"; readonly currentDepth: 0 }
  | { readonly kind: "descendant"; readonly currentDepth: number; readonly limits: DelegationLimits }
  | { readonly kind: "legacy-child" }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const MALFORMED_ENVIRONMENT_DIAGNOSTIC =
  "pi-subagents disabled: malformed managed delegation environment".slice(0, 500);

export function parseExtensionLaunchContext(
  env: Readonly<NodeJS.ProcessEnv>,
): ExtensionLaunchContext {
  const marker = env[CHILD_MARKER_ENV];
  const numericValues = [env[CHILD_DEPTH_ENV], env[CHILD_MAX_DEPTH_ENV], env[CHILD_CAPACITY_ENV]];
  const hasNumericValue = numericValues.some((value) => value !== undefined);

  if (marker === undefined && !hasNumericValue) return { kind: "root", currentDepth: 0 };
  if (marker === "1" && !hasNumericValue) return { kind: "legacy-child" };
  if (marker !== "1" || numericValues.some((value) => value === undefined)) return invalidContext();

  const [currentDepth, maxDepth, maxConcurrentRuns] = numericValues.map(parseCanonicalInteger);
  if (
    currentDepth === undefined || maxDepth === undefined || maxConcurrentRuns === undefined ||
    currentDepth < 1 || maxDepth < 1 || maxDepth > MAX_MAX_DEPTH ||
    currentDepth > maxDepth || maxConcurrentRuns < 1
  ) return invalidContext();

  return { kind: "descendant", currentDepth, limits: { maxDepth, maxConcurrentRuns } };
}

export function boundedTreeChildCount(
  capacity: number,
  maxDepth: number,
  limit: number = MAX_TREE_CHILD_PROCESSES,
): number {
  if (maxDepth <= 0) return 0;
  let total = 0;
  let generation = capacity;
  const cap = limit + 1;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (generation > cap - total) return cap;
    total += generation;
    if (depth + 1 < maxDepth && generation > Math.floor(cap / capacity)) return cap;
    generation *= capacity;
  }
  return total;
}

export function canDelegateFrom(currentDepth: number, maxDepth: number): boolean {
  return currentDepth < maxDepth;
}

function parseCanonicalInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function invalidContext(): ExtensionLaunchContext {
  return { kind: "invalid", diagnostic: MALFORMED_ENVIRONMENT_DIAGNOSTIC };
}
