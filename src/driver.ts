// The Driver: an agent loop that operates the real app in a browser to try
// to accomplish a goal. It does NOT decide whether the goal was met;
// that's the Judge's job, from evidence only.
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BrowserSession, StepRecord } from "./browser.js";
import { MODEL, client, requestDefaults } from "./claude.js";

type Tool = Anthropic.Beta.BetaTool;

const strictObject = (properties: Record<string, unknown>): Tool["input_schema"] => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const ref = { type: "string", description: "Element ref from the latest snapshot, e.g. e12" };

const TOOLS: Tool[] = [
  {
    name: "snapshot",
    description: "Get the accessibility tree of the current page, with [ref=eN] markers you can target.",
    input_schema: strictObject({}),
  },
  {
    name: "click",
    description: "Click an element.",
    input_schema: strictObject({ ref, element: { type: "string", description: "What you're clicking, in words" } }),
  },
  {
    name: "type",
    description: "Replace the contents of a text field. Set submit=true to press Enter afterwards.",
    input_schema: strictObject({ ref, text: { type: "string" }, submit: { type: "boolean" } }),
  },
  {
    name: "press",
    description: "Press a keyboard key on the focused element, e.g. Enter, Escape, Tab.",
    input_schema: strictObject({ key: { type: "string" } }),
  },
  {
    name: "navigate",
    description: "Go to a URL.",
    input_schema: strictObject({ url: { type: "string" } }),
  },
  {
    name: "reload",
    description: "Reload the page, e.g. to check that state persists.",
    input_schema: strictObject({}),
  },
  {
    name: "screenshot",
    description: "Look at the page visually. Use it when layout or visual state matters.",
    input_schema: strictObject({}),
  },
  {
    name: "finish",
    description:
      "End the session once you have exercised everything the goal describes, or when you are blocked. " +
      "Describe what you did and what you observed, not whether it 'works': a separate reviewer decides that.",
    input_schema: strictObject({
      status: { type: "string", enum: ["exercised", "blocked"] },
      summary: { type: "string" },
    }),
  },
];

const Inputs = {
  snapshot: z.object({}),
  click: z.object({ ref: z.string(), element: z.string() }),
  type: z.object({ ref: z.string(), text: z.string(), submit: z.boolean() }),
  press: z.object({ key: z.string() }),
  navigate: z.object({ url: z.string() }),
  reload: z.object({}),
  screenshot: z.object({}),
  finish: z.object({ status: z.enum(["exercised", "blocked"]), summary: z.string() }),
};

const SYSTEM = `You are the Driver in Witness, a verification harness. You operate a real web app in a browser to exercise a goal a user describes.

How to work:
- Start with a snapshot. Target elements by their ref from the most recent snapshot; refs change after the page updates.
- Exercise the goal the way a real user would: use the visible controls (click buttons rather than only pressing Enter, if the goal implies a button).
- Look for evidence, not just the happy path. If the goal involves persistence, reload. If it involves counts, read the count. If you add, delete or toggle something, check the result in the next snapshot.
- If something doesn't behave as the goal describes, try once more a different way, then record what happened. Don't paper over it.
- Every action is screenshotted and logged automatically for a reviewer.
- Call finish when you're done. Your summary is a log of what you did and saw, not a verdict.`;

export interface DriverResult {
  status: "exercised" | "blocked" | "step_limit";
  summary: string;
  steps: StepRecord[];
  usage: { input: number; output: number };
}

export async function drive(
  session: BrowserSession,
  runDir: string,
  goal: string,
  opts: { maxSteps: number; log?: (line: string) => void },
): Promise<DriverResult> {
  const log = opts.log ?? (() => {});
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Goal to exercise:\n${goal}\n\nThe app is open at ${session.page.url()}.` },
  ];
  const usage = { input: 0, output: 0 };

  for (let turn = 0; turn < opts.maxSteps; turn++) {
    const response = await client.beta.messages.create({
      ...requestDefaults,
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      return { status: "blocked", summary: "Model declined the request.", steps: session.steps, usage };
    }

    // Append-only history: the assistant turn goes back exactly as received.
    messages.push({ role: "assistant", content: response.content });

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) {
      messages.push({ role: "user", content: "Keep going with the tools, or call finish." });
      continue;
    }
    if (response.stop_reason === "max_tokens") throw new Error("Driver output truncated (max_tokens)");

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let finished: z.infer<typeof Inputs.finish> | undefined;

    for (const call of calls) {
      const schema = Inputs[call.name as keyof typeof Inputs];
      const parsed = schema?.safeParse(call.input);
      if (!parsed?.success) {
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Invalid input for ${call.name}` });
        continue;
      }
      const input = parsed.data as Record<string, any>;

      if (call.name === "finish") {
        finished = input as z.infer<typeof Inputs.finish>;
        results.push({ type: "tool_result", tool_use_id: call.id, content: "Session ended." });
        continue;
      }
      if (call.name === "snapshot") {
        results.push({ type: "tool_result", tool_use_id: call.id, content: await session.snapshot() });
        continue;
      }
      if (call.name === "screenshot") {
        const step = await session.act("screenshot", {}, async () => "Screenshot taken");
        const data = (await readFile(join(runDir, step.screenshot))).toString("base64");
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
        });
        log(`  #${step.index} screenshot`);
        continue;
      }

      const step = await session.act(call.name, input, async (page) => {
        switch (call.name) {
          case "click":
            await page.locator(`aria-ref=${input.ref}`).click();
            return `Clicked ${input.element}`;
          case "type": {
            const el = page.locator(`aria-ref=${input.ref}`);
            await el.fill(input.text);
            if (input.submit) await el.press("Enter");
            return `Typed ${JSON.stringify(input.text)}${input.submit ? " and pressed Enter" : ""}`;
          }
          case "press":
            await page.keyboard.press(input.key);
            return `Pressed ${input.key}`;
          case "navigate":
            await page.goto(input.url);
            return `Navigated to ${input.url}`;
          case "reload":
            await page.reload();
            return "Reloaded";
        }
      });
      log(`  #${step.index} ${step.action} ${step.ok ? "" : "FAILED "}${step.result}`);

      const lines = [`${step.ok ? "OK" : "ERROR"}: ${step.result}`, `URL: ${step.url}`];
      if (step.consoleErrors.length) lines.push(`Console errors:\n${step.consoleErrors.join("\n")}`);
      if (step.failedRequests.length) lines.push(`Failed requests:\n${step.failedRequests.join("\n")}`);
      lines.push(`Page after this step:\n${step.snapshot}`);
      results.push({ type: "tool_result", tool_use_id: call.id, is_error: !step.ok, content: lines.join("\n") });
    }

    // All results for this turn go back in one user message.
    messages.push({ role: "user", content: results });
    if (finished) return { ...finished, steps: session.steps, usage };
  }

  return {
    status: "step_limit",
    summary: `Stopped after ${opts.maxSteps} turns without calling finish.`,
    steps: session.steps,
    usage,
  };
}
