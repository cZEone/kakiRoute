// OpenCode Go connection (OpenAI-compatible chat completions API).
//
// Published guides disagree on the exact base URL, so unless OPENCODE_BASE_URL
// is set we try the known candidates and use the first one that lists models
// for this key. The model is OPENCODE_MODEL, or the first available model
// from a preference list of models that handle tool calling well.

import OpenAI from "openai";

const BASE_URL_CANDIDATES = [
  "https://opencode.ai/zen/go/v1",
  "https://opencode.ai/inference/go/openai/v1",
];

// Matched as substrings against the model IDs the account can use, in order.
const MODEL_PREFERENCE = ["kimi", "glm", "deepseek", "qwen"];

export function apiKey() {
  return process.env.OPENCODE_API_KEY || "";
}

export async function connect({ log = () => {} } = {}) {
  const key = apiKey();
  if (!key) throw new MissingKeyError();

  const candidates = process.env.OPENCODE_BASE_URL ? [process.env.OPENCODE_BASE_URL] : BASE_URL_CANDIDATES;
  const failures = [];
  for (const baseURL of candidates) {
    const client = new OpenAI({ apiKey: key, baseURL, timeout: 90_000, maxRetries: 1 });
    let ids = [];
    try {
      const list = await client.models.list();
      for await (const m of list) ids.push(m.id);
    } catch (err) {
      failures.push(`${baseURL}: ${err.status ?? ""} ${err.message}`.trim());
      continue;
    }
    const model = pickModel(ids);
    if (!model) {
      failures.push(`${baseURL}: no models available for this key`);
      continue;
    }
    log(`OpenCode Go: ${baseURL}, model ${model}`);
    return { client, baseURL, model, models: ids };
  }
  throw new Error(`Could not connect to OpenCode Go.\n  ${failures.join("\n  ")}`);
}

function pickModel(ids) {
  if (process.env.OPENCODE_MODEL) return process.env.OPENCODE_MODEL;
  for (const pref of MODEL_PREFERENCE) {
    const hit = ids.find((id) => id.toLowerCase().includes(pref));
    if (hit) return hit;
  }
  return ids[0] || null;
}

export class MissingKeyError extends Error {
  constructor() {
    super("OPENCODE_API_KEY is not set");
  }
}
