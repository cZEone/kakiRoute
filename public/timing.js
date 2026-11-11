// Pure timing logic: given a saved route and live arrivals, work out which bus
// you'd catch on each leg if you left now. Plain arithmetic, no AI.

const TIGHT_BUFFER_MIN = 2;

// Bus crowding codes used by LTA (and arrivelah).
export const LOAD_LABEL = { SEA: "Seats", SDA: "Standing", LSD: "Limited standing" };
export const LOAD_TITLE = { SEA: "Seats available", SDA: "Standing room available", LSD: "Limited standing room" };

// arrivals response -> sorted, de-duplicated buses for one service:
// [{ time: Date, load: "SEA"|"SDA"|"LSD"|null, live: true|false|null }]
export function arrivalBuses(arrivalsBody, serviceNo) {
  const svc = (arrivalsBody?.services || []).find((s) => String(s.no).toUpperCase() === String(serviceNo).toUpperCase());
  if (!svc) return null; // service not reported at this stop right now
  const seen = new Set();
  const out = [];
  for (const key of ["next", "subsequent", "next2", "next3"]) {
    const b = svc[key];
    const t = b?.time;
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) continue;
    const m = b.monitored;
    out.push({
      time: d,
      load: LOAD_LABEL[b.load] ? b.load : null,
      live: m === 1 || m === "1" ? true : m === 0 || m === "0" ? false : null,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

// arrivals response -> sorted list of arrival Date objects for one service.
export function arrivalTimes(arrivalsBody, serviceNo) {
  return arrivalBuses(arrivalsBody, serviceNo)?.map((b) => b.time) ?? null;
}

// Station crowd levels from LTA (per station, not per platform or carriage).
export const CROWD_LABEL = { low: "Quiet", moderate: "Busy", high: "Packed" };
// Within this many minutes the real-time level beats the forecast. LTA refreshes it every 10 minutes.
const CROWD_NOW_MIN = 10;
const SLOT_MIN = 30; // LTA forecasts crowding in 30-minute slots

export const isTrain = (leg) => leg?.mode === "train";

// Key for a train leg's data in planRoute's `trains` map (the client and "Help me decide" both use it).
export function trainKey(leg) {
  return `${leg.line}:${leg.board.code}>${leg.alight.code}:${leg.crowdLine || ""}`;
}

// LTA's train alerts name lines slightly differently from the timetable (GTFS) line codes.
const ALERT_LINE = { BP: "BPL", SK: "STL", SLRT: "STL", PG: "PTL", PLRT: "PTL", CGL: "EWL", CEL: "CCL" };
export const alertLine = (line) => ALERT_LINE[String(line).toUpperCase()] || String(line).toUpperCase();

// Crowd at the boarding station when you'd board: real-time level if soon, else the 30-min forecast.
export function crowdAt(crowd, when, now) {
  if (!crowd || !when) return null;
  if (crowd.now?.level && CROWD_LABEL[crowd.now.level] && Math.abs(when - now) <= CROWD_NOW_MIN * 60000) {
    return { level: crowd.now.level, source: "now" };
  }
  for (const slot of crowd.forecast || []) {
    const start = new Date(slot.start);
    if (start <= when && when < addMin(start, SLOT_MIN) && CROWD_LABEL[slot.level]) return { level: slot.level, source: "forecast" };
  }
  return null;
}

// LTA's advisory for this disrupted line ("1710hrs: NEL - No train service…"), not another line's.
function lineMessage(status, seg) {
  const names = [seg.line, alertLine(seg.line), seg.lineName].filter(Boolean).map((s) => String(s).toLowerCase());
  return (status.messages || []).find((m) => {
    const text = String(m).toLowerCase();
    return names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
  }) || null;
}

// Service alerts that affect one leg: a disrupted train line, or a bus service LTA says is delayed/diverted.
export function legAlert(leg, status) {
  if (!status) return null;
  if (isTrain(leg)) {
    const seg = (status.segments || []).find((s) => alertLine(s.line) === alertLine(leg.line));
    if (!seg) return null;
    const hits = (seg.stations || []).filter((c) => c === leg.board.code || c === leg.alight.code);
    return {
      kind: "disruption",
      line: seg.line,
      text: lineMessage(status, seg) || `${seg.lineName || seg.line}: train service disrupted`,
      atYourStations: hits,
      freeBus: seg.freeBus || null,
    };
  }
  const svc = String(leg.service).toUpperCase();
  const adv = (status.busAdvisories || []).find((a) => (a.services || []).some((s) => String(s).toUpperCase() === svc));
  return adv ? { kind: adv.kind, text: adv.message, delayUpToMin: adv.delayUpToMin ?? null } : null;
}

// route: { walkFromHomeMin, legs: [bus leg | train leg] }
//   bus leg:   { service, board:{code}, alight:{code}, rideMin, walkBeforeMin }
//   train leg: { mode: "train", line, crowdLine, towards, board:{code}, alight:{code}, rideMin, walkBeforeMin }
// arrivalsByStop: { [bus stop code]: arrivals body | { error } }
// extras.trains: { [trainKey(leg)]: { departures: [{ time, towards }], crowd } | { error } }
// extras.status: service status (train disruptions + bus advisories), or null
//
// Every leg gets `bus`: the Date the vehicle you'd catch leaves (a bus, or a scheduled train).
export function planRoute(route, arrivalsByStop, now = new Date(), { trains = {}, status = null } = {}) {
  const legs = [];
  let t = addMin(now, route.walkFromHomeMin || 0);
  let planStatus = "ok";
  const alerts = route.legs.map((leg, i) => ({ leg: i, ...legAlert(leg, status) })).filter((a) => a.kind);
  if (alerts.some((a) => a.kind === "disruption")) planStatus = "disrupted";

  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    if (i > 0) t = addMin(t, leg.walkBeforeMin || 0);
    const atStop = t;
    const train = isTrain(leg);
    const body = train ? trains[trainKey(leg)] : arrivalsByStop[leg.board.code];

    if (!body || body.error) {
      legs.push({ ...leg, state: "unavailable", atStop });
      planStatus = worst(planStatus, "unavailable");
      break;
    }
    const vehicles = train ? scheduledTrains(body) : arrivalBuses(body, leg.service);
    if (!vehicles || vehicles.length === 0) {
      legs.push({ ...leg, state: "no-service", atStop });
      planStatus = worst(planStatus, "no-service");
      break;
    }
    const caught = vehicles.find((v) => v.time >= atStop);
    if (!caught) {
      legs.push({ ...leg, state: "beyond-data", atStop, lastKnown: vehicles[vehicles.length - 1].time });
      planStatus = worst(planStatus, "beyond-data");
      break;
    }
    const bus = caught.time;
    const waitMin = Math.round((bus - atStop) / 60000);
    const tight = i > 0 && waitMin < TIGHT_BUFFER_MIN;
    const missedEarlier = vehicles.filter((v) => v.time < atStop).length; // ones that leave before you get there
    const extra = train
      ? { live: false, scheduled: true, towards: caught.towards || leg.towards || null, crowd: crowdAt(body.crowd, bus, now) }
      : { load: caught.load, live: caught.live };
    const alert = alerts.find((a) => a.leg === i) || null;
    // A disrupted line marks the leg itself; `tight` is kept separately for the transfer-slack tag.
    const state = alert?.kind === "disruption" ? "disrupted" : tight ? "tight" : "ok";
    legs.push({ ...leg, state, tight, atStop, bus, waitMin, missedEarlier, ...extra, alert });
    if (tight) planStatus = worst(planStatus, "tight");
    t = addMin(bus, leg.rideMin || 0);
  }

  const complete = legs.length === route.legs.length && legs.every((l) => l.bus);
  const first = legs[0];
  return {
    legs,
    status: planStatus,
    alerts,
    complete,
    arriveAt: complete ? t : null,
    // When to walk out the door to catch the first bus (or train) you can make.
    leaveBy: first?.bus ? addMin(first.bus, -(route.walkFromHomeMin || 0)) : null,
  };
}

function scheduledTrains(body) {
  return (body.departures || [])
    .map((d) => ({ time: new Date(d.time), towards: d.towards || null }))
    .filter((d) => !Number.isNaN(d.time.getTime()))
    .sort((a, b) => a.time - b.time);
}

const RANK = { ok: 0, tight: 1, disrupted: 2, "beyond-data": 3, "no-service": 4, unavailable: 5 };
function worst(a, b) {
  return RANK[b] > RANK[a] ? b : a;
}

function addMin(d, min) {
  return new Date(d.getTime() + min * 60000);
}

export function minutesFrom(now, d) {
  return Math.max(0, Math.round((d - now) / 60000));
}

export function clock(d) {
  return d.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" });
}
