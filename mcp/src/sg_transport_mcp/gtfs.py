"""GTFS Schedule (train timetable) and GTFS-Realtime (alerts, disruption trip updates) helpers."""

from __future__ import annotations

import csv
import io
import math
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Iterator

from google.transit import gtfs_realtime_pb2

from .util import SGT

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def parse_gtfs_time(value: str) -> int | None:
    """'25:10:00' -> seconds after service-day midnight (GTFS allows hours >= 24)."""
    try:
        h, m, s = (int(p) for p in value.strip().split(":"))
    except (ValueError, AttributeError):
        return None
    return h * 3600 + m * 60 + s


@dataclass
class Departure:
    when: datetime
    stop_id: str
    trip_id: str
    route_id: str
    headsign: str
    direction_id: str


@dataclass
class GTFSSchedule:
    """An in-memory GTFS Schedule feed. stop_times.txt is streamed on demand, not held in memory."""

    zip_bytes: bytes
    stops: dict[str, dict[str, str]] = field(default_factory=dict)
    routes: dict[str, dict[str, str]] = field(default_factory=dict)
    trips: dict[str, dict[str, str]] = field(default_factory=dict)
    calendar: list[dict[str, str]] = field(default_factory=list)
    calendar_dates: list[dict[str, str]] = field(default_factory=list)
    frequencies: dict[str, list[tuple[int, int, int]]] = field(default_factory=dict)

    @classmethod
    def from_zip(cls, zip_bytes: bytes) -> "GTFSSchedule":
        feed = cls(zip_bytes=zip_bytes)
        feed.stops = {r["stop_id"]: r for r in feed._read("stops.txt")}
        feed.routes = {r["route_id"]: r for r in feed._read("routes.txt")}
        feed.trips = {r["trip_id"]: r for r in feed._read("trips.txt")}
        feed.calendar = list(feed._read("calendar.txt"))
        feed.calendar_dates = list(feed._read("calendar_dates.txt"))
        for r in feed._read("frequencies.txt"):
            start, end = parse_gtfs_time(r.get("start_time", "")), parse_gtfs_time(r.get("end_time", ""))
            headway = int(r.get("headway_secs") or 0)
            if start is not None and end is not None and headway > 0:
                feed.frequencies.setdefault(r["trip_id"], []).append((start, end, headway))
        return feed

    def _read(self, name: str) -> Iterator[dict[str, str]]:
        with zipfile.ZipFile(io.BytesIO(self.zip_bytes)) as zf:
            member = next((n for n in zf.namelist() if n.rsplit("/", 1)[-1] == name), None)
            if member is None:
                return
            with zf.open(member) as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
                for row in csv.DictReader(text):
                    yield {(k or "").strip(): (v or "").strip() for k, v in row.items()}

    # ---- lookups -------------------------------------------------------------------------

    def find_stations(self, query: str, limit: int = 10) -> list[dict[str, str]]:
        """Match stops by exact id/code first, then by name words. Child platforms fold into parents."""
        q = query.strip().lower()
        exact = [s for s in self.stops.values() if q in (s.get("stop_id", "").lower(), s.get("stop_code", "").lower())]
        if exact:
            return exact[:limit]
        words = q.split()
        hits = [s for s in self.stops.values() if all(w in s.get("stop_name", "").lower() for w in words)]
        parents = [s for s in hits if not s.get("parent_station")]
        return (parents or hits)[:limit]

    def expand_stop_ids(self, stop_ids: list[str]) -> set[str]:
        ids = set(stop_ids)
        ids |= {sid for sid, s in self.stops.items() if s.get("parent_station") in ids}
        return ids

    def route_label(self, route_id: str) -> str:
        r = self.routes.get(route_id, {})
        return r.get("route_long_name") or r.get("route_short_name") or route_id

    def active_services(self, day: date) -> set[str]:
        ymd = day.strftime("%Y%m%d")
        weekday = WEEKDAYS[day.weekday()]
        active = {
            c["service_id"]
            for c in self.calendar
            if c.get(weekday) == "1" and c.get("start_date", "0") <= ymd <= c.get("end_date", "99999999")
        }
        for cd in self.calendar_dates:
            if cd.get("date") != ymd:
                continue
            if cd.get("exception_type") == "1":
                active.add(cd["service_id"])
            elif cd.get("exception_type") == "2":
                active.discard(cd["service_id"])
        return active

    # ---- departures ----------------------------------------------------------------------

    def departures(self, stop_ids: set[str], now: datetime, window_minutes: int = 60, limit: int = 10) -> list[Departure]:
        """Scheduled departures from the given stops between now and now+window (SGT)."""
        now = now.astimezone(SGT)
        horizon = now + timedelta(minutes=window_minutes)
        freq_trips = set(self.frequencies)
        at_stop: list[tuple[str, int, str, int]] = []  # (trip_id, departure secs, stop_id, stop_sequence)
        first_time: dict[str, int] = {}  # first departure of each frequency-based trip template
        last_seq: dict[str, int] = {}  # final stop of each trip, so terminating trains aren't "departures"
        for row in self._read("stop_times.txt"):
            trip_id = row.get("trip_id", "")
            t = parse_gtfs_time(row.get("departure_time") or row.get("arrival_time") or "")
            if t is None:
                continue
            try:
                seq = int(row.get("stop_sequence") or 0)
            except ValueError:
                seq = 0
            if seq > last_seq.get(trip_id, -1):
                last_seq[trip_id] = seq
            if trip_id in freq_trips and (trip_id not in first_time or t < first_time[trip_id]):
                first_time[trip_id] = t
            if row.get("stop_id") in stop_ids:
                at_stop.append((trip_id, t, row["stop_id"], seq))
        at_stop = [(trip, t, stop, seq) for trip, t, stop, seq in at_stop if seq < last_seq.get(trip, seq + 1)]

        out: list[Departure] = []
        today = now.date()
        for day in (today - timedelta(days=1), today):  # yesterday's service day can run past midnight
            services = self.active_services(day)
            midnight = datetime(day.year, day.month, day.day, tzinfo=SGT)
            for trip_id, t, stop_id, _seq in at_stop:
                trip = self.trips.get(trip_id)
                if not trip or trip.get("service_id") not in services:
                    continue
                if trip_id in self.frequencies:
                    offset = t - first_time.get(trip_id, t)
                    for start, end, headway in self.frequencies[trip_id]:
                        lo = (now - midnight).total_seconds() - offset - start
                        k = max(0, math.ceil(lo / headway))
                        while True:
                            dep_start = start + k * headway
                            if dep_start >= end:
                                break
                            when = midnight + timedelta(seconds=dep_start + offset)
                            if when > horizon:
                                break
                            out.append(_dep(when, stop_id, trip_id, trip))
                            k += 1
                else:
                    when = midnight + timedelta(seconds=t)
                    if now <= when <= horizon:
                        out.append(_dep(when, stop_id, trip_id, trip))
        out.sort(key=lambda d: d.when)
        return out[:limit]


