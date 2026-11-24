#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Backend } from "./driver.js";
import type { RunReport } from "./report.js";
import {
  REPLAY_DIR,
  loadReplays,
  replayFromRun,
  runReplay,
  rerecord,
  saveReplay,
  toPlaywrightSpec,
  type ReplayResult,
} from "./replay.js";
import { provenanceLine } from "./provenance.js";
import { AUTH_EXTRA_FILE, authWarnings, saveAuth, soonestExpiry, waitForEnter } from "./auth.js";
import { allowedOrigins, launchBrowser, waitReady } from "./browser.js";
import { IGNORE_FILE, ignoredLine } from "./noise.js";
import { AUTH_FILE, defaultStorageState, newRunDir, runVerify, type VerifyOptions } from "./verify.js";
import { SECRETS_FILE } from "./secrets.js";
import { MAP_FILE, buildMap, checkMap, hasDrift, readMap, writeMap } from "./map.js";

const HELP = `witness: agents don't get to say "it works" without a witness.

Usage:
  witness verify "<goal>" [options]   Drive the app with an agent, judge the evidence.
                                      A pass is saved as a replay.
  witness replay [name...] [options]  Re-run saved replays with no LLM (all if no names).
  witness export [name...] [--dir d]  Write replays as plain Playwright tests.
  witness map [--check]               Crawl the app into a Feature Map (${MAP_FILE}),
                                      or report drift from the saved one (no LLM).
  witness auth "<login goal>"         Have the agent log in, and save the session to ${AUTH_FILE}.
                                      Later runs start signed in.
  witness auth --manual               Open a browser and sign in yourself (single sign-on, MFA),
                                      then press Enter to save the session.
  witness mcp                         Serve Witness as an MCP server on stdio, for coding agents.

Secrets: write {{secret:NAME}} in a goal instead of a password or key. Set the value
as WITNESS_SECRET_NAME or in ${SECRETS_FILE}. The agent never sees it, and every report,
replay and log stores only the placeholder.

Known-noise errors: list patterns the app always logs (one per line, substring or /regex/)
in ${IGNORE_FILE}, or set WITNESS_IGNORE_ERRORS to a regex. They're left out of the
evidence and counted in the report.

Options:
  --url <url>         App to open (default: $WITNESS_URL or http://localhost:4173)
  --backend <name>    claude-code: your Claude Code sign-in (e.g. a Claude subscription)
                      api: the Claude API with ANTHROPIC_API_KEY
                      (default: api if ANTHROPIC_API_KEY is set, else claude-code)
  --max-steps <n>     Driver action limit (default: 30)
  --out <dir>         Where run folders go (default: .witness/runs)
  --no-save           verify: don't save a replay on pass
  --heal              replay: when a replay diverges, re-verify with the agent.
                      Still passing: re-record the replay. Failing: report a regression.
  --dir <dir>         export: output folder (default: tests/witness)
  --no-map            verify: don't give the Driver the Feature Map
  --no-auth           Ignore the saved login in ${AUTH_FILE}
  --headed            Show the browser
  --channel <name>    Use an installed browser: msedge, chrome, brave, or the path
                      to any Chromium-based browser
                      (default: Playwright's Chromium; or $WITNESS_BROWSER_CHANNEL)
  --manual            auth: sign in yourself in a visible browser

Environment:
  WITNESS_READY_SELECTOR     After each page load, wait for this CSS selector (app shells
                             that show a spinner first). WITNESS_READY_TIMEOUT_MS: default 15000.
  WITNESS_ALLOWED_ORIGINS    Extra origins the browser may load, comma-separated.
  --json              Print results as JSON

Exit code: 0 pass, 1 fail, 2 inconclusive, 3 error.`;

type Values = Record<string, string | boolean | undefined>;

