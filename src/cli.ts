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
  saveReplay,
  toPlaywrightSpec,
  type ReplayResult,
} from "./replay.js";
import { newRunDir, runVerify, type VerifyOptions } from "./verify.js";

const HELP = `witness: agents don't get to say "it works" without a witness.

Usage:
  witness verify "<goal>" [options]   Drive the app with an agent, judge the evidence.
                                      A pass is saved as a replay.
  witness replay [name...] [options]  Re-run saved replays with no LLM (all if no names).
  witness export [name...] [--dir d]  Write replays as plain Playwright tests.

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
  --headed            Show the browser
  --json              Print results as JSON

Exit code: 0 pass, 1 fail, 2 inconclusive, 3 error.`;

type Values = Record<string, string | boolean | undefined>;

function options(values: Values): VerifyOptions & { json: boolean } {
  const backend = String(values.backend ?? (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code"));
  if (backend !== "api" && backend !== "claude-code") throw new Error(`Unknown backend "${backend}"`);
  const json = Boolean(values.json);
  return {
    url: String(values.url ?? process.env.WITNESS_URL ?? "http://localhost:4173"),
    backend: backend as Backend,
    maxSteps: Number(values["max-steps"] ?? 30),
    outDir: String(values.out ?? ".witness/runs"),
    headed: Boolean(values.headed),
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
  const opts = options(values);
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
  const opts = options(values);
  const replays = await loadReplays(names);
  if (!replays.length) throw new Error(`No replays in ${REPLAY_DIR}. A passing "witness verify" creates one.`);

  let worst = 0;
  const results: (ReplayResult & { healed?: string; regression?: string })[] = [];
  for (const { replay: r } of replays) {
    const { runDir } = await newRunDir(opts.outDir, `-replay-${r.name}`);
    const res = await runReplay(r, { url: opts.url, runDir, headed: opts.headed });
    const entry: (typeof results)[number] = { ...res };
    results.push(entry);

    if (res.status === "match") {
      opts.log!(`✓ ${r.name}  ${res.steps} steps match  (${(res.durationMs / 1000).toFixed(1)}s, no LLM)`);
      continue;
    }
    const d = res.divergence!;
    opts.log!(`✗ ${r.name}  diverged at step ${d.step} (${d.action}): ${d.reason}`);
    if (d.diff) opts.log!(d.diff.replace(/^/gm, "    "));
    opts.log!(`    evidence: ${rel(runDir)}`);

    if (!values.heal) {
      worst = Math.max(worst, 1);
      continue;
    }
    opts.log!(`  healing: re-verifying "${r.goal}" with the agent…`);
    const { report, runDir: verifyDir } = await runVerify(r.goal, opts);
    if (report.verdict.verdict === "pass") {
      const file = await saveIfPassed(report, opts.log!);
      entry.healed = file;
      opts.log!(`  HEALED  The app changed, but the goal still holds. Replay re-recorded: ${file ? rel(file) : "(not saved)"}`);
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
      headed: { type: "boolean" },
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
