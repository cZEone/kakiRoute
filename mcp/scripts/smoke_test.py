"""Live smoke test: start the server over stdio and call a few tools against the real APIs.

Usage:  uv run python scripts/smoke_test.py
Set LTA_ACCOUNT_KEY first to include the LTA DataMall tools.
"""

import asyncio
import json
import os
import sys

from mcp import Client, StdioServerParameters


async def main() -> int:
    params = StdioServerParameters(command=sys.executable, args=["-m", "sg_transport_mcp.server"], env=dict(os.environ))
    has_key = bool(os.environ.get("LTA_ACCOUNT_KEY"))
    calls = [
        ("get_weather_forecast_2h", {"area": "Bishan"}),
        ("get_weather_forecast_24h", {}),
        ("get_weather_outlook_4day", {}),
        ("get_current_weather", {"latitude": 1.3521, "longitude": 103.8198}),
        ("get_bus_arrivals", {"bus_stop_code": "83139"}),
        ("get_train_service_alerts", {}),
    ]
    if has_key:
        calls += [
            ("find_bus_stops", {"query": "Tanah Merah Stn"}),
            ("find_bus_stops", {"latitude": 1.3521, "longitude": 103.8198, "radius_m": 300}),
            ("get_bus_service", {"service_no": "15"}),
            ("get_bus_route", {"service_no": "15", "direction": 1}),
            ("get_train_disruption_feed", {}),
            ("find_train_station", {"query": "Bishan"}),
            ("get_scheduled_train_departures", {"station": "Bishan"}),
            ("get_station_crowd", {"train_line": "EWL", "station": "EW13"}),
            ("get_station_crowd", {"train_line": "NSL", "station": "Bishan"}),
            ("get_station_crowd_forecast", {"train_line": "NSL", "station": "NS17", "hours_ahead": 1}),
            ("get_traffic_incidents", {}),
            ("get_expressway_travel_times", {"expressway": "PIE"}),
            ("get_traffic_speed", {"road_name": "ORCHARD ROAD", "limit": 3}),
            ("get_traffic_cameras", {"latitude": 1.447, "longitude": 103.77, "limit": 2}),
            ("get_carpark_availability", {"query": "Suntec"}),
            ("get_flood_alerts", {}),
            ("get_emas_messages", {}),
        ]
    failures = 0
    async with Client(params) as client:
        tools = (await client.list_tools()).tools
        print(f"server up: {len(tools)} tools")
        for name, args in calls:
            res = await client.call_tool(name, args)
            text = res.content[0].text if res.content else ""
            expected_error = not has_key and name in ("get_bus_arrivals", "get_train_service_alerts")
            status = "ERROR" if res.is_error else "ok"
            if res.is_error and not expected_error:
                failures += 1
            print(f"\n== {name} {args} -> {status}{' (expected: no LTA key)' if expected_error else ''}")
            print(text[:600] if res.is_error else json.dumps(res.structured_content or json.loads(text), ensure_ascii=False)[:600])
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
