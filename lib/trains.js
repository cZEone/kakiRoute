// Train legs, service status (train disruptions + bus advisories) and station
// crowding, from the sg-transport MCP server. Shared by the API endpoints and
// "Help me decide". Train times are LTA's TIMETABLE: LTA publishes no live
// train arrivals, so every train time is labelled as scheduled.
import { defaultTransport } from "./sgtransport.js";

// The first train call makes the server download and index LTA's timetable (a few seconds).
const TRAIN_TIMEOUT_MS = 60_000;
const LEG_CACHE_MS = 30_000;
const STATUS_CACHE_MS = 30_000;
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
    const [deps, crowdNow, forecast] = await Promise.allSettled([
      transport.call(
        "get_scheduled_train_departures",
        { station: from, to_station: to, line: leg.line, window_minutes: DEPARTURE_WINDOW_MIN, limit: 30 },
        { timeoutMs: TRAIN_TIMEOUT_MS },
      ),
      leg.crowdLine ? transport.call("get_station_crowd", { train_line: leg.crowdLine, station: from }) : null,
      leg.crowdLine ? transport.call("get_station_crowd_forecast", { train_line: leg.crowdLine, station: from, hours_ahead: 3 }) : null,
    ]);
    if (deps.status === "rejected") return { error: deps.reason?.message || "Train timetable unavailable" };
    const station = crowdNow.status === "fulfilled" ? crowdNow.value?.stations?.[0] : null;
    const slots = forecast.status === "fulfilled" ? forecast.value?.forecast?.[from] || Object.values(forecast.value?.forecast || {})[0] || [] : [];
    return {
      kind: "scheduled",
      departures: (deps.value.departures || []).map((d) => ({ time: d.eta, towards: d.towards, line: d.line_code })),
      crowd: {
        now: station ? { level: station.crowd, from: station.from, to: station.to } : null,
        forecast: slots.map((s) => ({ start: sgTimeToday(s.from, now), level: s.crowd })),
      },
    };
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
