// Route-setup agent: turns "I take 961 from outside my block, change at
// Bt Panjang Int to 975..." into a saved route with real stop codes.
//
// The agent never decides which route is better. It only resolves what the
// commuter described, asks when something is ambiguous, and hands back a
// proposal that the commuter confirms or edits before saving.

import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { connect, MissingKeyError } from "./llm.js";

const MAX_STEPS = 16;
const SESSION_TTL_MS = 30 * 60 * 1000;

const SYSTEM = `You help a Singapore bus commuter save one of their own preferred bus routes, so an app can show live timings for it.

The commuter describes the route in their own words. Your job is to turn that into exact data:
- which bus service they board, at which stop (5-digit stop code), and where they alight, for every leg;
- how many minutes they walk from home to the first stop;
- for each later leg, how many minutes they walk from the previous alighting stop to the next boarding stop (0 if it is the same stop).

How to work:
- Use search_stops to find stops. Pass the service number when you know it: it narrows the results to stops that service actually serves.
- Stops come in pairs on opposite sides of a road ("Blk 123" and "Opp Blk 123"). Use check_leg to find which side runs in the commuter's direction of travel rather than guessing.
- When a transfer involves walking ("walk across", "walk to the other stop"), use stops_near on the alighting stop to find the boarding stop.
- Call check_leg for every leg before proposing. It also gives a ride-time estimate you should use.
- Use the commuter's own words for walk times if they gave them. Otherwise use walk_min from tools; for home -> first stop, use 3 minutes if they said nothing.
- Call ask_user only when you genuinely cannot resolve something from the tools: for example, two equally plausible stops, or a service that does not serve the place they named. Ask one short question at a time and offer the candidate stops as options, written as "<name> (<code>)".
- When every leg checks out, call propose_route. The commuter will review and edit it before saving.

Never compare, rate or recommend routes, and never suggest a different route from the one they described. If what they described cannot work (the service does not run there), say so plainly through ask_user and let them correct it.`;

const TOOLS = [
  {
    name: "search_stops",
    description:
      "Search bus stops by name, road, landmark or 5-digit code. Understands abbreviations (Blk, Opp, Bt, Int, Stn, Aft, Bef). Returns up to 10 stops with the services that stop there.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "e.g. 'Opp Blk 123', 'Bukit Panjang Int', '44009'" },
        service: { type: "string", description: "Optional service number; only return stops this service serves." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "stops_near",
    description: "List bus stops within walking distance of a stop, with walking minutes and the services at each.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "5-digit stop code" },
        radius_m: { type: "integer", description: "Search radius in metres (default 300, max 800)" },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "get_service",
    description: "Get a bus service's stops in order, for each direction.",
    input_schema: {
      type: "object",
      properties: { service: { type: "string" } },
      required: ["service"],
      additionalProperties: false,
    },
  },
  {
    name: "check_leg",
    description:
      "Check that a service runs from the boarding stop to the alighting stop in that order. Returns the direction, number of stops and a ride-time estimate, or an error explaining what is wrong.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        board_code: { type: "string" },
        alight_code: { type: "string" },
      },
      required: ["service", "board_code", "alight_code"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the commuter one short clarifying question. Use only when tools cannot resolve the ambiguity. The conversation pauses until they answer.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, description: "Optional short answer choices" },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_route",
    description: "Propose the finished route for the commuter to confirm. Every leg must already pass check_leg.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short label in the commuter's words, e.g. 'Work via Bt Panjang Int'" },
        walk_from_home_min: { type: "integer" },
        legs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              service: { type: "string" },
              board_code: { type: "string" },
              alight_code: { type: "string" },
              ride_min: { type: "integer" },
              walk_before_min: {
                type: "integer",
                description: "Minutes walking from the previous leg's alighting stop to this boarding stop. 0 for the first leg.",
              },
            },
            required: ["service", "board_code", "alight_code", "ride_min", "walk_before_min"],
            additionalProperties: false,
          },
        },
        notes: { type: "string", description: "One or two sentences on anything you assumed, for the commuter to double-check." },
      },
      required: ["name", "walk_from_home_min", "legs", "notes"],
      additionalProperties: false,
    },
  },
];

