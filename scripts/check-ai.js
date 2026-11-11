// Checks your OpenCode Go setup: finds the working endpoint, lists your
// models, and runs a two-step tool-calling exchange like the route setup does.
//   npm run check-ai           test the model the app will use
//   npm run check-ai -- --all  test every model on your plan
import OpenAI from "openai";
import { connect } from "../lib/llm.js";
import { FUNCTIONS } from "../lib/agent.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {}

async function tryModel(client, model) {
  const messages = [
    { role: "system", content: "You help a commuter save a bus route. Use the tools." },
    { role: "user", content: "I take bus 961 from Opp Blk 123. Look up that stop." },
  ];
  const first = await client.chat.completions.create({ model, messages, tools: FUNCTIONS, tool_choice: "auto" });
  const msg = first.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0];
  if (!call) return "answered without calling a tool";
  // Second turn: send the tool result back, as the app does.
  messages.push({ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls, ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}) });
  for (const tc of msg.tool_calls) {
    messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify([{ code: "44009", name: "Opp Blk 123", services: ["961"] }]) });
  }
  try {
    await client.chat.completions.create({ model, messages, tools: FUNCTIONS, tool_choice: "auto" });
  } catch (err) {
    if (!(err instanceof OpenAI.BadRequestError) || !msg.reasoning_content) throw err;
    const stripped = messages.map(({ reasoning_content, ...m }) => m);
    await client.chat.completions.create({ model, messages: stripped, tools: FUNCTIONS, tool_choice: "auto" });
  }
  return `OK (${call.function.name} ${call.function.arguments})`;
}

try {
  const { client, baseURL, model, models } = await connect();
  console.log(`Endpoint:  ${baseURL}`);
  console.log(`Models:    ${models.join(", ")}`);
  console.log(`App uses:  ${model}${process.env.OPENCODE_MODEL ? " (from OPENCODE_MODEL)" : ""}\n`);
  const targets = process.argv.includes("--all") ? models : [model];
  for (const m of targets) {
    try {
      console.log(`${m}: ${await tryModel(client, m)}`);
    } catch (err) {
      console.log(`${m}: FAILED ${err.status ?? ""} ${String(err.error?.message || err.message).slice(0, 200)}`);
    }
  }
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}
