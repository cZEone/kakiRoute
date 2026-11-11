"""MCP server: Singapore buses, trains, crowding, traffic and weather.

Data sources
- LTA DataMall API User Guide v6.11 (30 Oct 2026): https://datamall.lta.gov.sg
- data.gov.sg real-time weather (NEA / MSS): https://api-open.data.gov.sg/v2/real-time/api/
"""

from __future__ import annotations

import logging
import os
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated, Any, Callable, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from . import gtfs
from .lta import LTAClient
from .util import SGT, haversine_m, matches_all_words, natural_key, now_sgt, parse_dt, to_float
from .weather import WeatherClient

# ---- reference data (LTA API User Guide v6.11) ------------------------------------------------

OPERATORS = {"SBST": "SBS Transit", "SMRT": "SMRT", "TTS": "Tower Transit Singapore", "GAS": "Go-Ahead Singapore"}
BUS_LOAD = {"SEA": "seats available", "SDA": "standing available", "LSD": "limited standing"}
BUS_TYPE = {"SD": "single deck", "DD": "double deck", "BD": "bendy"}
CROWD = {"l": "low", "m": "moderate", "h": "high"}
TRAIN_LINE_NAMES = {
    "CCL": "Circle Line",
    "CEL": "Circle Line Extension (Bayfront, Marina Bay)",
    "CGL": "Changi Extension (Expo, Changi Airport)",
    "DTL": "Downtown Line",
    "EWL": "East West Line",
    "NEL": "North East Line",
    "NSL": "North South Line",
    "BPL": "Bukit Panjang LRT",
    "SLRT": "Sengkang LRT",
    "STL": "Sengkang LRT",
    "PLRT": "Punggol LRT",
    "PTL": "Punggol LRT",
    "TEL": "Thomson-East Coast Line",
}
CrowdLine = Literal["CCL", "CEL", "CGL", "DTL", "EWL", "NEL", "NSL", "BPL", "SLRT", "PLRT", "TEL"]

DAY = 24 * 3600
STATION_CODE = re.compile(r"^[A-Z]{2,3}\d{1,2}$")

INSTRUCTIONS = """\
Live Singapore transport, traffic and weather data from LTA DataMall and data.gov.sg (NEA).

Typical chains:
- "When is my bus?": find_bus_stops (by name or lat/lon) -> get_bus_arrivals(bus_stop_code).
- "Which stops does bus 190 call at?": get_bus_route(service_no).
- "Is the MRT OK?": get_train_service_alerts, then get_train_disruption_feed during a disruption.
  Its bus_advisories also list bus services LTA reports as delayed or diverted.
- "Train from Bishan to Dhoby Ghaut?": check_train_leg, then
  get_scheduled_train_departures(station="Bishan", to_station="Dhoby Ghaut").
- "How crowded is Raffles Place?": get_station_crowd(train_line="EWL", station="EW14").
- "Weather near me": get_weather_forecast_2h(latitude, longitude) and get_current_weather.

Limits to tell users about:
- Real-time MRT/LRT next-train arrivals are NOT published by LTA. get_scheduled_train_departures
  gives timetable (planned) times only; label them as scheduled, not live.
- Station crowding is per station (low/moderate/high), not per platform or carriage.
- Bus 'live' = true means the ETA is from GPS; false means it is the operator's schedule.
All times are Singapore time (UTC+8).
"""

READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=True, idempotentHint=True)


# ---- service container -------------------------------------------------------------------------


@dataclass
class Services:
    lta: LTAClient
    weather: WeatherClient
    now: Callable[[], datetime] = now_sgt
    _schedule: gtfs.GTFSSchedule | None = field(default=None, repr=False)

    async def train_schedule(self) -> gtfs.GTFSSchedule:
        raw = await self.lta.download_link("GTFSScheduleTrain", ttl=12 * 3600)
        if self._schedule is None or self._schedule.zip_bytes is not raw:
            self._schedule = gtfs.GTFSSchedule.from_zip(raw)
        return self._schedule


_services: Services | None = None


def services() -> Services:
    global _services
    if _services is None:
        _services = Services(
            lta=LTAClient(os.environ.get("LTA_ACCOUNT_KEY")),
            weather=WeatherClient(os.environ.get("DATA_GOV_SG_API_KEY")),
        )
    return _services


def set_services(svc: Services | None) -> None:
    """Swap the backing clients (used by tests)."""
    global _services
    _services = svc


mcp = MCPServer(
    name="sg-transport",
    title="Singapore Transport, Traffic & Weather",
    instructions=INSTRUCTIONS,
    version="0.1.0",
)


