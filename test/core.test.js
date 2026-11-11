import { test } from "node:test";
import assert from "node:assert/strict";
import { BusData } from "../lib/busdata.js";
import { RouteSetupAgent } from "../lib/agent.js";
import { planRoute, arrivalTimes } from "../public/timing.js";

const bus = await BusData.load({ mock: true });

test("searchStops understands abbreviations and service filter", () => {
  const hits = bus.searchStops("opposite mock bukit interchange");
  assert.equal(hits[0].code, "90032");
  const only905 = bus.searchStops("mock bt int", { service: "905" });
  assert.ok(only905.every((s) => s.services.includes("905")));
});

test("checkLeg enforces direction", () => {
  assert.equal(bus.checkLeg("901", "90011", "90031").ok, true);
  const wrong = bus.checkLeg("901", "90031", "90011");
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /in that order|does not stop/);
});

const route = {
  name: "Work",
  walkFromHomeMin: 3,
  legs: [
    { service: "901", board: { code: "90011" }, alight: { code: "90031" }, rideMin: 10, walkBeforeMin: 0 },
    { service: "905", board: { code: "90032" }, alight: { code: "90051" }, rideMin: 15, walkBeforeMin: 1 },
  ],
};
const at = (now, min) => ({ time: new Date(now.getTime() + min * 60000).toISOString() });

test("planRoute chains legs and flags tight transfers", () => {
  const now = new Date("2026-11-11T08:00:00+08:00");
  const arrivals = {
    "90011": { services: [{ no: "901", next: at(now, 1), next2: at(now, 5), next3: at(now, 15) }] },
    "90032": { services: [{ no: "905", next: at(now, 10), next2: at(now, 17), next3: at(now, 30) }] },
  };
  const plan = planRoute(route, arrivals, now);
  // At stop at +3, so the +1 bus is missed; catch +5. Alight +15, walk 1 -> +16, catch +17 (1 min spare = tight).
  assert.equal(plan.legs[0].bus.getTime(), now.getTime() + 5 * 60000);
  assert.equal(plan.legs[0].missedEarlier, 1);
  assert.equal(plan.legs[1].waitMin, 1);
  assert.equal(plan.status, "tight");
  assert.equal(plan.arriveAt.getTime(), now.getTime() + 32 * 60000);
});

test("planRoute reports unavailable and beyond-data", () => {
  const now = new Date();
  assert.equal(planRoute(route, { "90011": { error: "x" } }, now).status, "unavailable");
  const arrivals = {
    "90011": { services: [{ no: "901", next: at(now, 4) }] },
    "90032": { services: [{ no: "905", next: at(now, 2) }] },
  };
  assert.equal(planRoute(route, arrivals, now).status, "beyond-data");
  assert.equal(arrivalTimes({ services: [] }, "901"), null);
});

// Scripted fake of client.chat.completions.create to exercise the agent loop.
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(structuredClone(params.messages));
          const message = script.shift();
          return { choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] };
        },
      },
    },
  };
}
const tc = (id, name, input) => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
const turn = (...tool_calls) => ({ role: "assistant", content: null, tool_calls });

test("agent: search -> ask -> propose, every tool call answered", async () => {
  const client = fakeClient([
    turn(tc("t1", "search_stops", { query: "Mock Blk 101", service: "901" })),
    turn(tc("t2", "check_leg", { service: "901", board_code: "90011", alight_code: "90031" }), tc("t3", "ask_user", { question: "Which side?", options: ["A", "B"] })),
    turn(tc("t4", "propose_route", {
      name: "Work", walk_from_home_min: 4, notes: "Assumed 1 min walk.",
      legs: [
        { service: "901", board_code: "90011", alight_code: "90031", ride_min: 9, walk_before_min: 0 },
        { service: "905", board_code: "90032", alight_code: "90051", ride_min: 14, walk_before_min: 1 },
      ],
    })),
  ]);
  const agent = new RouteSetupAgent({ busData: bus, client });
  const q = await agent.start("901 from my block then 905 to the office");
  assert.equal(q.type, "question");
  assert.deepEqual(q.options, ["A", "B"]);

  const p = await agent.reply(q.sessionId, "A");
  // After the answer, both t2 and t3 must have tool messages following the assistant turn.
  const sent = client.calls[2];
  assert.equal(sent[0].role, "system");
  const toolIds = sent.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(toolIds.sort(), ["t1", "t2", "t3"]);
  assert.match(sent.at(-1).content, /Commuter answered: A/);
  assert.equal(p.type, "proposal");
  assert.equal(p.route.legs[1].board.name, "Opp Mock Bt Int");
  assert.equal(p.route.walkFromHomeMin, 4);
});

test("agent: invalid proposal and bad JSON are sent back as tool errors", async () => {
  const client = fakeClient([
    turn(
      tc("t1", "propose_route", { name: "x", walk_from_home_min: 3, notes: "", legs: [{ service: "901", board_code: "90031", alight_code: "90011", ride_min: 5, walk_before_min: 0 }] }),
      { id: "t2", type: "function", function: { name: "search_stops", arguments: "{oops" } },
    ),
    { role: "assistant", content: "Which stop do you board at?" },
  ]);
  const agent = new RouteSetupAgent({ busData: bus, client });
  const res = await agent.start("901 backwards");
  assert.equal(res.type, "question");
  const tools = client.calls[1].filter((m) => m.role === "tool");
  assert.equal(tools.length, 2);
  assert.ok(tools.every((m) => m.content.startsWith("Error:")));
});

test("agent: missing key gives a friendly message", async () => {
  const saved = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  const agent = new RouteSetupAgent({ busData: bus });
  const res = await agent.start("anything");
  assert.equal(res.type, "error");
  assert.match(res.message, /OPENCODE_API_KEY/);
  if (saved) process.env.OPENCODE_API_KEY = saved;
});

test("agent: retries without reasoning_content when the provider rejects it", async () => {
  const { default: OpenAI } = await import("openai");
  const calls = [];
  const replies = [
    { role: "assistant", content: null, reasoning_content: "thinking...", tool_calls: [tc("t1", "search_stops", { query: "Mock Blk 101" })] },
    { role: "assistant", content: "Which stop?" },
  ];
  const client = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          calls.push(messages);
          if (messages.some((m) => m.reasoning_content)) throw new OpenAI.BadRequestError(400, { message: "unknown field reasoning_content" }, "bad", new Headers());
          const message = replies.shift();
          return { choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] };
        },
      },
    },
  };
  const res = await new RouteSetupAgent({ busData: bus, client }).start("901 from Mock Blk 101");
  assert.equal(res.type, "question");
  assert.equal(calls.length, 3); // first ok, second rejected with reasoning, retried without
  const assistant = calls[2].find((m) => m.role === "assistant");
  assert.equal(assistant.content, null);
});
