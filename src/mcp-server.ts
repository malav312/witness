// `witness mcp`: Witness as an MCP server (stdio), so a coding agent can end
// its own task with "prove it" and get evidence back, not just say "done".
//
//   claude mcp add witness -- npx tsx /path/to/witness/src/cli.ts mcp
//
// Tools: witness_verify, witness_replay, witness_map, witness_replays.
// Everything runs in the agent's working directory: .witness/ for runs and
// replays, witness.map.yaml for the Feature Map. stdout carries the MCP
// protocol, so all logging goes to stderr.
import { join, relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Backend } from "./driver.js";
import { MAP_FILE, buildMap, checkMap, hasDrift, readMap, writeMap } from "./map.js";
import type { RunReport } from "./report.js";
import { loadReplays, replayFromRun, rerecord, runReplay, saveReplay } from "./replay.js";
import { SECRETS_FILE } from "./secrets.js";
import { AUTH_FILE, defaultStorageState, newRunDir, runVerify } from "./verify.js";

const OUT = ".witness/runs";
const log = (line: string) => process.stderr.write(line + "\n");
const rel = (p: string) => relative(process.cwd(), p);
const backend = (): Backend => (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code");
const urlOr = (url?: string) => url ?? process.env.WITNESS_URL ?? "http://localhost:4173";

const text = (t: string, structured?: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(structured ? { structuredContent: structured } : {}),
  isError,
});

function formatVerdict(report: RunReport, runDir: string, replayFile?: string): string {
  const v = report.verdict;
  const mark = { met: "✓", not_met: "✗", not_tested: "–" };
  return [
    `${v.verdict.toUpperCase()}: ${v.summary}`,
    "",
    ...v.criteria.map(
      (c) => `${mark[c.status]} ${c.criterion}${c.evidence_steps.length ? ` [steps ${c.evidence_steps.join(", ")}]` : ""}${c.note ? `: ${c.note}` : ""}`,
    ),
    ...(v.problems.length ? ["", "Problems:", ...v.problems.map((p) => `- ${p}`)] : []),
    "",
    `Evidence report: ${rel(join(runDir, "report.html"))} (screenshots in ${rel(join(runDir, "screens"))}/)`,
    ...(replayFile ? [`Saved as replay: ${rel(replayFile)}. Re-check later with witness_replay, no LLM needed.`] : []),
  ].join("\n");
}

async function savePass(report: RunReport): Promise<string | undefined> {
  if (report.verdict.verdict !== "pass") return;
  const r = replayFromRun(report);
  return "error" in r ? undefined : saveReplay(r);
}

