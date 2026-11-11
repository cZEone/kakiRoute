// Checks your OpenCode Go setup: finds the working endpoint, lists your
// models, and makes one small tool call. Run: OPENCODE_API_KEY=... npm run check-ai
import { connect } from "../lib/llm.js";

try {
  const { client, baseURL, model, models } = await connect();
  console.log(`Endpoint:  ${baseURL}`);
  console.log(`Models:    ${models.join(", ")}`);
  console.log(`Using:     ${model}${process.env.OPENCODE_MODEL ? " (from OPENCODE_MODEL)" : ""}`);

  const res = await client.chat.completions.create({
    model,
    max_tokens: 2000,
    messages: [{ role: "user", content: "Look up the bus stop called 'Opp Blk 123' using the tool." }],
    tools: [{
      type: "function",
      function: {
        name: "search_stops",
        description: "Search bus stops by name",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      },
    }],
  });
  const call = res.choices?.[0]?.message?.tool_calls?.[0];
  if (call) console.log(`Tool call: OK (${call.function.name} ${call.function.arguments})`);
  else console.log("Tool call: model answered without calling the tool. Try a different OPENCODE_MODEL.");
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}
