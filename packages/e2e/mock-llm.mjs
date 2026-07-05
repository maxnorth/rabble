// Minimal OpenAI-compatible streaming endpoint so e2e tests exercise the
// real provider/streaming code path without external API credentials.
import { createServer } from "node:http";

const port = Number(process.env.MOCK_LLM_PORT ?? 3199);

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const lastUser = [...parsed.messages].reverse().find((m) => m.role === "user");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const words = `Mock reply to: ${lastUser?.content ?? ""}`.split(" ");
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) {
          const chunk = { choices: [{ delta: { content: (i ? " " : "") + words[i] } }] };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          i++;
        } else {
          res.write("data: [DONE]\n\n");
          res.end();
          clearInterval(timer);
        }
      }, 15);
    });
  } else {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`mock llm listening on :${port}`));
