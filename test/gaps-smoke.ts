// No-LLM tests for the fixes from testing Witness on real apps (Actual Budget,
// Uptime Kuma): secrets, select_option, click_at, saved logins, live-data
// masking in replays, unique replay names, and aborted runs keeping evidence.
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BrowserSession } from "../src/browser.ts";
import type { RunReport } from "../src/report.ts";
import { ariaDiff, numericChanges, replayFromRun, replayName, rerecord, runReplay, toPlaywrightSpec } from "../src/replay.ts";
import { resetSecrets } from "../src/secrets.ts";
import { runTool } from "../src/tools.ts";
import { runVerify } from "../src/verify.ts";

const PAGE = `<!doctype html><title>Gaps</title>
<h1>Gaps</h1>
<label>Password <input id="pw" type="text"></label>
<button id="save" onclick="document.getElementById('out').textContent='Saved ' + document.getElementById('pw').value; localStorage.setItem('signedIn','yes')">Save</button>
<p id="out"></p>
<label>Fruit <select id="fruit"><option>Apple</option><option>Banana</option><option>Cherry</option></select></label>
<p id="chosen"></p>
<button id="open" onclick="document.getElementById('menu').hidden=false">Open menu</button>
<div id="menu" hidden style="position:absolute;top:300px;left:300px;width:200px;height:100px;border:1px solid">Menu</div>
<p id="who"></p>
<p id="beat">Heartbeats: <span id="n"></span></p>
<script>
  document.getElementById('fruit').onchange = (e) => document.getElementById('chosen').textContent = 'Chose ' + e.target.value;
  document.addEventListener('mousedown', (e) => { const m = document.getElementById('menu'); if (!m.contains(e.target) && e.target.id !== 'open') m.hidden = true; });
  document.getElementById('who').textContent = localStorage.getItem('signedIn') ? 'Signed in' : 'Signed out';
  document.getElementById('n').textContent = String(Date.now() % 100000); // live data: changes every load
</script>`;

const server = http.createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

let failed = 0;
const expect = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
const refOf = (snap: string, re: RegExp) => snap.split("\n").find((l) => re.test(l))?.match(/\[ref=(e\d+)\]/)?.[1];
const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "witness-gaps-"));
  dirs.push(d);
  return d;
};

const SECRET = "hunter2-very-secret";
process.env.WITNESS_SECRET_PASS = SECRET;
resetSecrets();

