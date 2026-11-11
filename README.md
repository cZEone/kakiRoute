# kakiRoute

Helps a commuter standing in the lift decide which bus stop to walk to, for routes **they already trust**.

Save your own routes once (including transfers that need a short walk between stops). Then open the app and see, for each route:

- which stop to walk to, and when to leave;
- the bus you'd actually catch on each leg, if you leave now;
- how many minutes you'd have spare at each transfer (amber when it's under 2 minutes);
- roughly when you'd arrive.

Routes stay in the order you saved them. The app doesn't rank or recommend routes; you choose.

## AI route setup

Instead of looking up 5-digit stop codes, you can describe a route in plain words:

> I take 961 from the stop outside Blk 123, get off at Bt Panjang Int, walk across the road and take 975 to work.

An agent (Claude, via the Anthropic API) then:

1. searches the stop list (understands `Blk`, `Opp`, `Bt`, `Int`, `Stn`, …);
2. checks which side of the road each service runs from, in your direction of travel;
3. finds the nearby stop for walking transfers and estimates the walking and ride times;
4. asks you one short question when something is ambiguous (for example, two stops with the same name);
5. fills in the route form for you to check, edit and save.

The agent only sets up routes. The timings screen is plain arithmetic on live arrival data, with no AI involved. If AI setup is unavailable, you can still enter routes manually.

## Data sources

- Live arrivals: [arrivelah](https://github.com/cheeaun/arrivelah) (`https://arrivelah2.busrouter.sg/?id=<stop code>`), proxied by the server and cached for 15 seconds.
- Stops and service routes: [busrouter.sg](https://busrouter.sg) static data (`data.busrouter.sg/v1/stops.min.json`, `services.min.json`), used by the setup agent and the stop-name lookup.

## Running it

Requires Node 20+.

```bash
npm install
```

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Then open http://localhost:3000. If `ANTHROPIC_API_KEY` isn't set, the app still works, but routes have to be entered manually.

**Offline / mock mode.** `npm run mock` uses a small fake network (stops named "Mock …", codes `900xx`) and generated arrival times, so you can try the UI without network access.

**Tests:**

```bash
npm test
```

## Layout

| Path | What it is |
|---|---|
| `server.js` | Express server: static files, arrivals proxy, stop lookup, setup-agent endpoints |
| `lib/agent.js` | Route setup agent: tool definitions and tool-use loop, with pauses for questions and proposals |
| `lib/busdata.js` | Stop search, nearby stops, leg direction check, walk and ride estimates |
| `lib/fixtures.js` | Mock network for `MOCK=1` and tests |
| `public/timing.js` | Pure "which bus do I catch on each leg" calculation |
| `public/app.js` | UI: home timings, route editor, AI setup chat. Routes are stored in `localStorage` |

## Known limits

- Routes are saved in your browser only (no accounts or sync).
- arrivelah only returns the next few buses at each stop, so connections far in the future show as "next bus not known yet".
- Ride times are estimates (distance along the route plus a small stop dwell time). Correct them in the editor if you know better.
