#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { BrowserSession } from "./browser.js";
import { MODEL } from "./claude.js";
import { drive } from "./driver.js";
import { judge } from "./judge.js";
import { writeReport } from "./report.js";

const HELP = `witness: agents don't get to say "it works" without a witness.

Usage:
  witness verify "<goal>" --url <app url> [options]

Options:
  --url <url>         App to open (default: $WITNESS_URL or http://localhost:4173)
  --max-steps <n>     Driver turn limit (default: 30)
  --out <dir>         Where run folders go (default: .witness/runs)
  --headed            Show the browser
  --json              Print the report as JSON instead of a summary

Exit code: 0 pass, 1 fail, 2 inconclusive, 3 error.`;

async function verify(goal: string, values: Record<string, string | boolean | undefined>) {
  const url = String(values.url ?? process.env.WITNESS_URL ?? "http://localhost:4173");
  const maxSteps = Number(values["max-steps"] ?? 30);
  const startedAt = new Date();
  const id = startedAt.toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(String(values.out ?? ".witness/runs"), id);
  await mkdir(runDir, { recursive: true });
  const quiet = Boolean(values.json);
  const log = (line: string) => quiet || console.error(line);

  log(`witness › ${goal}`);
  log(`  driving ${url}`);
  const session = new BrowserSession(runDir, { headed: Boolean(values.headed) });
  let driven;
  try {
    await session.start(url);
    driven = await drive(session, runDir, goal, { maxSteps, log });
  } finally {
    await session.stop();
  }

  log(`  judging ${driven.steps.length} steps of evidence…`);
  const judged = await judge(runDir, goal, driven.steps);

  const report = {
    id,
    goal,
    url,
    model: MODEL,
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

  if (quiet) {
    const { steps: _steps, ...rest } = report;
    console.log(JSON.stringify({ ...rest, runDir }, null, 2));
  } else {
    const v = judged.verdict;
    const mark = { met: "✓", not_met: "✗", not_tested: "–" };
    console.log(`\n${v.verdict.toUpperCase()}  ${v.summary}`);
    for (const c of v.criteria) {
      console.log(`  ${mark[c.status]} ${c.criterion}${c.evidence_steps.length ? `  [#${c.evidence_steps.join(", #")}]` : ""}`);
    }
    for (const p of v.problems) console.log(`  ! ${p}`);
    console.log(`\nevidence: ${relative(process.cwd(), join(runDir, "report.html"))}`);
  }
  return { pass: 0, fail: 1, inconclusive: 2 }[judged.verdict.verdict];
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      "max-steps": { type: "string" },
      out: { type: "string" },
      headed: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command !== "verify" || rest.length === 0) {
    console.log(HELP);
    return command === undefined || values.help ? 0 : 3;
  }
  return verify(rest.join(" "), values);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`witness: ${err instanceof Error ? err.message : err}`);
    process.exit(3);
  },
);
