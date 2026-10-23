import OpenAI from "openai";

try {
  process.loadEnvFile();
} catch {
  // Node versions without process.loadEnvFile are supported by Docker too.
}

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

const baseURL = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

export const config = {
  apiKey: env("OPENAI_API_KEY", ""),
  baseURL,
  model: env("OPENAI_MODEL", "gpt-4.1-mini"),
};

export function requireKey(): string {
  if (!config.apiKey) {
    throw new Error("OPENAI_API_KEY manquante. Copiez .env.example dans .env et renseignez la clé.");
  }
  return config.apiKey;
}

export function openai(): OpenAI {
  return new OpenAI({ apiKey: requireKey(), baseURL: config.baseURL, timeout: 60_000, maxRetries: 3 });
}
