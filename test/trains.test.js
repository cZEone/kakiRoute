// Phases 2-3: train legs (LTA timetable), station crowding, train disruptions and bus advisories.
// All offline: a fake sg-transport MCP client stands in for the Python server.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SgTransport } from "../lib/sgtransport.js";
import {
  trainLegData,
  serviceStatus,
  stationCrowd,
  stationSuggestions,
  checkTrainLeg,
  trainLegFromOption,
  clearTrainsCache,
  TrainsUnavailable,
  trainErrorStatus,
} from "../lib/trains.js";
import { sanitizeRoutes } from "../lib/routes.js";
import { planRoute, crowdAt, legAlert, alertLine, trainKey } from "../public/timing.js";
import { describeRoute } from "../lib/decide.js";
import { RouteSetupAgent } from "../lib/agent.js";
import { BusData } from "../lib/busdata.js";
import { clearArrivalsCache } from "../lib/arrivals.js";

const NOW = new Date("2026-11-11T08:00:00+08:00");
const at = (min) => new Date(NOW.getTime() + min * 60000).toISOString();

const TRAIN_LEG = {
  mode: "train",
  service: "NSL",
  line: "NSL",
  lineName: "North-South Line",
  crowdLine: "NSL",
  towards: "Marina South Pier",
  board: { code: "NS17", name: "Bishan" },
  alight: { code: "NS24", name: "Dhoby Ghaut" },
  rideMin: 15,
  walkBeforeMin: 0,
};

// MCP tool outputs, as the Python server returns them.
const MCP = {
  get_scheduled_train_departures: {
    kind: "scheduled timetable (not real-time)",
    departures: [3, 8, 13, 18].map((m) => ({ eta: at(m), line_code: "NSL", towards: "Marina South Pier" })),
  },
  get_station_crowd: { line: "NSL", stations: [{ station: "NS17", crowd: "high", from: at(-10), to: at(0) }] },
  get_station_crowd_forecast: {
    line: "NSL",
    forecast: { NS17: [{ from: "08:00", crowd: "high" }, { from: "08:30", crowd: "moderate" }, { from: "09:00", crowd: "low" }] },
  },
  get_train_service_alerts: {
    status: "disrupted service or major delays",
    status_code: 2,
    affected_segments: [{ line: "NSL", line_name: "North South Line", direction: "Both", stations: ["NS17", "NS18"], free_public_bus_at: "NS17,NS18", free_mrt_shuttle_at: null }],
    messages: [{ content: "0805hrs: NSL - No train service between Bishan and Braddell due to a track fault." }],
    bus_advisories: [{ services: ["901", "170X"], kind: "delay", delay_up_to_min: 20, message: "Bus services 901 and 170X are delayed by up to 20 minutes." }],
  },
  check_train_leg: {
    board: "Bishan",
    alight: "Dhoby Ghaut",
    options: [{ line: "NSL", line_name: "North-South Line", crowd_line: "NSL", direction_id: "1", towards: "Marina South Pier", board_code: "NS17", alight_code: "NS24", stops_travelled: 7, ride_min: 15, trains_today: 326 }],
  },
};

function fakeTransport(overrides = {}) {
  const calls = [];
  const t = new SgTransport({
    log: () => {},
    connect: async () => ({
      callTool: async ({ name, arguments: args }) => {
        calls.push({ name, args });
        const out = name in overrides ? overrides[name] : MCP[name];
        if (out instanceof Error) return { isError: true, content: [{ type: "text", text: out.message }] };
        return { structuredContent: out, content: [{ type: "text", text: JSON.stringify(out) }] };
      },
      close: async () => {},
    }),
  });
  t.calls = calls;
  return t;
}

beforeEach(() => {
  clearTrainsCache();
  clearArrivalsCache();
});

// ---- lib/trains.js --------------------------------------------------------------------------

test("trainLegData asks for departures towards the alight station, plus station crowd now and forecast", async () => {
  const t = fakeTransport();
  const data = await trainLegData(TRAIN_LEG, { transport: t, now: NOW });
  assert.equal(data.kind, "scheduled");
  assert.deepEqual(data.departures[0], { time: at(3), towards: "Marina South Pier", line: "NSL" });
  assert.equal(data.crowd.now.level, "high");
  assert.deepEqual(data.crowd.forecast[1], { start: "2026-11-11T08:30:00+08:00", level: "moderate" });
  const dep = t.calls.find((c) => c.name === "get_scheduled_train_departures");
  assert.deepEqual(dep.args, { station: "NS17", to_station: "NS24", line: "NSL", window_minutes: 120, limit: 30 });
  // cached
  await trainLegData(TRAIN_LEG, { transport: t, now: NOW });
  assert.equal(t.calls.filter((c) => c.name === "get_scheduled_train_departures").length, 1);
});

