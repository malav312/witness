import type { EvalCase } from "./cases.ts";

export interface CaseResult extends EvalCase {
  trial: number;
  verdict: "pass" | "fail" | "inconclusive" | "error";
  summary: string;
  steps: number;
  durationMs: number;
  tokens: number;
  report?: string;
}

export interface ReplayCheck {
  key: string;
  kind: EvalCase["kind"];
  diverged: boolean;
  at?: string;
  durationMs: number;
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

export function summarize(results: CaseResult[], replays: ReplayCheck[]) {
  const bug = results.filter((r) => r.kind === "bug");
  const ok = results.filter((r) => r.kind !== "bug"); // clean + harmless: should pass
  const count = (rs: CaseResult[], v: CaseResult["verdict"]) => rs.filter((r) => r.verdict === v).length;
  const replayBugs = replays.filter((r) => r.kind === "bug");
  const replayHarmless = replays.filter((r) => r.kind === "harmless");
  const ran = results.filter((r) => r.verdict !== "error");
  return {
    bugRuns: bug.length,
    caught: count(bug, "fail"),
    missed: count(bug, "pass"),
    bugInconclusive: count(bug, "inconclusive"),
    okRuns: ok.length,
    correctPasses: count(ok, "pass"),
    falseAlarms: count(ok, "fail"),
    okInconclusive: count(ok, "inconclusive"),
    errors: count(results, "error"),
    accuracy: ran.filter((r) => r.verdict === r.expected).length / (ran.length || 1),
    catchRate: count(bug, "fail") / (bug.length || 1),
    falseAlarmRate: count(ok, "fail") / (ok.length || 1),
    meanSeconds: ran.reduce((s, r) => s + r.durationMs, 0) / 1000 / (ran.length || 1),
    meanSteps: ran.reduce((s, r) => s + r.steps, 0) / (ran.length || 1),
    totalTokens: results.reduce((s, r) => s + r.tokens, 0),
    replay: {
      bugRuns: replayBugs.length,
      caught: replayBugs.filter((r) => r.diverged).length,
      harmlessRuns: replayHarmless.length,
      harmlessDiverged: replayHarmless.filter((r) => r.diverged).length,
      meanMs: replays.reduce((s, r) => s + r.durationMs, 0) / (replays.length || 1),
    },
  };
}

type Summary = ReturnType<typeof summarize>;

export function toMarkdown(e: {
  id: string;
  backend: string;
  trials: number;
  summary: Summary;
  results: CaseResult[];
  replays: ReplayCheck[];
}): string {
  const s = e.summary;
  const icon = (r: CaseResult) => (r.verdict === "error" ? "⚠️" : r.verdict === r.expected ? "✅" : r.verdict === "inconclusive" ? "❔" : "❌");
  const rows = e.results
    .map(
      (r) =>
        `| ${icon(r)} | \`${r.key}\`${e.trials > 1 ? ` #${r.trial}` : ""} | ${r.kind} | ${r.expected} | **${r.verdict}** | ${r.steps} | ${(r.durationMs / 1000).toFixed(0)}s |`,
    )
    .join("\n");
  const replayRows = e.replays
    .map((r) => `| ${r.kind === "bug" ? (r.diverged ? "✅" : "❌") : r.diverged ? "↻" : "✅"} | \`${r.key}\` | ${r.kind} | ${r.diverged ? `diverged at ${r.at}` : "matched"} | ${r.durationMs}ms |`)
    .join("\n");

  return `# Witness eval ${e.id}

Backend: \`${e.backend}\` · ${e.results.length} agent runs (${e.trials} trial${e.trials > 1 ? "s" : ""} per case)

## Headline

| Metric | Result |
|---|---|
| **Bug catch rate** (bug present → \`fail\`) | **${pct(s.caught, s.bugRuns)}** (${s.caught}/${s.bugRuns}) |
| **False alarm rate** (no bug → \`fail\`) | **${pct(s.falseAlarms, s.okRuns)}** (${s.falseAlarms}/${s.okRuns}) |
| Overall accuracy | ${Math.round(s.accuracy * 100)}% |
| Bugs missed (judged \`pass\`) | ${s.missed} |
| Inconclusive | ${s.bugInconclusive + s.okInconclusive} |
| Errors | ${s.errors} |
| Mean time / steps per run | ${s.meanSeconds.toFixed(0)}s / ${s.meanSteps.toFixed(1)} |
| Tokens (all runs) | ${s.totalTokens.toLocaleString("en-US")} |
${
  e.replays.length
    ? `| **Replay catch rate** (no LLM) | **${pct(s.replay.caught, s.replay.bugRuns)}** (${s.replay.caught}/${s.replay.bugRuns}), mean ${Math.round(s.replay.meanMs)}ms |
| Harmless changes flagged by replay (handled by \`--heal\`) | ${s.replay.harmlessDiverged}/${s.replay.harmlessRuns} |
`
    : ""
}
## Agent runs

| | Case | Kind | Expected | Verdict | Steps | Time |
|---|---|---|---|---|---|---|
${rows}
${
  e.replays.length
    ? `
## Replay (no LLM)

Each goal's passing clean recording replayed against its variants. Divergence on a bug is a catch; divergence on a harmless change is what \`--heal\` resolves.

| | Variant | Kind | Replay | Time |
|---|---|---|---|---|
${replayRows}
`
    : ""
}`;
}
