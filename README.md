# kakiRoute

Helps a commuter standing in the lift decide which bus stop or MRT station to walk to, for routes **they already trust**.

Save your own routes once: bus legs, MRT/LRT train legs, and transfers that need a short walk. Then open the app and see, for each route:

- which stop or station to walk to, and when to leave;
- the bus you'd actually catch on each leg, if you leave now, and how full it is (**Seats** / **Standing** / **Crowded**);
- for train legs, the next scheduled train in your direction and how crowded the station is (**Quiet** / **Busy** / **Packed**);
- a warning when LTA reports a disruption on your train line, or a delay or diversion on one of your bus services;
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
4. for MRT/LRT legs, checks that a line runs directly between your two stations and in which direction, using LTA's timetable (a change of line becomes two legs);
5. asks you one short question when something is ambiguous (for example, two stops with the same name);
6. fills in the route form for you to check, edit and save.

You can also add train legs by hand: in the route form, switch a leg to **Train (MRT / LRT)**, type the two stations (names or codes such as `NS17`), and pick the line and direction it finds.

The agent only sets up routes. The timings screen is plain arithmetic on live arrival data, with no AI involved. If AI setup is unavailable, you can still enter routes manually.

## Help me decide (AI)

With two or more saved routes, a **Help me decide** button appears above them. Tapping it:

1. computes the latest timings for every route (the same arithmetic as the cards);
2. matches each stop on each route to an area in the NEA 2-hour rain forecast (data.gov.sg);
3. asks the decision model (`gpt-6-luna` by default) to weigh arrival time, transfer risk, how crowded each bus and station is, any LTA disruption or delay on the route, and where you'd walk in the rain;
4. shows its pick with a one-line reason, marks that card "AI pick" and adds a short note to each card.

It only runs when you tap the button, so the timings screen stays instant and the cards are unchanged without it. It only ever picks among your own saved routes.

## Data sources

- Live arrivals: official [LTA DataMall](https://datamall.lta.gov.sg) bus arrivals through the sg-transport MCP server in [`mcp/`](mcp/README.md), when `LTA_ACCOUNT_KEY` is set. Each bus comes with its crowding (LTA's load: seats, standing, limited standing) and whether its time is live GPS or the operator's schedule, shown as *sched.* on the card. Without a key, or if the MCP server can't start, arrivals come from [arrivelah](https://github.com/cheeaun/arrivelah) (`https://arrivelah2.busrouter.sg/?id=<stop code>`). Either way the server caches them for 15 seconds.
- Trains (needs `LTA_ACCOUNT_KEY`): LTA DataMall's GTFS train timetable, through the same MCP server. LTA does not publish live train arrivals, so train times are the **timetable**, labelled as such on the card. Departures are filtered to trains that go on to stop at your alighting station.
- Station crowding (needs `LTA_ACCOUNT_KEY`): LTA's real-time station crowd level (updated every 10 minutes) when you'd board within 15 minutes, otherwise LTA's 30-minute crowd forecast. It is per station, not per platform or carriage.
- Service alerts (needs `LTA_ACCOUNT_KEY`): LTA's train service alerts, including the bus delay and diversion notices LTA publishes with them, matched against the lines and bus services in your routes. Cached for 30 seconds.
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

It prints the endpoint it found, the models your plan includes, the model it picked, and whether a two-step tool-calling exchange worked. To test every model on your plan, run `npm run check-ai -- --all`.

**Official LTA data (recommended).** Request a free [LTA DataMall AccountKey](https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html) and add it to `.env`:

```
LTA_ACCOUNT_KEY=your-key
```

The app starts the sg-transport MCP server in `mcp/` as a child process, which needs [uv](https://docs.astral.sh/uv/). Install its Python dependencies once, then check it end to end:

```bash
npm run mcp:setup
```

```bash
npm run check-mcp
```

`check-mcp` starts the server, prints live arrivals with crowding for a stop (default `44009`, or pass one: `npm run check-mcp -- 83139`), and lists any bus services LTA reports as delayed or diverted. Then start the app:

```bash
npm start
```

Open http://localhost:3000. If there's no key, the app still works, but routes have to be entered manually.

Optional settings:

| Variable | Default |
|---|---|
| `OPENCODE_MODEL` | Route setup model: first available match for Kimi, then GLM, DeepSeek, Qwen |
| `OPENCODE_DECIDE_MODEL` | "Help me decide" model: `gpt-6-luna` |
| `LTA_ACCOUNT_KEY` | None: arrivals come from arrivelah |
| `SG_TRANSPORT` | Set to `off` to skip the MCP server even when `LTA_ACCOUNT_KEY` is set |
| `SG_TRANSPORT_DEBUG` | Set to `1` to show the MCP server's own log output |
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
| `lib/arrivals.js` | Cached bus arrivals (LTA via MCP, else arrivelah) in one shape, shared by the timings screen and decisions |
| `lib/sgtransport.js` | MCP client: runs the sg-transport server in `mcp/` as a child process and calls its tools |
| `lib/trains.js` | Train legs (timetable departures + station crowd), service status and train-leg checks, via the MCP server |
| `lib/routes.js` | Validates routes sent by the browser (bus and train legs) |
| `mcp/` | sg-transport MCP server (Python): LTA DataMall and NEA data for buses, trains, crowding, traffic and weather |
| `scripts/check-ai.js` | `npm run check-ai`: verifies your OpenCode Go key and model |
| `scripts/check-mcp.js` | `npm run check-mcp`: verifies your LTA key and the MCP server with live data |
| `lib/busdata.js` | Stop search, nearby stops, leg direction check, walk and ride estimates |
| `lib/fixtures.js` | Mock network for `MOCK=1` and tests |
| `public/timing.js` | Pure "which bus do I catch on each leg" calculation |
| `public/app.js` | UI: home timings, route editor, AI setup chat. Routes are stored in `localStorage` |
| `public/about.html` | Landing page, served at `/about` |
| `public/icon.svg` | Logo. PNG app icons and `manifest.webmanifest` sit beside it |

## Known limits

- Routes are saved in your browser only (no accounts or sync).
- Rain exposure is judged from area forecasts, not from which walkways are covered.
- LTA (and arrivelah) only return the next three buses at each stop, so connections far in the future show as "next bus not known yet".
- Some bus times are the operator's schedule rather than live GPS (marked *sched.*); they can be less accurate.
- Train times are LTA's timetable, not live. During a disruption the card warns you, but the times shown are still the timetable.
- Some station pairs have few direct trains even when trains run often (for example, most Circle Line trains from Bishan turn off at Promenade, so direct trains to Dhoby Ghaut are rare). The card then shows a long wait; save it as two legs with a change of line instead.
- Train legs, crowding and service alerts need `LTA_ACCOUNT_KEY`; without it the app works for buses only.
- In mock mode there are no trains.
- Ride times are estimates (distance along the route plus a small stop dwell time). Correct them in the editor if you know better.