test("trainLegData: crowd failures are tolerated, a timetable failure is an error, no MCP server is TrainsUnavailable", async () => {
  const noCrowd = await trainLegData(TRAIN_LEG, { transport: fakeTransport({ get_station_crowd: new Error("x"), get_station_crowd_forecast: new Error("y") }), now: NOW });
  assert.equal(noCrowd.departures.length, 4);
  assert.deepEqual(noCrowd.crowd, { now: null, forecast: [] });
  clearTrainsCache();
  const broken = await trainLegData(TRAIN_LEG, { transport: fakeTransport({ get_scheduled_train_departures: new Error("No train station matches 'NS99'") }), now: NOW });
  assert.match(broken.error, /NS99/);
  await assert.rejects(trainLegData(TRAIN_LEG, { transport: null }), TrainsUnavailable);
});

test("serviceStatus maps disruptions and bus advisories", async () => {
  const s = await serviceStatus({ transport: fakeTransport() });
  assert.equal(s.statusCode, 2);
  assert.deepEqual(s.segments[0].stations, ["NS17", "NS18"]);
  assert.equal(s.segments[0].freeBus, "NS17,NS18");
  assert.deepEqual(s.busAdvisories[0].services, ["901", "170X"]);
  assert.equal(s.busAdvisories[0].delayUpToMin, 20);
});

test("checkTrainLeg + trainLegFromOption build a saved train leg", async () => {
  const check = await checkTrainLeg("Bishan", "Dhoby Ghaut", { transport: fakeTransport() });
  const leg = trainLegFromOption(check, check.options[0], 3);
  assert.deepEqual(leg, { ...TRAIN_LEG, walkBeforeMin: 3 });
});

// ---- public/timing.js -----------------------------------------------------------------------

test("planRoute: train leg catches the first scheduled train after reaching the platform", async () => {
  const data = await trainLegData(TRAIN_LEG, { transport: fakeTransport(), now: NOW });
  const route = { name: "MRT", walkFromHomeMin: 5, legs: [TRAIN_LEG] };
  const plan = planRoute(route, {}, NOW, { trains: { [trainKey(TRAIN_LEG)]: data } });
  const leg = plan.legs[0];
  // On the platform at +5: the +3 train is gone, catch +8.
  assert.equal(leg.bus.toISOString(), at(8));
  assert.equal(leg.scheduled, true);
  assert.equal(leg.live, false);
  assert.equal(leg.missedEarlier, 1);
  assert.equal(leg.towards, "Marina South Pier");
  assert.deepEqual(leg.crowd, { level: "high", source: "now" });
  assert.equal(plan.arriveAt.toISOString(), at(23));
  assert.equal(plan.leaveBy.toISOString(), at(3));
});

test("planRoute: bus then train, with transfer slack and the forecast crowd at boarding time", async () => {
  const data = await trainLegData(TRAIN_LEG, { transport: fakeTransport(), now: NOW });
  const busLeg = { service: "901", board: { code: "90011" }, alight: { code: "90031" }, rideMin: 20, walkBeforeMin: 0 };
  const train = { ...TRAIN_LEG, walkBeforeMin: 4 };
  const later = { ...data, departures: [25, 31, 36].map((m) => ({ time: at(m), towards: "Marina South Pier" })) };
  const arrivals = { "90011": { services: [{ no: "901", next: { time: at(4), load: "SDA", monitored: 1 } }] } };
  const plan = planRoute({ walkFromHomeMin: 3, legs: [busLeg, train] }, arrivals, NOW, { trains: { [trainKey(train)]: later } });
  // Bus at +4, ride 20 -> +24, walk 4 -> platform at +28: miss +25, catch +31 (3 min spare).
  assert.equal(plan.legs[1].bus.toISOString(), at(31));
  assert.equal(plan.legs[1].waitMin, 3);
  // Boarding at 08:31 is more than 15 min away, so the 08:30 forecast slot applies.
  assert.deepEqual(plan.legs[1].crowd, { level: "moderate", source: "forecast" });
  assert.equal(plan.legs[0].load, "SDA");
});

