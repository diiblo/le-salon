import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const FIRST_TOKEN_MS = 120;
const TOKEN_MS = 20;
const failRate = Number(process.env.MOCK_FAIL_RATE ?? 0);
const streamErrorRate = Number(process.env.MOCK_STREAM_ERROR_RATE ?? 0);
const rpm = Number(process.env.MOCK_RPM ?? 60);
let requests = 0;
let windowStart = Date.now();

type Json = Record<string, any>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const id = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: any) => part.text ?? "").join("");
  return "";
};

function json(res: ServerResponse, status: number, body: Json) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function guard(res: ServerResponse): boolean {
  const now = Date.now();
  if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
  requests++;
  if (requests > rpm) { json(res, 429, { error: { type: "rate_limit_exceeded", message: "limite simulée" } }); return false; }
  if (Math.random() < failRate) { json(res, 503, { error: { type: "server_error", message: "panne simulée" } }); return false; }
  return true;
}

function simulated(question: string) {
  return `[réponse simulée] Vous avez écrit : « ${question.slice(0, 120)} ». Le faux serveur permet de tester Le Salon sans dépenser. `;
}

async function completions(req: IncomingMessage, res: ServerResponse) {
  if (!guard(res)) return;
  const request = await body(req);
  const question = textOf(request.messages?.at(-1)?.content);
  const answer = simulated(question);
  const usage = { prompt_tokens: Math.max(1, Math.ceil(JSON.stringify(request.messages).length / 4)), completion_tokens: Math.ceil(answer.length / 4), total_tokens: 0 };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  const base = { id: id("chatcmpl-"), object: "chat.completion", model: request.model, choices: [] };

  if (!request.stream) return json(res, 200, { ...base, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }], usage });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (chunk: Json) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [chunk] })}\n\n`);
  await sleep(FIRST_TOKEN_MS);
  send({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null });
  const pieces = answer.match(/\S+\s*/g) ?? [];
  const breakAt = Math.random() < streamErrorRate ? Math.floor(pieces.length / 2) : -1;
  for (let i = 0; i < pieces.length; i++) {
    if (i === breakAt) { res.write(`data: ${JSON.stringify({ error: { message: "erreur dans le flux simulée" } })}\n\n`); return res.end(); }
    send({ index: 0, delta: { content: pieces[i] }, finish_reason: null });
    await sleep(TOKEN_MS);
  }
  send({ index: 0, delta: {}, finish_reason: "stop" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function responses(req: IncomingMessage, res: ServerResponse) {
  if (!guard(res)) return;
  const request = await body(req);
  const input = typeof request.input === "string" ? request.input : textOf(request.input?.at(-1)?.content);
  const output = request.text?.format?.type === "json_schema"
    ? JSON.stringify({ sujets: ["Discussion du salon"], decisions: [], actions: [] })
    : simulated(input);
  json(res, 200, {
    id: id("resp_"), object: "response", status: "completed", model: request.model,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: output }] }],
    output_text: output,
    output_parsed: request.text?.format?.type === "json_schema" ? JSON.parse(output) : undefined,
    usage: { input_tokens: 10, output_tokens: Math.ceil(output.length / 4), total_tokens: 10 + Math.ceil(output.length / 4) },
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/v1/chat/completions") return await completions(req, res);
    if (req.method === "POST" && req.url === "/v1/responses") return await responses(req, res);
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) return json(res, 200, { object: "list", data: [{ id: "gpt-4.1-mini" }] });
    json(res, 404, { error: { message: "route inconnue" } });
  } catch (error) {
    json(res, 500, { error: { message: (error as Error).message } });
  }
});

server.listen(PORT, () => console.log(`Faux serveur OpenAI sur http://localhost:${PORT}/v1`));