def _dep(when: datetime, stop_id: str, trip_id: str, trip: dict[str, str]) -> Departure:
    return Departure(
        when=when,
        stop_id=stop_id,
        trip_id=trip_id,
        route_id=trip.get("route_id", ""),
        headsign=trip.get("trip_headsign", ""),
        direction_id=trip.get("direction_id", ""),
    )


# ---- GTFS-Realtime ---------------------------------------------------------------------------


def decode_feed(data: bytes) -> gtfs_realtime_pb2.FeedMessage:
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(data)
    return feed


def _text(translated: Any) -> str:
    items = list(translated.translation)
    for t in items:
        if t.language.lower().startswith("en"):
            return t.text
    return items[0].text if items else ""


def _ts(seconds: int) -> str | None:
    return datetime.fromtimestamp(seconds, SGT).isoformat() if seconds else None


def summarize_alerts(feed: gtfs_realtime_pb2.FeedMessage) -> list[dict[str, Any]]:
    Alert = gtfs_realtime_pb2.Alert
    out = []
    for ent in feed.entity:
        if not ent.HasField("alert"):
            continue
        a = ent.alert
        out.append(
            {
                "id": ent.id,
                "header": _text(a.header_text),
                "description": _text(a.description_text),
                "cause": Alert.Cause.Name(a.cause) if a.HasField("cause") else None,
                "effect": Alert.Effect.Name(a.effect) if a.HasField("effect") else None,
                "active_periods": [{"start": _ts(p.start), "end": _ts(p.end)} for p in a.active_period],
                "affected": [
                    {k: v for k, v in {"route_id": e.route_id, "stop_id": e.stop_id}.items() if v}
                    for e in a.informed_entity
                ],
            }
        )
    return out


def summarize_trip_updates(feed: gtfs_realtime_pb2.FeedMessage, max_trips: int = 30) -> list[dict[str, Any]]:
    TripDescriptor = gtfs_realtime_pb2.TripDescriptor
    StopTimeUpdate = gtfs_realtime_pb2.TripUpdate.StopTimeUpdate
    out = []
    for ent in feed.entity:
        if not ent.HasField("trip_update"):
            continue
        tu = ent.trip_update
        stops = []
        for stu in tu.stop_time_update:
            item: dict[str, Any] = {"stop_id": stu.stop_id}
            if stu.HasField("schedule_relationship"):
                item["status"] = StopTimeUpdate.ScheduleRelationship.Name(stu.schedule_relationship)
            for label, ev in (("arrival", stu.arrival), ("departure", stu.departure)):
                if stu.HasField(label):
                    if ev.HasField("delay"):
                        item[f"{label}_delay_s"] = ev.delay
                    if ev.HasField("time"):
                        item[f"{label}_time"] = _ts(ev.time)
            stops.append(item)
        out.append(
            {
                "trip_id": tu.trip.trip_id,
                "route_id": tu.trip.route_id,
                "status": TripDescriptor.ScheduleRelationship.Name(tu.trip.schedule_relationship),
                "delay_s": tu.delay if tu.HasField("delay") else None,
                "stop_updates": stops,
            }
        )
        if len(out) >= max_trips:
            break
    return out