test("planRoute: missing or empty train data", () => {
  const route = { walkFromHomeMin: 0, legs: [TRAIN_LEG] };
  assert.equal(planRoute(route, {}, NOW).status, "unavailable");
  const key = trainKey(TRAIN_LEG);
  assert.equal(planRoute(route, {}, NOW, { trains: { [key]: { departures: [] } } }).status, "no-service");
  assert.equal(planRoute(route, {}, NOW, { trains: { [key]: { departures: [{ time: at(-5) }] } } }).status, "beyond-data");
});

test("crowdAt prefers real-time near now, else the 30-minute forecast slot", () => {
  const crowd = { now: { level: "low" }, forecast: [{ start: at(30), level: "high" }] };
  assert.deepEqual(crowdAt(crowd, new Date(at(10)), NOW), { level: "low", source: "now" });
  assert.deepEqual(crowdAt(crowd, new Date(at(45)), NOW), { level: "high", source: "forecast" });
  assert.equal(crowdAt(crowd, new Date(at(90)), NOW), null);
  assert.equal(crowdAt({ now: { level: "NA" }, forecast: [] }, NOW, NOW), null);
});

test("alerts: disrupted line and delayed bus mark the route, even without timings", async () => {
  const status = await serviceStatus({ transport: fakeTransport() });
  const busLeg = { service: "901", board: { code: "90011" }, alight: { code: "90031" }, rideMin: 10, walkBeforeMin: 0 };
  const plan = planRoute({ walkFromHomeMin: 0, legs: [busLeg, { ...TRAIN_LEG, walkBeforeMin: 3 }] }, {}, NOW, { status });
  assert.equal(plan.status, "unavailable"); // no timings at all is still the worst state
  assert.deepEqual(plan.alerts.map((a) => [a.leg, a.kind]), [[0, "delay"], [1, "disruption"]]);
  assert.deepEqual(plan.alerts[1].atYourStations, ["NS17"]);
  // With timings, a disruption outranks "ok".
  const arrivals = { "90011": { services: [{ no: "901", next: { time: at(2) } }] } };
  const busOnly = planRoute({ walkFromHomeMin: 0, legs: [busLeg] }, arrivals, NOW, { status });
  assert.equal(busOnly.status, "ok");
  assert.equal(busOnly.legs[0].alert.delayUpToMin, 20);
  const trainOnly = planRoute({ walkFromHomeMin: 0, legs: [TRAIN_LEG] }, {}, NOW, {
    status,
    trains: { [trainKey(TRAIN_LEG)]: { departures: [{ time: at(3) }] } },
  });
  assert.equal(trainOnly.status, "disrupted");
});

test("a disrupted line marks the leg itself, keeps transfer slack, and uses that line's LTA message", () => {
  const status = {
    segments: [
      { line: "CCL", lineName: "Circle Line", stations: ["CC10"] },
      { line: "NSL", lineName: "North South Line", stations: ["NS20"] },
    ],
    messages: ["0801hrs: CCL - No train service between Promenade and Bishan.", "0805hrs: NSL - Trains are delayed between Bishan and Novena."],
    busAdvisories: [],
  };
  const busLeg = { service: "901", board: { code: "90011" }, alight: { code: "90031" }, rideMin: 5, walkBeforeMin: 0 };
  const train = { ...TRAIN_LEG, walkBeforeMin: 1 };
  const arrivals = { "90011": { services: [{ no: "901", next: { time: at(1) } }] } };
  // Bus +1, ride 5 -> +6, walk 1 -> platform +7; train at +8 = 1 min spare (tight).
  const plan = planRoute({ walkFromHomeMin: 0, legs: [busLeg, train] }, arrivals, NOW, {
    status,
    trains: { [trainKey(train)]: { departures: [{ time: at(8) }] } },
  });
  assert.equal(plan.legs[0].state, "ok");
  assert.equal(plan.legs[1].state, "disrupted");
  assert.equal(plan.legs[1].tight, true);
  assert.equal(plan.status, "disrupted");
  assert.match(plan.alerts[0].text, /^0805hrs: NSL/, "the NSL leg gets the NSL message, not the first (CCL) one");
  // No message names the line -> generic text.
  const quiet = legAlert(TRAIN_LEG, { segments: [{ line: "NSL", lineName: "North South Line", stations: [] }], messages: ["0801hrs: CCL - delay"] });
  assert.equal(quiet.text, "North South Line: train service disrupted");
});

