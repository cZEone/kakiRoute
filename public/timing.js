// Pure timing logic: given a saved route and live arrivals, work out which bus
// you'd catch on each leg if you left now. Plain arithmetic, no AI.

const TIGHT_BUFFER_MIN = 2;

// Bus crowding codes used by LTA (and arrivelah).
export const LOAD_LABEL = { SEA: "Seats", SDA: "Standing", LSD: "Crowded" };
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

// route: { walkFromHomeMin, legs: [{ service, board:{code}, alight:{code}, rideMin, walkBeforeMin }] }
// arrivalsByStop: { [code]: arrivelah body | { error } }
export function planRoute(route, arrivalsByStop, now = new Date()) {
  const legs = [];
  let t = addMin(now, route.walkFromHomeMin || 0);
  let status = "ok";

  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    if (i > 0) t = addMin(t, leg.walkBeforeMin || 0);
    const atStop = t;
    const body = arrivalsByStop[leg.board.code];

    if (!body || body.error) {
      legs.push({ ...leg, state: "unavailable", atStop });
      status = "unavailable";
      break;
    }
    const buses = arrivalBuses(body, leg.service);
    if (!buses || buses.length === 0) {
      legs.push({ ...leg, state: "no-service", atStop });
      status = worst(status, "no-service");
      break;
    }
    const caught = buses.find((b) => b.time >= atStop);
    if (!caught) {
      legs.push({ ...leg, state: "beyond-data", atStop, lastKnown: buses[buses.length - 1].time });
      status = worst(status, "beyond-data");
      break;
    }
    const bus = caught.time;
    const waitMin = Math.round((bus - atStop) / 60000);
    const tight = i > 0 && waitMin < TIGHT_BUFFER_MIN;
    const missedEarlier = buses.filter((b) => b.time < atStop).length; // buses that leave before you get there
    legs.push({ ...leg, state: tight ? "tight" : "ok", atStop, bus, waitMin, missedEarlier, load: caught.load, live: caught.live });
    if (tight) status = worst(status, "tight");
    t = addMin(bus, leg.rideMin || 0);
  }

  const complete = legs.length === route.legs.length && legs.every((l) => l.bus);
  const first = legs[0];
  return {
    legs,
    status,
    complete,
    arriveAt: complete ? t : null,
    // When to walk out the door to catch the first bus you can make.
    leaveBy: first?.bus ? addMin(first.bus, -(route.walkFromHomeMin || 0)) : null,
  };
}

const RANK = { ok: 0, tight: 1, "beyond-data": 2, "no-service": 3, unavailable: 4 };
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
