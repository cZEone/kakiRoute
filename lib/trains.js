// Train legs, service status (train disruptions + bus advisories) and station
// crowding, from the sg-transport MCP server. Shared by the API endpoints and
// "Help me decide". Train times are LTA's TIMETABLE: LTA publishes no live
// train arrivals, so every train time is labelled as scheduled.
import { defaultTransport } from "./sgtransport.js";

// The first train call makes the server download and index LTA's timetable (a few seconds).
const TRAIN_TIMEOUT_MS = 60_000;
const LEG_CACHE_MS = 30_000;
const STATUS_CACHE_MS = 30_000;
const CROWD_CACHE_MS = 60_000; // LTA updates real-time crowding every 10 minutes
const DEPARTURE_WINDOW_MIN = 120; // later legs of a route need trains well after "now"

export const STATION_CODE = /^[A-Z]{1,3}\d{0,3}$/; // NS17, DT1, STC, PE1
export const LINE_CODE = /^[A-Z]{2,4}$/; // NSL, DTL, BP, SLRT

export class TrainsUnavailable extends Error {}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function need(transport) {
  if (!transport) throw new TrainsUnavailable("Train timings and service alerts need official LTA data: set LTA_ACCOUNT_KEY.");
  return transport;
}

// Departures for one train leg plus the boarding station's crowd level (now and forecast).
// leg: { line, crowdLine, board: { code }, alight: { code } }
export async function trainLegData(leg, { transport = defaultTransport(), now = new Date() } = {}) {
  need(transport);
  const from = leg.board.code;
  const to = leg.alight.code;
  return cached(`leg:${leg.line}:${from}>${to}:${leg.crowdLine || ""}`, LEG_CACHE_MS, async () => {
    const [deps, crowd] = await Promise.allSettled([
      transport.call(
        "get_scheduled_train_departures",
        { station: from, to_station: to, line: leg.line, window_minutes: DEPARTURE_WINDOW_MIN, limit: 30 },
        { timeoutMs: TRAIN_TIMEOUT_MS },
      ),
      leg.crowdLine ? stationCrowd(leg.crowdLine, [from], { transport, now }) : null,
    ]);
    if (deps.status === "rejected") return { error: deps.reason?.message || "Train timetable unavailable" };
    const c = crowd.status === "fulfilled" ? crowd.value : null;
    return {
      kind: "scheduled",
      departures: (deps.value.departures || []).map((d) => ({ time: d.eta, towards: d.towards, line: d.line_code })),
      crowd: {
        now: c?.now[from] || Object.values(c?.now || {})[0] || null,
        forecast: c?.forecast[from] || Object.values(c?.forecast || {})[0] || [],
      },
    };
  });
}

// Station crowd levels on one line: LTA's real-time level (10-minute intervals) and its
// 30-minute forecast, for the given station codes (all stations on the line if none given).
// -> { line, now: { NS17: { level, from, to } }, forecast: { NS17: [{ start, level }] } }
export async function stationCrowd(crowdLine, stations = [], { transport = defaultTransport(), now = new Date() } = {}) {
  need(transport);
  const station = stations.join(",");
  return cached(`crowd:${crowdLine}:${station}`, CROWD_CACHE_MS, async () => {
    const scope = station ? { station } : {};
    const [current, forecast] = await Promise.allSettled([
      transport.call("get_station_crowd", { train_line: crowdLine, ...scope }),
      transport.call("get_station_crowd_forecast", { train_line: crowdLine, ...scope, hours_ahead: 3 }),
    ]);
    if (current.status === "rejected" && forecast.status === "rejected") throw current.reason;
    const nowByStation = {};
    for (const s of current.status === "fulfilled" ? current.value?.stations || [] : []) {
      nowByStation[s.station] = { level: s.crowd, from: s.from, to: s.to };
    }
    const forecastByStation = {};
    for (const [code, slots] of Object.entries(forecast.status === "fulfilled" ? forecast.value?.forecast || {} : {})) {
      forecastByStation[code] = slots.map((s) => ({ start: sgTimeToday(s.from, now), level: s.crowd }));
    }
    return { line: crowdLine, now: nowByStation, forecast: forecastByStation };
  });
}

// "15:30" -> ISO time today in Singapore.
function sgTimeToday(hhmm, now) {
  const day = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  return `${day}T${hhmm}:00+08:00`;
}

// Train line status plus bus services LTA reports as delayed or diverted.
export async function serviceStatus({ transport = defaultTransport() } = {}) {
  need(transport);
  return cached("status", STATUS_CACHE_MS, async () => {
    const s = await transport.call("get_train_service_alerts");
    return {
      trainStatus: s.status,
      statusCode: s.status_code,
      segments: (s.affected_segments || []).map((g) => ({
        line: g.line,
        lineName: g.line_name,
        direction: g.direction,
        stations: g.stations || [],
        freeBus: g.free_public_bus_at,
        freeShuttle: g.free_mrt_shuttle_at,
      })),
      messages: (s.messages || []).map((m) => m.content),
      busAdvisories: (s.bus_advisories || []).map((a) => ({
        services: a.services,
        kind: a.kind,
        delayUpToMin: a.delay_up_to_min,
        message: a.message,
      })),
    };
  });
}

// For the route editor and setup agent: which lines run directly from one station to another.
export async function checkTrainLeg(from, to, { transport = defaultTransport() } = {}) {
  need(transport);
  return transport.call("check_train_leg", { board_station: from, alight_station: to }, { timeoutMs: TRAIN_TIMEOUT_MS });
}

export async function findTrainStation(query, { transport = defaultTransport() } = {}) {
  need(transport);
  return transport.call("find_train_station", { query }, { timeoutMs: TRAIN_TIMEOUT_MS });
}

// find_train_station output -> [{ name: "Bishan", codes: ["NS17", "CC15"] }] for the editor's suggestions.
export function stationSuggestions(found) {
  const byName = new Map();
  for (const s of found?.stations || []) {
    const codes = byName.get(s.name) || new Set();
    if (s.code) codes.add(s.code);
    for (const p of s.platforms || []) {
      const code = String(p.stop_id || "").split("_")[0];
      if (STATION_CODE.test(code)) codes.add(code);
    }
    byName.set(s.name, codes);
  }
  return [...byName].map(([name, codes]) => ({ name, codes: [...codes].sort() })).slice(0, 10);
}

// check_train_leg option -> saved route leg.
export function trainLegFromOption(check, option, walkBeforeMin = 0) {
  return {
    mode: "train",
    service: option.line,
    line: option.line,
    lineName: option.line_name,
    crowdLine: option.crowd_line || null,
    towards: option.towards || null,
    board: { code: option.board_code, name: check.board },
    alight: { code: option.alight_code, name: check.alight },
    rideMin: option.ride_min,
    walkBeforeMin,
  };
}

export function clearTrainsCache() {
  cache.clear();
}