test("stationCrowd: per-station real-time and forecast for a line; one failing half is tolerated", async () => {
  const t = fakeTransport({
    get_station_crowd: { line: "NSL", stations: [{ station: "NS17", crowd: "low", from: at(-10), to: at(0) }, { station: "NS24", crowd: "high", from: at(-10), to: at(0) }] },
  });
  const c = await stationCrowd("NSL", ["NS17", "NS24"], { transport: t, now: NOW });
  assert.deepEqual(Object.keys(c.now), ["NS17", "NS24"]);
  assert.equal(c.now.NS24.level, "high");
  assert.deepEqual(c.forecast.NS17[0], { start: "2026-11-11T08:00:00+08:00", level: "high" });
  assert.deepEqual(t.calls.find((x) => x.name === "get_station_crowd").args, { train_line: "NSL", station: "NS17,NS24" });
  clearTrainsCache();
  const half = await stationCrowd("NSL", [], { transport: fakeTransport({ get_station_crowd_forecast: new Error("down") }), now: NOW });
  assert.deepEqual(half.forecast, {});
  assert.equal(half.now.NS17.level, "high");
  clearTrainsCache();
  await assert.rejects(stationCrowd("NSL", [], { transport: fakeTransport({ get_station_crowd: new Error("a"), get_station_crowd_forecast: new Error("b") }) }));
});

test("stationSuggestions groups platforms under one station name with its line codes", () => {
  const found = {
    stations: [
      { stop_id: "CC15", code: "CC15", name: "Bishan", platforms: [{ stop_id: "NS17_A" }, { stop_id: "NS17_B" }, { stop_id: "CC15_A" }] },
      { stop_id: "BRH", code: null, name: "Braddell", platforms: [{ stop_id: "NS18_A" }] },
    ],
  };
  assert.deepEqual(stationSuggestions(found), [
    { name: "Bishan", codes: ["CC15", "NS17"] },
    { name: "Braddell", codes: ["NS18"] },
  ]);
});

test("crowd window: real-time within 10 minutes of boarding, forecast after", () => {
  const crowd = { now: { level: "low" }, forecast: [{ start: at(0), level: "high" }] };
  assert.equal(crowdAt(crowd, new Date(at(10)), NOW).source, "now");
  assert.equal(crowdAt(crowd, new Date(at(11)), NOW).source, "forecast");
});

test("train errors map to HTTP statuses, and MCP validation details stay internal", async () => {
  assert.equal(trainErrorStatus(new TrainsUnavailable("x")), 503);
  assert.equal(trainErrorStatus(new Error("No train station matches 'ZZ99'.")), 422);
  assert.equal(trainErrorStatus(new Error("No direct train from A to B today.")), 422);
  assert.equal(trainErrorStatus(new Error("Could not reach LTA DataMall")), 502);
  const pydantic = new Error("1 validation error for get_station_crowdArguments\ntrain_line\n  Input should be 'CCL'");
  const t = fakeTransport({ get_station_crowd: pydantic, get_station_crowd_forecast: pydantic });
  await assert.rejects(stationCrowd("XYZ", [], { transport: t }), (err) => {
    assert.equal(err.message, "Invalid input for get_station_crowd.");
    assert.equal(trainErrorStatus(err), 400);
    return true;
  });
  // trainLegData reports the status with its error, so /api/train-leg can return it.
  clearTrainsCache();
  const unknown = await trainLegData(TRAIN_LEG, { transport: fakeTransport({ get_scheduled_train_departures: new Error("No train station matches 'NS17'.") }), now: NOW });
  assert.equal(unknown.status, 422);
});

test("alert line names: timetable codes map to LTA's alert codes", () => {
  assert.equal(alertLine("BP"), "BPL");
  assert.equal(alertLine("SK"), "STL");
  assert.equal(alertLine("PG"), "PTL");
  assert.equal(alertLine("nsl"), "NSL");
  const status = { segments: [{ line: "BPL", stations: [] }], messages: [] };
  assert.equal(legAlert({ ...TRAIN_LEG, line: "BP" }, status).kind, "disruption");
  assert.equal(legAlert(TRAIN_LEG, status), null);
});

