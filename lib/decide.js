// "Help me decide": compares the commuter's own saved routes right now, using
// live timings and the NEA 2-hour rain forecast, and suggests one.
//
// The timings themselves are computed in code (public/timing.js). The model
// only weighs the computed facts and explains its pick in one line.

import { randomUUID } from "node:crypto";
import { planRoute, isTrain, trainKey } from "../public/timing.js";
import { getArrivals } from "./arrivals.js";
import { trainLegData, serviceStatus } from "./trains.js";
import { twoHourForecast, forecastForStops } from "./weather.js";
import { sharedConnection } from "./llm.js";
import { describeApiError } from "./agent.js";

const FALLBACK = "Your live timings below still work.";

const SYSTEM = `You help a Singapore commuter choose which of THEIR OWN saved routes (bus and/or MRT/LRT train) to take right now. They are about to leave home.

You get, for each route, facts already computed from live bus arrivals, LTA's train timetable and service alerts, station crowding, and the NEA 2-hour weather forecast:
- when they would arrive, how long until they must leave, and how many spare minutes they have at each transfer;
- where they walk (home to first stop, between transfer stops, from the last stop onwards) and the forecast for the area of each of those stops;
- any missing data (no live timing, or a connection beyond the buses currently shown);
- LTA service alerts that affect a route: a disrupted train line, or a bus service LTA reports as delayed or diverted.

Weigh everything together:
- Earlier arrival is better, but a transfer with under 2 spare minutes is risky, and a leg with missing data is uncertain.
- Rain matters most where they walk. Waiting at a bus stop is usually sheltered; walking is not. More walking minutes in an area with showers or thundery showers is worse. Thundery showers are worse than light showers.
- A few minutes slower is worth it to stay dry; a large delay usually is not, unless there are thunderstorms.
- Bus crowding, where given: "limited standing" is a packed bus (uncomfortable, and it may not take more passengers at busy stops); "standing room" is a mild negative; "seats available" is best. It matters less than a missed connection.
- A bus time marked "operator schedule" is not from live GPS, so it is less certain than a live time.
- Train times are LTA's timetable (there are no live train arrivals) but trains run every few minutes, so they are reliable unless the line is disrupted.
- A disrupted train line on a route is a strong reason to avoid it. A bus LTA reports as delayed adds that delay risk to the leg.
- Station crowding ("high" = packed platform) is a mild negative, like a crowded bus.

Only choose among the routes given, by their number. Do not invent routes, stops or timings.

Reply with JSON only, no other text:
{"choice": <route number>, "headline": "<max 8 words, e.g. 'Walk to Blk 101 for the 961'>", "reason": "<one sentence, max 30 words, mentioning the deciding factor>", "notes": [{"route": <number>, "note": "<max 12 words on this route's main pro or con>"}]}`;

const LOAD_TEXT = { SEA: "seats available", SDA: "standing room", LSD: "limited standing" };

// " (limited standing; operator schedule, not live GPS)" for the bus the commuter would catch.
function busNote(p) {
  const bits = [];
  if (p.load) bits.push(LOAD_TEXT[p.load]);
  if (p.live === false) bits.push("operator schedule, not live GPS");
  return bits.length ? ` (${bits.join("; ")})` : "";
}

// " (timetable; station crowd high, forecast)" for the train the commuter would catch.
function trainNote(p) {
  const bits = ["timetable"];
  if (p.crowd) bits.push(`station crowd ${p.crowd.level}${p.crowd.source === "forecast" ? ", forecast" : ""}`);
  return ` (${bits.join("; ")})`;
}

// Everything planRoute needs for these routes: bus arrivals, train legs and service status.
export async function liveInputs(routes, { mock = false, transport } = {}) {
  const legs = routes.flatMap((r) => r.legs);
  const codes = [...new Set(legs.filter((l) => !isTrain(l)).map((l) => l.board.code))];
  const trainLegs = [...new Map(legs.filter(isTrain).map((l) => [trainKey(l), l])).values()];
  const opts = transport === undefined ? {} : { transport };
  const [arrivals, trains, status] = await Promise.all([
    Promise.all(codes.map(async (c) => [c, await getArrivals(c, { mock, ...opts }).catch((e) => ({ error: e.message }))])),
    Promise.all(trainLegs.map(async (l) => [trainKey(l), mock ? { error: "no trains in mock mode" } : await trainLegData(l, opts).catch((e) => ({ error: e.message }))])),
    mock ? null : serviceStatus(opts).catch(() => null),
  ]);
  return { arrivals: Object.fromEntries(arrivals), trains: Object.fromEntries(trains), status };
}

