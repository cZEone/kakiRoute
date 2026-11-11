// LTA data through the sg-transport MCP server: client, arrivals adapter and fallback,
// crowding in the timing plan and in "Help me decide" facts. All offline (fake MCP client).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SgTransport, SgTransportError } from "../lib/sgtransport.js";
import { getArrivals, fromLta, clearArrivalsCache } from "../lib/arrivals.js";
import { planRoute, arrivalBuses } from "../public/timing.js";
import { describeRoute } from "../lib/decide.js";

const NOW = new Date("2026-11-11T08:00:00+08:00");
const iso = (min) => new Date(NOW.getTime() + min * 60000).toISOString();

// What sg-transport's get_bus_arrivals returns (see mcp/src/sg_transport_mcp/server.py).
const LTA_OUT = {
  bus_stop_code: "90011",
  services: [
    {
      service_no: "901",
      operator: "SBS Transit",
      next_buses: [
        { eta: iso(1), live: true, load: "seats available", bus_type: "double deck", wheelchair_accessible: true },
        { eta: iso(5), live: false, load: "limited standing", bus_type: "single deck", wheelchair_accessible: false },
        { eta: iso(15), live: true, load: "standing available", bus_type: "bendy", wheelchair_accessible: true },
      ],
    },
  ],
};

function fakeTransport(handler) {
  const calls = [];
  const t = new SgTransport({
    log: () => {},
    connect: async () => ({
      callTool: async ({ name, arguments: args }) => {
        calls.push({ name, args });
        return handler(name, args);
      },
      close: async () => {},
    }),
  });
  t.calls = calls;
  return t;
}
const structured = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

beforeEach(() => clearArrivalsCache());

test("SgTransport returns structured content and turns tool errors into SgTransportError", async () => {
  const t = fakeTransport((name) =>
    name === "boom"
      ? { isError: true, content: [{ type: "text", text: "Error executing tool boom: LTA DataMall rejected the AccountKey (HTTP 401)." }] }
      : structured({ ok: true }),
  );
  assert.deepEqual(await t.call("get_train_service_alerts"), { ok: true });
  await assert.rejects(t.call("boom"), (err) => err instanceof SgTransportError && /^LTA DataMall rejected/.test(err.message));
});

test("SgTransport backs off after the server fails to start", async () => {
  let attempts = 0;
  const t = new SgTransport({
    log: () => {},
    connect: async () => {
      attempts++;
      throw new Error("uv: command not found");
    },
  });
  await assert.rejects(t.call("x"), /uv: command not found/);
  await assert.rejects(t.call("x"), /unavailable/);
  assert.equal(attempts, 1, "does not respawn on every request");
});

test("fromLta maps sg-transport output to arrivelah's shape", () => {
  const body = fromLta(LTA_OUT);
  assert.equal(body.source, "lta");
  const s = body.services[0];
  assert.equal(s.no, "901");
  assert.deepEqual(s.next, { time: iso(1), load: "SEA", monitored: 1, type: "DD", feature: "WAB" });
  assert.equal(s.next2.load, "LSD");
  assert.equal(s.next2.monitored, 0);
  assert.equal(s.next3.type, "BD");
});

test("getArrivals uses LTA via MCP, and caches", async () => {
  const t = fakeTransport(() => structured(LTA_OUT));
  const fetchImpl = () => assert.fail("arrivelah should not be called");
  const body = await getArrivals("90011", { transport: t, fetchImpl });
  assert.equal(body.source, "lta");
  await getArrivals("90011", { transport: t, fetchImpl });
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0], { name: "get_bus_arrivals", args: { bus_stop_code: "90011" } });
});

test("getArrivals falls back to arrivelah when the MCP server fails", async () => {
  const t = fakeTransport(() => ({ isError: true, content: [{ type: "text", text: "HTTP 503" }] }));
  const arrivelah = { services: [{ no: "901", next: { time: iso(3), load: "SDA", monitored: 1 } }] };
  const fetchImpl = async (url) => {
    assert.match(String(url), /arrivelah2\.busrouter\.sg\/\?id=90011$/);
    return { ok: true, json: async () => arrivelah };
  };
  const body = await getArrivals("90011", { transport: t, fetchImpl });
  assert.equal(body.source, "arrivelah");
  assert.equal(body.services[0].next.load, "SDA");
});

test("getArrivals with no MCP server configured goes straight to arrivelah", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ services: [] }) });
  assert.equal((await getArrivals("90011", { transport: null, fetchImpl })).source, "arrivelah");
});

test("planRoute carries the caught bus's crowding and live/scheduled flag", () => {
  const route = {
    walkFromHomeMin: 3,
    legs: [{ service: "901", board: { code: "90011" }, alight: { code: "90031" }, rideMin: 10, walkBeforeMin: 0 }],
  };
  const plan = planRoute(route, { "90011": fromLta(LTA_OUT) }, NOW);
  // At the stop at +3: the +1 bus is missed, so you catch the +5 bus (scheduled, limited standing).
  assert.equal(plan.legs[0].bus.toISOString(), iso(5));
  assert.equal(plan.legs[0].load, "LSD");
  assert.equal(plan.legs[0].live, false);
  // arrivelah-style bodies without these fields still work.
  const bare = arrivalBuses({ services: [{ no: "901", next: { time: iso(4) } }] }, "901");
  assert.deepEqual(bare, [{ time: new Date(iso(4)), load: null, live: null }]);
});

test("Help me decide facts mention crowding and schedule-only times", () => {
  const route = {
    name: "Work",
    walkFromHomeMin: 3,
    legs: [{ service: "901", board: { code: "90011", name: "Mock Blk 101" }, alight: { code: "90031", name: "Mock Bt Int" }, rideMin: 10, walkBeforeMin: 0 }],
  };
  const plan = planRoute(route, { "90011": fromLta(LTA_OUT) }, NOW);
  const text = describeRoute(route, plan, null, NOW, 1);
  assert.match(text, /Bus 901 .*bus in 5 min \(limited standing; operator schedule, not live GPS\)/);
});
