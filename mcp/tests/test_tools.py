"""End-to-end tool tests through the MCP protocol (in-memory client) against fake backends."""

from __future__ import annotations

import json
from typing import Any

import pytest
from mcp import Client

from sg_transport_mcp.server import mcp

from .conftest import TEST_KEY


async def call(name: str, args: dict[str, Any] | None = None) -> tuple[bool, Any]:
    async with Client(mcp) as client:
        res = await client.call_tool(name, args or {})
    text = res.content[0].text if res.content else ""
    if res.is_error:
        return True, text
    data = res.structured_content if res.structured_content is not None else json.loads(text)
    return False, data


async def ok(name: str, args: dict[str, Any] | None = None) -> Any:
    is_error, data = await call(name, args)
    assert not is_error, data
    return data


# ---- plumbing ---------------------------------------------------------------------------------


async def test_all_tools_listed_read_only():
    async with Client(mcp) as client:
        tools = (await client.list_tools()).tools
    assert len(tools) == 22
    assert all(t.annotations and t.annotations.read_only_hint for t in tools)


async def test_missing_key_gives_clear_error(install):
    install(key=None)
    is_error, text = await call("get_bus_arrivals", {"bus_stop_code": "83139"})
    assert is_error and "LTA_ACCOUNT_KEY is not set" in text


async def test_bad_key_reports_401(install):
    install(key="wrong")
    is_error, text = await call("get_train_service_alerts")
    assert is_error and "HTTP 401" in text


async def test_invalid_stop_code_rejected_by_schema(install):
    install()
    is_error, _ = await call("get_bus_arrivals", {"bus_stop_code": "abc"})
    assert is_error


async def test_pagination_uses_literal_skip_and_fetches_everything(install):
    fake = install()
    data = await ok("find_bus_stops", {"query": "Blk 1199"})
    assert [s["bus_stop_code"] for s in data["stops"]] == ["11199"]
    urls = [str(r.url) for r in fake.lta_requests if "BusStops" in str(r.url)]
    assert any("$skip=500" in u for u in urls), urls
    assert all("%24skip" not in u for u in urls)


# ---- buses ------------------------------------------------------------------------------------


async def test_bus_arrivals_formatting(install):
    install()
    data = await ok("get_bus_arrivals", {"bus_stop_code": "83139"})
    assert [s["service_no"] for s in data["services"]] == ["2", "10", "15"]
    svc15 = data["services"][2]
    assert svc15["operator"] == "Go-Ahead Singapore"
    first, second = svc15["next_buses"]
    assert first["display"] == "Arr" and first["live"] is True and first["load"] == "seats available"
    assert first["wheelchair_accessible"] is True and first["position"] == {"latitude": 1.32, "longitude": 103.94}
    assert second["minutes"] == 7 and second["live"] is False and second["bus_type"] == "double deck"
    assert "position" not in second  # 0,0 coordinates are dropped
    assert len(svc15["next_buses"]) == 2  # blank NextBus3 skipped


async def test_bus_arrivals_empty_body(install):
    install()
    data = await ok("get_bus_arrivals", {"bus_stop_code": "99999"})
    assert data["services"] == [] and "note" in data


async def test_find_bus_stops_near_location(install):
    install()
    data = await ok("find_bus_stops", {"latitude": 1.3273, "longitude": 103.9464, "radius_m": 200})
    assert [s["bus_stop_code"] for s in data["stops"]] == ["83139", "83131"]
    assert data["stops"][0]["distance_m"] < 50


async def test_bus_service(install):
    install()
    data = await ok("get_bus_service", {"service_no": "15"})
    d1 = data["directions"][0]
    assert data["operator"] == "Go-Ahead Singapore"
    assert d1["from"].startswith("Opp Tanah Merah Stn") and d1["to"].startswith("Hotel Grand Pacific")
    assert d1["frequency_minutes"]["am_peak_0630_0830"] == "08-12"


async def test_bus_route_sorted_with_names(install):
    install()
    data = await ok("get_bus_route", {"service_no": "15", "direction": 1})
    stops = data["directions"][0]["stops"]
    assert [s["bus_stop_code"] for s in stops] == ["83139", "01012"]
    assert stops[1]["description"] == "Hotel Grand Pacific"
    assert stops[1]["first_last_bus"]["weekday"] == "0615-2352"


async def test_unknown_bus_service(install):
    install()
    is_error, text = await call("get_bus_route", {"service_no": "999X"})
    assert is_error and "999X" in text


# ---- trains -----------------------------------------------------------------------------------


async def test_train_alerts(install):
    install()
    data = await ok("get_train_service_alerts")
    assert data["status"] == "disrupted service or major delays"
    seg = data["affected_segments"][0]
    assert seg["line_name"] == "North East Line" and seg["stations"] == ["NE9", "NE8", "NE7", "NE6"]
    assert "Boon Keng" in data["messages"][0]["content"]


