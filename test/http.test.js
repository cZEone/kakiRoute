// HTTP status codes and error bodies of the real server (MOCK=1, no AI or LTA keys).
// Guards the fixes from the demo's HTTP check: right status per failure, JSON errors, no stack traces.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 41000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
let server;

before(async () => {
  // Empty keys: Node's .env loading never overrides variables that are already set.
  const env = { ...process.env, MOCK: "1", PORT: String(PORT), OPENCODE_API_KEY: "", LTA_ACCOUNT_KEY: "" };
  server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15000);
    const onData = (d) => {
      log += d;
      if (log.includes(`localhost:${PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.on("exit", (code) => reject(new Error(`server exited (${code}):\n${log}`)));
  });
});

after(() => server?.kill());

async function req(path, { method = "GET", body, raw, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: body !== undefined || raw !== undefined ? { "content-type": "application/json", ...headers } : headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, type: res.headers.get("content-type") || "", location: res.headers.get("location"), text, json };
}

const busRoute = (name) => ({ name, legs: [{ service: "901", board: { code: "90011" }, alight: { code: "90031" } }] });

function assertJsonError(r, status) {
  assert.equal(r.status, status, r.text);
  assert.match(r.type, /application\/json/);
  assert.equal(typeof (r.json?.error ?? r.json?.message), "string");
  assert.doesNotMatch(r.text, /node_modules|at [A-Za-z.]+ \(|\\Users\\/, "no stack traces or file paths");
}

test("Help me decide: 503 when the AI isn't configured, 400 for fewer than two routes", async () => {
  const noKey = await req("/api/decide", { method: "POST", body: { routes: [busRoute("a"), busRoute("b")] } });
  assertJsonError(noKey, 503);
  assert.match(noKey.json.error, /OPENCODE_API_KEY/);
  assert.equal(noKey.json.status, undefined, "status is the HTTP code, not part of the body");
  assertJsonError(await req("/api/decide", { method: "POST", body: { routes: [busRoute("a")] } }), 400);
  assertJsonError(await req("/api/decide", { method: "POST", body: { routes: "x" } }), 400);
});

test("AI route setup: 503 without a key, 404 for an expired chat, 400 for an empty description", async () => {
  const start = await req("/api/setup/start", { method: "POST", body: { text: "190 to Orchard" } });
  assertJsonError(start, 503);
  assert.equal(start.json.type, "error");
  assertJsonError(await req("/api/setup/reply", { method: "POST", body: { sessionId: "nope", text: "A" } }), 404);
  assertJsonError(await req("/api/setup/start", { method: "POST", body: { text: "" } }), 400);
});

test("bad JSON and oversized bodies get JSON errors, never stack traces", async () => {
  const bad = await req("/api/decide", { method: "POST", raw: "{bad" });
  assertJsonError(bad, 400);
  assert.equal(bad.json.error, "The request body isn't valid JSON.");
  const big = await req("/api/decide", { method: "POST", raw: JSON.stringify({ routes: "a".repeat(40000) }) });
  assertJsonError(big, 413);
});

test("unknown API routes are JSON 404s", async () => {
  const r = await req("/api/nope");
  assertJsonError(r, 404);
  assert.match(r.json.error, /GET \/api\/nope/);
});

test("crowd: unknown line is a 400 listing valid lines; without LTA data it's a 503", async () => {
  const xyz = await req("/api/crowd/XYZ");
  assertJsonError(xyz, 400);
  assert.match(xyz.json.error, /NSL/);
  assertJsonError(await req("/api/crowd/NSL?stations=NS17"), 503);
});

test("train endpoints without LTA data are 503s; bad parameters are 400s", async () => {
  assertJsonError(await req("/api/train-leg?from=NS17&to=NS24&line=NSL"), 503);
  assertJsonError(await req("/api/train-leg?from=%3Cx%3E&to=NS24&line=NSL"), 400);
  assertJsonError(await req("/api/trains/check?from=Bishan&to=Bugis"), 503);
  assertJsonError(await req("/api/status"), 503);
  assertJsonError(await req("/api/arrivals/abc"), 400);
});

test("/favicon.ico redirects to the SVG icon", async () => {
  const r = await req("/favicon.ico");
  assert.equal(r.status, 301);
  assert.equal(r.location, "/icon.svg");
  assert.equal((await req("/icon.svg")).status, 200);
});
