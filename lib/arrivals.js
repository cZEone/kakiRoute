// Live bus arrivals from arrivelah, cached briefly so the browser, the
// decision endpoint and repeated refreshes share one upstream request.
import { mockArrivals } from "./fixtures.js";

const ARRIVELAH = "https://arrivelah2.busrouter.sg/?id=";
const CACHE_MS = 15_000;
const cache = new Map();

export async function getArrivals(code, { mock = false } = {}) {
  if (mock) return { ...mockArrivals(code), fetchedAt: new Date().toISOString() };
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  const r = await fetch(ARRIVELAH + code, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = { ...(await r.json()), fetchedAt: new Date().toISOString() };
  cache.set(code, { at: Date.now(), body });
  return body;
}
