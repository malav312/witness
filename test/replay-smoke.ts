// No-LLM test of Replay: script a "driver" run through the real tool layer,
// turn it into a replay, then check that the replay matches the clean app
// and diverges, at the right step, on each bug.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.ts";
import type { RunReport } from "../src/report.ts";
import { replayFromRun, runReplay, type Replay } from "../src/replay.ts";
import { runTool } from "../src/tools.ts";

async function serve(port: number, bugs = ""): Promise<ChildProcess> {
  const p = spawn("node", ["demo/server.js"], { env: { ...process.env, PORT: String(port), WITNESS_BUGS: bugs } });
  await new Promise((r) => p.stdout!.once("data", r));
  return p;
}

const refOf = (snap: string, re: RegExp) => snap.split("\n").find((l) => re.test(l))?.match(/\[ref=(e\d+)\]/)?.[1];

async function record(url: string): Promise<Replay> {
  const dir = await mkdtemp(join(tmpdir(), "witness-rec-"));
  const s = new BrowserSession(dir);
  try {
    await s.start(url);
    const call = async (name: string, input: object) => {
      const out = await runTool(s, dir, name, input);
      if (out.isError) throw new Error(`${name} failed: ${out.text}`);
    };
    let snap = await s.snapshot();
    await call("type", { ref: refOf(snap, /textbox "New task"/), text: "Buy milk", submit: false });
    snap = await s.snapshot();
    await call("click", { ref: refOf(snap, /button "Add"/), element: "Add button" });
    await call("screenshot", {}); // should be skipped in the replay
    await call("reload", {});
    const report = { id: "scripted", goal: "Add a task and it survives reload", url, steps: s.steps } as RunReport;
    const replay = replayFromRun(report);
    if ("error" in replay) throw new Error(replay.error);
    return replay;
  } finally {
    await s.stop();
    await rm(dir, { recursive: true });
  }
}

const clean = await serve(4310);
const replay = await record("http://localhost:4310");
clean.kill();
const actions = replay.steps.map((s) => s.action).join(",");
console.log(`recorded: ${actions}  targets: ${replay.steps.filter((s) => s.target).map((s) => `${s.target!.role} "${s.target!.name}"`).join(", ")}`);

const cases: [string, string | null][] = [
  ["", null], // clean app: must match
  ["no-persist", "reload"],
  ["dead-add", "click"],
  ["count-off", "open"], // the counter is wrong even on the empty page
  ["console-error", "click"],
];
let failed = actions !== "open,type,click,reload" ? 1 : 0;
for (const [i, [bugs, wantAt]] of cases.entries()) {
  const port = 4320 + i;
  const server = await serve(port, bugs);
  const dir = await mkdtemp(join(tmpdir(), "witness-replay-"));
  try {
    const res = await runReplay(replay, { url: `http://localhost:${port}`, runDir: dir });
    const at = res.divergence?.action ?? null;
    const ok = at === wantAt;
    if (!ok) failed++;
    console.log(
      `${ok ? "ok  " : "FAIL"} bugs=${bugs || "none"}  ${res.status}${at ? ` at ${at}: ${res.divergence!.reason}` : ""}  (${res.durationMs}ms)`,
    );
    if (res.divergence?.diff && bugs === "count-off") console.log(res.divergence.diff.replace(/^/gm, "       "));
  } finally {
    server.kill();
    await rm(dir, { recursive: true });
  }
}
process.exit(failed ? 1 : 0);
