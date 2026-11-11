// Validates routes sent by the browser (they come from localStorage, so treat them as untrusted).
// Bus legs use 5-digit stop codes; train legs (mode: "train") use station codes such as NS17.
import { STATION_CODE, LINE_CODE, CROWD_LINES } from "./trains.js";

export function sanitizeRoutes(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10) return null;
  const place = (x, pattern) =>
    pattern.test(String(x?.code)) ? { code: String(x.code), name: String(x.name || "").slice(0, 80) } : null;
  const num = (x, d) => (Number.isFinite(Number(x)) ? Math.max(0, Math.min(180, Number(x))) : d);
  const text = (x, n) => (x == null ? null : String(x).slice(0, n));
  const out = [];
  for (const r of input) {
    const legs = (Array.isArray(r?.legs) ? r.legs : []).slice(0, 5).map((l) => {
      const common = { rideMin: num(l?.rideMin, 10), walkBeforeMin: num(l?.walkBeforeMin, 0) };
      if (l?.mode === "train") {
        const line = LINE_CODE.test(String(l.line)) ? String(l.line) : null;
        return {
          mode: "train",
          service: line,
          line,
          lineName: text(l.lineName, 40),
          crowdLine: CROWD_LINES.includes(String(l.crowdLine)) ? String(l.crowdLine) : null,
          towards: text(l.towards, 60),
          board: place(l.board, STATION_CODE),
          alight: place(l.alight, STATION_CODE),
          ...common,
        };
      }
      return { service: String(l?.service || "").slice(0, 5), board: place(l?.board, /^\d{5}$/), alight: place(l?.alight, /^\d{5}$/), ...common };
    });
    if (legs.length === 0 || legs.some((l) => !l.service || !l.board || !l.alight)) return null;
    out.push({ name: String(r.name || "Route").slice(0, 60), walkFromHomeMin: num(r.walkFromHomeMin, 3), legs });
  }
  return out;
}
