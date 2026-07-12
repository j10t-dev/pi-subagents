/**
 * Registers a deterministic, network-free provider that keeps a parent turn streaming for at
 * least two seconds. Used only by the real-Pi UI-forwarding spike (`scripts/run-ui-spike.ts`) so
 * the spike can observe mid-turn behaviour without any network access or real model latency.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

const DELTA_WORDS = [
  "Thinking",
  " slowly",
  " so",
  " the",
  " spike",
  " has",
  " time",
  " to",
  " open",
  " a",
  " dialog",
  " mid-turn.",
];
const DELTA_DELAY_MS = 250;

function baseMessage(modelId: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "slow-fake",
    model: modelId,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const factory: ExtensionFactory = (pi) => {
  pi.registerProvider("slow-fake", {
    name: "Slow Fake Provider",
    baseUrl: "http://127.0.0.1:0",
    apiKey: "unused",
    api: "anthropic-messages",
    models: [
      {
        id: "slow-fake-model",
        name: "Slow Fake Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
      },
    ],
    streamSimple: (model: Model<Api>) => {
      const stream = createAssistantMessageEventStream();
      void run(stream, model.id);
      return stream;
    },
  });
};

async function run(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  modelId: string,
): Promise<void> {
  stream.push({ type: "start", partial: baseMessage(modelId) });
  stream.push({ type: "text_start", contentIndex: 0, partial: baseMessage(modelId) });
  let text = "";
  for (const word of DELTA_WORDS) {
    await sleep(DELTA_DELAY_MS);
    text += word;
    stream.push({ type: "text_delta", contentIndex: 0, delta: word, partial: baseMessage(modelId) });
  }
  const final: AssistantMessage = { ...baseMessage(modelId), content: [{ type: "text", text }] };
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
  stream.push({ type: "done", reason: "stop", message: final });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default factory;