def _minutes_until(when: datetime | None, now: datetime) -> int | None:
    if when is None:
        return None
    return max(0, int((when - now).total_seconds() // 60))


def _rows(body: dict[str, Any]) -> list[dict[str, Any]]:
    value = body.get("value", [])
    return [value] if isinstance(value, dict) else list(value or [])


async def _bus_stop_index() -> dict[str, dict[str, Any]]:
    stops = await services().lta.get_all("BusStops", ttl=DAY)
    return {s["BusStopCode"]: s for s in stops if s.get("BusStopCode")}


def _stop_label(index: dict[str, dict[str, Any]], code: str) -> str:
    s = index.get(code)
    return f"{s.get('Description', '')} ({s.get('RoadName', '')})" if s else code


# ==== Buses =====================================================================================


@mcp.tool(annotations=READ_ONLY)
async def find_bus_stops(
    query: Annotated[str | None, Field(description="Stop name, road, landmark or 5-digit stop code, e.g. 'Opp Blk 123' or '83139'")] = None,
    latitude: Annotated[float | None, Field(description="Search near this latitude (use with longitude)")] = None,
    longitude: Annotated[float | None, Field(description="Search near this longitude (use with latitude)")] = None,
    radius_m: Annotated[int, Field(ge=50, le=5000, description="Search radius in metres when lat/lon given")] = 400,
    limit: Annotated[int, Field(ge=1, le=50)] = 10,
) -> dict[str, Any]:
    """Find Singapore bus stops by name/road/code or by distance from a location. Returns bus stop codes for get_bus_arrivals."""
    if not query and (latitude is None or longitude is None):
        raise ToolError("Give a query, or both latitude and longitude.")
    index = await _bus_stop_index()
    candidates = list(index.values())
    if query:
        q = query.strip()
        if q.isdigit() and len(q) == 5:
            candidates = [index[q]] if q in index else []
        else:
            candidates = [s for s in candidates if matches_all_words(q, s.get("Description"), s.get("RoadName"), s.get("BusStopCode"))]
    results = []
    for s in candidates:
        item = {
            "bus_stop_code": s.get("BusStopCode"),
            "description": s.get("Description"),
            "road": s.get("RoadName"),
            "latitude": s.get("Latitude"),
            "longitude": s.get("Longitude"),
        }
        if latitude is not None and longitude is not None and s.get("Latitude") is not None:
            d = haversine_m(latitude, longitude, float(s["Latitude"]), float(s["Longitude"]))
            if d > radius_m:
                continue
            item["distance_m"] = round(d)
        results.append(item)
    results.sort(key=lambda r: (r.get("distance_m", 0), r["description"] or ""))
    return {"count": len(results), "stops": results[:limit]}


def format_bus_arrivals(raw: dict[str, Any], now: datetime) -> dict[str, Any]:
    services_out = []
    for svc in raw.get("Services") or []:
        buses = []
        for key in ("NextBus", "NextBus2", "NextBus3"):
            b = svc.get(key) or {}
            eta = parse_dt(b.get("EstimatedArrival"))
            if eta is None:
                continue
            mins = _minutes_until(eta, now)
            bus = {
                "eta": eta.isoformat(timespec="seconds"),
                "minutes": mins,
                "display": "Arr" if mins == 0 else f"{mins} min",
                "live": str(b.get("Monitored")) == "1",
                "load": BUS_LOAD.get(b.get("Load", ""), b.get("Load") or None),
                "bus_type": BUS_TYPE.get(b.get("Type", ""), b.get("Type") or None),
                "wheelchair_accessible": b.get("Feature") == "WAB",
            }
            lat, lon = to_float(b.get("Latitude")), to_float(b.get("Longitude"))
            if lat and lon:
                bus["position"] = {"latitude": lat, "longitude": lon}
            if str(b.get("VisitNumber", "1")) not in ("", "1"):
                bus["visit_number"] = int(b["VisitNumber"])
            buses.append(bus)
        services_out.append(
            {
                "service_no": svc.get("ServiceNo"),
                "operator": OPERATORS.get(svc.get("Operator", ""), svc.get("Operator")),
                "next_buses": buses,
            }
        )
    services_out.sort(key=lambda s: natural_key(s["service_no"] or ""))
    return {"bus_stop_code": raw.get("BusStopCode"), "as_of": now.isoformat(timespec="seconds"), "services": services_out}


@mcp.tool(annotations=READ_ONLY)
async def get_bus_arrivals(
    bus_stop_code: Annotated[str, Field(pattern=r"^\d{5}$", description="5-digit bus stop code, e.g. '83139'")],
    service_no: Annotated[str | None, Field(description="Only this bus service, e.g. '15'")] = None,
) -> dict[str, Any]:
    """Real-time arrival of the next 3 buses per service at a stop (all operators: SBS Transit, SMRT, Tower Transit, Go-Ahead), with crowd load, deck type and wheelchair access. Updates every 20s."""
    svc = services()
    raw = await svc.lta.get("v3/BusArrival", {"BusStopCode": bus_stop_code, "ServiceNo": service_no}, ttl=15)
    out = format_bus_arrivals(raw, svc.now())
    out["bus_stop_code"] = out["bus_stop_code"] or bus_stop_code
    if not out["services"]:
        out["note"] = "No buses reported: services may not be running now, or the stop code / service number is wrong."
    return out


@mcp.tool(annotations=READ_ONLY)
async def get_bus_service(
    service_no: Annotated[str, Field(description="Bus service number, e.g. '190' or '107M'")],
) -> dict[str, Any]:
    """Bus service details: operator, category, start/end stops and dispatch frequency (minutes) in AM/PM peak and off-peak."""
    svc = services()
    rows = _rows(await svc.lta.get("BusServices", {"ServiceNo": service_no}, ttl=DAY))
    rows = [r for r in rows if str(r.get("ServiceNo", "")).upper() == service_no.upper()]
    if not rows:
        raise ToolError(f"No bus service '{service_no}' found.")
    index = await _bus_stop_index()
    return {
        "service_no": rows[0].get("ServiceNo"),
        "operator": OPERATORS.get(rows[0].get("Operator", ""), rows[0].get("Operator")),
        "category": rows[0].get("Category"),
        "directions": [
            {
                "direction": r.get("Direction"),
                "from": _stop_label(index, r.get("OriginCode", "")),
                "from_code": r.get("OriginCode"),
                "to": _stop_label(index, r.get("DestinationCode", "")),
                "to_code": r.get("DestinationCode"),
                "loop_at": r.get("LoopDesc") or None,
                "frequency_minutes": {
                    "am_peak_0630_0830": r.get("AM_Peak_Freq"),
                    "am_offpeak_0831_1659": r.get("AM_Offpeak_Freq"),
                    "pm_peak_1700_1900": r.get("PM_Peak_Freq"),
                    "pm_offpeak_after_1900": r.get("PM_Offpeak_Freq"),
                },
            }
            for r in sorted(rows, key=lambda r: r.get("Direction", 0))
        ],
    }


@mcp.tool(annotations=READ_ONLY)
async def get_bus_route(
    service_no: Annotated[str, Field(description="Bus service number, e.g. '190'")],
    direction: Annotated[Literal[1, 2] | None, Field(description="1 or 2; omit for both")] = None,
) -> dict[str, Any]:
    """Ordered list of stops for a bus service with distance and first/last bus times (weekday, Saturday, Sunday). First call downloads the full route table (~1 min), later calls are cached for a day."""
    svc = services()
    rows = await svc.lta.get_all("BusRoutes", ttl=DAY)
    rows = [r for r in rows if str(r.get("ServiceNo", "")).upper() == service_no.upper()]
    if direction is not None:
        rows = [r for r in rows if int(r.get("Direction", 0)) == direction]
    if not rows:
        raise ToolError(f"No route found for bus service '{service_no}'" + (f" direction {direction}." if direction else "."))
    index = await _bus_stop_index()
    by_dir: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for r in sorted(rows, key=lambda r: (int(r.get("Direction", 0)), int(r.get("StopSequence", 0)))):
        stop = index.get(r.get("BusStopCode", ""), {})
        by_dir[int(r.get("Direction", 0))].append(
            {
                "seq": r.get("StopSequence"),
                "bus_stop_code": r.get("BusStopCode"),
                "description": stop.get("Description"),
                "road": stop.get("RoadName"),
                "distance_km": r.get("Distance"),
                "first_last_bus": {
                    "weekday": f"{r.get('WD_FirstBus')}-{r.get('WD_LastBus')}",
                    "saturday": f"{r.get('SAT_FirstBus')}-{r.get('SAT_LastBus')}",
                    "sunday": f"{r.get('SUN_FirstBus')}-{r.get('SUN_LastBus')}",
                },
            }
        )
    return {
        "service_no": rows[0].get("ServiceNo"),
        "operator": OPERATORS.get(rows[0].get("Operator", ""), rows[0].get("Operator")),
        "directions": [{"direction": d, "stop_count": len(stops), "stops": stops} for d, stops in sorted(by_dir.items())],
    }


# ==== Trains ====================================================================================


def format_train_alerts(raw: dict[str, Any]) -> dict[str, Any]:
    value = raw.get("value", raw)
    if isinstance(value, list):
        value = value[0] if value else {}
    status = value.get("Status")
    segments = []
    for seg in value.get("AffectedSegments") or []:
        line = seg.get("Line", "")
        segments.append(
            {
                "line": line,
                "line_name": TRAIN_LINE_NAMES.get(line, line),
                "direction": seg.get("Direction"),
                "stations": [s for s in (seg.get("Stations") or "").split(",") if s],
                "free_public_bus_at": seg.get("FreePublicBus") or None,
                "free_mrt_shuttle_at": seg.get("FreeMRTShuttle") or None,
                "mrt_shuttle_direction": seg.get("MRTShuttleDirection") or None,
            }
        )
    messages = [
        {"content": m.get("Content"), "created": m.get("CreatedDate")}
        for m in (value.get("Message") or [])
        if m.get("Content")
    ]
    label = {1: "normal service or minor delays", 2: "disrupted service or major delays"}.get(
        int(status) if str(status).isdigit() else -1, "unknown"
    )
    return {
        "status": label,
        "status_code": status,
        "affected_segments": segments,
        "messages": messages,
        "bus_advisories": parse_bus_advisories(messages),
    }


# "Bus services 5, 23, 59, 518 and 966 are delayed by up to 25 minutes due to ..."
# "Bus service 961 has been diverted ..."
_BUS_LIST = re.compile(r"\bbus services?\s+(.+?)\s+(?:is|are|has|have|will|was|were)\b", re.IGNORECASE)
_SERVICE_NO = re.compile(r"\b\d{1,3}[A-Z]?\b")
_DELAY_MIN = re.compile(r"delayed by up to (\d+)\s*min", re.IGNORECASE)


def parse_bus_advisories(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pull the bus service numbers out of LTA's travel advisories, so apps can match them to a route."""
    out = []
    for m in messages:
        text = m.get("content") or ""
        found = _BUS_LIST.search(text)
        if not found:
            continue
        services_ = list(dict.fromkeys(_SERVICE_NO.findall(found.group(1).upper())))
        if not services_:
            continue
        lower = text.lower()
        kind = "delay" if "delay" in lower else "diversion" if "divert" in lower else "advisory"
        delay = _DELAY_MIN.search(text)
        out.append(
            {
                "services": services_,
                "kind": kind,
                "delay_up_to_min": int(delay.group(1)) if delay else None,
                "message": text,
                "created": m.get("created"),
            }
        )
    return out


@mcp.tool(annotations=READ_ONLY)
async def get_train_service_alerts() -> dict[str, Any]:
    """Current MRT/LRT service status across all lines: disruptions, affected stations, free bus / shuttle arrangements and LTA advisories. bus_advisories lists bus services LTA reports as delayed or diverted."""
    raw = await services().lta.get("TrainServiceAlerts", ttl=30)
    return format_train_alerts(raw)


@mcp.tool(annotations=READ_ONLY)
async def get_train_disruption_feed() -> dict[str, Any]:
    """GTFS-Realtime train feeds: service alerts plus trip updates (delays, cancellations, skipped stops). LTA only publishes trip updates DURING disruptions; empty otherwise."""
    lta = services().lta
    result: dict[str, Any] = {}
    for key, path, summarize in (
        ("alerts", "GTFSRealTimeTrainServiceAlerts", gtfs.summarize_alerts),
        ("trip_updates", "GTFSRealtimeTrainTripUpdates", gtfs.summarize_trip_updates),
    ):
        try:
            feed = gtfs.decode_feed(await lta.download_link(path, ttl=30))
            result[key] = summarize(feed)
            result[f"{key}_feed_time"] = datetime.fromtimestamp(feed.header.timestamp, SGT).isoformat() if feed.header.timestamp else None
        except ToolError as exc:
            result[key] = []
            result[f"{key}_error"] = str(exc)
    if not result["alerts"] and not result["trip_updates"]:
        result["note"] = "No active GTFS-Realtime alerts or disruption trip updates."
    return result


@mcp.tool(annotations=READ_ONLY)
async def find_train_station(
    query: Annotated[str, Field(description="Station name or code, e.g. 'Jurong East' or 'EW24'")],
) -> dict[str, Any]:
    """Look up MRT/LRT stations (and their platform stop ids) in LTA's GTFS train schedule."""
    sched = await services().train_schedule()
    hits = sched.find_stations(query)
    if not hits:
        raise ToolError(f"No train station matches '{query}'.")
    out = []
    for s in hits:
        children = [c for c in sched.stops.values() if c.get("parent_station") == s["stop_id"]]
        # GTFS location_type: 0/blank = platform, 2 = entrance/exit.
        platforms = [c for c in children if c.get("location_type", "") in ("", "0")]
        exits = [c for c in children if c.get("location_type") == "2"]
        out.append(
            {
                "stop_id": s.get("stop_id"),
                "code": s.get("stop_code") or None,
                "name": s.get("stop_name"),
                "latitude": to_float(s.get("stop_lat")),
                "longitude": to_float(s.get("stop_lon")),
                "platforms": [{"stop_id": c["stop_id"], "name": c.get("stop_name")} for c in platforms][:12],
                "exits": sorted(c.get("stop_name") or c["stop_id"] for c in exits),
            }
        )
    return {"stations": out}


def _station_stop_ids(sched: gtfs.GTFSSchedule, station: str) -> tuple[list[dict[str, str]], set[str]]:
    hits = sched.find_stations(station)
    if not hits:
        raise ToolError(f"No train station matches '{station}'. Try find_train_station.")
    return hits, sched.expand_stop_ids([h["stop_id"] for h in hits])


def crowd_line(sched: gtfs.GTFSSchedule, route_id: str) -> str | None:
    """The TrainLine code get_station_crowd expects, for a GTFS route."""
    line = sched.line_code(route_id).upper()
    short = sched.routes.get(route_id, {}).get("route_short_name", "").upper()
    if short in ("CG", "CE"):
        return f"{short}L"
    return {"BP": "BPL", "SK": "SLRT", "PG": "PLRT"}.get(line, line if line in TRAIN_LINE_NAMES else None)


@mcp.tool(annotations=READ_ONLY)
async def get_scheduled_train_departures(
    station: Annotated[str, Field(description="Station name or code, e.g. 'Bishan' or 'NS17'")],
    to_station: Annotated[str | None, Field(description="Only trains that go on to stop here, e.g. 'Dhoby Ghaut'. Use this for a commuter's direction of travel.")] = None,
    line: Annotated[str | None, Field(description="Only this line, e.g. 'NSL', 'DTL', 'CCL' (or short codes 'NS', 'DT')")] = None,
    window_minutes: Annotated[int, Field(ge=5, le=240)] = 30,
    limit: Annotated[int, Field(ge=1, le=50)] = 12,
) -> dict[str, Any]:
    """SCHEDULED (timetable, not live) MRT/LRT departures from a station, from LTA's GTFS train schedule. Filter by to_station and/or line to get one direction. LTA does not publish real-time next-train times; check get_train_service_alerts for disruptions."""
    svc = services()
    sched = await svc.train_schedule()
    hits, stop_ids = _station_stop_ids(sched, station)
    to_ids = _station_stop_ids(sched, to_station)[1] if to_station else None
    now = svc.now()
    deps = sched.departures(stop_ids, now, window_minutes=window_minutes, limit=limit, to_stop_ids=to_ids, line=line)
    out: dict[str, Any] = {
        "station_matches": sorted({h.get("stop_name", "") for h in hits}),
        "kind": "scheduled timetable (not real-time)",
        "as_of": now.isoformat(timespec="seconds"),
        "departures": [
            {
                "time": d.when.strftime("%H:%M"),
                "eta": d.when.isoformat(timespec="seconds"),
                "minutes": _minutes_until(d.when, now),
                "line": sched.route_label(d.route_id),
                "line_code": sched.line_code(d.route_id),
                "towards": d.headsign or None,
                "direction_id": d.direction_id or None,
                "platform_stop_id": d.stop_id,
            }
            for d in deps
        ],
    }
    if not deps and (to_station or line):
        out["note"] = "No scheduled trains match in this window. Check the direction/line with check_train_leg, or widen window_minutes."
    return out


@mcp.tool(annotations=READ_ONLY)
async def check_train_leg(
    board_station: Annotated[str, Field(description="Station where the commuter boards, name or code, e.g. 'Bishan' or 'NS17'")],
    alight_station: Annotated[str, Field(description="Station where they get off, e.g. 'Dhoby Ghaut'")],
) -> dict[str, Any]:
    """Check that a train runs directly from one MRT/LRT station to another (no change of line), from today's timetable. Returns each line that does it with direction ('towards'), stops travelled, scheduled ride minutes, and the station codes to use with get_station_crowd."""
    svc = services()
    sched = await svc.train_schedule()
    board_hits, board_ids = _station_stop_ids(sched, board_station)
    alight_hits, alight_ids = _station_stop_ids(sched, alight_station)
    options = sched.leg_options(board_ids, alight_ids, svc.now().date())
    board_name = board_hits[0].get("stop_name")
    alight_name = alight_hits[0].get("stop_name")
    if not options:
        raise ToolError(
            f"No direct train from {board_name} to {alight_name} today. The trip may need a change of line, "
            "or the stations may be on different lines: check each leg separately."
        )
    code = lambda stop_id: sched.stops.get(stop_id, {}).get("stop_code") or stop_id  # noqa: E731
    return {
        "board": board_name,
        "alight": alight_name,
        "options": [
            {
                "line": o["line"],
                "line_name": sched.route_label(o["route_id"]),
                "crowd_line": crowd_line(sched, o["route_id"]),
                "direction_id": o["direction_id"],
                "towards": o["towards"],
                "board_code": code(o["board_stop_id"]),
                "alight_code": code(o["alight_stop_id"]),
                "stops_travelled": o["stops_travelled"],
                "ride_min": o["ride_min"],
                "trains_today": o["trips_on_day"],
            }
            for o in options
        ],
    }


async def _resolve_station_codes(station: str, available: set[str]) -> set[str]:
    """Accept codes ('EW13', 'EW13,NS25') or a name resolved through the GTFS schedule."""
    parts = {p.strip().upper() for p in station.split(",") if p.strip()}
    codes = {p for p in parts if p in available or STATION_CODE.match(p)}
    if codes == parts:
        return codes
    try:
        sched = await services().train_schedule()
    except ToolError:
        sched = None
    if sched is not None:
        for hit in sched.find_stations(station):
            ids = {hit.get("stop_id", ""), hit.get("stop_code", "")}
            ids |= {c.get("stop_code", "") for c in sched.stops.values() if c.get("parent_station") == hit.get("stop_id")}
            for ident in ids:
                for token in re.split(r"[^A-Za-z0-9]+", ident.upper()):
                    if token in available:
                        codes.add(token)
    if not codes:
        raise ToolError(f"Could not map '{station}' to a station code on this line. Pass a code such as 'EW13'.")
    return codes


def _crowd(level: Any) -> str:
    return CROWD.get(str(level).lower(), "unknown")


@mcp.tool(annotations=READ_ONLY)
async def get_station_crowd(
    train_line: Annotated[CrowdLine, Field(description="Train line code")],
    station: Annotated[str | None, Field(description="Optional station code(s) or name, e.g. 'EW13' or 'EW13,EW14'")] = None,
) -> dict[str, Any]:
    """Real-time crowd level (low/moderate/high) at MRT/LRT stations on a line, updated every 10 minutes. Station-level, not per platform."""
    rows = _rows(await services().lta.get("PCDRealTime", {"TrainLine": train_line}, ttl=60))
    if station:
        wanted = await _resolve_station_codes(station, {str(r.get("Station", "")).upper() for r in rows})
        rows = [r for r in rows if str(r.get("Station", "")).upper() in wanted]
    stations = [
        {"station": r.get("Station"), "crowd": _crowd(r.get("CrowdLevel")), "from": r.get("StartTime"), "to": r.get("EndTime")}
        for r in sorted(rows, key=lambda r: natural_key(r.get("Station", "")))
    ]
    summary: dict[str, int] = defaultdict(int)
    for s in stations:
        summary[s["crowd"]] += 1
    return {"line": train_line, "line_name": TRAIN_LINE_NAMES[train_line], "summary": dict(summary), "stations": stations}


def flatten_crowd_forecast(rows: list[dict[str, Any]]) -> list[tuple[str, datetime, str]]:
    out = []
    for rec in rows:
        for st in rec.get("Stations") or [rec]:
            code = st.get("Station")
            for iv in st.get("Interval") or st.get("Intervals") or [st]:
                start = parse_dt(iv.get("Start"))
                if code and start:
                    out.append((code, start, _crowd(iv.get("CrowdLevel"))))
    return out


@mcp.tool(annotations=READ_ONLY)
async def get_station_crowd_forecast(
    train_line: Annotated[CrowdLine, Field(description="Train line code")],
    station: Annotated[str | None, Field(description="Optional station code(s) or name, e.g. 'NS1'")] = None,
    hours_ahead: Annotated[int, Field(ge=1, le=24)] = 3,
) -> dict[str, Any]:
    """Forecast crowd level per station in 30-minute slots for today (refreshed daily)."""
    svc = services()
    entries = flatten_crowd_forecast(_rows(await svc.lta.get("PCDForecast", {"TrainLine": train_line}, ttl=3600)))
    if station:
        wanted = await _resolve_station_codes(station, {c.upper() for c, _, _ in entries})
        entries = [e for e in entries if e[0].upper() in wanted]
    now = svc.now()
    start, end = now - timedelta(minutes=30), now + timedelta(hours=hours_ahead)
    by_station: dict[str, list[dict[str, str]]] = defaultdict(list)
    for code, when, level in sorted(entries, key=lambda e: (natural_key(e[0]), e[1])):
        if start < when <= end:
            by_station[code].append({"from": when.strftime("%H:%M"), "crowd": level})
    return {"line": train_line, "line_name": TRAIN_LINE_NAMES[train_line], "forecast": dict(by_station)}


# ==== Traffic ===================================================================================


@mcp.tool(annotations=READ_ONLY)
async def get_traffic_incidents(
    incident_type: Annotated[str | None, Field(description="e.g. 'Accident', 'Roadwork', 'Vehicle breakdown', 'Heavy Traffic'")] = None,
    keyword: Annotated[str | None, Field(description="Filter message text, e.g. 'PIE' or 'Changi'")] = None,
) -> dict[str, Any]:
    """Current road incidents in Singapore: accidents, breakdowns, roadworks, road blocks, diversions, heavy traffic."""
    rows = _rows(await services().lta.get("TrafficIncidents", ttl=60))
    if incident_type:
        rows = [r for r in rows if str(r.get("Type", "")).lower() == incident_type.lower()]
    if keyword:
        rows = [r for r in rows if matches_all_words(keyword, r.get("Message"))]
    counts: dict[str, int] = defaultdict(int)
    for r in rows:
        counts[r.get("Type", "Unknown")] += 1
    return {
        "count": len(rows),
        "by_type": dict(counts),
        "incidents": [
            {"type": r.get("Type"), "message": r.get("Message"), "latitude": r.get("Latitude"), "longitude": r.get("Longitude")}
            for r in rows
        ],
    }


@mcp.tool(annotations=READ_ONLY)
async def get_expressway_travel_times(
    expressway: Annotated[str | None, Field(description="e.g. 'PIE', 'AYE', 'CTE', 'ECP'")] = None,
) -> dict[str, Any]:
    """Estimated travel time (minutes) along expressway segments, grouped by expressway and direction. Updates every 5 minutes."""
    rows = await services().lta.get_all("EstTravelTimes", ttl=120)
    if expressway:
        rows = [r for r in rows if str(r.get("Name", "")).upper() == expressway.upper()]
    groups: dict[tuple[str, Any, str], list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        groups[(r.get("Name", ""), r.get("Direction"), r.get("FarEndPoint", ""))].append(r)
    out = []
    for (name, direction, far_end), segs in sorted(groups.items(), key=lambda kv: (kv[0][0], str(kv[0][1]))):
        out.append(
            {
                "expressway": name,
                "towards": far_end,
                "direction": direction,
                "total_minutes": sum(int(s.get("EstTime") or 0) for s in segs),
                "segments": [{"from": s.get("StartPoint"), "to": s.get("EndPoint"), "minutes": s.get("EstTime")} for s in segs],
            }
        )
    if expressway and not out:
        raise ToolError(f"No travel times for expressway '{expressway}'.")
    return {"routes": out}


@mcp.tool(annotations=READ_ONLY)
async def get_traffic_speed(
    road_name: Annotated[str, Field(description="Road name to match, e.g. 'PAN ISLAND EXPRESSWAY' or 'Orchard Road'")],
    limit: Annotated[int, Field(ge=1, le=200)] = 40,
) -> dict[str, Any]:
    """Current speed bands (1 = 0-9 km/h ... 8 = 70+ km/h) for road links matching a road name. Large dataset: first call may take ~30s."""
    rows = await services().lta.get_all("v4/TrafficSpeedBands", ttl=240)
    rows = [r for r in rows if matches_all_words(road_name, r.get("RoadName"))]
    if not rows:
        raise ToolError(f"No road links match '{road_name}'.")
    bands = [int(r.get("SpeedBand") or 0) for r in rows if r.get("SpeedBand") not in (None, "")]
    return {
        "links_matched": len(rows),
        "average_speed_band": round(sum(bands) / len(bands), 2) if bands else None,
        "slow_links_band_1_to_3": sum(1 for b in bands if 1 <= b <= 3),
        "links": [
            {
                "road": r.get("RoadName"),
                "speed_band": r.get("SpeedBand"),
                "speed_kmh": f"{r.get('MinimumSpeed')}-{r.get('MaximumSpeed')}",
                "start": [to_float(r.get("StartLat")), to_float(r.get("StartLon"))],
                "end": [to_float(r.get("EndLat")), to_float(r.get("EndLon"))],
            }
            for r in rows[:limit]
        ],
    }


@mcp.tool(annotations=READ_ONLY)
async def get_traffic_cameras(
    latitude: Annotated[float | None, Field(description="Find cameras near this latitude")] = None,
    longitude: Annotated[float | None, Field(description="Find cameras near this longitude")] = None,
    camera_id: Annotated[str | None, Field(description="Specific camera id, e.g. '2701' (Woodlands Causeway)")] = None,
    limit: Annotated[int, Field(ge=1, le=20)] = 5,
) -> dict[str, Any]:
    """Live traffic camera images on expressways and at Woodlands/Tuas checkpoints. Image links expire after 15 minutes."""
    rows = _rows(await services().lta.get("Traffic-Imagesv2", ttl=60))
    if camera_id:
        rows = [r for r in rows if str(r.get("CameraID")) == camera_id]
    items = []
    for r in rows:
        item = {"camera_id": r.get("CameraID"), "latitude": r.get("Latitude"), "longitude": r.get("Longitude"), "image_url": r.get("ImageLink")}
        if latitude is not None and longitude is not None:
            item["distance_m"] = round(haversine_m(latitude, longitude, float(r["Latitude"]), float(r["Longitude"])))
        items.append(item)
    items.sort(key=lambda i: i.get("distance_m", 0))
    return {"cameras": items[:limit]}


@mcp.tool(annotations=READ_ONLY)
async def get_carpark_availability(
    query: Annotated[str | None, Field(description="Development / area name, e.g. 'Suntec' or 'Orchard'")] = None,
    latitude: Annotated[float | None, Field(description="Find carparks near this latitude")] = None,
    longitude: Annotated[float | None, Field(description="Find carparks near this longitude")] = None,
    radius_m: Annotated[int, Field(ge=50, le=5000)] = 800,
    lot_type: Annotated[Literal["C", "H", "Y"], Field(description="C=car, H=heavy vehicle, Y=motorcycle")] = "C",
    limit: Annotated[int, Field(ge=1, le=50)] = 10,
) -> dict[str, Any]:
    """Available parking lots at HDB, LTA and URA carparks, updated every minute."""
    if not query and (latitude is None or longitude is None):
        raise ToolError("Give a query, or both latitude and longitude.")
    rows = await services().lta.get_all("CarParkAvailabilityv2", ttl=60)
    out = []
    for r in rows:
        if r.get("LotType") != lot_type:
            continue
        if query and not matches_all_words(query, r.get("Development"), r.get("Area"), r.get("CarParkID")):
            continue
        item = {
            "carpark_id": r.get("CarParkID"),
            "development": r.get("Development"),
            "area": r.get("Area") or None,
            "agency": r.get("Agency"),
            "available_lots": r.get("AvailableLots"),
        }
        loc = str(r.get("Location") or "").split()
        if len(loc) == 2:
            lat, lon = to_float(loc[0]), to_float(loc[1])
            item["latitude"], item["longitude"] = lat, lon
            if latitude is not None and longitude is not None and lat is not None and lon is not None:
                d = haversine_m(latitude, longitude, lat, lon)
                if d > radius_m:
                    continue
                item["distance_m"] = round(d)
        elif latitude is not None and not query:
            continue
        out.append(item)
    out.sort(key=lambda i: i.get("distance_m", 0))
    return {"count": len(out), "carparks": out[:limit]}


@mcp.tool(annotations=READ_ONLY)
async def get_flood_alerts() -> dict[str, Any]:
    """Active PUB flash-flood alerts across Singapore (updated every 3 minutes)."""
    svc = services()
    rows = _rows(await svc.lta.get("PubFloodAlerts", ttl=60))
    now = svc.now()
    alerts = []
    for r in rows:
        expires = parse_dt(r.get("expires"))
        alerts.append(
            {
                "headline": r.get("headline"),
                "description": r.get("description"),
                "instruction": r.get("instruction"),
                "severity": r.get("severity"),
                "message_type": r.get("msgType"),
                "issued": r.get("dateTime"),
                "expires": r.get("expires"),
                "active": r.get("msgType") != "Cancel" and (expires is None or expires > now),
            }
        )
    active = [a for a in alerts if a["active"]]
    return {"active_count": len(active), "alerts": active, "inactive_or_cancelled": len(alerts) - len(active)}


@mcp.tool(annotations=READ_ONLY)
async def get_emas_messages(
    keyword: Annotated[str | None, Field(description="Filter sign text, e.g. 'PIE' or 'ACCIDENT'")] = None,
) -> dict[str, Any]:
    """Traffic advisories currently shown on EMAS electronic signboards along expressways."""
    rows = _rows(await services().lta.get("VMS", ttl=60))
    rows = [r for r in rows if r.get("Message") and (not keyword or matches_all_words(keyword, r.get("Message")))]
    return {
        "count": len(rows),
        "signs": [{"id": r.get("EquipmentID"), "message": r.get("Message"), "latitude": r.get("Latitude"), "longitude": r.get("Longitude")} for r in rows],
    }


# ==== Weather ===================================================================================


async def _two_hour() -> dict[str, Any]:
    return await services().weather.get("two-hr-forecast", ttl=300)


def _nearest_area(data: dict[str, Any], lat: float, lon: float) -> tuple[str, float]:
    best = min(
        data.get("area_metadata") or [],
        key=lambda a: haversine_m(lat, lon, a["label_location"]["latitude"], a["label_location"]["longitude"]),
    )
    loc = best["label_location"]
    return best["name"], haversine_m(lat, lon, loc["latitude"], loc["longitude"])


@mcp.tool(annotations=READ_ONLY)
async def get_weather_forecast_2h(
    area: Annotated[str | None, Field(description="Town/area name, e.g. 'Bedok' or 'Jurong West'")] = None,
    latitude: Annotated[float | None, Field(description="Use the area nearest to this latitude")] = None,
    longitude: Annotated[float | None, Field(description="Use the area nearest to this longitude")] = None,
) -> dict[str, Any]:
    """NEA 2-hour weather forecast by area (47 areas), updated every 30 minutes. Omit filters for all areas."""
    data = await _two_hour()
    items = data.get("items") or []
    if not items:
        raise ToolError("data.gov.sg returned no 2-hour forecast.")
    item = items[0]
    forecasts = item.get("forecasts") or []
    note = None
    if latitude is not None and longitude is not None:
        name, dist = _nearest_area(data, latitude, longitude)
        forecasts = [f for f in forecasts if f.get("area") == name]
        note = f"Nearest forecast area: {name} ({dist / 1000:.1f} km away)"
    elif area:
        forecasts = [f for f in forecasts if matches_all_words(area, f.get("area"))]
        if not forecasts:
            names = sorted(a["name"] for a in data.get("area_metadata") or [])
            raise ToolError(f"No forecast area matches '{area}'. Areas: {', '.join(names)}")
    out = {
        "valid": (item.get("valid_period") or {}).get("text"),
        "updated": item.get("update_timestamp"),
        "forecasts": [{"area": f.get("area"), "forecast": f.get("forecast")} for f in forecasts],
    }
    if note:
        out["note"] = note
    return out


@mcp.tool(annotations=READ_ONLY)
async def get_weather_forecast_24h() -> dict[str, Any]:
    """NEA 24-hour forecast: overall outlook, temperature, humidity, wind, and regional (N/S/E/W/central) forecasts per time period."""
    data = await services().weather.get("twenty-four-hr-forecast", ttl=900)
    records = data.get("records") or []
    if not records:
        raise ToolError("data.gov.sg returned no 24-hour forecast.")
    rec = records[0]
    g = rec.get("general") or {}
    return {
        "updated": rec.get("updatedTimestamp"),
        "valid": (g.get("validPeriod") or {}).get("text"),
        "forecast": (g.get("forecast") or {}).get("text"),
        "temperature_c": {"low": (g.get("temperature") or {}).get("low"), "high": (g.get("temperature") or {}).get("high")},
        "humidity_pct": {"low": (g.get("relativeHumidity") or {}).get("low"), "high": (g.get("relativeHumidity") or {}).get("high")},
        "wind": {"direction": (g.get("wind") or {}).get("direction"), "speed_kmh": (g.get("wind") or {}).get("speed")},
        "periods": [
            {
                "period": (p.get("timePeriod") or {}).get("text"),
                "regions": {region: (v or {}).get("text") for region, v in (p.get("regions") or {}).items()},
            }
            for p in rec.get("periods") or []
        ],
    }


@mcp.tool(annotations=READ_ONLY)
async def get_weather_outlook_4day() -> dict[str, Any]:
    """NEA 4-day weather outlook: daily forecast, temperature, humidity and wind."""
    data = await services().weather.get("four-day-outlook", ttl=1800)
    records = data.get("records") or []
    if not records:
        raise ToolError("data.gov.sg returned no 4-day outlook.")
    rec = records[0]
    return {
        "updated": rec.get("updatedTimestamp"),
        "days": [
            {
                "day": f.get("day"),
                "date": (f.get("timestamp") or "")[:10] or None,
                "forecast": (f.get("forecast") or {}).get("text"),
                "summary": (f.get("forecast") or {}).get("summary"),
                "temperature_c": {"low": (f.get("temperature") or {}).get("low"), "high": (f.get("temperature") or {}).get("high")},
                "humidity_pct": {"low": (f.get("relativeHumidity") or {}).get("low"), "high": (f.get("relativeHumidity") or {}).get("high")},
                "wind": {"direction": (f.get("wind") or {}).get("direction"), "speed_kmh": (f.get("wind") or {}).get("speed")},
            }
            for f in rec.get("forecasts") or []
        ],
    }


def nearest_readings(data: dict[str, Any], lat: float, lon: float, n: int) -> dict[str, Any]:
    readings = (data.get("readings") or [{}])[0]
    values = {d.get("stationId"): d.get("value") for d in readings.get("data") or []}
    stations = []
    for s in data.get("stations") or []:
        loc = s.get("location") or {}
        if s.get("id") in values and loc.get("latitude") is not None:
            d = haversine_m(lat, lon, loc["latitude"], loc["longitude"])
            stations.append({"station": s.get("name"), "distance_km": round(d / 1000, 1), "value": values[s["id"]]})
    stations.sort(key=lambda s: s["distance_km"])
    return {"timestamp": readings.get("timestamp"), "unit": data.get("readingUnit"), "nearest": stations[:n]}


@mcp.tool(annotations=READ_ONLY)
async def get_current_weather(
    latitude: Annotated[float | None, Field(description="Latitude of the place")] = None,
    longitude: Annotated[float | None, Field(description="Longitude of the place")] = None,
    area: Annotated[str | None, Field(description="Or a town/area name, e.g. 'Tampines'")] = None,
    stations: Annotated[int, Field(ge=1, le=5)] = 2,
) -> dict[str, Any]:
    """Latest measured rainfall (mm, 5-min) and air temperature (°C) from the NEA weather stations nearest a location."""
    if latitude is None or longitude is None:
        if not area:
            raise ToolError("Give latitude and longitude, or an area name.")
        meta = (await _two_hour()).get("area_metadata") or []
        match = next((a for a in meta if matches_all_words(area, a.get("name"))), None)
        if match is None:
            raise ToolError(f"Unknown area '{area}'. Use get_weather_forecast_2h to see area names, or pass lat/lon.")
        latitude, longitude = match["label_location"]["latitude"], match["label_location"]["longitude"]
    weather = services().weather
    rain = await weather.get("rainfall", ttl=120)
    temp = await weather.get("air-temperature", ttl=120)
    return {
        "location": {"latitude": latitude, "longitude": longitude},
        "rainfall": nearest_readings(rain, latitude, longitude, stations),
        "air_temperature": nearest_readings(temp, latitude, longitude, stations),
    }


def main() -> None:
    # httpx logs every URL at INFO; that would put pre-signed S3 tokens in the logs.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    mcp.run()


if __name__ == "__main__":
    main()
