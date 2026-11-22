// The Driver: an agent loop that operates the real app in a browser to try
// to accomplish a goal. It does NOT decide whether the goal was met;
// that's the Judge's job, from evidence only.
//
// Two backends:
//   api          Claude API (ANTHROPIC_API_KEY), loop owned here
//   claude-code  headless Claude Code (your Claude subscription), tools over MCP
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { BrowserSession, StepRecord } from "./browser.js";
import { MODEL, client, requestDefaults } from "./claude.js";
import { runClaudeCode } from "./claude-code.js";
import { startToolServer } from "./mcp.js";
import { DRIVER_SYSTEM, TOOL_SPECS, runTool, type FinishInput } from "./tools.js";

export type Backend = "api" | "claude-code";

export interface DriverResult {
  status: "exercised" | "blocked" | "step_limit";
  summary: string;
  steps: StepRecord[];
  usage: { input: number; output: number };
}

interface DriveOptions {
  backend: Backend;
  maxSteps: number;
  log?: (line: string) => void;
}

const goalPrompt = (goal: string, url: string) =>
  `Goal to exercise:\n${goal}\n\nThe app is open at ${url}.`;

export function drive(session: BrowserSession, runDir: string, goal: string, opts: DriveOptions) {
  return opts.backend === "api"
    ? driveWithApi(session, runDir, goal, opts)
    : driveWithClaudeCode(session, runDir, goal, opts);
}

async function driveWithClaudeCode(
  session: BrowserSession,
  runDir: string,
  goal: string,
  opts: DriveOptions,
): Promise<DriverResult> {
  let finished: FinishInput | undefined;
  const server = await startToolServer(session, runDir, {
    log: opts.log,
    maxActions: opts.maxSteps,
    onFinish: (f) => (finished = f),
  });
  try {
    const result = await runClaudeCode({
      prompt: `${goalPrompt(goal, session.page.url())}\n\nUse only the witness tools.`,
      systemPrompt: DRIVER_SYSTEM,
      mcpUrl: server.url,
      tools: "",
      allowedTools: ["mcp__witness"],
    });
    const usage = { input: result.inputTokens, output: result.outputTokens };
    if (finished) return { ...finished, steps: session.steps, usage };
    return {
      status: result.hitTurnLimit ? "step_limit" : "blocked",
      summary: result.text || "Driver ended without calling finish.",
      steps: session.steps,
      usage,
    };
  } finally {
    await server.close();
  }
}

async function driveWithApi(
  session: BrowserSession,
  runDir: string,
  goal: string,
  opts: DriveOptions,
): Promise<DriverResult> {
  const log = opts.log ?? (() => {});
  const tools: Anthropic.Beta.BetaTool[] = Object.entries(TOOL_SPECS).map(([name, spec]) => ({
    name,
    description: spec.description,
    input_schema: z.toJSONSchema(z.object(spec.shape).strict()) as Anthropic.Beta.BetaTool["input_schema"],
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: goalPrompt(goal, session.page.url()) },
  ];
  const usage = { input: 0, output: 0 };

  for (let turn = 0; turn < opts.maxSteps; turn++) {
    const response = await client.beta.messages.create({
      ...requestDefaults,
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      system: DRIVER_SYSTEM,
      tools,
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
    let finished: FinishInput | undefined;
    for (const call of calls) {
      const out = await runTool(session, runDir, call.name, call.input, log);
      finished ??= out.finish;
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        is_error: out.isError,
        content: out.imageBase64
          ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: out.imageBase64 } }]
          : (out.text ?? ""),
      });
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
