import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import * as childConversationGate from "../scripts/run-child-conversation-gate.ts";
import {
  FixedTerminalScreen,
  REQUIRED_CHILD_VIEW_EVENTS,
  classifyChildConversationGate,
  hasFullscreenConversationFrame,
  safeChildGateDiagnostic,
} from "../scripts/run-child-conversation-gate.ts";

describe("child conversation PTY gate control logic", () => {
  test("accepts only an ordered superset of the required lifecycle", () => {
    expect(classifyChildConversationGate(["noise", ...REQUIRED_CHILD_VIEW_EVENTS, "noise"]))
      .toBe("supported");
    expect(classifyChildConversationGate([...REQUIRED_CHILD_VIEW_EVENTS].reverse()))
      .toBe("unsupported");
    expect(classifyChildConversationGate([])).toBe("not-run");
  });

  test("reconstructs the current frame across split ANSI control sequences", () => {
    const screen = new FixedTerminalScreen(4, 12);
    screen.feed("historical\ntext\u001b[");
    screen.feed("2J\u001b[Htop\u001b[4;1Hbottom");

    expect(screen.lines()).toEqual(["top", "", "", "bottom"]);
  });

  test("requires top and bottom markers in one complete fixed-size frame", () => {
    const frame = Array.from({ length: 24 }, () => "");
    frame[0] = "A1.2 · fixture:h · ?% · running";
    frame[23] = "following · arrows";

    expect(hasFullscreenConversationFrame(frame)).toBe(true);
    expect(hasFullscreenConversationFrame(frame.slice(0, -1))).toBe(false);
    expect(hasFullscreenConversationFrame(frame.map((line, index) => index === 23 ? "" : line))).toBe(false);
  });

  test("constructs an isolated Pi environment without caller configuration overrides", () => {
    const createEnvironment = (childConversationGate as unknown as {
      readonly createChildConversationGateEnvironment?: (
        workDir: string,
        eventFile: string,
        inherited: NodeJS.ProcessEnv,
      ) => NodeJS.ProcessEnv;
    }).createChildConversationGateEnvironment;
    expect(createEnvironment).toBeFunction();

    const workDir = "/tmp/child-gate-isolated";
    const environment = createEnvironment!(workDir, join(workDir, "events.txt"), {
      HOME: "/caller/home",
      PATH: "/caller/bin",
      PI_CODING_AGENT_DIR: "/caller/agent",
      PI_CODING_AGENT_SESSION_DIR: "/caller/sessions",
      PI_PACKAGE_DIR: "/caller/packages",
      XDG_CONFIG_HOME: "/caller/config",
      XDG_DATA_HOME: "/caller/data",
      XDG_CACHE_HOME: "/caller/cache",
    });

    expect(environment).toMatchObject({
      HOME: join(workDir, "home"),
      PATH: "/caller/bin",
      PI_CODING_AGENT_DIR: join(workDir, "agent"),
      PI_CHILD_CONVERSATION_GATE_EVENT_FILE: join(workDir, "events.txt"),
      PI_OFFLINE: "1",
    });
    for (const name of [
      "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR",
      "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    ]) expect(environment).not.toHaveProperty(name);
  });

  test("reports bounded structural diagnostics without terminal or unknown trace content", () => {
    const secret = "private editor and transcript content \u001b]52;c;clipboard\u0007";
    const diagnostic = safeChildGateDiagnostic(
      "conversation open",
      secret.repeat(500),
      ["unknown-private-event", "conversation-opened", "conversation-opened"],
    );

    expect(diagnostic).toContain("phase=conversation_open");
    expect(diagnostic).toContain("outputLength=");
    expect(diagnostic).toContain("events=conversation-opened");
    expect(diagnostic).not.toContain("private editor");
    expect(diagnostic).not.toContain("clipboard");
    expect(diagnostic).not.toContain("unknown-private-event");
    expect(diagnostic.length).toBeLessThanOrEqual(350);
  });
});