// Chat-completions tool format.
const FUNCTIONS = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

export class RouteSetupAgent {
  // Pass { client, model } to skip auto-connecting (used by tests).
  constructor({ busData, client, model } = {}) {
    this.bus = busData;
    this.conn = client ? Promise.resolve({ client, model: model || "test-model" }) : null;
    this.sessions = new Map();
  }

  #connection() {
    if (!this.conn) {
      this.conn = connect({ log: console.log }).catch((err) => {
        this.conn = null; // retry on the next request
        throw err;
      });
    }
    return this.conn;
  }

  async start(description) {
    const id = randomUUID();
    const session = { id, messages: [{ role: "system", content: SYSTEM }], pendingToolUseId: null, touched: Date.now() };
    this.sessions.set(id, session);
    this.#gc();
    session.messages.push({ role: "user", content: String(description) });
    return { sessionId: id, ...(await this.#run(session)) };
  }

  async reply(sessionId, answer) {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, type: "error", message: "This setup chat expired. Please start again." };
    session.touched = Date.now();
    if (session.pendingToolUseId) {
      session.messages.push({ role: "tool", tool_call_id: session.pendingToolUseId, content: `Commuter answered: ${answer}` });
      session.pendingToolUseId = null;
    } else {
      session.messages.push({ role: "user", content: String(answer) });
    }
    return { sessionId, ...(await this.#run(session)) };
  }

  async #run(session) {
    let conn;
    try {
      conn = await this.#connection();
    } catch (err) {
      return { type: "error", message: describeApiError(err) };
    }

    for (let step = 0; step < MAX_STEPS; step++) {
      let completion;
      try {
        completion = await conn.client.chat.completions.create({
          model: conn.model,
          messages: session.messages,
          tools: FUNCTIONS,
          tool_choice: "auto",
          max_tokens: 8000,
        });
      } catch (err) {
        return { type: "error", message: describeApiError(err) };
      }

      const choice = completion.choices?.[0];
      const msg = choice?.message;
      if (!msg) return { type: "error", message: "The AI assistant returned an empty reply. Please try again." };

      // Echo the assistant turn back as-is (some reasoning models need reasoning_content kept).
      const toolCalls = msg.tool_calls || [];
      session.messages.push({
        role: "assistant",
        content: msg.content ?? "",
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
      });

      if (toolCalls.length === 0) {
        if (choice.finish_reason === "length") return { type: "error", message: "The assistant's reply was cut off. Please try again." };
        const text = String(msg.content || "").trim();
        // Model replied in prose instead of a tool: treat it as a question.
        return { type: "question", question: text || "Could you describe the route again?", options: [] };
      }

      let pause = null;
      const toolMsg = (id, content) => session.messages.push({ role: "tool", tool_call_id: id, content });
      for (const call of toolCalls) {
        const name = call.function?.name;
        let input;
        try {
          input = JSON.parse(call.function?.arguments || "{}");
          if (!input || typeof input !== "object") throw new Error("not an object");
        } catch {
          toolMsg(call.id, "Error: arguments were not valid JSON. Call the tool again with a JSON object.");
          continue;
        }

        if (name === "ask_user" || name === "propose_route") {
          if (pause) {
            toolMsg(call.id, "Error: only one question or proposal at a time.");
            continue;
          }
          if (name === "ask_user") {
            pause = { type: "question", question: String(input.question || ""), options: arr(input.options).map(String) };
            session.pendingToolUseId = call.id;
            continue;
          }
          const built = this.#buildRoute(input);
          if (!built.ok) {
            toolMsg(call.id, `Error: ${built.error}`);
            continue;
          }
          pause = { type: "proposal", route: built.route, notes: String(input.notes || "") };
          session.pendingToolUseId = call.id;
          continue;
        }

        const out = this.#execTool(name, input);
        toolMsg(call.id, (out.isError ? "Error: " : "") + JSON.stringify(out.result));
      }

      // The paused call's result is added when the commuter answers.
      if (pause) return pause;
    }
    return { type: "error", message: "Setup took too many steps. Try describing the route more simply, or enter it manually." };
  }

  #execTool(name, input) {
    const bus = this.bus;
    try {
      switch (name) {
        case "search_stops": {
          const hits = bus.searchStops(input.query, { service: input.service });
          return { result: hits.length ? hits : { message: "No stops matched. Try fewer or different words." } };
        }
        case "stops_near": {
          const r = Math.min(800, Math.max(50, input.radius_m || 300));
          const near = bus.stopsNear(input.code, r);
          return near ? { result: near } : { result: { error: `Stop ${input.code} not found.` }, isError: true };
        }
        case "get_service": {
          const svc = bus.service(input.service);
          if (!svc) return { result: { error: `Service ${input.service} not found.` }, isError: true };
          return {
            result: {
              service: svc.no,
              name: svc.name,
              directions: svc.routes.map((r, i) => ({ direction: i + 1, stops: r.map((c) => `${c} ${bus.stop(c)?.name || "?"}`) })),
            },
          };
        }
        case "check_leg": {
          const r = bus.checkLeg(input.service, input.board_code, input.alight_code);
          return { result: r, isError: !r.ok };
        }
        default:
          return { result: { error: `Unknown tool ${name}` }, isError: true };
      }
    } catch (err) {
      return { result: { error: String(err.message || err) }, isError: true };
    }
  }

  #buildRoute(input) {
    const legs = arr(input.legs);
    if (legs.length === 0) return { ok: false, error: "A route needs at least one leg." };
    const out = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const check = this.bus.checkLeg(leg.service, leg.board_code, leg.alight_code);
      if (!check.ok) return { ok: false, error: `Leg ${i + 1}: ${check.error}` };
      let walkBefore = 0;
      if (i > 0) {
        walkBefore = Number.isFinite(leg.walk_before_min)
          ? leg.walk_before_min
          : this.bus.walkMin(legs[i - 1].alight_code, leg.board_code) ?? 2;
      }
      out.push({
        service: check.service,
        board: { code: check.board.code, name: check.board.name },
        alight: { code: check.alight.code, name: check.alight.name },
        rideMin: Number.isFinite(leg.ride_min) && leg.ride_min > 0 ? leg.ride_min : check.ride_min_estimate,
        walkBeforeMin: walkBefore,
      });
    }
    return {
      ok: true,
      route: {
        name: String(input.name || "My route").slice(0, 60),
        walkFromHomeMin: Number.isFinite(input.walk_from_home_min) ? input.walk_from_home_min : 3,
        legs: out,
      },
    };
  }

  #gc() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of this.sessions) if (s.touched < cutoff) this.sessions.delete(id);
  }
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function describeApiError(err) {
  if (err instanceof MissingKeyError) return "AI setup isn't configured on the server yet (set OPENCODE_API_KEY). You can still enter the route manually.";
  if (err instanceof OpenAI.AuthenticationError) return "OpenCode Go rejected the API key. Check OPENCODE_API_KEY. You can still enter the route manually.";
  if (err instanceof OpenAI.PermissionDeniedError) return "OpenCode Go refused the request (is the Go subscription active?). You can still enter the route manually.";
  if (err instanceof OpenAI.RateLimitError) return "You've hit the OpenCode Go usage limit for now. Try again later, or enter the route manually.";
  if (err instanceof OpenAI.APIError) return `AI assistant error (${err.status ?? "network"}). You can still enter the route manually.`;
  console.warn("Route setup agent error:", err?.message || err);
  return "Couldn't reach the AI assistant. You can still enter the route manually.";
}
