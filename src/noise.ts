// Known-noise errors: console errors and failed requests the app always
// produces and that say nothing about the goal (an analytics script blocked by
// the corporate proxy, a missing favicon). They're left out of each step's
// evidence, so they don't fail goals or break replays, but they're counted and
// listed in the report, never silently dropped.
//
//   witness.ignore-errors.txt   one pattern per line; # comments. A line is a
//                               plain substring, or /regex/flags.
//   WITNESS_IGNORE_ERRORS       one more regex, e.g. "favicon\.ico|appinsights"
import { existsSync, readFileSync } from "node:fs";

export const IGNORE_FILE = "witness.ignore-errors.txt";

export interface IgnoreRule {
  pattern: string;
  test: (line: string) => boolean;
}

export interface IgnoredError {
  pattern: string;
  count: number;
  example: string;
}

function rule(pattern: string): IgnoreRule {
  const m = pattern.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    const re = new RegExp(m[1], m[2]);
    return { pattern, test: (l) => re.test(l) };
  }
  return { pattern, test: (l) => l.includes(pattern) };
}

export function loadIgnoreRules(file = IGNORE_FILE): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      try {
        rules.push(rule(line));
      } catch (err) {
        throw new Error(`Bad pattern in ${file}: ${line} (${err instanceof Error ? err.message : err})`);
      }
    }
  }
  const env = process.env.WITNESS_IGNORE_ERRORS?.trim();
  if (env) {
    try {
      rules.push(rule(`/${env}/`));
    } catch (err) {
      throw new Error(`Bad WITNESS_IGNORE_ERRORS regex: ${err instanceof Error ? err.message : err}`);
    }
  }
  return rules;
}

/** "ignored 3 known-noise errors: favicon.ico ×2, /appinsights/ ×1", or undefined. */
export function ignoredLine(ignored?: IgnoredError[]): string | undefined {
  if (!ignored?.length) return;
  const n = ignored.reduce((sum, e) => sum + e.count, 0);
  return `ignored ${n} known-noise error${n === 1 ? "" : "s"}: ${ignored.map((e) => `${e.pattern} ×${e.count}`).join(", ")}`;
}
