// npm run check-mcp [stop code]
// Starts the sg-transport MCP server the way the app does and checks the live
// LTA data kakiRoute uses: bus arrivals (with crowding), a train leg (timetable +
// station crowd), station crowding on a line, and service alerts.
//
// Skipped (exit 0) when LTA_ACCOUNT_KEY isn't set or uv isn't installed, since
// the app then runs on arrivelah. Exits 1 only when a check actually fails.

import { spawnSync } from "node:child_process";
import { SgTransport } from "../lib/sgtransport.js";
import { getArrivals } from "../lib/arrivals.js";
import { trainLegData, stationCrowd, serviceStatus, checkTrainLeg, trainLegFromOption } from "../lib/trains.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {}

const skip = (why) => {
  console.log(`skipped: ${why}`);
  process.exit(0);
};
if (!process.env.LTA_ACCOUNT_KEY) skip("LTA_ACCOUNT_KEY is not set (add it to .env). Without it the app uses arrivelah, buses only.");
if (spawnSync("uv", ["--version"], { stdio: "ignore" }).status !== 0) skip("uv is not installed (https://docs.astral.sh/uv/), so the MCP server can't run.");

const code = process.argv[2] || "44009";
const transport = new SgTransport({ log: (m) => console.error(m) });
let failed = false;
const step = async (label, fn) => {
  const t = Date.now();
  try {
    await fn();
    console.log(`ok   ${label} (${Date.now() - t} ms)`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${label}: ${err.message}`);
  }
};

await step("start server", async () => {
  await transport.call("get_train_service_alerts");
});

await step(`bus arrivals at ${code}`, async () => {
  const body = await getArrivals(code, { transport, fetchImpl: () => Promise.reject(new Error("fallback disabled")) });
  if (body.source !== "lta") throw new Error(`source was ${body.source}`);
  for (const s of body.services.slice(0, 6)) {
    const b = s.next;
    console.log(`     ${s.no.padEnd(5)} ${b ? new Date(b.time).toLocaleTimeString("en-SG") : "-"}  load=${b?.load ?? "?"}  ${b?.monitored === 1 ? "live" : "sched"}`);
  }
});

await step("train leg Bishan -> Dhoby Ghaut (first call downloads the timetable)", async () => {
  const check = await checkTrainLeg("Bishan", "Dhoby Ghaut", { transport });
  const leg = trainLegFromOption(check, check.options[0]);
  const data = await trainLegData(leg, { transport });
  if (data.error) throw new Error(data.error);
  const next = data.departures[0];
  console.log(`     ${leg.line} towards ${leg.towards}: next ${next ? new Date(next.time).toLocaleTimeString("en-SG") : "-"} (timetable), station crowd ${data.crowd.now?.level ?? "?"}`);
});

await step("station crowd on the NSL", async () => {
  const c = await stationCrowd("NSL", [], { transport });
  const levels = Object.values(c.now).map((s) => s.level);
  console.log(`     ${levels.length} stations: ${["low", "moderate", "high"].map((l) => `${levels.filter((x) => x === l).length} ${l}`).join(", ")}`);
});

await step("service alerts from LTA", async () => {
  const s = await serviceStatus({ transport });
  console.log(`     train status: ${s.trainStatus}${s.segments.length ? ` (${s.segments.map((g) => g.line).join(", ")})` : ""}`);
  for (const a of s.busAdvisories) console.log(`     bus ${a.kind}: ${a.services.join(", ")}`);
});

await transport.close();
process.exit(failed ? 1 : 0);
