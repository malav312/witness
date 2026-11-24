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
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { waitReady } from "./browser.js";

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
  // Session tokens: readable by you only.
  await writeFile(AUTH_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  await writeFile(AUTH_EXTRA_FILE, JSON.stringify(extra, null, 2), { mode: 0o600 });
}

const pageOrigin = (page: Page) => {
  try {
    return new URL(page.url()).origin;
  } catch {
    return "";
  }
};

/**
 * Does the saved session really sign in? Opens the app the way a run will, and
 * again with no session, and compares. Returns why not:
 *   "elsewhere"  the app sent us to another site, so it isn't signed in
 *   "doubtful"   it shows a password field, or looks exactly as it does signed
 *                out. Usually an unfinished sign-in, but a public home page
 *                looks like this too, so the user decides.
 */
export async function checkSignedIn(
  browser: Browser,
  url: string,
  state: BrowserContextOptions["storageState"],
  extra: AuthExtra,
): Promise<{ problem: "elsewhere" | "doubtful"; why: string } | undefined> {
  const open = async (signedIn: boolean) => {
    const context = await browser.newContext(signedIn ? { storageState: state } : {});
    try {
      if (signedIn) await restoreSessionStorage(context, extra);
      const page = await context.newPage();
      await page.goto(url);
      await waitReady(page);
      return {
        origin: pageOrigin(page),
        path: page.url(),
        password: (await page.locator("input[type=password]:visible").count()) > 0,
        aria: (await page.ariaSnapshot()).replace(/\d+/g, "#"),
      };
    } finally {
      await context.close();
    }
  };
  const now = await open(true);
  if (now.origin !== new URL(url).origin) return { problem: "elsewhere", why: `opening the app with this session went to ${now.origin}, probably a sign-in page` };
  if (now.password) return { problem: "doubtful", why: `opening the app with this session shows a password field at ${now.path}` };
  const out = await open(false);
  if (out.path === now.path && out.aria === now.aria) return { problem: "doubtful", why: `${now.path} looks exactly the same with this session as without it` };
}

/** Resolve when the user presses Enter; reject if the browser is closed first. */
export function waitForEnter(prompt: string, closed: Promise<unknown>): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<string>((resolve, reject) => {
    rl.question(prompt, (answer) => resolve(answer));
    closed.then(() => reject(new Error("The browser was closed before you pressed Enter, so nothing was saved.")));
  }).finally(() => rl.close());
}
