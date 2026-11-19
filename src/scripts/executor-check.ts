/**
 * Connects to one agent's Executor scoped connection and lists the tools it sees.
 *   npm run executor:check -- <executor-workspace>
 * Needs EXECUTOR_URL__<WORKSPACE> and EXECUTOR_TOKEN__<WORKSPACE>.
 */
import { ExecutorTools } from "../adapters/executor.js";

const workspace = process.argv[2];
if (!workspace) {
  console.error("Usage: npm run executor:check -- <executor-workspace>");
  process.exit(1);
}

const tools = await ExecutorTools.fromEnv().listTools(workspace);
console.log(`${tools.length} tools visible to "${workspace}":`);
for (const t of tools) console.log(`- ${t.name}: ${t.description.split("\n")[0]}`);
if (!tools.length) {
  console.log("\nNo tools found. Check the scoped connection in Executor, or the result format this adapter parses.");
}
process.exit(0);
