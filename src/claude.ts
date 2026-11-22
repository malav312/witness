import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.WITNESS_MODEL ?? "claude-opus-5-5";

export const client = new Anthropic();

// If a request is declined by a safety classifier, the API re-runs it on a
// fallback model inside the same call instead of just stopping.
export const requestDefaults: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};
