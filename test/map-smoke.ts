// No-LLM test of the Mapper's deterministic half: crawl finds every page and
// its controls, and --check reports drift only when controls actually change.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMap, crawl, hasDrift, type FeatureMap } from "../src/map.ts";

async function withApp<T>(port: number, bugs: string, fn: (url: string, dir: string) => Promise<T>): Promise<T> {
  const p = spawn("node", ["demo/server.js"], { env: { ...process.env, PORT: String(port), WITNESS_BUGS: bugs } });
  await new Promise((r) => p.stdout.once("data", r));
  const dir = await mkdtemp(join(tmpdir(), "witness-map-"));
  try {
    return await fn(`http://localhost:${port}`, dir);
  } finally {
    p.kill();
    await rm(dir, { recursive: true });
  }
}

let failed = 0;
const expect = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};

const pages = await withApp(4340, "", (url, dir) => crawl(url, dir));
expect(pages.map((p) => p.path).join(",") === "/,/settings", `crawl found ${pages.map((p) => p.path).join(", ")}`);
const home = pages.find((p) => p.path === "/")!;
expect(home.controls.includes('button "Add"') && home.controls.includes('textbox "New task"'), `home controls: ${home.controls.join(", ")}`);
const settings = pages.find((p) => p.path === "/settings")!;
expect(settings.controls.filter((c) => c.startsWith("checkbox")).length === 2, `settings controls: ${settings.controls.join(", ")}`);

const map: FeatureMap = {
  generated: "",
  url: "",
  summary: "",
  pages: pages.map((p) => ({ path: p.path, title: p.title, purpose: "", controls: p.controls })),
  features: [
    { name: "Add a task", page: "/", how_to_reach: [], controls: ['textbox "New task"', 'button "Add"'], behavior: "", traps: [] },
    { name: "Delete a task", page: "/", how_to_reach: [], controls: ['button "Delete \\"…\\""'], behavior: "", traps: [] },
  ],
};

for (const [i, [bugs, wantDrift]] of ([["", false], ["new-heading", false], ["dead-add", false], ["rename-add", true]] as const).entries()) {
  const d = await withApp(4341 + i, bugs, (url, dir) => checkMap(map, url, dir));
  const detail = hasDrift(d)
    ? d.changedPages.map((c) => `${c.path} +[${c.added}] -[${c.removed}]`).join("; ") + (d.staleFeatures.length ? `; stale: ${d.staleFeatures.map((f) => f.name)}` : "")
    : "no drift";
  expect(hasDrift(d) === wantDrift, `check bugs=${bugs || "none"}: ${detail}`);
  if (bugs === "rename-add") expect(d.staleFeatures.map((f) => f.name).join() === "Add a task", "only 'Add a task' is stale (per-item Delete never counted)");
}
process.exit(failed ? 1 : 0);