try {
  // --- secrets, select_option, click_at, saved login ---
  const dir = await tmp();
  const s = new BrowserSession(dir);
  await s.start(url);
  let snap = await s.snapshot();
  const typed = await runTool(s, dir, "type", { ref: refOf(snap, /textbox "Password"/), text: "{{secret:PASS}}", submit: false });
  snap = await s.snapshot();
  await runTool(s, dir, "click", { ref: refOf(snap, /button "Save"/), element: "Save" });
  expect(await s.page.locator("#out").textContent() === `Saved ${SECRET}`, "the real secret value was typed into the page");

  snap = await s.snapshot();
  const sel = await runTool(s, dir, "select_option", { ref: refOf(snap, /combobox "Fruit"/), option: "Cherry" });
  expect(!sel.isError && (await s.page.locator("#chosen").textContent()) === "Chose Cherry", `select_option picked Cherry: ${sel.text?.split("\n")[0]}`);

  snap = await s.snapshot();
  await runTool(s, dir, "click", { ref: refOf(snap, /button "Open menu"/), element: "Open menu" });
  const menuOpen = await s.page.locator("#menu").isVisible();
  const outside = await runTool(s, dir, "click_at", { x: 1000, y: 700, description: "empty area" });
  expect(menuOpen && !outside.isError && !(await s.page.locator("#menu").isVisible()), "click_at on an empty area closed the menu");

  await s.saveState(join(dir, "auth.json"));
  await s.stop();

  const recorded = JSON.stringify(s.steps);
  expect(!recorded.includes(SECRET) && recorded.includes("{{secret:PASS}}"), "recorded steps hold only the placeholder");
  expect(!typed.text!.includes(SECRET), "the agent's tool result never shows the secret");
  expect(!existsSync(join(dir, "trace.zip")), "no Playwright trace is written while secrets are configured");

  const s2 = new BrowserSession(await tmp(), { storageState: join(dir, "auth.json") });
  await s2.start(url);
  expect((await s2.page.locator("#who").textContent()) === "Signed in", "a saved login state is reused by a new session");
  await s2.stop();

  // --- replays: secrets, new actions, unique names, live data ---
  const goal = "Save the password {{secret:PASS}} and pick a fruit";
  const report = { id: "t", goal, url, steps: s.steps } as unknown as RunReport;
  const replay = replayFromRun(report);
  if ("error" in replay) throw new Error(replay.error);
  expect(!JSON.stringify(replay).includes(SECRET) && !replay.name.includes("hunter"), `replay file and name are clean: ${replay.name}`);
  expect(replay.steps.some((x) => x.action === "select_option") && replay.steps.some((x) => x.action === "click_at"), "replay records select_option and click_at");
  expect(replayName("A".repeat(80) + " one") !== replayName("A".repeat(80) + " two"), "goals sharing a long prefix get different replay names");

  const spec = toPlaywrightSpec(replay);
  expect(spec.includes('secret("PASS")') && !spec.includes(SECRET), "exported test reads the secret from the env");

  const first = await runReplay(replay, { url, runDir: await tmp() });
  expect(first.status === "diverged" && first.divergence?.numbersOnly === true, `live counter diverges as numbers-only: ${first.divergence?.reason}`);

  const healed = rerecord(replay, report, first.divergence);
  if ("error" in healed) throw new Error(healed.error);
  expect(healed.name === replay.name && (healed.volatile ?? []).some((l) => l.includes("Heartbeats: #")), `heal keeps the name and learns: ${healed.volatile}`);
  const again = await runReplay(healed, { url, runDir: await tmp() });
  expect(again.status === "match", `after learning, the replay matches despite the live counter: ${again.divergence?.reason ?? "match"}`);

  // A real wrong number on a line that is not volatile still diverges.
  const d = ariaDiff('- text: "1 item left"\n- text: "Heartbeats: 5"', '- text: "2 items left"\n- text: "Heartbeats: 9"', {
    volatile: ['- text: "Heartbeats: #"'],
  });
  const changed = (d ?? "").split("\n").filter((l) => /^[+-] /.test(l));
  expect(changed.some((l) => l.includes("left")) && !changed.some((l) => l.includes("Heartbeats")), `masking is per line: a changed count elsewhere is still caught (${changed.join(" | ")})`);
  expect(numericChanges("- a 1\n+ a 2\n- b\n+ c").numbersOnly === false, "a divergence with a text change is not numbers-only");

  // --- a missing backend fails fast, before a browser opens ---
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent"; // the claude CLI can't be found
  const pre = await tmp();
  const t0 = Date.now();
  const preErr = await runVerify("Open the page", { url, backend: "claude-code", maxSteps: 3, outDir: pre }).then(() => "", (e) => String(e?.message ?? e));
  expect(preErr.includes("isn't installed") && Date.now() - t0 < 3000, `preflight stops the run in ${Date.now() - t0}ms: ${preErr.slice(0, 70)}`);
  expect((await readdir(pre)).length === 0, "no run folder or browser for a run that can't start");

  // --- an aborted run keeps its evidence (backend dies after the check) ---
  process.env.WITNESS_SKIP_PREFLIGHT = "1";
  const out = await tmp();
  const { report: ab, runDir } = await runVerify("Open the page", { url, backend: "claude-code", maxSteps: 3, outDir: out });
  process.env.PATH = path;
  delete process.env.WITNESS_SKIP_PREFLIGHT;
  const files = await readdir(runDir);
  expect(ab.verdict.verdict === "inconclusive" && ab.verdict.summary.includes("aborted"), `aborted run is inconclusive: ${ab.verdict.summary.slice(0, 90)}`);
  expect(files.includes("report.html") && files.includes("progress.log") && (await readdir(join(runDir, "screens"))).length > 0, "aborted run still has a report, progress log and screenshots");
  expect((await readFile(join(runDir, "progress.log"), "utf8")).includes("run aborted"), "progress.log records why it stopped");
} finally {
  server.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
