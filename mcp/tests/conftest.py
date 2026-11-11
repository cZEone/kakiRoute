"""Fake LTA DataMall + data.gov.sg backends, driven through the real MCP protocol layer."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import httpx
import pytest
from google.transit import gtfs_realtime_pb2

from sg_transport_mcp import server
from sg_transport_mcp.lta import LTAClient
from sg_transport_mcp.util import SGT
from sg_transport_mcp.weather import WeatherClient

FIXTURES = Path(__file__).parent / "fixtures"
TEST_KEY = "test-account-key"
NOW = datetime(2026, 11, 11, 8, 0, 0, tzinfo=SGT)  # Wednesday 08:00 SGT
S3 = "https://dmprod-datasets.s3.ap-southeast-1.amazonaws.com"


# ---- synthetic DataMall data (field names from LTA API User Guide v6.11) --------------------

BUS_STOPS = [
    {"BusStopCode": f"{10000 + i:05d}", "RoadName": "Filler Rd", "Description": f"Blk {i}", "Latitude": 1.40 + i * 1e-5, "Longitude": 103.70}
    for i in range(1200)
] + [
    {"BusStopCode": "83139", "RoadName": "Upp Changi Rd East", "Description": "Opp Tanah Merah Stn", "Latitude": 1.3272, "Longitude": 103.9466},
    {"BusStopCode": "83131", "RoadName": "Upp Changi Rd East", "Description": "Tanah Merah Stn", "Latitude": 1.3275, "Longitude": 103.9462},
    {"BusStopCode": "01012", "RoadName": "Victoria St", "Description": "Hotel Grand Pacific", "Latitude": 1.2968, "Longitude": 103.8525},
]

BUS_ARRIVAL = {
    "BusStopCode": "83139",
    "Services": [
        {
            "ServiceNo": "15",
            "Operator": "GAS",
            "NextBus": {"OriginCode": "77009", "DestinationCode": "77131", "EstimatedArrival": "2026-11-11T08:00:20+08:00", "Monitored": 1, "Latitude": "1.32", "Longitude": "103.94", "VisitNumber": "1", "Load": "SEA", "Feature": "WAB", "Type": "SD"},
            "NextBus2": {"EstimatedArrival": "2026-11-11T08:07:40+08:00", "Monitored": 0, "Latitude": "0.0", "Longitude": "0.0", "VisitNumber": "1", "Load": "SDA", "Feature": "", "Type": "DD"},
            "NextBus3": {"EstimatedArrival": "", "Monitored": 0, "Latitude": "", "Longitude": "", "VisitNumber": "", "Load": "", "Feature": "", "Type": ""},
        },
        {
            "ServiceNo": "10",
            "Operator": "SBST",
            "NextBus": {"EstimatedArrival": "2026-11-11T08:12:00+08:00", "Monitored": 1, "Latitude": "1.33", "Longitude": "103.95", "VisitNumber": "1", "Load": "LSD", "Feature": "WAB", "Type": "BD"},
        },
        {"ServiceNo": "2", "Operator": "SMRT", "NextBus": {"EstimatedArrival": "2026-11-11T08:03:00+08:00", "Monitored": 1, "Load": "SEA", "Type": "SD", "Feature": "WAB", "VisitNumber": "1"}},
    ],
}

BUS_SERVICES = [
    {"ServiceNo": "15", "Operator": "GAS", "Direction": 1, "Category": "TRUNK", "OriginCode": "83139", "DestinationCode": "01012", "AM_Peak_Freq": "08-12", "AM_Offpeak_Freq": "10-14", "PM_Peak_Freq": "09-12", "PM_Offpeak_Freq": "12-15", "LoopDesc": ""},
    {"ServiceNo": "15", "Operator": "GAS", "Direction": 2, "Category": "TRUNK", "OriginCode": "01012", "DestinationCode": "83131", "AM_Peak_Freq": "08-12", "AM_Offpeak_Freq": "10-14", "PM_Peak_Freq": "09-12", "PM_Offpeak_Freq": "12-15", "LoopDesc": ""},
]

BUS_ROUTES = [
    {"ServiceNo": "99", "Operator": "SBST", "Direction": 1, "StopSequence": i, "BusStopCode": f"{10000 + i:05d}", "Distance": i * 0.4, "WD_FirstBus": "0600", "WD_LastBus": "2330", "SAT_FirstBus": "0600", "SAT_LastBus": "2330", "SUN_FirstBus": "0630", "SUN_LastBus": "2330"}
    for i in range(1, 700)
] + [
    {"ServiceNo": "15", "Operator": "GAS", "Direction": 1, "StopSequence": 2, "BusStopCode": "01012", "Distance": 10.3, "WD_FirstBus": "0615", "WD_LastBus": "2352", "SAT_FirstBus": "0615", "SAT_LastBus": "2349", "SUN_FirstBus": "0620", "SUN_LastBus": "2349"},
    {"ServiceNo": "15", "Operator": "GAS", "Direction": 1, "StopSequence": 1, "BusStopCode": "83139", "Distance": 0, "WD_FirstBus": "0600", "WD_LastBus": "2330", "SAT_FirstBus": "0600", "SAT_LastBus": "2330", "SUN_FirstBus": "0600", "SUN_LastBus": "2330"},
    {"ServiceNo": "15", "Operator": "GAS", "Direction": 2, "StopSequence": 1, "BusStopCode": "01012", "Distance": 0, "WD_FirstBus": "0600", "WD_LastBus": "2330", "SAT_FirstBus": "0600", "SAT_LastBus": "2330", "SUN_FirstBus": "0600", "SUN_LastBus": "2330"},
]

TRAIN_ALERTS = {
    "value": {
        "Status": 2,
        "AffectedSegments": [
            {"Line": "NEL", "Direction": "HarbourFront", "Stations": "NE9,NE8,NE7,NE6", "FreePublicBus": "NE9,NE8,NE7,NE6", "FreeMRTShuttle": "NE9,NE8,NE7,NE6", "MRTShuttleDirection": "HarbourFront"}
        ],
        "Message": [{"Content": "0901hrs: NEL - No train service between Boon Keng and Dhoby Ghaut towards HarbourFront.", "CreatedDate": "2026-11-11 09:01:25"}],
    }
}

PCD_REALTIME = [
    {"Station": "EW13", "StartTime": "2026-11-11T07:50:00+08:00", "EndTime": "2026-11-11T08:00:00+08:00", "CrowdLevel": "h"},
    {"Station": "EW14", "StartTime": "2026-11-11T07:50:00+08:00", "EndTime": "2026-11-11T08:00:00+08:00", "CrowdLevel": "m"},
    {"Station": "EW2", "StartTime": "2026-11-11T07:50:00+08:00", "EndTime": "2026-11-11T08:00:00+08:00", "CrowdLevel": "l"},
    {"Station": "EW24", "StartTime": "2026-11-11T07:50:00+08:00", "EndTime": "2026-11-11T08:00:00+08:00", "CrowdLevel": "NA"},
]

PCD_FORECAST = [
    {
        "Date": "2026-11-11T00:00:00+08:00",
        "Stations": [
            {"Station": code, "Interval": [{"Start": f"2026-11-11T{h:02d}:{m:02d}:00+08:00", "CrowdLevel": lvl} for h in range(24) for m in (0, 30)]}
            for code, lvl in (("NS1", "l"), ("NS24", "h"))
        ],
    }
]

TRAFFIC_INCIDENTS = [
    {"Type": "Accident", "Latitude": 1.33, "Longitude": 103.87, "Message": "(11/11)07:52 Accident on PIE (towards Tuas) after Thomson Rd Exit."},
    {"Type": "Roadwork", "Latitude": 1.30, "Longitude": 103.80, "Message": "(11/11)07:00 Roadworks on AYE (towards City)."},
    {"Type": "Accident", "Latitude": 1.35, "Longitude": 103.98, "Message": "(11/11)07:40 Accident on ECP (towards Changi Airport)."},
]

TRAVEL_TIMES = [
    {"Name": "AYE", "Direction": 1, "FarEndPoint": "TUAS CHECKPOINT", "StartPoint": "AYE/MCE INTERCHANGE", "EndPoint": "TELOK BLANGAH RD", "EstTime": 2},
    {"Name": "AYE", "Direction": 1, "FarEndPoint": "TUAS CHECKPOINT", "StartPoint": "TELOK BLANGAH RD", "EndPoint": "CLEMENTI AVE 6", "EstTime": 7},
    {"Name": "PIE", "Direction": 2, "FarEndPoint": "CHANGI", "StartPoint": "BKE", "EndPoint": "CTE", "EstTime": 9},
]

CARPARKS = [
    {"CarParkID": "1", "Area": "Marina", "Development": "Suntec City", "Location": "1.29375 103.85718", "AvailableLots": 352, "LotType": "C", "Agency": "LTA"},
    {"CarParkID": "1", "Area": "Marina", "Development": "Suntec City", "Location": "1.29375 103.85718", "AvailableLots": 20, "LotType": "Y", "Agency": "LTA"},
    {"CarParkID": "KB7", "Area": "", "Development": "BLK 69 GEYLANG BAHRU", "Location": "1.32158 103.87047", "AvailableLots": 18, "LotType": "C", "Agency": "HDB"},
]

FLOOD_ALERTS = [
    {"alertId": "a1", "dateTime": "2026-11-11T07:30:00+08:00", "msgType": "Alert", "event": "Flood", "severity": "Minor", "expires": "2026-11-12T07:30:00+08:00", "headline": "Flash Flood Alert", "description": "Flash flood at Bt Timah Rd from Wilby Rd to Blackmore Dr.", "instruction": "Please avoid the area."},
    {"alertId": "a2", "dateTime": "2026-11-10T07:30:00+08:00", "msgType": "Alert", "event": "Flood", "severity": "Minor", "expires": "2026-11-11T07:30:00+08:00", "headline": "Old alert", "description": "Expired.", "instruction": ""},
]

CAMERAS = [
    {"CameraID": "2701", "Latitude": 1.447023, "Longitude": 103.7716, "ImageLink": "https://images.example/2701.jpg"},
    {"CameraID": "4703", "Latitude": 1.34355, "Longitude": 103.71118, "ImageLink": "https://images.example/4703.jpg"},
]

SPEED_BANDS = [
    {"LinkID": str(i), "RoadName": "PAN ISLAND EXPRESSWAY" if i % 2 else "ORCHARD ROAD", "RoadCategory": "1", "SpeedBand": 2 if i < 4 else 7, "MinimumSpeed": "10", "MaximumSpeed": "19", "StartLon": "103.8", "StartLat": "1.3", "EndLon": "103.81", "EndLat": "1.31"}
    for i in range(10)
]

VMS = [
    {"EquipmentID": "amvms_v9104", "Latitude": 1.39, "Longitude": 103.82, "Message": "VEH BREAKDOWN SH,AFT U.THOMSON"},
    {"EquipmentID": "amvms_v9200", "Latitude": 1.30, "Longitude": 103.80, "Message": ""},
]


def make_gtfs_zip() -> bytes:
    files = {
        "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nLTA,LTA,https://lta.gov.sg,Asia/Singapore\n",
        "stops.txt": (
            "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
            "BSH,NS17,Bishan,1.3509,103.8485,1,\n"
            "BSH_NS_S,NS17,Bishan NS Platform A,1.3509,103.8485,0,BSH\n"
            "BSH_CC,CC15,Bishan CC Platform,1.3509,103.8485,0,BSH\n"
            "BSH_EA,,A,1.3509,103.8485,2,BSH\n"
            "AMK,NS16,Ang Mo Kio,1.3700,103.8495,1,\n"
            "AMK_P,NS16,Ang Mo Kio Platform,1.3700,103.8495,0,AMK\n"
            "BRH_P,NS18,Braddell Platform,1.3404,103.8470,0,\n"
        ),
        "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nNSL,LTA,NS,North South Line,1\nCCL,LTA,CC,Circle Line,1\n",
        "trips.txt": (
            "route_id,service_id,trip_id,trip_headsign,direction_id\n"
            "NSL,WKDY,T1,Marina South Pier,0\n"
            "NSL,WKDY,T_LATE,Marina South Pier,0\n"
            "NSL,SUN,T_SUN,Marina South Pier,0\n"
            "NSL,WKDY,T_END,Bishan,0\n"
            "CCL,WKDY,F1,HarbourFront,1\n"
        ),
        "stop_times.txt": (
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
            "T1,08:04:00,08:05:00,AMK_P,1\n"
            "T1,08:09:00,08:10:00,BSH_NS_S,2\n"
            "T1,08:12:00,08:12:00,BRH_P,3\n"
            "T_LATE,24:20:00,24:20:00,BSH_NS_S,1\n"
            "T_LATE,24:22:00,24:22:00,BRH_P,2\n"
            "T_SUN,08:12:00,08:12:00,BSH_NS_S,1\n"
            "T_SUN,08:14:00,08:14:00,BRH_P,2\n"
            "T_END,08:01:00,08:01:00,AMK_P,1\n"
            "T_END,08:06:00,08:06:00,BSH_NS_S,2\n"
            "F1,00:00:00,00:00:00,AMK_P,1\n"
            "F1,00:03:00,00:03:00,BSH_CC,2\n"
            "F1,00:06:00,00:06:00,BRH_P,3\n"
        ),
        "calendar.txt": (
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
            "WKDY,1,1,1,1,1,0,0,20260101,20261231\n"
            "SUN,0,0,0,0,0,0,1,20260101,20261231\n"
        ),
        "calendar_dates.txt": "service_id,date,exception_type\n",
        "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nF1,07:00:00,09:00:00,300\n",
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in files.items():
            zf.writestr(name, text)
    return buf.getvalue()


def make_rt_alerts() -> bytes:
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    feed.header.timestamp = int(NOW.timestamp())
    ent = feed.entity.add(id="alert-1")
    ent.alert.cause = gtfs_realtime_pb2.Alert.TECHNICAL_PROBLEM
    ent.alert.effect = gtfs_realtime_pb2.Alert.REDUCED_SERVICE
    ent.alert.header_text.translation.add(text="NEL delay", language="en")
    ent.alert.description_text.translation.add(text="Signalling fault near Dhoby Ghaut", language="en")
    ent.alert.informed_entity.add(route_id="NEL")
    ent.alert.active_period.add(start=int(NOW.timestamp()))
    return feed.SerializeToString()


def make_rt_trip_updates() -> bytes:
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    feed.header.timestamp = int(NOW.timestamp())
    tu = feed.entity.add(id="tu-1").trip_update
    tu.trip.trip_id = "T1"
    tu.trip.route_id = "NSL"
    tu.delay = 300
    stu = tu.stop_time_update.add(stop_id="BSH_NS_S")
    stu.arrival.delay = 300
    skipped = tu.stop_time_update.add(stop_id="AMK_P")
    skipped.schedule_relationship = gtfs_realtime_pb2.TripUpdate.StopTimeUpdate.SKIPPED
    return feed.SerializeToString()


class FakeBackends:
    def __init__(self) -> None:
        self.lta_requests: list[httpx.Request] = []
        self.download_requests: list[httpx.Request] = []
        self.datasets: dict[str, Any] = {
            "BusStops": BUS_STOPS,
            "BusRoutes": BUS_ROUTES,
            "EstTravelTimes": TRAVEL_TIMES,
            "CarParkAvailabilityv2": CARPARKS,
            "v4/TrafficSpeedBands": SPEED_BANDS,
        }
        self.files = {
            "GTFSScheduleTrain": ("train-gtfs-schedule/gtfs_schedule.zip", make_gtfs_zip()),
            "GTFSRealTimeTrainServiceAlerts": ("train-gtfs-real-time/gtfs_realtime.pb", make_rt_alerts()),
            "GTFSRealtimeTrainTripUpdates": ("train-gtfs-trip-update/gtfs_trip_update.pb", make_rt_trip_updates()),
        }

    def lta_handler(self, request: httpx.Request) -> httpx.Response:
        self.lta_requests.append(request)
        if request.headers.get("AccountKey") != TEST_KEY:
            return httpx.Response(401)
        path = urlsplit(str(request.url)).path.split("/ltaodataservice/", 1)[1]
        raw_query = urlsplit(str(request.url)).query
        q = {k: v[0] for k, v in parse_qs(unquote(raw_query)).items()}
        if path in self.datasets:
            skip = int(q.get("$skip", 0))
            return httpx.Response(200, json={"value": self.datasets[path][skip : skip + 500]})
        if path == "v3/BusArrival":
            if q.get("BusStopCode") != "83139":
                return httpx.Response(200, content=b"")
            data = json.loads(json.dumps(BUS_ARRIVAL))
            if q.get("ServiceNo"):
                data["Services"] = [s for s in data["Services"] if s["ServiceNo"] == q["ServiceNo"]]
            return httpx.Response(200, json=data)
        if path == "BusServices":
            return httpx.Response(200, json={"value": [s for s in BUS_SERVICES if s["ServiceNo"] == q.get("ServiceNo")]})
        if path == "TrainServiceAlerts":
            return httpx.Response(200, json=TRAIN_ALERTS)
        if path == "PCDRealTime":
            return httpx.Response(200, json={"value": PCD_REALTIME if q.get("TrainLine") == "EWL" else []})
        if path == "PCDForecast":
            return httpx.Response(200, json={"value": PCD_FORECAST if q.get("TrainLine") == "NSL" else []})
        simple = {"TrafficIncidents": TRAFFIC_INCIDENTS, "PubFloodAlerts": FLOOD_ALERTS, "Traffic-Imagesv2": CAMERAS, "VMS": VMS}
        if path in simple:
            return httpx.Response(200, json={"value": simple[path]})
        if path in self.files:
            return httpx.Response(200, json={"value": [{"Link": f"{S3}/{self.files[path][0]}?X-Amz-Security-Token=abc"}]})
        return httpx.Response(404)

    def download_handler(self, request: httpx.Request) -> httpx.Response:
        self.download_requests.append(request)
        for name, body in self.files.values():
            if request.url.path.endswith(name.rsplit("/", 1)[1]):
                return httpx.Response(200, content=body)
        return httpx.Response(404)

    def weather_handler(self, request: httpx.Request) -> httpx.Response:
        endpoint = request.url.path.rsplit("/", 1)[1]
        path = FIXTURES / f"{endpoint}.json"
        if not path.exists():
            return httpx.Response(404)
        return httpx.Response(200, content=path.read_bytes(), headers={"content-type": "application/json"})


@pytest.fixture
def backends() -> FakeBackends:
    return FakeBackends()


@pytest.fixture
def install(backends: FakeBackends):
    """Install fake clients; returns a function to (re)install with a chosen LTA key."""

    def _install(key: str | None = TEST_KEY) -> FakeBackends:
        server.set_services(
            server.Services(
                lta=LTAClient(
                    key,
                    transport=httpx.MockTransport(backends.lta_handler),
                    download_transport=httpx.MockTransport(backends.download_handler),
                ),
                weather=WeatherClient(transport=httpx.MockTransport(backends.weather_handler)),
                now=lambda: NOW,
            )
        )
        return backends

    yield _install
    server.set_services(None)
