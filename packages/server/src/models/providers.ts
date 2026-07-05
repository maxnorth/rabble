/**
 * Model provider adapters. Both speak their provider's native streaming
 * protocol over fetch, and both normalize to a simple async iterator of text
 * deltas. Custom models can override the base URL to hit any compatible
 * endpoint or gateway.
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system: string;
  turns: ChatTurn[];
  modelId: string;
  apiKey: string;
  baseUrl?: string | null;
  maxTokens?: number;
}

export type Protocol = "anthropic" | "openai";

export async function* streamCompletion(
  protocol: Protocol,
  req: CompletionRequest,
): AsyncGenerator<string> {
  if (protocol === "anthropic") {
    yield* streamAnthropic(req);
  } else {
    yield* streamOpenAi(req);
  }
}

/** Parse an SSE byte stream into `data:` payload strings. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  }
}

async function raiseForStatus(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 500);
  } catch {
    // response body unavailable; status alone will have to do
  }
  throw new Error(`${provider} request failed (${res.status}): ${detail}`);
}

async function* streamAnthropic(req: CompletionRequest): AsyncGenerator<string> {
  const baseUrl = (req.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": req.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: req.modelId,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system || undefined,
      messages: req.turns.map((t) => ({ role: t.role, content: t.content })),
      stream: true,
    }),
  });
  await raiseForStatus(res, "Anthropic");
  if (!res.body) throw new Error("Anthropic returned no response body");

  for await (const data of sseData(res.body)) {
    if (!data || data === "[DONE]") continue;
    let event: {
      type?: string;
      delta?: { type?: string; text?: string };
      error?: { message?: string };
    };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "error") {
      throw new Error(event.error?.message ?? "Anthropic stream error");
    }
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      typeof event.delta.text === "string"
    ) {
      yield event.delta.text;
    }
  }
}

async function* streamOpenAi(req: CompletionRequest): AsyncGenerator<string> {
  const baseUrl = (req.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      model: req.modelId,
      max_tokens: req.maxTokens ?? 4096,
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...req.turns.map((t) => ({ role: t.role, content: t.content })),
      ],
      stream: true,
    }),
  });
  await raiseForStatus(res, "Model endpoint");
  if (!res.body) throw new Error("Model endpoint returned no response body");

  for await (const data of sseData(res.body)) {
    if (!data || data === "[DONE]") continue;
    let event: { choices?: Array<{ delta?: { content?: string } }> };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const text = event.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text.length > 0) yield text;
  }
}
