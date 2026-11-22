// One full verification: drive the app, judge the evidence, write the report.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { BrowserSession } from "./browser.js";
import { MODEL } from "./claude.js";
import { drive, type Backend } from "./driver.js";
import { judge } from "./judge.js";
import { writeReport, type RunReport } from "./report.js";

export interface VerifyOptions {
  url: string;
  backend: Backend;
  maxSteps: number;
  outDir: string;
  headed?: boolean;
  log?: (line: string) => void;
}

export const newRunDir = async (outDir: string, suffix = "") => {
  const startedAt = new Date();
  const id = startedAt.toISOString().replace(/[:.]/g, "-") + suffix;
  const runDir = resolve(outDir, id);
  await mkdir(runDir, { recursive: true });
  return { id, runDir, startedAt };
};

export async function runVerify(goal: string, opts: VerifyOptions): Promise<{ report: RunReport; runDir: string }> {
  const log = opts.log ?? (() => {});
  const { id, runDir, startedAt } = await newRunDir(opts.outDir);

  log(`witness › ${goal}`);
  log(`  driving ${opts.url} via ${opts.backend}`);
  const session = new BrowserSession(runDir, { headed: opts.headed });
  let driven;
  try {
    await session.start(opts.url);
    driven = await drive(session, runDir, goal, { backend: opts.backend, maxSteps: opts.maxSteps, log });
  } finally {
    await session.stop();
  }

  log(`  judging ${driven.steps.length} steps of evidence…`);
  const judged = await judge(runDir, goal, driven.steps, opts.backend);

  const report: RunReport = {
    id,
    goal,
    url: opts.url,
    model: opts.backend === "api" ? MODEL : (process.env.WITNESS_MODEL ?? "claude-code default"),
    backend: opts.backend,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    driver: { status: driven.status, summary: driven.summary },
    verdict: judged.verdict,
    steps: driven.steps,
    consoleErrors: session.allConsoleErrors,
    failedRequests: session.allFailedRequests,
    usage: {
      input: driven.usage.input + judged.usage.input,
      output: driven.usage.output + judged.usage.output,
    },
  };
  await writeReport(runDir, report);
  return { report, runDir };
}
