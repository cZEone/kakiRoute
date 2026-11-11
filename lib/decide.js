// "Help me decide": compares the commuter's own saved routes right now, using
// live timings and the NEA 2-hour rain forecast, and suggests one.
//
// The timings themselves are computed in code (public/timing.js). The model
// only weighs the computed facts and explains its pick in one line.

import { randomUUID } from "node:crypto";
import { planRoute } from "../public/timing.js";
import { getArrivals } from "./arrivals.js";
import { twoHourForecast, forecastForStops } from "./weather.js";
import { sharedConnection } from "./llm.js";
import { describeApiError } from "./agent.js";

const FALLBACK = "Your live timings below still work.";

const SYSTEM = `You help a Singapore bus commuter choose which of THEIR OWN saved routes to take right now. They are about to leave home.

You get, for each route, facts already computed from live bus arrivals and the NEA 2-hour weather forecast:
- when they would arrive, how long until they must leave, and how many spare minutes they have at each transfer;
- where they walk (home to first stop, between transfer stops, from the last stop onwards) and the forecast for the area of each of those stops;
- any missing data (no live timing, or a connection beyond the buses currently shown).

Weigh everything together:
- Earlier arrival is better, but a transfer with under 2 spare minutes is risky, and a leg with missing data is uncertain.
- Rain matters most where they walk. Waiting at a bus stop is usually sheltered; walking is not. More walking minutes in an area with showers or thundery showers is worse. Thundery showers are worse than light showers.
- A few minutes slower is worth it to stay dry; a large delay usually is not, unless there are thunderstorms.

Only choose among the routes given, by their number. Do not invent routes, stops or timings.

Reply with JSON only, no other text:
{"choice": <route number>, "headline": "<max 8 words, e.g. 'Walk to Blk 101 for the 961'>", "reason": "<one sentence, max 30 words, mentioning the deciding factor>", "notes": [{"route": <number>, "note": "<max 12 words on this route's main pro or con>"}]}`;

export async function decide(routes, { mock = false, busData = null, client = null, model = null } = {}) {
  if (!Array.isArray(routes) || routes.length < 2) return { error: "Save at least two routes to compare." };

  const now = new Date();
  const codes = [...new Set(routes.flatMap((r) => r.legs.map((l) => l.board.code)))];
  const arrivals = Object.fromEntries(
    await Promise.all(codes.map(async (c) => [c, await getArrivals(c, { mock }).catch((e) => ({ error: e.message }))])),
  );
  const plans = routes.map((r) => planRoute(r, arrivals, now));

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

function describeRoute(route, plan, weather, now, n) {
  const min = (d) => (d ? Math.round((d - now) / 60000) : null);
  const area = (code) => {
    const w = weather?.stopAreas?.[code];
    return w ? `${w.area}: ${w.forecast}` : "forecast unknown";
  };
  const lines = [`Route ${n}: "${route.name}"`];
  lines.push(`- Walk ${route.walkFromHomeMin} min from home to ${route.legs[0].board.name || route.legs[0].board.code} (${area(route.legs[0].board.code)})`);
  route.legs.forEach((leg, i) => {
    const p = plan.legs[i];
    if (i > 0) lines.push(`- Walk ${leg.walkBeforeMin} min to ${leg.board.name || leg.board.code} (${area(leg.board.code)})`);
    let timing;
    if (!p) timing = "not reached (earlier leg has no timing)";
    else if (p.bus) timing = i === 0 ? `bus in ${min(p.bus)} min` : `bus in ${min(p.bus)} min, ${p.waitMin} min spare at transfer`;
    else if (p.state === "unavailable") timing = "NO LIVE DATA for this stop";
    else if (p.state === "no-service") timing = "service not reported at this stop right now";
    else timing = "would miss the buses shown; next bus time unknown";
    lines.push(`- Bus ${leg.service} from ${leg.board.name || leg.board.code} to ${leg.alight.name || leg.alight.code}, ride ~${leg.rideMin} min: ${timing}`);
  });
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
