// What was actually tested. A verdict is only as good as knowing which code it
// was about: the checked-out commit can say one thing while the server serves
// a build from another (found on Uptime Kuma, where `git checkout` moved HEAD
// but dist/ still held the previous branch's build).
//
//   git    the commit, branch and uncommitted changes in the app's repo
//   build  a fingerprint of the JavaScript the browser actually loaded
//   warnings  e.g. the served JavaScript is older than the latest code change
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

export interface ScriptInfo {
  url: string; // path on the app's origin
  sha256: string;
  bytes: number;
  lastModified?: string; // the server's Last-Modified header, if any
  fromServiceWorker: boolean;
}

export interface BuildInfo {
  /** Hash of the scripts loaded by the first page; same build, same fingerprint. */
  fingerprint: string;
  scripts: ScriptInfo[];
  /** A service worker controlled the page at the end of the run. */
  serviceWorker: boolean;
}

export interface GitInfo {
  commit: string;
  branch: string; // "(detached)" when HEAD is detached
  dirty: string[]; // uncommitted files, Witness's own files excluded
  /** Latest code change: HEAD moving (checkout, commit) or an edit to an uncommitted frontend file. */
  changedAt: string;
  changedBy: string;
}

export interface Provenance {
  git?: GitInfo;
  build: BuildInfo;
  warnings: string[];
}

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Fingerprint for a set of scripts: order-independent, short. */
export const fingerprintOf = (scripts: ScriptInfo[]) =>
  scripts.length ? sha256(scripts.map((s) => s.sha256).sort().join("\n")).slice(0, 12) : "none";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const OWN_FILES = /^(\.witness\/|witness\.map\.yaml$)/;
// Uncommitted edits to these can change what the browser runs. Backend-only
// edits don't make a frontend build stale, so they don't count.
const FRONTEND = /\.(m?[jt]sx?|cjs|vue|svelte|astro|css|scss|sass|less|html?)$/i;

/** Git state of the repo containing `dir`, or undefined if it isn't one. */
export function gitInfo(dir = process.cwd()): GitInfo | undefined {
  try {
    const root = git(dir, "rev-parse", "--show-toplevel");
    const commit = git(root, "rev-parse", "--short", "HEAD");
    const branch = git(root, "branch", "--show-current") || "(detached)";
    // -z: NUL-separated, no quoting; a rename is "R  new\0old".
    const entries = execFileSync("git", ["status", "--porcelain", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
    const dirty: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      dirty.push(e.slice(3));
      if (e[0] === "R" || e[0] === "C") i++; // skip the old path
    }
    dirty.splice(0, dirty.length, ...dirty.filter((p) => !OWN_FILES.test(p)));

    // When HEAD last moved (a checkout also rewrites files, so it counts as a
    // code change even when the commit itself is old). Falls back to the commit time.
    let headMoved: number;
    try {
      headMoved = Number(git(root, "reflog", "-1", "--date=unix", "--format=%gd").match(/\{(\d+)\}/)![1]) * 1000;
    } catch {
      headMoved = Number(git(root, "log", "-1", "--format=%ct")) * 1000;
    }
    let changed = headMoved;
    let changedBy = `HEAD moved to ${commit}${branch === "(detached)" ? "" : ` (${branch})`}`;
    for (const p of dirty.filter((p) => FRONTEND.test(p))) {
      try {
        const m = statSync(join(root, p)).mtimeMs;
        if (m > changed) {
          changed = m;
          changedBy = `uncommitted edit to ${p}`;
        }
      } catch {
        // deleted file
      }
    }
    return { commit, branch, dirty, changedAt: new Date(changed).toISOString(), changedBy };
  } catch {
    return undefined;
  }
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost|.*\.test)$/;
// Last-Modified has one-second precision, and builds take a moment to write.
const SLACK_MS = 5000;

export function provenance(build: BuildInfo, code: GitInfo | undefined, appUrl: string): Provenance {
  const warnings: string[] = [];
  const stamps = build.scripts.map((s) => (s.lastModified ? Date.parse(s.lastModified) : NaN)).filter((t) => !isNaN(t));
  // Only for an app served from this machine: a deployed app has its own build.
  if (code && stamps.length && LOCAL.test(new URL(appUrl).hostname)) {
    const newest = Math.max(...stamps);
    if (newest < Date.parse(code.changedAt) - SLACK_MS) {
      warnings.push(
        `The app's JavaScript may be an old build: the newest script the server sent was last modified ${new Date(newest).toISOString()}, ` +
          `before the latest code change (${code.changedBy}, ${code.changedAt}). Rebuild or restart the app, then run again.`,
      );
    }
  }
  const fromSw = build.scripts.filter((s) => s.fromServiceWorker).length;
  if (fromSw) {
    warnings.push(`${fromSw} script(s) came from a service worker cache rather than the server, so they may be from an older build.`);
  }
  return { git: code, build, warnings };
}

/** One line: "code 33cd7c7 (fix/x) + 2 uncommitted · build 3f2a91c0b7de (4 scripts)". */
export function provenanceLine(p: Provenance): string {
  const code = p.git
    ? `code ${p.git.commit} ${p.git.branch === "(detached)" ? "(detached)" : `(${p.git.branch})`}` +
      (p.git.dirty.length ? ` + ${p.git.dirty.length} uncommitted` : "")
    : "code: not a git repo";
  const sw = p.build.serviceWorker ? " · service worker active" : "";
  return `${code} · build ${p.build.fingerprint} (${p.build.scripts.length} script${p.build.scripts.length === 1 ? "" : "s"})${sw}`;
}
