// No-LLM test of `witness mcp`: a real MCP client over stdio lists the tools
// and calls the ones that need no model (replays, map --check, replay).
import { spawn } from "node:child_process";
import { mkdtemp, rm, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(".");
const port = 4360;
const app = spawn("node", ["demo/server.js"], { env: { ...process.env, PORT: String(port) } });
await new Promise((r) => app.stdout.once("data", r));

// Run in a scratch project so the test doesn't touch this repo's .witness/.
const work = await mkdtemp(join(tmpdir(), "witness-mcp-"));
await cp(join(root, "witness.map.yaml"), join(work, "witness.map.yaml"));
await mkdir(join(work, ".witness"), { recursive: true });

let failed = 0;
const expect = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

const client = new Client({ name: "witness-test", version: "0" });
try {
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [join(root, "bin/witness.js"), "mcp"],
      cwd: work,
      env: { ...process.env, WITNESS_URL: `http://localhost:${port}` } as Record<string, string>,
      stderr: "ignore",
    }),
  );
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort().join(",");
  expect(names === "witness_auth,witness_map,witness_replay,witness_replays,witness_verify", `tools: ${names}`);
  expect(Boolean(client.getInstructions()?.includes("before saying the work is done")), "server instructions tell agents when to verify");

  const empty = await client.callTool({ name: "witness_replays", arguments: {} });
  expect(textOf(empty).includes("No replays"), `witness_replays (empty): ${textOf(empty)}`);

  const check = await client.callTool({ name: "witness_map", arguments: { check: true } });
  expect(textOf(check).includes("matches the app") && (check.structuredContent as any)?.drift === false, `witness_map check: ${textOf(check)}`);

  const replay = await client.callTool({ name: "witness_replay", arguments: {} });
  expect(textOf(replay).includes("No replays saved yet"), `witness_replay (empty): ${textOf(replay)}`);
} finally {
  await client.close();
  app.kill();
  await rm(work, { recursive: true });
}
process.exit(failed ? 1 : 0);