async def test_disruption_feed_decodes_gtfs_rt_without_leaking_key(install):
    fake = install()
    data = await ok("get_train_disruption_feed")
    alert = data["alerts"][0]
    assert alert["header"] == "NEL delay" and alert["effect"] == "REDUCED_SERVICE"
    trip = data["trip_updates"][0]
    assert trip["delay_s"] == 300
    assert trip["stop_updates"][1] == {"stop_id": "AMK_P", "status": "SKIPPED"}
    assert fake.download_requests and all("AccountKey" not in r.headers for r in fake.download_requests)
    assert all(TEST_KEY not in str(r.url) for r in fake.download_requests)


async def test_scheduled_departures_timetable_and_frequency(install):
    install()
    data = await ok("get_scheduled_train_departures", {"station": "Bishan", "window_minutes": 15})
    assert data["kind"].startswith("scheduled")
    deps = data["departures"]
    # Frequency trip F1 runs 07:00-09:00 every 5 min from AMK, reaching Bishan 3 min later.
    assert [(d["time"], d["line"]) for d in deps] == [
        ("08:03", "Circle Line"),
        ("08:08", "Circle Line"),
        ("08:10", "North South Line"),
        ("08:13", "Circle Line"),
    ]
    assert deps[2]["towards"] == "Marina South Pier"  # Sunday-only trip T_SUN at 08:12 excluded on Wednesday
    # T_END terminates at Bishan at 08:06, so it is an arrival, not a departure.
    assert all(d["towards"] != "Bishan" for d in deps)


async def test_departures_filtered_to_direction_and_line(install):
    install()
    # Trips from Bishan that go on to Braddell: T1 (NSL, 08:10) and the Circle Line frequency trip F1.
    data = await ok("get_scheduled_train_departures", {"station": "Bishan", "to_station": "Braddell", "window_minutes": 15})
    assert [(d["time"], d["line_code"]) for d in data["departures"]] == [
        ("08:03", "CCL"),
        ("08:08", "CCL"),
        ("08:10", "NSL"),
        ("08:13", "CCL"),
    ]
    data = await ok("get_scheduled_train_departures", {"station": "Bishan", "to_station": "Braddell", "line": "nsl", "window_minutes": 15})
    assert [d["time"] for d in data["departures"]] == ["08:10"]
    # Nothing runs from Bishan back to Ang Mo Kio in the fixture.
    data = await ok("get_scheduled_train_departures", {"station": "Bishan", "to_station": "Ang Mo Kio"})
    assert data["departures"] == [] and "check_train_leg" in data["note"]


async def test_check_train_leg(install):
    install()
    data = await ok("check_train_leg", {"board_station": "Ang Mo Kio", "alight_station": "Bishan"})
    by_line = {o["line"]: o for o in data["options"]}
    assert set(by_line) == {"NSL", "CCL"}
    nsl = by_line["NSL"]
    # T1 departs AMK 08:05, arrives Bishan 08:09; T_END departs 08:01, arrives 08:06 -> median 4.5 rounds to 4.
    assert nsl["ride_min"] in (4, 5) and nsl["stops_travelled"] == 1 and nsl["trains_today"] == 2
    assert nsl["board_code"] == "NS16" and nsl["alight_code"] == "NS17" and nsl["crowd_line"] == "NSL"
    assert nsl["towards"] in ("Marina South Pier", "Bishan")
    assert by_line["CCL"]["alight_code"] == "CC15"


async def test_check_train_leg_wrong_direction(install):
    install()
    is_error, text = await call("check_train_leg", {"board_station": "Braddell", "alight_station": "Ang Mo Kio"})
    assert is_error and "No direct train" in text


def test_parse_bus_advisories():
    from sg_transport_mcp.server import parse_bus_advisories

    msgs = [
        {"content": "11/11/2026 14:25-Bus services 5, 23, 59, 518 and 966 are delayed by up to 25 minutes due to an accident along PIE.", "created": "x"},
        {"content": "Bus services 170 and 170X have been diverted from Woodlands Road.", "created": "y"},
        {"content": "Bus service 961 is not calling at Blk 123.", "created": "z"},
        {"content": "1710hrs: NEL - No train service between Harbourfront and Dhoby Ghaut.", "created": "w"},
    ]
    out = parse_bus_advisories(msgs)
    assert [a["services"] for a in out] == [["5", "23", "59", "518", "966"], ["170", "170X"], ["961"]]
    assert [a["kind"] for a in out] == ["delay", "diversion", "advisory"]
    assert out[0]["delay_up_to_min"] == 25 and out[1]["delay_up_to_min"] is None


