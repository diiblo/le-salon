import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { chatStream, type Msg } from "./tp3/llm.js";

const PORT = Number(process.env.PORT ?? 3001);

const ClientMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), pseudo: z.string().trim().min(1).max(20) }),
  z.object({ type: z.literal("say"), text: z.string().trim().min(1).max(1000) }),
]);

type Line = { from: string; text: string; at: number };
type ServerMsg =
  | { type: "said"; from: string; text: string; at: number }
  | { type: "presence"; users: string[] }
  | { type: "info"; text: string }
  | { type: "ia_start"; id: string; for: string }
  | { type: "ia_delta"; id: string; text: string }
  | { type: "ia_done"; id: string; cancelled?: boolean; tokens?: number }
  | { type: "ia_queue"; size: number }
  | { type: "error"; message: string };

type Client = WebSocket & { pseudo?: string };
type Job = { id: string; asker: string; ctrl: AbortController };

const room: Line[] = [];
const wss = new WebSocketServer({ noServer: true });
const queue: Job[] = [];
let running: Job | null = null;
const lastAsk = new Map<string, number>();

function broadcast(message: ServerMsg) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function sendTo(client: WebSocket, message: ServerMsg) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function presence() {
  broadcast({
    type: "presence",
    users: [...wss.clients].map((client) => (client as Client).pseudo).filter(Boolean) as string[],
  });
}

function post(from: string, text: string) {
  const line = { from, text, at: Date.now() };
  room.push(line);
  if (room.length > 200) room.shift();
  broadcast({ type: "said", ...line });
}

const SYSTEM =
  "Tu es « ia », un participant d'un salon de discussion d'équipe. Tu réponds en français, brièvement, " +
  "à la personne qui t'a interpellé. Le fil de discussion t'est fourni comme contexte de conversation.";

function contexte(n = 20): string {
  return room.slice(-n).map((line) => `${line.from}: ${line.text}`).join("\n");
}

/** N1 : une demande @ia produit une réponse streamée visible par tous. */
async function answer(job: Job) {
  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${contexte()}\n\nRéponds à ${job.asker}.` },
  ];
  broadcast({ type: "ia_start", id: job.id, for: job.asker });

  let text = "";
  let tokens: number | undefined;
  try {
    for await (const event of chatStream(messages, { signal: job.ctrl.signal })) {
      if ("delta" in event) {
        text += event.delta;
        broadcast({ type: "ia_delta", id: job.id, text: event.delta });
      } else {
        tokens = event.usage.total_tokens;
      }
    }
    broadcast({ type: "ia_done", id: job.id, tokens });
  } catch (error) {
    const cancelled = (error as Error).name === "AbortError";
    broadcast({ type: "ia_done", id: job.id, cancelled });
    if (!cancelled) broadcast({ type: "error", message: (error as Error).message });
  }
  if (text) {
    room.push({ from: "ia", text, at: Date.now() });
    if (room.length > 200) room.shift();
  }
}

function ask(asker: string) {
  const last = lastAsk.get(asker) ?? 0;
  if (Date.now() - last < 10_000) {
    post("salon", `${asker}, patience : une demande IA toutes les 10 secondes.`);
    return;
  }
  lastAsk.set(asker, Date.now());
  queue.push({ id: crypto.randomUUID().slice(0, 8), asker, ctrl: new AbortController() });
  broadcast({ type: "ia_queue", size: queue.length });
  void pump();
}

async function pump() {
  if (running || queue.length === 0) return;
  running = queue.shift()!;
  try {
    await answer(running);
  } finally {
    running = null;
    broadcast({ type: "ia_queue", size: queue.length });
    void pump();
  }
}

function stop(pseudo: string) {
  if (running?.asker === pseudo) {
    running.ctrl.abort();
    return;
  }
  post("salon", `${pseudo}, seul le demandeur de la réponse en cours peut l'arrêter.`);
}

wss.on("connection", (ws: Client) => {
  ws.on("message", (raw) => {
    let message: z.infer<typeof ClientMsg>;
    try {
      message = ClientMsg.parse(JSON.parse(raw.toString()));
    } catch {
      return sendTo(ws, { type: "error", message: "message invalide" });
    }
    if (message.type === "join") {
      ws.pseudo = message.pseudo.replace(/[^\p{L}\p{N}_-]/gu, "") || "anonyme";
      for (const line of room.slice(-50)) sendTo(ws, { type: "said", ...line });
      post("salon", `${ws.pseudo} a rejoint le salon.`);
      return presence();
    }
    if (!ws.pseudo) return sendTo(ws, { type: "error", message: "choisissez d'abord un pseudo" });
    if (message.text === "/stop") return stop(ws.pseudo);
    post(ws.pseudo, message.text);
    if (/(^|\s)@ia\b/i.test(message.text)) ask(ws.pseudo);
  });
  ws.on("close", () => {
    if (ws.pseudo) post("salon", `${ws.pseudo} est parti.`);
    presence();
  });
});

const http = createServer(async (request, response) => {
  if (request.url === "/" || request.url === "/index.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(await readFile(new URL("./public/index.html", import.meta.url)));
    return;
  }
  response.writeHead(404).end();
});

http.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") return socket.destroy();
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

http.listen(PORT, () => {
  console.log(`Le Salon est prêt sur http://localhost:${PORT}`);
});
