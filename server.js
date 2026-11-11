import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BusData } from "./lib/busdata.js";
import { RouteSetupAgent } from "./lib/agent.js";
import { getArrivals } from "./lib/arrivals.js";
import { defaultTransport } from "./lib/sgtransport.js";
import { decide } from "./lib/decide.js";
import {
  trainLegData,
  serviceStatus,
  stationCrowd,
  checkTrainLeg,
  findTrainStation,
  stationSuggestions,
  trainErrorStatus,
  STATION_CODE,
  LINE_CODE,
  CROWD_LINES,
} from "./lib/trains.js";
import { sanitizeRoutes } from "./lib/routes.js";

// Load settings such as OPENCODE_API_KEY from .env (git-ignored), if present.
try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {}

const MOCK = process.env.MOCK === "1";
const PORT = Number(process.env.PORT) || 3000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(join(__dirname, "public"), { extensions: ["html"] }));

// --- Bus stop / service data (loaded lazily so the timings screen works even if it fails) ---
let busDataPromise = null;
function getBusData() {
  if (!busDataPromise) {
    busDataPromise = BusData.load({ mock: MOCK }).catch((err) => {
      busDataPromise = null; // retry next time
      throw err;
    });
  }
  return busDataPromise;
}
getBusData().then(
  (d) => console.log(`Loaded ${d.stops.size} stops, ${d.services.size} services${MOCK ? " (mock)" : ""}`),
  (err) => console.warn("Could not load bus stop data yet:", err.message),
);

let agent = null;
async function getAgent() {
  if (!agent) agent = new RouteSetupAgent({ busData: await getBusData(), transport: defaultTransport() });
  return agent;
}

// --- Live arrivals (arrivelah) ---
app.get("/api/arrivals/:code", async (req, res) => {
  const code = req.params.code;
  if (!/^\d{5}$/.test(code)) return res.status(400).json({ error: "Stop code must be 5 digits" });
  try {
    res.json(await getArrivals(code, { mock: MOCK }));
  } catch (err) {
    res.status(502).json({ error: `Arrival timings unavailable (${err.message})` });
  }
});

// --- Help me decide: AI compares saved routes using timings + rain forecast ---
app.post("/api/decide", async (req, res) => {
  const routes = sanitizeRoutes(req.body?.routes);
  if (!routes) return res.status(400).json({ error: "Invalid routes." });
  let busData = null;
  try {
    busData = await getBusData();
  } catch {
    // Weather matching needs stop coordinates; decide on timings alone without them.
  }
  try {
    sendResult(res, await decide(routes, { mock: MOCK, busData }));
  } catch (err) {
    console.error("Help me decide failed:", err);
    res.status(500).json({ error: "Couldn't compare routes. Your live timings still work." });
  }
});

// Results from decide() and the setup agent carry their own HTTP `status` when they're errors.
function sendResult(res, result) {
  const { status, ...body } = result;
  const failed = Boolean(body.error) || body.type === "error";
  res.status(failed ? status || 502 : 200).json(body);
}

// --- Trains (LTA timetable), service status and station crowding, via the MCP server ---
function trainsError(res, err) {
  res.status(trainErrorStatus(err)).json({ error: err.message });
}

app.get("/api/train-leg", async (req, res) => {
  const { from, to, line, crowdLine } = req.query;
  if (![from, to].every((c) => STATION_CODE.test(String(c))) || !LINE_CODE.test(String(line))) {
    return res.status(400).json({ error: "Need from, to (station codes such as NS17) and line (such as NSL)." });
  }
  const leg = {
    line: String(line),
    crowdLine: CROWD_LINES.includes(String(crowdLine)) ? String(crowdLine) : null,
    board: { code: String(from) },
    alight: { code: String(to) },
  };
  try {
    sendResult(res, await trainLegData(leg));
  } catch (err) {
    trainsError(res, err);
  }
});

app.get("/api/status", async (req, res) => {
  try {
    res.json(await serviceStatus());
  } catch (err) {
    trainsError(res, err);
  }
});

