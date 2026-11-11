// NEA two-hour forecast from data.gov.sg, matched to the nearest forecast
// area for each stop. Same source the sg-transport MCP server uses.

import { haversineM } from "./busdata.js";

const URL_2HR = "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const CACHE_MS = 5 * 60 * 1000; // NEA updates roughly every 30 minutes

const RAINY = /shower|rain|thunder/i;

let cache = null;

export async function twoHourForecast({ mock = false } = {}) {
  if (mock) return mockForecast();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const headers = { accept: "application/json" };
  if (process.env.DATA_GOV_SG_API_KEY) headers["x-api-key"] = process.env.DATA_GOV_SG_API_KEY;
  const res = await fetch(URL_2HR, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`data.gov.sg HTTP ${res.status}`);
  const body = await res.json();
  if (body.code && body.code !== 0) throw new Error(`data.gov.sg error ${body.errorMsg || body.code}`);
  const data = body.data || {};
  cache = { at: Date.now(), data };
  return data;
}

// Returns { validFor, areas: { [area]: forecast } } for the given stops,
// plus the area each stop falls in.
export function forecastForStops(data, stops) {
  const item = (data.items || [])[0];
  const meta = data.area_metadata || [];
  if (!item || meta.length === 0) return null;
  const byArea = Object.fromEntries((item.forecasts || []).map((f) => [f.area, f.forecast]));
  const stopAreas = {};
  for (const s of stops) {
    if (!s) continue;
    let best = null;
    let bestD = Infinity;
    for (const a of meta) {
      const d = haversineM(s, { lat: a.label_location.latitude, lng: a.label_location.longitude });
      if (d < bestD) {
        bestD = d;
        best = a.name;
      }
    }
    if (best) stopAreas[s.code] = { area: best, forecast: byArea[best] || "Unknown", rainy: RAINY.test(byArea[best] || "") };
  }
  return { validFor: item.valid_period?.text || null, stopAreas };
}

function mockForecast() {
  const now = new Date();
  return {
    area_metadata: [
      { name: "Mock North", label_location: { latitude: 1.38, longitude: 103.772 } },
      { name: "Mock Central", label_location: { latitude: 1.37, longitude: 103.78 } },
      { name: "Mock South", label_location: { latitude: 1.35, longitude: 103.80 } },
    ],
    items: [{
      valid_period: { text: `${now.getHours()}:00 to ${now.getHours() + 2}:00` },
      forecasts: [
        { area: "Mock North", forecast: "Partly Cloudy (Day)" },
        { area: "Mock Central", forecast: "Thundery Showers" },
        { area: "Mock South", forecast: "Cloudy" },
      ],
    }],
  };
}
