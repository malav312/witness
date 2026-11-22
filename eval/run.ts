// Witness eval: how often does it catch real bugs, and how often does it cry wolf?
//
//   npm run eval                          # every case, 1 trial
//   npm run eval -- --only add-persist    # one goal (comma-separated ids or case keys)
//   npm run eval -- --trials 3 --concurrency 3
//
// For each goal, Witness runs against the clean demo app (expected: pass),
// against each bug that breaks the goal (expected: fail), and against harmless
// changes (expected: pass). It then replays every passing clean run against the
// same variants with no LLM, to measure what deterministic replay catches for free.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import type { Backend } from "../src/driver.ts";
import type { RunReport } from "../src/report.ts";
import { replayFromRun, runReplay } from "../src/replay.ts";
import { newRunDir, runVerify } from "../src/verify.ts";
import { GOALS, expandCases, type EvalCase } from "./cases.ts";
import { summarize, toMarkdown, type CaseResult, type ReplayCheck } from "./metrics.ts";

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    trials: { type: "string", default: "1" },
    concurrency: { type: "string", default: "3" },
    "max-steps": { type: "string", default: "25" },
    backend: { type: "string" },
    "no-replay": { type: "boolean" },
  },
});

const backend = (values.backend ?? (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code")) as Backend;
const trials = Number(values.trials);
const concurrency = Number(values.concurrency);
const only = values.only?.split(",").map((s) => s.trim());
const cases = expandCases().filter((c) => !only || only.some((o) => c.key === o || c.goalId === o));
if (!cases.length) throw new Error(`No cases match --only ${values.only}`);

const { id, runDir: evalDir } = await newRunDir(".witness/evals");
let nextPort = 4500;

async function serve(bugs: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = nextPort++;
  const proc = spawn("node", ["demo/server.js"], { env: { ...process.env, PORT: String(port), WITNESS_BUGS: bugs } });
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.once("data", () => resolve());
    proc.once("exit", (code) => reject(new Error(`demo server exited ${code}`)));
  });
  return { url: `http://localhost:${port}`, proc };
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const label = (c: EvalCase, t: number) => `${c.key}${trials > 1 ? ` #${t + 1}` : ""}`;

console.error(`witness eval ${id}: ${cases.length} cases × ${trials} trial(s), ${backend}, concurrency ${concurrency}\n`);
const jobs = cases.flatMap((c) => Array.from({ length: trials }, (_, t) => ({ c, t })));
const reports = new Map<string, RunReport>();

const results: CaseResult[] = await pool(jobs, concurrency, async ({ c, t }) => {
  const started = Date.now();
  const { url, proc } = await serve(c.bugs);
  try {
    const { report, runDir } = await runVerify(c.goal, {
      url,
      backend,
      maxSteps: Number(values["max-steps"]),
      outDir: join(evalDir, "runs", `${c.key.replace("/", "--")}-${t + 1}`),
    });
    if (c.kind === "clean") reports.set(`${c.goalId}#${t}`, report);
    const r: CaseResult = {
      ...c,
      trial: t + 1,
      verdict: report.verdict.verdict,
      summary: report.verdict.summary,
      steps: report.steps.length,
      durationMs: Date.now() - started,
      tokens: report.usage.input + report.usage.output,
      report: relative(evalDir, join(runDir, "report.html")),
    };
    const ok = r.verdict === c.expected;
    console.error(`${ok ? "✓" : "✗"} ${label(c, t).padEnd(36)} expected ${c.expected}, got ${r.verdict}  (${(r.durationMs / 1000).toFixed(0)}s)`);
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`! ${label(c, t).padEnd(36)} error: ${msg.slice(0, 200)}`);
    return { ...c, trial: t + 1, verdict: "error", summary: msg, steps: 0, durationMs: Date.now() - started, tokens: 0 };
  } finally {
    proc.kill();
  }
});

// Replay: re-run each passing clean recording against its goal's variants, no LLM.
const replays: ReplayCheck[] = [];
if (!values["no-replay"]) {
  console.error(`\nreplaying passing clean runs against each variant (no LLM)…`);
  for (const g of GOALS) {
    const variants = cases.filter((c) => c.goalId === g.id && c.kind !== "clean");
    if (!variants.length) continue;
    const recorded = [...Array(trials).keys()].map((t) => reports.get(`${g.id}#${t}`)).find((r) => r?.verdict.verdict === "pass");
    const replay = recorded && replayFromRun(recorded);
    if (!replay || "error" in replay) {
      console.error(`  ${g.id}: no passing clean run to replay`);
      continue;
    }
    for (const v of variants) {
      const { url, proc } = await serve(v.bugs);
      try {
        const { runDir } = await newRunDir(join(evalDir, "replays"), `-${v.key.replace("/", "--")}`);
        const res = await runReplay(replay, { url, runDir });
        replays.push({
          key: v.key,
          kind: v.kind,
          diverged: res.status === "diverged",
          at: res.divergence ? `${res.divergence.action} (step ${res.divergence.step})` : undefined,
          durationMs: res.durationMs,
        });
        console.error(`  ${res.status === "diverged" ? "✗ diverged" : "✓ matched "} ${v.key}  (${res.durationMs}ms)`);
      } finally {
        proc.kill();
      }
    }
  }
}

const summary = summarize(results, replays);
await mkdir(evalDir, { recursive: true });
await writeFile(join(evalDir, "results.json"), JSON.stringify({ id, backend, trials, summary, results, replays }, null, 2));
const md = toMarkdown({ id, backend, trials, summary, results, replays });
await writeFile(join(evalDir, "summary.md"), md);
console.log("\n" + md);
console.error(`results: ${relative(process.cwd(), join(evalDir, "summary.md"))}`);
process.exit(0);
