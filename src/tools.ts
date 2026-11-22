// The Driver's browser tools, defined once and shared by both backends:
// the Claude API loop (driver.ts) and Claude Code over MCP (mcp.ts).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BrowserSession } from "./browser.js";

const ref = z.string().describe("Element ref from the latest snapshot, e.g. e12");

export const TOOL_SPECS = {
  snapshot: {
    description: "Get the accessibility tree of the current page, with [ref=eN] markers you can target.",
    shape: {},
  },
  click: {
    description: "Click an element.",
    shape: { ref, element: z.string().describe("What you're clicking, in words") },
  },
  type: {
    description: "Replace the contents of a text field. Set submit=true to press Enter afterwards.",
    shape: { ref, text: z.string(), submit: z.boolean() },
  },
  press: {
    description: "Press a keyboard key on the focused element, e.g. Enter, Escape, Tab.",
    shape: { key: z.string() },
  },
  navigate: { description: "Go to a URL.", shape: { url: z.string() } },
  reload: { description: "Reload the page, e.g. to check that state persists.", shape: {} },
  screenshot: {
    description: "Look at the page visually. Use it when layout or visual state matters.",
    shape: {},
  },
  finish: {
    description:
      "End the session once you have exercised everything the goal describes, or when you are blocked. " +
      "Describe what you did and what you observed, not whether it 'works': a separate reviewer decides that.",
    shape: { status: z.enum(["exercised", "blocked"]), summary: z.string() },
  },
} satisfies Record<string, { description: string; shape: z.ZodRawShape }>;

export type ToolName = keyof typeof TOOL_SPECS;
export type FinishInput = { status: "exercised" | "blocked"; summary: string };

export const DRIVER_SYSTEM = `You are the Driver in Witness, a verification harness. You operate a real web app in a browser to exercise a goal a user describes.

How to work:
- Start with a snapshot. Target elements by their ref from the most recent snapshot; refs change after the page updates.
- Exercise the goal the way a real user would: use the visible controls (click buttons rather than only pressing Enter, if the goal implies a button).
- Look for evidence, not just the happy path. If the goal involves persistence, reload. If it involves counts, read the count. If you add, delete or toggle something, check the result in the next snapshot.
- If something doesn't behave as the goal describes, try once more a different way, then record what happened. Don't paper over it.
- Every action is screenshotted and logged automatically for a reviewer.
- Call finish when you're done. Your summary is a log of what you did and saw, not a verdict.`;

export interface ToolOutcome {
  text?: string;
  imageBase64?: string;
  isError: boolean;
  finish?: FinishInput;
}

/** Validate and run one tool call against the browser session. */
export async function runTool(
  session: BrowserSession,
  runDir: string,
  name: string,
  rawInput: unknown,
  log: (line: string) => void = () => {},
): Promise<ToolOutcome> {
  const spec = TOOL_SPECS[name as ToolName];
  const parsed = spec && z.object(spec.shape).safeParse(rawInput ?? {});
  if (!parsed?.success) return { text: `Invalid input for ${name}`, isError: true };
  const input = parsed.data as Record<string, any>;

  if (name === "finish") return { text: "Session ended.", isError: false, finish: input as FinishInput };
  if (name === "snapshot") return { text: await session.snapshot(), isError: false };
  if (name === "screenshot") {
    const step = await session.act("screenshot", {}, async () => "Screenshot taken");
    log(`  #${step.index} screenshot`);
    const imageBase64 = (await readFile(join(runDir, step.screenshot))).toString("base64");
    return { imageBase64, isError: false };
  }

  const target = input.ref ? await session.describe(input.ref) : undefined;
  if (input.ref && process.env.WITNESS_VIDEO) {
    // Demo recordings only: briefly outline what's about to be used. It's
    // removed before the action, so evidence screenshots stay clean.
    const el = session.page.locator(`aria-ref=${input.ref}`);
    await el.evaluate((n: HTMLElement) => { n.style.outline = "3px solid #e5534b"; n.style.outlineOffset = "2px"; }).catch(() => {});
    await session.page.waitForTimeout(700);
    await el.evaluate((n: HTMLElement) => { n.style.outline = ""; n.style.outlineOffset = ""; }).catch(() => {});
  }
  const step = await session.act(name, input, async (page) => {
    switch (name) {
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
  }, target);
  log(`  #${step.index} ${step.action} ${step.ok ? "" : "FAILED "}${step.result}`);

  const lines = [`${step.ok ? "OK" : "ERROR"}: ${step.result}`, `URL: ${step.url}`];
  if (step.consoleErrors.length) lines.push(`Console errors:\n${step.consoleErrors.join("\n")}`);
  if (step.failedRequests.length) lines.push(`Failed requests:\n${step.failedRequests.join("\n")}`);
  if (step.dialogs.length) lines.push(`Dialogs:\n${step.dialogs.join("\n")}`);
  lines.push(`Page after this step:\n${step.snapshot}`);
  return { text: lines.join("\n"), isError: !step.ok };
}