async def test_find_train_station(install):
    install()
    data = await ok("find_train_station", {"query": "NS17"})
    st = data["stations"][0]
    assert st["name"] == "Bishan" and len(st["platforms"]) == 2
    assert st["exits"] == ["A"]


async def test_station_crowd_by_code_and_name(install):
    install()
    data = await ok("get_station_crowd", {"train_line": "EWL"})
    assert data["summary"] == {"high": 1, "moderate": 1, "low": 1, "unknown": 1}
    assert [s["station"] for s in data["stations"]] == ["EW2", "EW13", "EW14", "EW24"]
    data = await ok("get_station_crowd", {"train_line": "EWL", "station": "ew13, EW14"})
    assert [s["crowd"] for s in data["stations"]] == ["high", "moderate"]


async def test_station_crowd_rejects_unknown_line(install):
    install()
    is_error, _ = await call("get_station_crowd", {"train_line": "XYZ"})
    assert is_error


async def test_crowd_forecast_window(install):
    install()
    data = await ok("get_station_crowd_forecast", {"train_line": "NSL", "station": "NS24", "hours_ahead": 1})
    assert list(data["forecast"]) == ["NS24"]
    assert [i["from"] for i in data["forecast"]["NS24"]] == ["08:00", "08:30", "09:00"]
    assert all(i["crowd"] == "high" for i in data["forecast"]["NS24"])


# ---- traffic ----------------------------------------------------------------------------------


async def test_traffic_incidents_filter(install):
    install()
    data = await ok("get_traffic_incidents", {"incident_type": "accident", "keyword": "PIE"})
    assert data["count"] == 1 and "Thomson" in data["incidents"][0]["message"]
    data = await ok("get_traffic_incidents")
    assert data["by_type"] == {"Accident": 2, "Roadwork": 1}


async def test_expressway_travel_times(install):
    install()
    data = await ok("get_expressway_travel_times", {"expressway": "aye"})
    route = data["routes"][0]
    assert route["towards"] == "TUAS CHECKPOINT" and route["total_minutes"] == 9 and len(route["segments"]) == 2


async def test_traffic_speed(install):
    install()
    data = await ok("get_traffic_speed", {"road_name": "pan island"})
    assert data["links_matched"] == 5 and data["slow_links_band_1_to_3"] == 2


async def test_carparks_by_query_and_location(install):
    install()
    data = await ok("get_carpark_availability", {"query": "suntec"})
    assert data["count"] == 1 and data["carparks"][0]["available_lots"] == 352
    data = await ok("get_carpark_availability", {"latitude": 1.3216, "longitude": 103.8705, "radius_m": 300})
    assert [c["carpark_id"] for c in data["carparks"]] == ["KB7"]
    data = await ok("get_carpark_availability", {"query": "suntec", "lot_type": "Y"})
    assert data["carparks"][0]["available_lots"] == 20


async def test_flood_alerts_drop_expired(install):
    install()
    data = await ok("get_flood_alerts")
    assert data["active_count"] == 1 and data["inactive_or_cancelled"] == 1
    assert "Bt Timah" in data["alerts"][0]["description"]


async def test_cameras_nearest(install):
    install()
    data = await ok("get_traffic_cameras", {"latitude": 1.44, "longitude": 103.77, "limit": 1})
    assert data["cameras"][0]["camera_id"] == "2701"


async def test_emas(install):
    install()
    data = await ok("get_emas_messages")
    assert data["count"] == 1


# ---- weather (recorded live data.gov.sg responses) -------------------------------------------


async def test_weather_2h_by_area_and_location(install):
    install()
    data = await ok("get_weather_forecast_2h", {"area": "ang mo kio"})
    assert data["forecasts"] == [{"area": "Ang Mo Kio", "forecast": "Showers"}]
    data = await ok("get_weather_forecast_2h", {"latitude": 1.321, "longitude": 103.924})
    assert data["forecasts"][0]["area"] == "Bedok" and "Bedok" in data["note"]
    is_error, text = await call("get_weather_forecast_2h", {"area": "Atlantis"})
    assert is_error and "Ang Mo Kio" in text


async def test_weather_24h_and_4day(install):
    install()
    day = await ok("get_weather_forecast_24h")
    assert day["forecast"] and set(day["periods"][0]["regions"]) == {"central", "east", "north", "south", "west"}
    outlook = await ok("get_weather_outlook_4day")
    assert len(outlook["days"]) == 4 and outlook["days"][0]["temperature_c"]["high"] is not None


async def test_current_weather(install):
    install()
    data = await ok("get_current_weather", {"area": "Bukit Batok", "stations": 1})
    assert data["rainfall"]["unit"] == "mm" and len(data["rainfall"]["nearest"]) == 1
    assert data["air_temperature"]["nearest"][0]["value"] is not None