export async function serveMcp() {
  const server = new McpServer(
    { name: "witness", version: "0.1.0" },
    {
      instructions:
        "Witness proves that a web app actually does something by driving it in a real browser and judging the recorded evidence. " +
        "Use witness_verify after changing app behavior, before saying the work is done; a 'pass' is the evidence. " +
        "Use witness_replay to check earlier verified behavior still holds (fast, no LLM). " +
        "The app must already be running; pass its url or set WITNESS_URL. " +
        "Never put real passwords or keys in a goal: write {{secret:NAME}} and have the user set WITNESS_SECRET_NAME. " +
        "For apps behind a login, call witness_auth once; later runs start signed in.",
    },
  );

  server.registerTool(
    "witness_verify",
    {
      title: "Verify a goal in the running app",
      description:
        "Drive the running web app in a real browser to exercise a goal described in plain English, then have an independent judge decide pass/fail from the recorded evidence only (screenshots, accessibility trees, console errors, failed requests). " +
        "Write the goal as a user-visible outcome, including implied expectations, e.g. 'A user can add a task with the Add button and it is still there after reloading'. " +
        `Refer to credentials as {{secret:NAME}} (values from WITNESS_SECRET_NAME or ${SECRETS_FILE}); they are typed for the agent and redacted everywhere. ` +
        "Takes about a minute. On pass, the run is saved as a replay. Treat 'fail' and 'inconclusive' as not done: read the problems, fix, and verify again.",
      inputSchema: {
        goal: z.string().describe("The user-visible behavior to prove"),
        url: z.string().optional().describe("Where the app is running (default: $WITNESS_URL or http://localhost:4173)"),
        max_steps: z.number().int().min(3).max(60).optional().describe("Browser action limit (default 30)"),
      },
    },
    async ({ goal, url, max_steps }) => {
      try {
        const map = await readMap();
        const { report, runDir } = await runVerify(goal, {
          url: urlOr(url),
          backend: backend(),
          maxSteps: max_steps ?? 30,
          outDir: OUT,
          map: map?.text,
          storageState: defaultStorageState(),
          log,
        });
        const replayFile = await savePass(report);
        return text(formatVerdict(report, runDir, replayFile), {
          verdict: report.verdict.verdict,
          summary: report.verdict.summary,
          criteria: report.verdict.criteria,
          problems: report.verdict.problems,
          report: rel(join(runDir, "report.html")),
          replay: replayFile ? rel(replayFile) : null,
        });
      } catch (err) {
        return text(`Witness could not run: ${err instanceof Error ? err.message : err}. Is the app running at ${urlOr(url)}?`, undefined, true);
      }
    },
  );

  server.registerTool(
    "witness_replay",
    {
      title: "Re-check verified behavior (no LLM)",
      description:
        "Re-run saved replays of previously verified goals: same steps, compared against the accessibility tree recorded when they passed. About a second each, no model calls. " +
        "Run it before finishing a change to catch regressions in behavior you didn't touch. A divergence is either a regression or an intended UI change: set heal=true to re-verify diverged goals with the agent, which re-records the replay if the goal still holds.",
      inputSchema: {
        names: z.array(z.string()).optional().describe("Replay names (from witness_replays); omit for all"),
        url: z.string().optional(),
        heal: z.boolean().optional().describe("Re-verify diverged goals with the agent (slower, uses the model)"),
      },
    },
    async ({ names, url, heal }) => {
      try {
        const replays = await loadReplays(names ?? []);
        if (!replays.length) return text("No replays saved yet. A passing witness_verify creates one.");
        const lines: string[] = [];
        const results: Record<string, unknown>[] = [];
        let regressions = 0;
        for (const { replay: r } of replays) {
          const { runDir } = await newRunDir(OUT, `-replay-${r.name}`);
          const res = await runReplay(r, { url: urlOr(url), runDir, storageState: defaultStorageState() });
          if (res.status === "match") {
            lines.push(`✓ ${r.name}: ${res.steps} steps match (${(res.durationMs / 1000).toFixed(1)}s)`);
            results.push({ name: r.name, status: "match" });
            continue;
          }
          const d = res.divergence!;
          lines.push(`✗ ${r.name}: diverged at step ${d.step} (${d.action}): ${d.reason}`);
          if (d.diff) lines.push(d.diff.replace(/^/gm, "    "));
          if (d.numbersOnly && !heal) lines.push("    Only numbers changed (likely live data). heal=true re-verifies and learns these lines as volatile.");
          if (!heal) {
            regressions++;
            results.push({ name: r.name, status: "diverged", reason: d.reason });
            continue;
          }
          const { report, runDir: vDir } = await runVerify(r.goal, {
            url: urlOr(url), backend: backend(), maxSteps: 30, outDir: OUT, map: (await readMap())?.text,
            storageState: defaultStorageState(), log,
          });
          if (report.verdict.verdict === "pass") {
            const next = rerecord(r, report, d);
            if (!("error" in next)) await saveReplay(next);
            lines.push(`  HEALED: the UI changed but "${r.goal}" still holds. Replay re-recorded.`);
            results.push({ name: r.name, status: "healed" });
          } else {
            regressions++;
            lines.push(`  REGRESSION: ${report.verdict.summary}`, `  Evidence: ${rel(join(vDir, "report.html"))}`);
            results.push({ name: r.name, status: "regression", summary: report.verdict.summary });
          }
        }
        lines.unshift(regressions ? `${regressions} of ${replays.length} replay(s) need attention.\n` : `All ${replays.length} replay(s) OK.\n`);
        return text(lines.join("\n"), { regressions, results });
      } catch (err) {
        return text(`Replay failed: ${err instanceof Error ? err.message : err}`, undefined, true);
      }
    },
  );

  server.registerTool(
    "witness_map",
    {
      title: "Build or check the Feature Map",
      description:
        `Crawl the running app into a Feature Map (${MAP_FILE}): pages, features, how to reach them, the controls they use, and traps. witness_verify reads it automatically. ` +
        "With check=true, re-crawl without an LLM and report drift from the saved map (new or removed pages and controls, stale features).",
      inputSchema: { url: z.string().optional(), check: z.boolean().optional() },
    },
    async ({ url, check }) => {
      try {
        const { runDir } = await newRunDir(OUT, "-map");
        if (check) {
          const saved = await readMap();
          if (!saved) return text(`No ${MAP_FILE} yet. Call witness_map without check to create one.`);
          const d = await checkMap(saved.map, urlOr(url), runDir, defaultStorageState());
          if (!hasDrift(d)) return text(`${MAP_FILE} matches the app.`, { drift: false });
          const lines = [
            `${MAP_FILE} has drifted:`,
            ...d.addedPages.map((p) => `+ new page ${p}`),
            ...d.removedPages.map((p) => `- page gone: ${p}`),
            ...d.changedPages.flatMap((c) => [...c.added.map((a) => `+ ${c.path}: ${a}`), ...c.removed.map((r) => `- ${c.path}: ${r}`)]),
            ...d.staleFeatures.map((f) => `! "${f.name}" relies on missing ${f.missing.join(", ")}`),
          ];
          return text(lines.join("\n"), { drift: true, ...d });
        }
        const m = await buildMap({ url: urlOr(url), backend: backend(), workDir: runDir, runsDir: OUT, storageState: defaultStorageState(), log });
        await writeMap(m);
        return text(
          `Wrote ${MAP_FILE}: ${m.pages.length} page(s), ${m.features.length} feature(s).\n` +
            m.features.map((f) => `- ${f.name} (${f.page})${f.traps.length ? `: ${f.traps.join(" / ")}` : ""}`).join("\n"),
        );
      } catch (err) {
        return text(`Mapping failed: ${err instanceof Error ? err.message : err}`, undefined, true);
      }
    },
  );

  server.registerTool(
    "witness_auth",
    {
      title: "Sign in once and reuse it",
      description:
        `Have the agent log in to the running app, and if the judge confirms you're signed in, save the session to ${AUTH_FILE}. ` +
        "From then on witness_verify, witness_replay and witness_map start signed in, instead of logging in every run and crawling only the login page. " +
        "Write credentials as {{secret:NAME}}, e.g. 'Log in as {{secret:USER}} with password {{secret:PASSWORD}}'.",
      inputSchema: {
        goal: z.string().describe("How to log in, with {{secret:NAME}} placeholders for credentials"),
        url: z.string().optional(),
      },
    },
    async ({ goal, url }) => {
      try {
        const { report, runDir } = await runVerify(`${goal}\nThe goal is only to end up signed in. Once you are, call finish.`, {
          url: urlOr(url), backend: backend(), maxSteps: 20, outDir: OUT, saveStateTo: AUTH_FILE, log,
        });
        const ok = report.verdict.verdict === "pass";
        return text(
          (ok ? `Signed in, and the session is saved to ${AUTH_FILE}. Later runs start signed in.\n\n` : "Not signed in; nothing was saved.\n\n") +
            formatVerdict(report, runDir),
          { signedIn: ok, authFile: ok ? AUTH_FILE : null },
          !ok,
        );
      } catch (err) {
        return text(`Sign-in failed: ${err instanceof Error ? err.message : err}`, undefined, true);
      }
    },
  );

  server.registerTool(
    "witness_replays",
    {
      title: "List saved replays",
      description: "List the goals that have been verified and saved as replays.",
      inputSchema: {},
    },
    async () => {
      const replays = await loadReplays([]);
      if (!replays.length) return text("No replays saved yet.");
      return text(
        replays.map(({ replay: r }) => `- ${r.name}: "${r.goal}" (${r.steps.length} steps, recorded ${r.recordedAt.slice(0, 10)})`).join("\n"),
        { replays: replays.map(({ replay: r }) => ({ name: r.name, goal: r.goal, recordedAt: r.recordedAt })) },
      );
    },
  );

  await server.connect(new StdioServerTransport());
  log("witness MCP server ready on stdio");
}