// Station crowd levels on a line (LTA): real-time and 30-minute forecast.
// GET /api/crowd/NSL?stations=NS17,NS24   (omit stations for the whole line)
app.get("/api/crowd/:line", async (req, res) => {
  const line = String(req.params.line).toUpperCase();
  const stations = String(req.query.stations || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!CROWD_LINES.includes(line)) {
    return res.status(400).json({ error: `Unknown line "${line.slice(0, 10)}". Use one of: ${CROWD_LINES.join(", ")}.` });
  }
  if (stations.length > 12 || !stations.every((s) => STATION_CODE.test(s))) {
    return res.status(400).json({ error: "Use up to 12 station codes such as NS17." });
  }
  try {
    res.json(await stationCrowd(line, stations));
  } catch (err) {
    trainsError(res, err);
  }
});

// Route editor: station name suggestions while typing ("bis" -> Bishan: NS17, CC15).
app.get("/api/trains/stations", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 40);
  if (q.length < 2) return res.json({ stations: [] });
  try {
    const found = await findTrainStation(q);
    res.json({ stations: stationSuggestions(found) });
  } catch (err) {
    // No matching station is a normal answer while typing; anything else is a real failure.
    trainErrorStatus(err) === 422 ? res.json({ stations: [] }) : trainsError(res, err);
  }
});

// Route editor: which lines run directly between two stations (names or codes).
app.get("/api/trains/check", async (req, res) => {
  const from = String(req.query.from || "").trim().slice(0, 40);
  const to = String(req.query.to || "").trim().slice(0, 40);
  if (!from || !to) return res.status(400).json({ error: "Enter both stations." });
  try {
    res.json(await checkTrainLeg(from, to));
  } catch (err) {
    trainsError(res, err);
  }
});

// --- Stop lookup (manual route entry) ---
app.get("/api/stops/:code", async (req, res) => {
  try {
    const s = (await getBusData()).stopSummary(req.params.code);
    s ? res.json(s) : res.status(404).json({ error: "Stop not found" });
  } catch {
    res.status(503).json({ error: "Stop data unavailable" });
  }
});

// --- Route setup agent ---
app.post("/api/setup/start", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ type: "error", message: "Describe your route first." });
  if (text.length > 2000) return res.status(400).json({ type: "error", message: "Please keep the description shorter." });
  try {
    sendResult(res, await (await getAgent()).start(text));
  } catch (err) {
    res.status(503).json({ type: "error", message: `Route setup unavailable: ${err.message}` });
  }
});

app.post("/api/setup/reply", async (req, res) => {
  const { sessionId, text } = req.body || {};
  if (!sessionId || !String(text || "").trim()) return res.status(400).json({ type: "error", message: "Missing answer." });
  try {
    sendResult(res, await (await getAgent()).reply(String(sessionId), String(text).slice(0, 1000)));
  } catch (err) {
    res.status(503).json({ type: "error", message: `Route setup unavailable: ${err.message}` });
  }
});

// --- Fallbacks: favicon, unknown API routes, and errors as JSON (never stack traces) ---
// Pages declare icon.svg, but some browsers and crawlers still ask for /favicon.ico.
app.get("/favicon.ico", (req, res) => res.redirect(301, "/icon.svg"));

app.use("/api", (req, res) => res.status(404).json({ error: `No such API endpoint: ${req.method} ${req.baseUrl}${req.path}` }));

// Body-parser errors (bad JSON, body too large) and anything thrown in a handler. Express's default
// handler would send an HTML page with the stack trace (server file paths) outside production.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  let message = "Something went wrong on the server.";
  if (err.type === "entity.parse.failed") message = "The request body isn't valid JSON.";
  else if (err.type === "entity.too.large") message = "The request is too large.";
  else if (status < 500 && err.expose) message = err.message;
  if (status >= 500) console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(status).json({ error: message });
});

// --- Official LTA data via the sg-transport MCP server (./mcp), if configured ---
const sgTransport = defaultTransport();
if (sgTransport) {
  sgTransport.warm(); // the Python server takes a couple of seconds to start
  console.log("Bus arrivals: LTA DataMall via the sg-transport MCP server (arrivelah as fallback)");
} else if (!MOCK) {
  console.log("Bus arrivals: arrivelah (set LTA_ACCOUNT_KEY in .env for official LTA data with bus crowding)");
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await sgTransport?.close().catch(() => {});
    process.exit(0);
  });
}

app.listen(PORT, () => console.log(`kakiRoute on http://localhost:${PORT}${MOCK ? " (MOCK data)" : ""}`));
