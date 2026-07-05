// Spec-compliant OpenAI chat-completions streaming endpoint so e2e tests
// exercise the real agent runtime (deepagents + LangChain ChatOpenAI)
// without external API credentials. Tool definitions in requests are
// accepted and ignored — replies are plain text, so agent loops terminate.
import { createServer } from "node:http";

const port = Number(process.env.MOCK_LLM_PORT ?? 3199);
let counter = 0;

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const lastUser = [...parsed.messages]
        .reverse()
        .find((m) => m.role === "user");
      const userText =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : (lastUser?.content ?? [])
              .map((b) => (typeof b === "string" ? b : (b.text ?? "")))
              .join("");

      const id = `chatcmpl-mock-${++counter}`;
      const base = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: parsed.model ?? "mock-1",
      };
      const words = `Mock reply to: ${userText}`.split(" ");

      if (!parsed.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: words.join(" ") },
                finish_reason: "stop",
              },
            ],
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = -1;
      const timer = setInterval(() => {
        if (i === -1) {
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [
                { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
              ],
            })}\n\n`,
          );
          i++;
        } else if (i < words.length) {
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { content: (i ? " " : "") + words[i] },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          i++;
        } else {
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
          clearInterval(timer);
        }
      }, 10);
    });
  } else {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`mock llm listening on :${port}`));
