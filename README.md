# kakiRoute

Helps a commuter standing in the lift decide which bus stop to walk to, for routes **they already trust**.

Save your own routes once (including transfers that need a short walk between stops). Then open the app and see, for each route:

- which stop to walk to, and when to leave;
- the bus you'd actually catch on each leg, if you leave now;
- how many minutes you'd have spare at each transfer (amber when it's under 2 minutes);
- roughly when you'd arrive.

Routes stay in the order you saved them, and you choose. If you want a second opinion, **Help me decide** (below) picks one of your saved routes.

## AI route setup

Instead of looking up 5-digit stop codes, you can describe a route in plain words:

> I take 961 from the stop outside Blk 123, get off at Bt Panjang Int, walk across the road and take 975 to work.

An agent (using your [OpenCode Go](https://opencode.ai/docs/go) subscription) then:

1. searches the stop list (understands `Blk`, `Opp`, `Bt`, `Int`, `Stn`, …);
2. checks which side of the road each service runs from, in your direction of travel;
3. finds the nearby stop for walking transfers and estimates the walking and ride times;
4. asks you one short question when something is ambiguous (for example, two stops with the same name);
5. fills in the route form for you to check, edit and save.

The agent only sets up routes. The timings screen is plain arithmetic on live arrival data, with no AI involved. If AI setup is unavailable, you can still enter routes manually.

## Help me decide (AI)

With two or more saved routes, a **Help me decide** button appears above them. Tapping it:

1. computes the latest timings for every route (the same arithmetic as the cards);
2. matches each stop on each route to an area in the NEA 2-hour rain forecast (data.gov.sg);
3. asks the decision model (`gpt-6-luna` by default) to weigh arrival time, transfer risk and where you'd walk in the rain;
4. shows its pick with a one-line reason, marks that card "AI pick" and adds a short note to each card.

It only runs when you tap the button, so the timings screen stays instant and the cards are unchanged without it. It only ever picks among your own saved routes.

## Data sources

- Live arrivals: [arrivelah](https://github.com/cheeaun/arrivelah) (`https://arrivelah2.busrouter.sg/?id=<stop code>`), proxied by the server and cached for 15 seconds.
- Rain forecast: NEA 2-hour forecast from [data.gov.sg](https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast), cached for 5 minutes. Set `DATA_GOV_SG_API_KEY` for higher rate limits.
- Stops and service routes: [busrouter.sg](https://busrouter.sg) static data (`data.busrouter.sg/v1/stops.min.json`, `services.min.json`), used by the setup agent and the stop-name lookup.

## Running it

Requires Node 20+.

```bash
npm install
```

Get your API key from the OpenCode console (you need an active Go subscription). Copy `.env.example` to `.env` and put the key in it:

```
OPENCODE_API_KEY=your-key
```

`.env` is git-ignored, so the key never gets committed. Then check the connection:

```bash
npm run check-ai
```

It prints the endpoint it found, the models your plan includes, the model it picked, and whether a two-step tool-calling exchange worked. To test every model on your plan, run `npm run check-ai -- --all`. Then start the app:

```bash
npm start
```

Open http://localhost:3000. If there's no key, the app still works, but routes have to be entered manually.

Optional settings:

| Variable | Default |
|---|---|
| `OPENCODE_MODEL` | Route setup model: first available match for Kimi, then GLM, DeepSeek, Qwen |
| `OPENCODE_DECIDE_MODEL` | "Help me decide" model: `gpt-6-luna` |
| `DATA_GOV_SG_API_KEY` | None (the weather API works without a key, at lower rate limits) |
| `OPENCODE_BASE_URL` | Auto-detected, trying `https://opencode.ai/inference/go/openai/v1` first, then `https://opencode.ai/zen/go/v1` |

**Offline / mock mode.** `npm run mock` uses a small fake network (stops named "Mock …", codes `900xx`) and generated arrival times, so you can try the UI without network access.

**Tests:**

```bash
npm test
```

## Layout

| Path | What it is |
|---|---|
| `server.js` | Express server: static files, arrivals proxy, stop lookup, setup-agent endpoints |
| `lib/agent.js` | Route setup agent: tool definitions and tool-calling loop, with pauses for questions and proposals |
| `lib/llm.js` | OpenCode Go connection: endpoint detection and model choice |
| `lib/decide.js` | "Help me decide": builds route facts (timings + rain) and asks the decision model |
| `lib/weather.js` | NEA 2-hour forecast, matched to the nearest forecast area for each stop |
| `lib/arrivals.js` | Cached arrivelah fetch, shared by the timings screen and decisions |
| `scripts/check-ai.js` | `npm run check-ai`: verifies your OpenCode Go key and model |
| `lib/busdata.js` | Stop search, nearby stops, leg direction check, walk and ride estimates |
| `lib/fixtures.js` | Mock network for `MOCK=1` and tests |
| `public/timing.js` | Pure "which bus do I catch on each leg" calculation |
| `public/app.js` | UI: home timings, route editor, AI setup chat. Routes are stored in `localStorage` |
| `public/about.html` | Landing page, served at `/about` |
| `public/icon.svg` | Logo. PNG app icons and `manifest.webmanifest` sit beside it |

## Known limits

- Routes are saved in your browser only (no accounts or sync).
- Rain exposure is judged from area forecasts, not from which walkways are covered.
- arrivelah only returns the next few buses at each stop, so connections far in the future show as "next bus not known yet".
- Ride times are estimates (distance along the route plus a small stop dwell time). Correct them in the editor if you know better.
