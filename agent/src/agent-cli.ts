// Ad-hoc one-shot: ask Bill anything from the terminal (read-only).
//   npm run ask -- "how's my paper book positioned vs the S&P?"
import "./load-env.js";
import { runAgent } from "./agent.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-ask");

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: npm run ask -- "your question"');
  process.exit(2);
}

const { text, costUsd, isError, numTurns } = await runAgent(prompt);
console.log("\n" + text + "\n");
console.error(`[${isError ? "error" : "ok"} · ${numTurns} turns · $${costUsd.toFixed(4)}]`);
process.exitCode = isError ? 1 : 0;
