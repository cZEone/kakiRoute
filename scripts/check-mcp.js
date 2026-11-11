// npm run check-mcp [stop code]
// Starts the sg-transport MCP server the way the app does and checks the live
// LTA data kakiRoute uses: bus arrivals (with crowding) and train/bus advisories.

import { SgTransport } from "../lib/sgtransport.js";
import { getArrivals } from "../lib/arrivals.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {}

const code = process.argv[2] || "44009";
if (!process.env.LTA_ACCOUNT_KEY) {
  console.error("LTA_ACCOUNT_KEY is not set (add it to .env). Without it the app uses arrivelah.");
  process.exit(1);
}

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

await step("bus advisories from LTA", async () => {
  const alerts = await transport.call("get_train_service_alerts");
  console.log(`     train status: ${alerts.status}`);
  for (const a of alerts.bus_advisories || []) console.log(`     ${a.kind}: ${a.services.join(", ")}`);
});

await transport.close();
process.exit(failed ? 1 : 0);
