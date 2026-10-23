import { config, requireKey } from "../src/config.js";
import { parseSSE } from "../tp2/sse.js";

export type Role = "system" | "user" | "assistant";
export type Msg = { role: Role; content: string };
export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export class HttpError extends Error {
  constructor(public status: number, public body: string, public retryAfterMs?: number) {
    super(`HTTP ${status} : ${body.slice(0, 200)}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    if (error.status === 429) return !/insufficient_quota/.test(error.body);
    return error.status === 408 || error.status >= 500;
  }
  if ((error as Error)?.name === "AbortError") return false;
  return true;
}

export class RateLimiter {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  pending = 0;

  constructor(private readonly minIntervalMs = 1000) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.pending--;
      return task();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= 4 || !isRetryable(error)) throw error;
      const fallback = Math.random() * Math.min(8000, 500 * 2 ** attempt);
      const wait = error instanceof HttpError && error.retryAfterMs ? error.retryAfterMs : fallback;
      await sleep(wait);
    }
  }
}

async function post(body: object, signal?: AbortSignal) {
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
    headers: { Authorization: `Bearer ${requireKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    throw new HttpError(response.status, await response.text(), retryAfter ? Number(retryAfter) * 1000 : undefined);
  }
  return response;
}

export const limiter = new RateLimiter(Number(process.env.MIN_INTERVAL_MS ?? 1000));

export async function* chatStream(
  messages: Msg[],
  options: { signal?: AbortSignal; temperature?: number; maxTokens?: number } = {},
): AsyncGenerator<{ delta: string } | { usage: Usage }> {
  const response = await withRetry(() => limiter.schedule(() => post({
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: options.temperature ?? 0.5,
    max_tokens: options.maxTokens,
  }, options.signal)));

  for await (const data of parseSSE(response.body!)) {
    const chunk = JSON.parse(data) as { error?: { message?: string }; choices?: { delta?: { content?: string } }[]; usage?: Usage };
    if (chunk.error) throw new HttpError(500, chunk.error.message ?? "Erreur pendant le flux");
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (delta) yield { delta };
    if (chunk.usage) yield { usage: chunk.usage };
  }
}
