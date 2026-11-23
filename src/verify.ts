// One full verification: drive the app, judge the evidence, write the report.
import { appendFileSync, existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BrowserSession } from "./browser.js";
import { MODEL } from "./claude.js";
import { drive, type Backend, type DriverResult } from "./driver.js";
import { judge, type Verdict } from "./judge.js";
import { gitInfo, provenance, provenanceLine, type BuildInfo } from "./provenance.js";
import { writeReport, type RunReport } from "./report.js";
import { redact } from "./secrets.js";

/** Where `witness auth` saves a login. Holds session cookies: keep it out of git (.witness/ is ignored). */
export const AUTH_FILE = ".witness/auth.json";

export interface VerifyOptions {
  url: string;
  backend: Backend;
  maxSteps: number;
  outDir: string;
  headed?: boolean;
  map?: string;
  /** Start signed in from a saved login (default: AUTH_FILE if it exists). */
  storageState?: string;
  /** If the run passes, save the browser's login state here (used by `witness auth`). */
  saveStateTo?: string;
  log?: (line: string) => void;
}

export const newRunDir = async (outDir: string, suffix = "") => {
  const startedAt = new Date();
  const id = startedAt.toISOString().replace(/[:.]/g, "-") + suffix;
  const runDir = resolve(outDir, id);
  await mkdir(runDir, { recursive: true });
  return { id, runDir, startedAt };
};

export const defaultStorageState = () => (existsSync(AUTH_FILE) ? AUTH_FILE : undefined);

const errorText = (err: unknown) => redact(err instanceof Error ? err.message : String(err));

export async function runVerify(goal: string, opts: VerifyOptions): Promise<{ report: RunReport; runDir: string }> {
  const { id, runDir, startedAt } = await newRunDir(opts.outDir);
  // Every log line also goes to progress.log, so a long run can be followed
  // (tail -f) and an aborted one still says how far it got.
  const log = (line: string) => {
    opts.log?.(line);
    appendFileSync(join(runDir, "progress.log"), redact(line) + "\n");
  };

  log(`witness › ${goal}`);
  log(
    `  driving ${opts.url} via ${opts.backend}` +
      `${opts.map ? " with the Feature Map" : ""}${opts.storageState ? " signed in" : ""}`,
  );
  const session = new BrowserSession(runDir, { headed: opts.headed, storageState: opts.storageState });
  const stateTmp = join(runDir, "auth-state.json");
  let driven: DriverResult;
  let aborted: string | undefined;
  let build: BuildInfo = { fingerprint: "none", scripts: [], serviceWorker: false };
  try {
    await session.start(opts.url);
    driven = await drive(session, runDir, goal, { backend: opts.backend, maxSteps: opts.maxSteps, map: opts.map, log });
  } catch (err) {
    // Usage limits, a crashed backend, an unreachable app: keep the evidence
    // gathered so far and report the run as inconclusive instead of dying.
    aborted = errorText(err);
    log(`  run aborted: ${aborted}`);
    driven = { status: "blocked", summary: `Run aborted: ${aborted}`, steps: session.steps, usage: { input: 0, output: 0 } };
  } finally {
    build = await session.build().catch(() => build);
    if (opts.saveStateTo && !aborted) await session.saveState(stateTmp).catch(() => {});
    await session.stop().catch(() => {});
  }

  const tested = provenance(build, gitInfo(), opts.url);
  log(`  tested: ${provenanceLine(tested)}`);
  for (const w of tested.warnings) log(`  ⚠ ${w}`);

  let verdict: Verdict;
  let judgeUsage = { input: 0, output: 0 };
  if (aborted || driven.steps.length === 0) {
    verdict = {
      verdict: "inconclusive",
      summary: `The run was aborted before a verdict: ${aborted ?? "no steps recorded"}. Evidence gathered so far is kept.`,
      criteria: [],
      problems: [],
    };
  } else {
    log(`  judging ${driven.steps.length} steps of evidence…`);
    try {
      const judged = await judge(runDir, goal, driven.steps, opts.backend);
      verdict = judged.verdict;
      judgeUsage = judged.usage;
    } catch (err) {
      const why = errorText(err);
      log(`  judge failed: ${why}`);
      verdict = { verdict: "inconclusive", summary: `The judge could not run: ${why}. Evidence is kept.`, criteria: [], problems: [] };
    }
  }

  if (opts.saveStateTo && existsSync(stateTmp)) {
    if (verdict.verdict === "pass") {
      await mkdir(resolve(opts.saveStateTo, ".."), { recursive: true });
      await copyFile(stateTmp, opts.saveStateTo);
      log(`  saved login state to ${opts.saveStateTo}`);
    }
    await rm(stateTmp, { force: true }); // never leave session cookies in run folders
  }

  const report: RunReport = {
    id,
    goal,
    url: opts.url,
    model: opts.backend === "api" ? MODEL : (process.env.WITNESS_MODEL ?? "claude-code default"),
    backend: opts.backend,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    driver: { status: driven.status, summary: redact(driven.summary) },
    verdict,
    provenance: tested,
    steps: driven.steps,
    consoleErrors: session.allConsoleErrors.map(redact),
    failedRequests: session.allFailedRequests.map(redact),
    usage: {
      input: driven.usage.input + judgeUsage.input,
      output: driven.usage.output + judgeUsage.output,
    },
  };
  await writeReport(runDir, report);
  log(`  verdict: ${verdict.verdict}`);
  return { report, runDir };
}