async function options(values: Values): Promise<VerifyOptions & { json: boolean }> {
  const backend = String(values.backend ?? (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code"));
  if (backend !== "api" && backend !== "claude-code") throw new Error(`Unknown backend "${backend}"`);
  const json = Boolean(values.json);
  if (values.channel) process.env.WITNESS_BROWSER_CHANNEL = String(values.channel);
  return {
    url: String(values.url ?? process.env.WITNESS_URL ?? "http://localhost:4173"),
    backend: backend as Backend,
    maxSteps: Number(values["max-steps"] ?? 30),
    outDir: String(values.out ?? ".witness/runs"),
    headed: Boolean(values.headed),
    map: values["no-map"] ? undefined : (await readMap())?.text,
    storageState: values["no-auth"] ? undefined : defaultStorageState(),
    log: (line) => json || console.error(line),
    json,
  };
}

const rel = (p: string) => relative(process.cwd(), p);

function printVerdict(report: RunReport, runDir: string) {
  const v = report.verdict;
  const mark = { met: "✓", not_met: "✗", not_tested: "–" };
  console.log(`\n${v.verdict.toUpperCase()}  ${v.summary}`);
  for (const c of v.criteria) {
    console.log(`  ${mark[c.status]} ${c.criterion}${c.evidence_steps.length ? `  [#${c.evidence_steps.join(", #")}]` : ""}`);
  }
  for (const p of v.problems) console.log(`  ! ${p}`);
  if (report.provenance) {
    console.log(`\ntested:   ${provenanceLine(report.provenance)}`);
    for (const w of report.provenance.warnings) console.log(`  ⚠ ${w}`);
  }
  const ignored = ignoredLine(report.ignoredErrors);
  if (ignored) console.log(`note:     ${ignored} (not shown to the Judge)`);
  console.log(`\nevidence: ${rel(join(runDir, "report.html"))}`);
}

async function saveIfPassed(report: RunReport, log: (l: string) => void): Promise<string | undefined> {
  if (report.verdict.verdict !== "pass") return;
  const replay = replayFromRun(report);
  if ("error" in replay) {
    log(`  (not saved as a replay: ${replay.error})`);
    return;
  }
  return saveReplay(replay);
}

async function verify(goal: string, values: Values) {
  const opts = await options(values);
  const { report, runDir } = await runVerify(goal, opts);
  const replayFile = values["no-save"] ? undefined : await saveIfPassed(report, opts.log!);
  if (opts.json) {
    const { steps: _steps, ...rest } = report;
    console.log(JSON.stringify({ ...rest, runDir, replay: replayFile }, null, 2));
  } else {
    printVerdict(report, runDir);
    if (replayFile) console.log(`replay:   ${rel(replayFile)}  (re-run free with: witness replay)`);
  }
  return { pass: 0, fail: 1, inconclusive: 2 }[report.verdict.verdict];
}

async function replay(names: string[], values: Values) {
  const opts = await options(values);
  const replays = await loadReplays(names);
  if (!replays.length) throw new Error(`No replays in ${REPLAY_DIR}. A passing "witness verify" creates one.`);

  let worst = 0;
  const results: (ReplayResult & { healed?: string; regression?: string })[] = [];
  for (const { replay: r } of replays) {
    const { runDir } = await newRunDir(opts.outDir, `-replay-${r.name}`);
    const res = await runReplay(r, { url: opts.url, runDir, headed: opts.headed, storageState: opts.storageState });
    const entry: (typeof results)[number] = { ...res };
    results.push(entry);

    const warn = () => res.provenance?.warnings.forEach((w) => opts.log!(`    ⚠ ${w}`));
    if (res.status === "match") {
      opts.log!(`✓ ${r.name}  ${res.steps} steps match  (${(res.durationMs / 1000).toFixed(1)}s, no LLM)`);
      warn();
      continue;
    }
    const d = res.divergence!;
    opts.log!(`✗ ${r.name}  diverged at step ${d.step} (${d.action}): ${d.reason}`);
    if (d.diff) opts.log!(d.diff.replace(/^/gm, "    "));
    if (res.provenance) opts.log!(`    tested: ${provenanceLine(res.provenance)}`);
    if (res.sameBuild === true) opts.log!(`    Same JavaScript build as when recorded, so the difference comes from data, the backend or the environment, not the frontend code.`);
    if (res.sameBuild === false) opts.log!(`    The JavaScript build differs from when the replay was recorded (${r.recordedWith?.build} → ${res.provenance?.build.fingerprint}).`);
    warn();
    opts.log!(`    evidence: ${rel(runDir)}`);
    if (d.numbersOnly && !values.heal) {
      opts.log!(`    Only numbers changed, which looks like live data. --heal re-verifies the goal and, if it holds, learns these lines as volatile.`);
    }

    if (!values.heal) {
      worst = Math.max(worst, 1);
      continue;
    }
    opts.log!(`  healing: re-verifying "${r.goal}" with the agent…`);
    const { report, runDir: verifyDir } = await runVerify(r.goal, opts);
    if (report.verdict.verdict === "pass") {
      const next = rerecord(r, report, d);
      const file = "error" in next ? undefined : await saveReplay(next);
      entry.healed = file;
      const learned = "error" in next ? 0 : (next.volatile?.length ?? 0) - (r.volatile?.length ?? 0);
      opts.log!(
        `  HEALED  The app changed, but the goal still holds. Replay re-recorded: ${file ? rel(file) : "(not saved)"}` +
          (learned > 0 ? `\n    learned ${learned} live-data line(s); numbers on them are ignored from now on` : ""),
      );
    } else {
      entry.regression = verifyDir;
      worst = Math.max(worst, report.verdict.verdict === "fail" ? 1 : 2);
      opts.log!(`  REGRESSION  ${report.verdict.summary}`);
      opts.log!(`    evidence: ${rel(join(verifyDir, "report.html"))}`);
    }
  }
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  return worst;
}

async function exportSpecs(names: string[], values: Values) {
  const dir = String(values.dir ?? "tests/witness");
  const replays = await loadReplays(names);
  if (!replays.length) throw new Error(`No replays in ${REPLAY_DIR}.`);
  await mkdir(dir, { recursive: true });
  for (const { replay: r } of replays) {
    const file = join(dir, `${r.name}.spec.ts`);
    await writeFile(file, toPlaywrightSpec(r));
    console.log(`wrote ${file}`);
  }
  console.log(`\nrun with: WITNESS_URL=<app url> npx playwright test ${dir}`);
  return 0;
}

async function map(values: Values) {
  const opts = await options(values);
  for (const w of authWarnings(opts.storageState)) console.error(`⚠ ${w}`);
  const { runDir } = await newRunDir(opts.outDir, "-map");
  if (values.check) {
    const saved = await readMap();
    if (!saved) throw new Error(`No ${MAP_FILE} yet. Create one with: witness map`);
    const d = await checkMap(saved.map, opts.url, runDir, opts.storageState);
    if (!hasDrift(d)) {
      console.log(`✓ ${MAP_FILE} matches the app (${saved.map.pages.length} pages, ${saved.map.features.length} features)`);
      return 0;
    }
    console.log(`✗ ${MAP_FILE} has drifted from the app:`);
    for (const p of d.addedPages) console.log(`  + new page ${p}`);
    for (const p of d.removedPages) console.log(`  - page gone: ${p}`);
    for (const c of d.changedPages) {
      for (const a of c.added) console.log(`  + ${c.path}: ${a}`);
      for (const r of c.removed) console.log(`  - ${c.path}: ${r}`);
    }
    for (const f of d.staleFeatures) console.log(`  ! feature "${f.name}" relies on missing ${f.missing.join(", ")}`);
    console.log(`\nRegenerate with: witness map`);
    return 1;
  }
  console.error(`witness map › ${opts.url}`);
  const m = await buildMap({
    url: opts.url, backend: opts.backend, workDir: runDir, runsDir: opts.outDir, storageState: opts.storageState, log: opts.log!,
  });
  await writeMap(m);
  console.log(`\nwrote ${MAP_FILE}: ${m.pages.length} page(s), ${m.features.length} feature(s)`);
  for (const f of m.features) console.log(`  • ${f.name}  (${f.page})${f.traps.length ? `  · ${f.traps.length} trap(s)` : ""}`);
  return 0;
}

async function manualAuth(values: Values) {
  const opts = await options(values);
  if (!process.stdin.isTTY) throw new Error("witness auth --manual needs a terminal: it waits for you to press Enter after signing in.");
  const appOrigin = new URL(opts.url).origin;
  const browser = await launchBrowser(false);
  try {
    const context = await browser.newContext({ viewport: null });
    // You're driving, so nothing is blocked. Note which other sites pages came
    // from (the identity provider): runs with this login may load them too.
    const origins = new Set<string>();
    context.on("request", (req) => {
      if (!req.isNavigationRequest()) return;
      try {
        const u = new URL(req.url());
        if (u.protocol.startsWith("http") && u.origin !== appOrigin) origins.add(u.origin);
      } catch {}
    });
    const page = await context.newPage();
    await page.goto(opts.url).catch((err) => console.error(`  (opening ${opts.url}: ${err instanceof Error ? err.message.split("\n")[0] : err})`));
    const closed = new Promise((r) => browser.once("disconnected", r));
    await waitForEnter(
      `\nSign in to ${opts.url} in the browser window. Pop-ups and extra tabs are fine.\n` +
        `When the app shows you signed in, come back here and press Enter… `,
      closed,
    );

    // sessionStorage isn't part of Playwright's storage state; take it from the app's open tabs.
    let saved: Record<string, string> = {};
    for (const p of context.pages()) {
      if (!p.url().startsWith(appOrigin)) continue;
      const items = await p.evaluate(() => Object.fromEntries(Object.entries(window.sessionStorage))).catch(() => ({}));
      saved = { ...saved, ...items };
    }
    const state = await context.storageState({ indexedDB: true });
    const extra = { savedAt: new Date().toISOString(), appOrigin, signInOrigins: [...origins].sort(), sessionStorage: saved };

    // Check it the way a run will use it: a fresh context with the saved state.
    const check = await browser.newContext({ storageState: state });
    if (Object.keys(saved).length) {
      await check.addInitScript(({ origin, items }) => {
        if (location.origin === origin && !sessionStorage.length) for (const [k, v] of Object.entries(items)) sessionStorage.setItem(k, v);
      }, { origin: appOrigin, items: saved });
    }
    const probe = await check.newPage();
    await probe.goto(opts.url).catch(() => {});
    await waitReady(probe);
    const landed = probe.url();
    if (!landed.startsWith(appOrigin)) {
      console.log(`\nOpening the app with this session went to ${new URL(landed).origin}, probably a sign-in page, so nothing was saved.`);
      console.log(`Finish signing in (until the app itself shows), then run witness auth --manual again.`);
      return 1;
    }

    await saveAuth(state, extra);
    console.log(`\nSaved the login to ${AUTH_FILE} (plus ${AUTH_EXTRA_FILE}). verify, replay and map now start signed in (--no-auth to skip).`);
    const soonest = soonestExpiry(state.cookies);
    if (soonest) console.log(`The soonest cookie expires ${soonest.toISOString()}. Runs after that may need a fresh sign-in.`);
    if (Object.keys(saved).length) console.log(`Also saved ${Object.keys(saved).length} sessionStorage item(s), restored at the start of each run.`);
    const extraAllowed = extra.signInOrigins.filter((o) => !allowedOrigins(opts.url).has(o));
    if (extraAllowed.length) {
      console.log(`Runs with this login may also load pages from the sign-in site(s) you went through: ${extraAllowed.join(", ")}.`);
      console.log(`Secrets are still only typed on the app's own origin.`);
    }
    console.log(`These files hold session tokens: keep them out of git. .witness/ is ignored by default.`);
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function auth(goal: string, values: Values) {
  const opts = await options(values);
  const { report, runDir } = await runVerify(
    `${goal}\nThe goal is only to end up signed in. Once you are, call finish.`,
    { ...opts, storageState: undefined, saveStateTo: AUTH_FILE },
  );
  printVerdict(report, runDir);
  if (report.verdict.verdict !== "pass") {
    console.log(`\nNot signed in, so nothing was saved.`);
    return report.verdict.verdict === "fail" ? 1 : 2;
  }
  console.log(`\nSaved the login to ${AUTH_FILE}. verify, replay and map now start signed in (--no-auth to skip).`);
  console.log(`It holds session cookies: keep it out of git. .witness/ is ignored by default.`);
  return 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      "max-steps": { type: "string" },
      out: { type: "string" },
      backend: { type: "string" },
      "no-save": { type: "boolean" },
      heal: { type: "boolean" },
      dir: { type: "string" },
      "no-map": { type: "boolean" },
      "no-auth": { type: "boolean" },
      check: { type: "boolean" },
      headed: { type: "boolean" },
      channel: { type: "string" },
      manual: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return 0;
  }
  if (command === "verify" && rest.length) return verify(rest.join(" "), values);
  if (command === "replay") return replay(rest, values);
  if (command === "export") return exportSpecs(rest, values);
  if (command === "map") return map(values);
  if (command === "auth" && values.manual) return manualAuth(values);
  if (command === "auth" && rest.length) return auth(rest.join(" "), values);
  if (command === "mcp") {
    const { serveMcp } = await import("./mcp-server.js");
    await serveMcp();
    return new Promise<number>(() => {}); // serve until the client disconnects
  }
  console.log(HELP);
  return 3;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`witness: ${err instanceof Error ? err.message : err}`);
    process.exit(3);
  },
);
