// Saved logins. `witness auth "<goal>"` has the agent sign in; `witness auth
// --manual` opens a visible browser for you to sign in yourself, for single
// sign-on, MFA and anything else you wouldn't hand an agent a password for.
//
//   .witness/auth.json        Playwright storage state: cookies, localStorage, IndexedDB
//   .witness/auth-extra.json  what storage state can't hold: sessionStorage (where
//                             e.g. MSAL keeps tokens by default) and the sign-in
//                             sites seen while signing in, which later runs may load
//                             (silent token refresh happens in a frame on those sites)
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { BrowserContext } from "playwright";

export const AUTH_FILE = ".witness/auth.json";
export const AUTH_EXTRA_FILE = ".witness/auth-extra.json";

export interface AuthExtra {
  savedAt: string;
  appOrigin: string;
  /** Other origins pages were loaded from while signing in (the identity provider). */
  signInOrigins: string[];
  sessionStorage?: Record<string, string>;
}

/** Extra sign-in data saved next to `storageState`, if it is the default login file. */
export function readAuthExtra(storageState?: string): AuthExtra | undefined {
  if (!storageState || storageState !== AUTH_FILE || !existsSync(AUTH_EXTRA_FILE)) return;
  try {
    return JSON.parse(readFileSync(AUTH_EXTRA_FILE, "utf8"));
  } catch {
    return;
  }
}

/** Restore the saved sessionStorage in every new page on the app's origin. */
export async function restoreSessionStorage(context: BrowserContext, extra?: AuthExtra) {
  if (!extra?.sessionStorage || !Object.keys(extra.sessionStorage).length) return;
  await context.addInitScript(
    ({ origin, items }) => {
      // Only into an empty sessionStorage, so the app's own changes (a sign-out) survive reloads.
      if (location.origin !== origin || sessionStorage.length) return;
      for (const [k, v] of Object.entries(items)) sessionStorage.setItem(k, v);
    },
    { origin: extra.appOrigin, items: extra.sessionStorage },
  );
}

/** Warnings about a saved login: expired cookies mean runs may land on the sign-in page. */
export function authWarnings(storageState?: string, now = Date.now()): string[] {
  if (!storageState || !existsSync(storageState)) return [];
  let cookies: { name: string; domain: string; expires: number }[];
  try {
    cookies = JSON.parse(readFileSync(storageState, "utf8")).cookies ?? [];
  } catch {
    return [`The saved login ${storageState} can't be read. Sign in again with: witness auth --manual`];
  }
  // expires is in seconds; -1 is a session cookie, which never expires on its own here.
  const expiring = cookies.filter((c) => c.expires > 0);
  const expired = expiring.filter((c) => c.expires * 1000 <= now);
  if (!expired.length) return [];
  const names = expired.slice(0, 3).map((c) => `${c.name} (${c.domain})`).join(", ");
  const all = expired.length === expiring.length;
  return [
    `${all ? "All" : `${expired.length} of ${expiring.length}`} expiring cookies in the saved login ${storageState} have expired ` +
      `(${names}${expired.length > 3 ? ", …" : ""}). If the run lands on a sign-in page, sign in again with: witness auth --manual`,
  ];
}

/** Soonest expiry among the saved cookies, for telling the user how long a login lasts. */
export function soonestExpiry(cookies: { expires: number }[]): Date | undefined {
  const t = cookies.filter((c) => c.expires > 0).map((c) => c.expires * 1000);
  return t.length ? new Date(Math.min(...t)) : undefined;
}

export async function saveAuth(state: object, extra: AuthExtra) {
  await mkdir(dirname(AUTH_FILE), { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(state, null, 2));
  await writeFile(AUTH_EXTRA_FILE, JSON.stringify(extra, null, 2));
}

/** Resolve when the user presses Enter; reject if the browser is closed first. */
export function waitForEnter(prompt: string, closed: Promise<unknown>): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<void>((resolve, reject) => {
    rl.question(prompt, () => resolve());
    closed.then(() => reject(new Error("The browser was closed before you pressed Enter, so nothing was saved.")));
  }).finally(() => rl.close());
}
