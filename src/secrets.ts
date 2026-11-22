// Secrets: credentials the Driver must type without ever seeing them.
//
// Goals refer to them as {{secret:NAME}}. Values come from the environment
// (WITNESS_SECRET_NAME=...) or from .witness/secrets.env (NAME=value lines).
// The agent passes the placeholder through unchanged, Witness substitutes the
// value only at the moment of typing, and every recorded artifact (steps,
// snapshots, reports, replays, file names) is redacted back to the placeholder.
import { readFileSync } from "node:fs";

const PLACEHOLDER = /\{\{secret:([A-Za-z0-9_]+)\}\}/g;
export const SECRETS_FILE = ".witness/secrets.env";

let cache: Map<string, string> | undefined;

export function loadSecrets(): Map<string, string> {
  if (cache) return cache;
  const secrets = new Map<string, string>();
  try {
    for (const line of readFileSync(SECRETS_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trimStart().startsWith("#")) secrets.set(m[1].toUpperCase(), m[2].replace(/^(['"])(.*)\1$/, "$2"));
    }
  } catch {
    // no file: env only
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("WITNESS_SECRET_") && v) secrets.set(k.slice("WITNESS_SECRET_".length).toUpperCase(), v);
  }
  cache = secrets;
  return secrets;
}

/** For tests. */
export function resetSecrets() {
  cache = undefined;
}

/** Swap placeholders for real values. Only call this right before typing. */
export function resolveSecrets(text: string): string {
  const secrets = loadSecrets();
  return text.replace(PLACEHOLDER, (_, name: string) => {
    const value = secrets.get(name.toUpperCase());
    if (value === undefined) {
      throw new Error(`Unknown secret {{secret:${name}}}. Set WITNESS_SECRET_${name.toUpperCase()} or add it to ${SECRETS_FILE}.`);
    }
    return value;
  });
}

export const hasSecrets = (text: string) => new RegExp(PLACEHOLDER.source).test(text);

/** Replace any secret value with its placeholder. Longest values first, so overlapping secrets redact fully. */
export function redact(text: string): string {
  const entries = [...loadSecrets()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of entries) {
    out = out.split(value).join(`{{secret:${name}}}`);
    const encoded = encodeURIComponent(value); // also catch values echoed in URLs
    if (encoded !== value) out = out.split(encoded).join(`{{secret:${name}}}`);
  }
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