// ---- server-side validation, decide facts, setup agent -------------------------------------

test("sanitizeRoutes keeps train legs and rejects bad station codes", () => {
  const ok = sanitizeRoutes([{ name: "MRT", walkFromHomeMin: 3, legs: [TRAIN_LEG] }]);
  assert.equal(ok[0].legs[0].mode, "train");
  assert.equal(ok[0].legs[0].crowdLine, "NSL");
  assert.equal(sanitizeRoutes([{ name: "x", legs: [{ ...TRAIN_LEG, board: { code: "<script>" } }] }]), null);
  assert.equal(sanitizeRoutes([{ name: "x", legs: [{ ...TRAIN_LEG, line: "north south" }] }]), null);
  // bus legs unchanged
  const bus = sanitizeRoutes([{ name: "b", legs: [{ service: "961", board: { code: "44009" }, alight: { code: "44331" } }] }]);
  assert.equal(bus[0].legs[0].mode, undefined);
});

test("Help me decide facts describe train legs, crowding and LTA alerts", async () => {
  const t = fakeTransport();
  const status = await serviceStatus({ transport: t });
  const data = await trainLegData(TRAIN_LEG, { transport: t, now: NOW });
  const route = { name: "MRT", walkFromHomeMin: 5, legs: [TRAIN_LEG] };
  const plan = planRoute(route, {}, NOW, { trains: { [trainKey(TRAIN_LEG)]: data }, status });
  const text = describeRoute(route, plan, null, NOW, 2);
  assert.match(text, /Train North-South Line towards Marina South Pier from Bishan to Dhoby Ghaut, ride ~15 min: train in 8 min \(timetable; station crowd high\)/);
  assert.match(text, /ALERT: NSL train service disrupted \(LTA\): 0805hrs/);
});

test("setup agent: check_train_leg is forwarded to MCP and a proposed train leg is built from it", async () => {
  const bus = await BusData.load({ mock: true });
  const tc = (id, name, input) => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
  const script = [
    { role: "assistant", content: null, tool_calls: [tc("t1", "check_train_leg", { board_station: "Bishan", alight_station: "Dhoby Ghaut" })] },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        tc("t2", "propose_route", {
          name: "Work by MRT",
          walk_from_home_min: 6,
          notes: "",
          legs: [
            { service: "901", board_code: "90011", alight_code: "90031", ride_min: 9, walk_before_min: 0 },
            { mode: "train", service: "NSL", board_code: "NS17", alight_code: "NS24", ride_min: 15, walk_before_min: 4 },
          ],
        }),
      ],
    },
  ];
  const sent = [];
  const client = {
    chat: {
      completions: {
        create: async (params) => {
          sent.push(structuredClone(params.messages));
          const message = script.shift();
          return { choices: [{ message, finish_reason: "tool_calls" }] };
        },
      },
    },
  };
  const transport = fakeTransport();
  const agent = new RouteSetupAgent({ busData: bus, client, transport });
  const res = await agent.start("901 to the interchange, then the MRT from Bishan to Dhoby Ghaut");
  assert.equal(res.type, "proposal", JSON.stringify(res));
  const toolReply = sent[1].find((m) => m.role === "tool" && m.tool_call_id === "t1");
  assert.match(toolReply.content, /Marina South Pier/);
  const [busLeg, trainLeg] = res.route.legs;
  assert.equal(busLeg.service, "901");
  assert.deepEqual(trainLeg, { ...TRAIN_LEG, walkBeforeMin: 4 });
});

test("setup agent: train tools without the MCP server give a clear error to the model", async () => {
  const bus = await BusData.load({ mock: true });
  const sent = [];
  const replies = [
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "check_train_leg", arguments: '{"board_station":"Bishan","alight_station":"Bugis"}' } }] },
    { role: "assistant", content: "Which stop?" },
  ];
  const client = { chat: { completions: { create: async (p) => (sent.push(structuredClone(p.messages)), { choices: [{ message: replies.shift(), finish_reason: "stop" }] }) } } };
  const agent = new RouteSetupAgent({ busData: bus, client, transport: null });
  await agent.start("MRT from Bishan to Bugis");
  const tool = sent[1].find((m) => m.role === "tool");
  assert.match(tool.content, /^Error: .*LTA_ACCOUNT_KEY/);
});
