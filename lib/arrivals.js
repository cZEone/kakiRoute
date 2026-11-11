// Live bus arrivals, cached briefly so the browser, the decision endpoint and
// repeated refreshes share one upstream request.
//
// Source: official LTA DataMall through the sg-transport MCP server when it's
// configured (LTA_ACCOUNT_KEY set), otherwise arrivelah. Both are returned in
// arrivelah's shape, which public/timing.js reads:
//   { source, services: [{ no, operator, next, next2, next3 }] }
//   each bus: { time, load: "SEA"|"SDA"|"LSD"|null, monitored: 0|1|null, type, feature }
import { mockArrivals } from "./fixtures.js";
import { defaultTransport } from "./sgtransport.js";

const ARRIVELAH = "https://arrivelah2.busrouter.sg/?id=";
const CACHE_MS = 15_000;
const cache = new Map();
let warnedFallback = false;

export async function getArrivals(code, { mock = false, transport = defaultTransport(), fetchImpl = fetch } = {}) {
  if (mock) return { ...mockArrivals(code), source: "mock", fetchedAt: new Date().toISOString() };
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;

  let body = null;
  if (transport) {
    try {
      body = fromLta(await transport.call("get_bus_arrivals", { bus_stop_code: code }));
    } catch (err) {
      if (!warnedFallback) console.warn(`LTA arrivals unavailable, using arrivelah: ${err.message}`);
      warnedFallback = true;
    }
  }
  if (!body) body = await fromArrivelah(code, fetchImpl);

  body.fetchedAt = new Date().toISOString();
  cache.set(code, { at: Date.now(), body });
  return body;
}

async function fromArrivelah(code, fetchImpl) {
  const r = await fetchImpl(ARRIVELAH + code, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { ...(await r.json()), source: "arrivelah" };
}

const LOAD_CODE = { "seats available": "SEA", "standing available": "SDA", "limited standing": "LSD" };
const TYPE_CODE = { "single deck": "SD", "double deck": "DD", bendy: "BD" };

// sg-transport get_bus_arrivals output -> arrivelah shape.
export function fromLta(out) {
  const bus = (b) =>
    b?.eta
      ? {
          time: b.eta,
          load: LOAD_CODE[b.load] || null,
          monitored: b.live === true ? 1 : b.live === false ? 0 : null,
          type: TYPE_CODE[b.bus_type] || null,
          feature: b.wheelchair_accessible ? "WAB" : "",
        }
      : null;
  return {
    source: "lta",
    services: (out?.services || []).map((s) => {
      const [a, b, c] = s.next_buses || [];
      return { no: s.service_no, operator: s.operator, next: bus(a), next2: bus(b), next3: bus(c) };
    }),
  };
}

// For tests.
export function clearArrivalsCache() {
  cache.clear();
  warnedFallback = false;
}
