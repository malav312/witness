// The Judge: decides pass/fail from recorded evidence only.
// It never sees the Driver's reasoning or its summary, so the agent that did
// the work can't grade its own homework.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { StepRecord } from "./browser.js";
import { MODEL, client, requestDefaults } from "./claude.js";

export const Verdict = z.object({
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  summary: z.string().describe("One or two sentences a developer can act on"),
  criteria: z.array(
    z.object({
      criterion: z.string().describe("One concrete, checkable claim implied by the goal"),
      status: z.enum(["met", "not_met", "not_tested"]),
      evidence_steps: z.array(z.number().int()).describe("Step numbers that support this status"),
      note: z.string(),
    }),
  ),
  problems: z.array(z.string()).describe("Anything wrong that was observed, including issues outside the goal"),
});
export type Verdict = z.infer<typeof Verdict>;

const SYSTEM = `You are the Judge in Witness, a verification harness. A separate agent operated a web app to exercise a goal. You get only the recorded evidence: an action log with the page state after each step, console errors, failed requests, and screenshots.

Decide whether the evidence PROVES the goal is met.
- Break the goal into concrete criteria, including the ones a user would implicitly expect (for example "add a task" implies it appears in the list and the input clears).
- A criterion is "met" only if a specific step shows it. Cite step numbers.
- If the log never exercised a criterion, mark it "not_tested". Missing evidence is not a pass.
- verdict: "pass" only if every criterion is met. "fail" if any criterion is contradicted by evidence. Otherwise "inconclusive".
- Uncaught errors or failed requests during the flow are problems even if the UI looked fine.
Be skeptical and precise.`;

const MAX_IMAGES = 8;

function pickScreens(steps: StepRecord[]): StepRecord[] {
  // Prefer moments that matter: reloads, navigations, explicit screenshots,
  // failures, errors. Always include the final state.
  const key = steps.filter(
    (s) => ["reload", "navigate", "screenshot"].includes(s.action) || !s.ok || s.consoleErrors.length,
  );
  const last = steps.at(-1);
  const chosen = new Map<number, StepRecord>();
  for (const s of [...key.slice(-(MAX_IMAGES - 1)), ...(last ? [last] : [])]) chosen.set(s.index, s);
  return [...chosen.values()].sort((a, b) => a.index - b.index);
}

export async function judge(
  runDir: string,
  goal: string,
  steps: StepRecord[],
): Promise<{ verdict: Verdict; usage: { input: number; output: number } }> {
  const log = steps
    .map((s) => {
      const lines = [`Step ${s.index}: ${s.action} ${JSON.stringify(s.input)} -> ${s.ok ? "ok" : "ERROR"}: ${s.result}`];
      lines.push(`  url: ${s.url}`);
      if (s.consoleErrors.length) lines.push(`  console errors: ${s.consoleErrors.join(" | ")}`);
      if (s.failedRequests.length) lines.push(`  failed requests: ${s.failedRequests.join(" | ")}`);
      if (s.snapshot) lines.push(`  page after:\n${s.snapshot.replace(/^/gm, "    ")}`);
      return lines.join("\n");
    })
    .join("\n\n");

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: `Goal:\n${goal}\n\nAction log:\n${log}` },
  ];
  for (const s of pickScreens(steps)) {
    const data = (await readFile(join(runDir, s.screenshot))).toString("base64");
    content.push({ type: "text", text: `Screenshot after step ${s.index} (${s.action}):` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  }

  const response = await client.beta.messages.parse({
    ...requestDefaults,
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "high", format: betaZodOutputFormat(Verdict) },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });

  const usage = { input: response.usage.input_tokens, output: response.usage.output_tokens };
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    return {
      verdict: {
        verdict: "inconclusive",
        summary: `Judge produced no verdict (stop_reason: ${response.stop_reason}).`,
        criteria: [],
        problems: [],
      },
      usage,
    };
  }
  return { verdict: response.parsed_output, usage };
}
