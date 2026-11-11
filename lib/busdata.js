// Static Singapore bus stop + service data, from busrouter.sg (the same
// project that runs arrivelah). Used by the route-setup agent to resolve
// stop names into codes and check that a service really runs between them.
//
// stops.min.json:    { "<code>": [lng, lat, name, road], ... }
// services.min.json: { "<service no>": { name, routes: [[codes...], [codes...]] }, ... }

import { MOCK_STOPS, MOCK_SERVICES } from "./fixtures.js";

const STOPS_URL = "https://data.busrouter.sg/v1/stops.min.json";
const SERVICES_URL = "https://data.busrouter.sg/v1/services.min.json";

const WALK_M_PER_MIN = 75; // unhurried walking pace
const WALK_DETOUR = 1.3; // straight line -> actual footpath
const BUS_KMH = 18; // average bus speed incl. traffic lights
const DWELL_MIN = 0.5; // per intermediate stop

export class BusData {
  constructor(stopsRaw, servicesRaw) {
    this.stops = new Map();
    for (const [code, [lng, lat, name, road]] of Object.entries(stopsRaw)) {
      this.stops.set(code, { code, lat, lng, name, road: road || "" });
    }
    this.services = new Map();
    this.servicesAtStop = new Map();
    for (const [no, svc] of Object.entries(servicesRaw)) {
      this.services.set(no, { no, name: svc.name, routes: svc.routes || [] });
      for (const route of svc.routes || []) {
        for (const code of route) {
          if (!this.servicesAtStop.has(code)) this.servicesAtStop.set(code, new Set());
          this.servicesAtStop.get(code).add(no);
        }
      }
    }
  }

  static async load({ mock = false } = {}) {
    if (mock) return new BusData(MOCK_STOPS, MOCK_SERVICES);
    const [stops, services] = await Promise.all([fetchJson(STOPS_URL), fetchJson(SERVICES_URL)]);
    return new BusData(stops, services);
  }

  stop(code) {
    return this.stops.get(String(code)) || null;
  }

  stopSummary(code) {
    const s = this.stop(code);
    if (!s) return null;
    return {
      code: s.code,
      name: s.name,
      road: s.road,
      services: [...(this.servicesAtStop.get(s.code) || [])].sort(compareServiceNo),
    };
  }

  // Fuzzy search by name / road / code, understanding common SG abbreviations.
  searchStops(query, { service, limit = 10 } = {}) {
    const q = String(query || "").trim();
    if (/^\d{5}$/.test(q)) {
      const hit = this.stopSummary(q);
      return hit ? [hit] : [];
    }
    const qTokens = tokenize(q);
    if (qTokens.length === 0) return [];
    const svcFilter = service ? String(service).toUpperCase() : null;
    const scored = [];
    for (const s of this.stops.values()) {
      if (svcFilter && !this.servicesAtStop.get(s.code)?.has(svcFilter)) continue;
      const hay = new Set([...tokenize(s.name), ...tokenize(s.road)]);
      let score = 0;
      for (const t of qTokens) {
        if (hay.has(t)) score += 2;
        else if ([...hay].some((h) => h.startsWith(t) && t.length >= 3)) score += 1;
      }
      if (score > 0) scored.push({ score, s });
    }
    scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
    const best = scored[0]?.score ?? 0;
    return scored
      .filter((x) => x.score >= Math.max(1, best - 1))
      .slice(0, limit)
      .map((x) => this.stopSummary(x.s.code));
  }

  stopsNear(code, radiusM = 300) {
    const origin = this.stop(code);
    if (!origin) return null;
    const out = [];
    for (const s of this.stops.values()) {
      if (s.code === origin.code) continue;
      const d = haversineM(origin, s);
      if (d <= radiusM) out.push({ ...this.stopSummary(s.code), distance_m: Math.round(d), walk_min: walkMinutes(d) });
    }
    return out.sort((a, b) => a.distance_m - b.distance_m).slice(0, 12);
  }

  walkMin(fromCode, toCode) {
    if (String(fromCode) === String(toCode)) return 0;
    const a = this.stop(fromCode);
    const b = this.stop(toCode);
    if (!a || !b) return null;
    return walkMinutes(haversineM(a, b));
  }

  service(no) {
    return this.services.get(String(no).toUpperCase()) || null;
  }

  // Checks that `service` runs from boardCode to alightCode in that order.
  checkLeg(serviceNo, boardCode, alightCode) {
    const svc = this.service(serviceNo);
    if (!svc) return { ok: false, error: `Service ${serviceNo} does not exist.` };
    const board = this.stop(boardCode);
    const alight = this.stop(alightCode);
    if (!board) return { ok: false, error: `Stop ${boardCode} does not exist.` };
    if (!alight) return { ok: false, error: `Stop ${alightCode} does not exist.` };

    for (let dir = 0; dir < svc.routes.length; dir++) {
      const route = svc.routes[dir];
      for (let i = 0; i < route.length; i++) {
        if (route[i] !== board.code) continue;
        const j = route.indexOf(alight.code, i + 1);
        if (j === -1) continue;
        const path = route.slice(i, j + 1).map((c) => this.stop(c)).filter(Boolean);
        let distM = 0;
        for (let k = 1; k < path.length; k++) distM += haversineM(path[k - 1], path[k]);
        const stopsBetween = j - i;
        const rideMin = Math.max(1, Math.round((distM / 1000 / BUS_KMH) * 60 + DWELL_MIN * (stopsBetween - 1)));
        return {
          ok: true,
          service: svc.no,
          direction: dir + 1,
          towards: this.stop(route[route.length - 1])?.name || null,
          board: this.stopSummary(board.code),
          alight: this.stopSummary(alight.code),
          stops_travelled: stopsBetween,
          ride_min_estimate: rideMin,
        };
      }
    }

    const servesBoard = this.servicesAtStop.get(board.code)?.has(svc.no);
    const servesAlight = this.servicesAtStop.get(alight.code)?.has(svc.no);
    let error;
    if (!servesBoard) error = `Service ${svc.no} does not stop at ${board.code} (${board.name}).`;
    else if (!servesAlight) error = `Service ${svc.no} does not stop at ${alight.code} (${alight.name}).`;
    else error = `Service ${svc.no} serves both stops, but never goes from ${board.code} to ${alight.code} in that order (wrong side of the road?).`;
    return { ok: false, error };
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Long forms -> the abbreviations LTA uses in stop names.
const ABBREV = {
  block: "blk", opposite: "opp", bukit: "bt", interchange: "int", station: "stn",
  avenue: "ave", street: "st", road: "rd", after: "aft", before: "bef", centre: "ctr",
  center: "ctr", terminal: "ter", terminus: "ter", jalan: "jln", lorong: "lor",
  primary: "pr", secondary: "sec", school: "sch", upper: "upp", tanjong: "tg",
  industrial: "ind", hospital: "hosp", mount: "mt", saint: "st", condominium: "condo",
  junction: "jct", crescent: "cres", drive: "dr", place: "pl", park: "pk",
};

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREV[t] || t);
}

function compareServiceNo(a, b) {
  return parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);
}

export function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function walkMinutes(distM) {
  return Math.max(1, Math.ceil((distM * WALK_DETOUR) / WALK_M_PER_MIN));
}
