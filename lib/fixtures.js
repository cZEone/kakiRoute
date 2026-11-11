// Small fake network used when MOCK=1 (offline development and tests).
// The names are made up on purpose so mock data is never mistaken for real stops.
//
//   Home is between Stop A (90011) and Stop B (90021).
//   Route 1: 901 from A -> Mock Interchange (90031), walk across to 90032, 905 -> Mock Office (90051)
//   Route 2: 902 from B -> Mock Office Opp (90052)

export const MOCK_STOPS = {
  "90011": [103.7700, 1.3800, "Mock Blk 101", "Mock Ave 1"],
  "90012": [103.7702, 1.3802, "Opp Mock Blk 101", "Mock Ave 1"],
  "90021": [103.7740, 1.3790, "Mock Blk 120", "Mock St 2"],
  "90022": [103.7742, 1.3792, "Opp Mock Blk 120", "Mock St 2"],
  "90031": [103.7800, 1.3700, "Mock Bt Int", "Mock Rd"],
  "90032": [103.7803, 1.3703, "Opp Mock Bt Int", "Mock Rd"],
  "90041": [103.7900, 1.3600, "Aft Mock Stn", "Mock Rd"],
  "90051": [103.8000, 1.3500, "Mock Office Twr", "Mock Rd"],
  "90052": [103.8003, 1.3503, "Opp Mock Office Twr", "Mock Rd"],
};

export const MOCK_SERVICES = {
  "901": { name: "Mock Blk 101 ⇄ Mock Bt Int", routes: [["90011", "90031"], ["90031", "90012"]] },
  "905": { name: "Mock Bt Int ⇄ Mock Office", routes: [["90032", "90041", "90051"], ["90052", "90041", "90031"]] },
  "902": { name: "Mock Blk 120 ⇄ Mock Office", routes: [["90021", "90041", "90052"], ["90051", "90022"]] },
};

// Deterministic-ish fake arrivals in arrivelah's response shape.
export function mockArrivals(code, now = Date.now()) {
  const services = [];
  for (const [no, svc] of Object.entries(MOCK_SERVICES)) {
    if (!svc.routes.some((r) => r.includes(code))) continue;
    const seed = (parseInt(no, 10) * 7 + parseInt(code, 10)) % 9;
    const headway = 8 + (seed % 5); // 8-12 min
    const first = 1 + seed; // 1-9 min
    const mk = (min) => ({ time: new Date(now + min * 60000).toISOString(), duration_ms: min * 60000 });
    services.push({ no, next: mk(first), subsequent: mk(first + headway), next2: mk(first + headway), next3: mk(first + 2 * headway) });
  }
  return { services };
}
