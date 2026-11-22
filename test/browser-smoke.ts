// No-LLM smoke test: drives the demo app through BrowserSession directly and
// checks that evidence is captured and that the switchable bugs really fire.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.ts";

const ref = (snap: string, pattern: RegExp) => {
  const line = snap.split("\n").find((l) => pattern.test(l));
  const m = line?.match(/\[ref=(e\d+)\]/);
  if (!m) throw new Error(`no ref for ${pattern} in:\n${snap}`);
  return m[1];
};

async function scenario(bugs: string, port: number) {
  const server = spawn("node", ["demo/server.js"], { env: { ...process.env, PORT: String(port), WITNESS_BUGS: bugs } });
  await new Promise((r) => server.stdout.once("data", r));
  const dir = await mkdtemp(join(tmpdir(), "witness-"));
  const s = new BrowserSession(dir);
  try {
    await s.start(`http://localhost:${port}`);
    let snap = await s.snapshot();
    await s.act("type", {}, (p) => p.locator(`aria-ref=${ref(snap, /textbox "New task"/)}`).fill("Buy milk"));
    snap = await s.snapshot();
    await s.act("click", {}, (p) => p.locator(`aria-ref=${ref(snap, /button "Add"/)}`).click());
    await s.act("reload", {}, (p) => p.reload().then(() => {}));
    const last = s.steps.at(-1)!;
    const files = await readdir(join(dir, "screens"));
    return {
      afterAdd: /button "Delete [^\n]*Buy milk/.test(s.steps[2].snapshot),
      afterReload: /button "Delete [^\n]*Buy milk/.test(last.snapshot),
      errors: s.allConsoleErrors.length,
      screens: files.length,
    };
  } finally {
    await s.stop();
    server.kill();
    const traced = (await readdir(dir)).includes("trace.zip");
    await rm(dir, { recursive: true });
    if (!traced) throw new Error("trace.zip missing");
  }
}

const cases: [string, Partial<Awaited<ReturnType<typeof scenario>>>][] = [
  ["", { afterAdd: true, afterReload: true, errors: 0 }],
  ["no-persist", { afterAdd: true, afterReload: false }],
  ["dead-add", { afterAdd: false }],
  ["console-error", { afterAdd: true, errors: 1 }],
];
let failed = 0;
for (const [i, [bugs, want]] of cases.entries()) {
  const got = await scenario(bugs, 4300 + i);
  const ok = Object.entries(want).every(([k, v]) => got[k as keyof typeof got] === v) && got.screens === 4;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} bugs=${bugs || "none"} ${JSON.stringify(got)}`);
}
process.exit(failed ? 1 : 0);
