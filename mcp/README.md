# sg-transport-mcp

An MCP server for live Singapore transport, traffic and weather data. It wraps two official, free APIs:

- **[LTA DataMall](https://datamall.lta.gov.sg)**: buses (all operators: SBS Transit, SMRT, Tower Transit, Go-Ahead), trains, station crowding and traffic. Built against the [API User Guide v6.11 (30 Oct 2026)](https://datamall.lta.gov.sg/content/dam/datamall/datasets/LTA_DataMall_API_User_Guide.pdf).
- **[data.gov.sg](https://data.gov.sg/collections/1456/view)**: NEA / Meteorological Service Singapore weather forecasts and readings.

## Tools (22, all read-only)

| Area | Tool | What it returns |
|---|---|---|
| Bus | `find_bus_stops` | Stops by name, road or code, or near a lat/lon |
| Bus | `get_bus_arrivals` | Next 3 buses per service: ETA, live or scheduled, load (seats/standing), deck type, wheelchair access |
| Bus | `get_bus_service` | Operator, category, start/end stops, peak and off-peak frequency |
| Bus | `get_bus_route` | Ordered stops with first and last bus times (weekday, Saturday, Sunday) |
| Train | `get_train_service_alerts` | Line status, affected stations, free bus/shuttle arrangements, LTA advisories, and `bus_advisories`: bus services LTA reports as delayed or diverted |
| Train | `get_train_disruption_feed` | GTFS-Realtime alerts and trip updates (delays, cancellations, skipped stops) during disruptions |
| Train | `find_train_station` | Station and platform lookup from LTA's GTFS train schedule |
| Train | `get_scheduled_train_departures` | **Timetable** departures from a station, optionally only trains going on to `to_station` and/or on one `line` (see the limitations section) |
| Train | `check_train_leg` | Whether a line runs directly between two stations: direction, stops, scheduled ride minutes, and station codes for the crowd tools |
| Crowd | `get_station_crowd` | Real-time crowd level per station (low/moderate/high), updated every 10 min |
| Crowd | `get_station_crowd_forecast` | 30-minute crowd forecast per station |
| Traffic | `get_traffic_incidents` | Accidents, breakdowns, roadworks, diversions |
| Traffic | `get_expressway_travel_times` | Minutes per expressway segment, with totals |
| Traffic | `get_traffic_speed` | Speed bands for links on a named road |
| Traffic | `get_traffic_cameras` | Live camera image URLs near a point or by camera id |
| Traffic | `get_carpark_availability` | Free lots at HDB, LTA and URA carparks |
| Traffic | `get_flood_alerts` | Active PUB flash-flood alerts |
| Traffic | `get_emas_messages` | Text shown on expressway EMAS signboards |
| Weather | `get_weather_forecast_2h` | 2-hour forecast by area, or for the area nearest a lat/lon |
| Weather | `get_weather_forecast_24h` | 24-hour outlook and regional forecasts |
| Weather | `get_weather_outlook_4day` | 4-day outlook |
| Weather | `get_current_weather` | Latest rainfall and temperature from the nearest NEA stations |

## Setup

Requires [uv](https://docs.astral.sh/uv/) (it installs Python 3.10+ and the dependencies for you).

1. **Get an LTA DataMall AccountKey** (free). Request one at https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html; the key arrives by email.
2. **Optional:** get a data.gov.sg API key for higher weather rate limits from https://data.gov.sg/signin. The weather tools work without a key.
3. Set the keys as environment variables:
   ```powershell
   setx LTA_ACCOUNT_KEY "your-key"
   setx DATA_GOV_SG_API_KEY "your-key"   # optional
   ```
   Restart your terminal or Claude afterwards so the new variables are picked up.

### Claude Code

`.mcp.json` is git-ignored, so each person keeps their own copy and no key gets committed. Copy the template to the folder you open in Claude Code (`mcp/`, or the kakiRoute repo root) and set the `--directory` path to where this `mcp/` folder lives on your machine:

```bash
cp mcp/.mcp.json.example .mcp.json
```

The template reads the keys from your environment variables (step 3). Open the folder in Claude Code and approve `sg-transport` when prompted.

### Claude Desktop / other MCP clients

Add this to the client's MCP config (for Claude Desktop, that is `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sg-transport": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/kakiRoute/mcp", "run", "sg-transport-mcp"],
      "env": { "LTA_ACCOUNT_KEY": "your-key" }
    }
  }
}
```

## Limitations (from LTA, not this server)

- **No real-time MRT/LRT next-train times.** LTA does not publish them; see the [MOT reply of 13 Jan 2026](https://www.mot.gov.sg/news-resources/newsroom/proposal-to-publish-real-time-train-arrival-data-on-lta-datamall/). `get_scheduled_train_departures` uses the GTFS timetable and labels its results as scheduled. LTA's GTFS-Realtime trip updates only cover **disruptions**.
- **Crowding is per station**, not per platform or carriage.
- **Some lookups are slow on the first call.** `get_bus_route`, `get_traffic_speed` and `find_bus_stops` download whole paginated datasets (500 rows per call). Bus routes and stops are then cached for 24 hours; speed bands for 4 minutes.
- **Short-lived links.** Camera images and GTFS files are pre-signed S3 links that expire after 15 minutes. Those downloads use a separate HTTP client, so your AccountKey is never sent to S3.

## Development

```bash
uv sync
uv run pytest                        # 28 offline tests through the MCP protocol, against fake backends
uv run python scripts/smoke_test.py  # live: starts the server over stdio and calls the real APIs
```

### Verification status

All 21 tools were run against the live APIs on 11 Nov 2026 with `scripts/smoke_test.py`. That run confirmed:

- the GTFS-Realtime endpoint names (`GTFSRealTimeTrainServiceAlerts`, `GTFSRealtimeTrainTripUpdates`);
- the nested `PCDForecast` response shape;
- that the GTFS train timetable parses into real departures.

The offline tests use fake LTA responses built from the v6.11 guide, plus recorded real data.gov.sg responses.

**Key format tip:** an LTA DataMall AccountKey is a 24-character string ending in `==`. If every LTA tool returns HTTP 401, check that you haven't put another key in `LTA_ACCOUNT_KEY`.
