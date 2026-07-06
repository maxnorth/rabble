/**
 * LLM provider fakes. Both speak their provider's real wire protocol —
 * request shapes in, streaming SSE out — covering the slice the app uses:
 * text replies and tool calls.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { logRequest, nextLlmReply, type ScriptedReply } from "./state.js";

interface ChatMessage {
  role: string;
  content: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string" ? b : ((b as { text?: string }).text ?? ""),
      )
      .join("");
  }
  return "";
}

function lastUserText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last ? textOf(last.content) : "";
}

function allText(messages: ChatMessage[], system?: unknown): string {
  return [textOf(system ?? ""), ...messages.map((m) => textOf(m.content))].join("\n");
}

function sse(reply: FastifyReply, payload: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseNamed(reply: FastifyReply, event: string, payload: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

let counter = 0;

// ---------------------------------------------------------------------------
// OpenAI chat completions
// ---------------------------------------------------------------------------

export function mountOpenAi(app: FastifyInstance): void {
  app.post("/mock/api.openai.com/v1/chat/completions", async (req, reply) => {
    const body = req.body as {
      model?: string;
      messages: ChatMessage[];
      stream?: boolean;
    };
    logRequest("api.openai.com", "POST", "/v1/chat/completions", body);
    const scripted = nextLlmReply(lastUserText(body.messages), allText(body.messages));
    const id = `chatcmpl-emu-${++counter}`;
    const base = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "emu",
    };

    if (!body.stream) {
      const message =
        scripted.type === "text"
          ? { role: "assistant", content: scripted.text ?? "" }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${id}`,
                  type: "function",
                  function: {
                    name: scripted.toolName ?? "tool",
                    arguments: JSON.stringify(scripted.toolArgs ?? {}),
                  },
                },
              ],
            };
      return reply.send({
        ...base,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message,
            finish_reason: scripted.type === "text" ? "stop" : "tool_calls",
          },
        ],
      });
    }

    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    sse(reply, {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });

    if (scripted.type === "text") {
      const words = (scripted.text ?? "").split(" ");
      for (let i = 0; i < words.length; i++) {
        sse(reply, {
          ...base,
          choices: [
            { index: 0, delta: { content: (i ? " " : "") + words[i] }, finish_reason: null },
          ],
        });
        await new Promise((r) => setTimeout(r, 5));
      }
      sse(reply, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    } else {
      sse(reply, {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${id}`,
                  type: "function",
                  function: {
                    name: scripted.toolName ?? "tool",
                    arguments: JSON.stringify(scripted.toolArgs ?? {}),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      sse(reply, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    }
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
  });
}

// ---------------------------------------------------------------------------
// Anthropic messages
// ---------------------------------------------------------------------------

export function mountAnthropic(app: FastifyInstance): void {
  app.post("/mock/api.anthropic.com/v1/messages", async (req, reply) => {
    const body = req.body as {
      model?: string;
      system?: unknown;
      messages: ChatMessage[];
      stream?: boolean;
    };
    logRequest("api.anthropic.com", "POST", "/v1/messages", body);
    const scripted = nextLlmReply(
      lastUserText(body.messages),
      allText(body.messages, body.system),
    );
    const id = `msg_emu_${++counter}`;

    const contentBlocks =
      scripted.type === "text"
        ? [{ type: "text", text: scripted.text ?? "" }]
        : [
            {
              type: "tool_use",
              id: `toolu_${id}`,
              name: scripted.toolName ?? "tool",
              input: scripted.toolArgs ?? {},
            },
          ];
    const stopReason = scripted.type === "text" ? "end_turn" : "tool_use";
    const usage = { input_tokens: 10, output_tokens: 20 };

    if (!body.stream) {
      return reply.send({
        id,
        type: "message",
        role: "assistant",
        model: body.model ?? "emu",
        content: contentBlocks,
        stop_reason: stopReason,
        usage,
      });
    }

    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    sseNamed(reply, "message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: body.model ?? "emu",
        content: [],
        stop_reason: null,
        usage,
      },
    });

    if (scripted.type === "text") {
      sseNamed(reply, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      const words = (scripted.text ?? "").split(" ");
      for (let i = 0; i < words.length; i++) {
        sseNamed(reply, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: (i ? " " : "") + words[i] },
        });
        await new Promise((r) => setTimeout(r, 5));
      }
    } else {
      sseNamed(reply, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: `toolu_${id}`,
          name: scripted.toolName ?? "tool",
          input: {},
        },
      });
      sseNamed(reply, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(scripted.toolArgs ?? {}),
        },
      });
    }

    sseNamed(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
    sseNamed(reply, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    sseNamed(reply, "message_stop", { type: "message_stop" });
    reply.raw.end();
  });
}

export type { ScriptedReply };