export async function decide(routes, { mock = false, busData = null, client = null, model = null, transport } = {}) {
  if (!Array.isArray(routes) || routes.length < 2) return { error: "Save at least two routes to compare." };

  const now = new Date();
  const { arrivals, trains, status } = await liveInputs(routes, { mock, transport });
  const plans = routes.map((r) => planRoute(r, arrivals, now, { trains, status }));

  let weather = null;
  try {
    const allStops = routes.flatMap((r) => r.legs.flatMap((l) => [l.board.code, l.alight.code]));
    const stopObjs = [...new Set(allStops)].map((c) => busData?.stop(c)).filter(Boolean);
    weather = forecastForStops(await twoHourForecast({ mock }), stopObjs);
  } catch (err) {
    console.warn("Weather unavailable:", err.message);
  }

  const facts = routes.map((r, i) => describeRoute(r, plans[i], weather, now, i + 1));
  const userMsg = [
    weather ? `NEA 2-hour forecast valid ${weather.validFor || "now"}.` : "Weather forecast unavailable right now; decide on timings alone and say so.",
    ...facts,
  ].join("\n\n");

  let conn;
  try {
    conn = client ? { client, decideModel: model || "test-model" } : await sharedConnection();
  } catch (err) {
    return { error: describeApiError(err, null, FALLBACK) };
  }

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userMsg },
  ];
  const opts = { headers: { "x-opencode-session": randomUUID() } };
  for (let attempt = 0; attempt < 2; attempt++) {
    let completion;
    try {
      completion = await conn.client.chat.completions.create({ model: conn.decideModel, messages }, opts);
    } catch (err) {
      console.warn(`Decision: ${conn.decideModel} request failed:`, err?.status, err?.message);
      return { error: describeApiError(err, conn.decideModel, FALLBACK) };
    }
    const text = completion.choices?.[0]?.message?.content || "";
    const parsed = parseDecision(text, routes.length);
    if (parsed) {
      return {
        ...parsed,
        model: conn.decideModel,
        decidedAt: now.toISOString(),
        weather: weatherSummary(weather),
      };
    }
    messages.push({ role: "assistant", content: text }, { role: "user", content: "Reply with the JSON object only, exactly in the format given." });
  }
  return { error: "The AI's answer couldn't be read. Try again." };
}

export function describeRoute(route, plan, weather, now, n) {
  const min = (d) => (d ? Math.round((d - now) / 60000) : null);
  const area = (code) => {
    const w = weather?.stopAreas?.[code];
    return w ? `${w.area}: ${w.forecast}` : "forecast unknown";
  };
  const lines = [`Route ${n}: "${route.name}"`];
  lines.push(`- Walk ${route.walkFromHomeMin} min from home to ${route.legs[0].board.name || route.legs[0].board.code} (${area(route.legs[0].board.code)})`);
  route.legs.forEach((leg, i) => {
    const p = plan.legs[i];
    const train = isTrain(leg);
    const what = train ? "train" : "bus";
    if (i > 0) lines.push(`- Walk ${leg.walkBeforeMin} min to ${leg.board.name || leg.board.code} (${area(leg.board.code)})`);
    let timing;
    if (!p) timing = "not reached (earlier leg has no timing)";
    else if (p.bus) {
      timing = i === 0 ? `${what} in ${min(p.bus)} min` : `${what} in ${min(p.bus)} min, ${p.waitMin} min spare at transfer`;
      timing += train ? trainNote(p) : busNote(p);
    } else if (p.state === "unavailable") timing = train ? "NO TIMETABLE DATA for this train leg" : "NO LIVE DATA for this stop";
    else if (p.state === "no-service") timing = train ? "no scheduled trains this way in the next 2 hours" : "service not reported at this stop right now";
    else timing = train ? "no scheduled train known after they reach the platform" : "would miss the buses shown; next bus time unknown";
    const label = train
      ? `Train ${leg.lineName || leg.line}${leg.towards ? ` towards ${leg.towards}` : ""}`
      : `Bus ${leg.service}`;
    lines.push(`- ${label} from ${leg.board.name || leg.board.code} to ${leg.alight.name || leg.alight.code}, ride ~${leg.rideMin} min: ${timing}`);
  });
  for (const a of plan.alerts || []) {
    const leg = route.legs[a.leg];
    lines.push(
      a.kind === "disruption"
        ? `- ALERT: ${leg.line} train service disrupted (LTA): ${a.text}`
        : `- ALERT: bus ${leg.service} ${a.kind}${a.delayUpToMin ? ` (up to ${a.delayUpToMin} min)` : ""} (LTA): ${a.text}`,
    );
  }
  const last = route.legs[route.legs.length - 1];
  lines.push(`- Final stop area: ${area(last.alight.code)}`);
  lines.push(
    plan.arriveAt
      ? `- Leave home in ${Math.max(0, min(plan.leaveBy))} min; arrive at final stop in about ${min(plan.arriveAt)} min`
      : "- Arrival time unknown (missing data)",
  );
  return lines.join("\n");
}

export function parseDecision(text, count) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const choice = Number(obj.choice);
  if (!Number.isInteger(choice) || choice < 1 || choice > count) return null;
  const notes = {};
  for (const n of Array.isArray(obj.notes) ? obj.notes : []) {
    const r = Number(n?.route);
    if (Number.isInteger(r) && r >= 1 && r <= count && n.note) notes[r - 1] = String(n.note).slice(0, 120);
  }
  return {
    choice: choice - 1,
    headline: String(obj.headline || "").slice(0, 80),
    reason: String(obj.reason || "").slice(0, 300),
    notes,
  };
}

function weatherSummary(weather) {
  if (!weather) return null;
  const areas = {};
  for (const w of Object.values(weather.stopAreas)) areas[w.area] = w.forecast;
  return { validFor: weather.validFor, areas: Object.entries(areas).map(([area, forecast]) => ({ area, forecast })) };
}
