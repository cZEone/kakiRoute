// Client for the sg-transport MCP server in ./mcp (official LTA DataMall + NEA data).
//
// The server runs as one long-lived child process over stdio, started on first
// use. kakiRoute calls its tools directly (no AI involved): the timings screen
// stays plain arithmetic on the data it returns.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const MCP_DIR = fileURLToPath(new URL("../mcp", import.meta.url));
const CALL_TIMEOUT_MS = 15_000;
const RETRY_AFTER_FAILURE_MS = 60_000; // don't respawn on every request if the server can't start

export class SgTransportError extends Error {}

export class SgTransport {
  // Pass `connect` (async () => ({ callTool, close })) to replace the real child process in tests.
  constructor({ command = "uv", args, env, connect, log = console.warn } = {}) {
    // --no-sync: another copy of the server (e.g. in Claude Code) may hold the venv's files open.
    this.command = command;
    this.args = args || ["--directory", MCP_DIR, "run", "--no-sync", "sg-transport-mcp"];
    this.env = env || childEnv();
    this.connectImpl = connect || null;
    this.log = log;
    this.client = null; // Promise<{ callTool, close }>
    this.failedAt = 0;
    this.lastError = null;
  }

  // Calls an MCP tool and returns its structured result. Throws SgTransportError on any failure.
  async call(name, args = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const client = await this.#client();
    let res;
    try {
      res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (err) {
      throw new SgTransportError(`${name} failed: ${err?.message || err}`);
    }
    const text = res?.content?.find?.((c) => c.type === "text")?.text || "";
    if (res?.isError) throw new SgTransportError(text.replace(/^Error executing tool \S+: /, "") || `${name} failed`);
    if (res?.structuredContent) return res.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      throw new SgTransportError(`${name} returned no data`);
    }
  }

  // Start the server ahead of the first request (it takes a couple of seconds).
  warm() {
    this.#client().catch(() => {});
  }

  async close() {
    const pending = this.client;
    this.client = null;
    if (pending) await (await pending.catch(() => null))?.close?.();
  }

  #client() {
    if (this.client) return this.client;
    if (this.failedAt && Date.now() - this.failedAt < RETRY_AFTER_FAILURE_MS) {
      return Promise.reject(new SgTransportError(`sg-transport MCP server unavailable: ${this.lastError}`));
    }
    this.client = (this.connectImpl ? this.connectImpl() : this.#spawn()).then(
      (client) => {
        this.failedAt = 0;
        return client;
      },
      (err) => {
        this.client = null;
        this.failedAt = Date.now();
        this.lastError = err?.message || String(err);
        this.log(`sg-transport MCP server failed to start: ${this.lastError}. Run "npm run mcp:setup" once (needs uv).`);
        throw new SgTransportError(`sg-transport MCP server unavailable: ${this.lastError}`);
      },
    );
    return this.client;
  }

  async #spawn() {
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.env,
      stderr: process.env.SG_TRANSPORT_DEBUG ? "inherit" : "ignore",
    });
    const client = new Client({ name: "kakiroute", version: "1.0.0" });
    // If the child exits, forget it so the next call starts a fresh one.
    transport.onclose = () => {
      this.client = null;
    };
    await client.connect(transport);
    return client;
  }
}

// Only what the server needs: never hand it unrelated secrets such as OPENCODE_API_KEY.
function childEnv() {
  const env = getDefaultEnvironment();
  for (const key of ["LTA_ACCOUNT_KEY", "DATA_GOV_SG_API_KEY", "UV_CACHE_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

let shared;
// The app-wide server, or null when it shouldn't run (mock mode, no LTA key, or SG_TRANSPORT=off).
export function defaultTransport() {
  if (shared !== undefined) return shared;
  const off = process.env.MOCK === "1" || process.env.SG_TRANSPORT === "off" || !process.env.LTA_ACCOUNT_KEY;
  shared = off ? null : new SgTransport();
  return shared;
}
