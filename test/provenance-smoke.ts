// No-LLM test of "what was tested": the stale-build case from Uptime Kuma.
// A git repo serves a built dist/app.js with Last-Modified, the way a
// production server does. Switching branches without rebuilding must warn;
// rebuilding must clear the warning; replays must tell same build from new.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BrowserSession } from "../src/browser.ts";
import { gitInfo, provenance, provenanceLine } from "../src/provenance.ts";
import type { RunReport } from "../src/report.ts";
import { replayFromRun, runReplay } from "../src/replay.ts";

let failed = 0;
const expect = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};

const repo = mkdtempSync(join(tmpdir(), "witness-prov-"));
const runs = mkdtempSync(join(tmpdir(), "witness-prov-runs-"));
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" }).toString();

mkdirSync(join(repo, "src"));
mkdirSync(join(repo, "dist"));
writeFileSync(join(repo, ".gitignore"), "dist/\n");
writeFileSync(join(repo, "src/app.js"), "say('v1')\n");
const build = () => writeFileSync(join(repo, "dist/app.js"), readFileSync(join(repo, "src/app.js"), "utf8").replace("say", "document.body.append"));
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "v1");
build();

const PAGE = `<!doctype html><title>Prov</title><h1>Prov</h1><script src="/app.js"></script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/app.js") {
    const file = join(repo, "dist/app.js");
    res.writeHead(200, { "content-type": "text/javascript", "last-modified": statSync(file).mtime.toUTCString() });
    return res.end(readFileSync(file));
  }
  res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

async function look() {
  const s = new BrowserSession(mkdtempSync(join(runs, "s-")));
  await s.start(url);
  const b = await s.build();
  await s.stop();
  return provenance(b, gitInfo(repo), url);
}

try {
  const fresh = await look();
  expect(fresh.git?.branch === "main" && fresh.git.dirty.length === 0, `git state: ${provenanceLine(fresh)}`);
  expect(fresh.build.scripts.length === 1 && fresh.build.fingerprint !== "none", "the served script is fingerprinted");
  expect(fresh.warnings.length === 0, `a fresh build has no warning: ${fresh.warnings.join(" | ") || "none"}`);

  // Make the build old, then switch branches without rebuilding (the Kuma case).
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(repo, "dist/app.js"), past, past);
  git("checkout", "-q", "-b", "fix");
  writeFileSync(join(repo, "src/app.js"), "say('v2')\n");
  git("commit", "-q", "-am", "v2");
  const stale = await look();
  expect(stale.git?.branch === "fix", `now on the fix branch: ${provenanceLine(stale)}`);
  expect(stale.warnings.some((w) => w.includes("old build") && w.includes("HEAD moved")), `stale build is flagged: ${stale.warnings[0]?.slice(0, 110)}`);
  expect(stale.build.fingerprint === fresh.build.fingerprint, "same bundle served, same fingerprint");

  build();
  const rebuilt = await look();
  expect(rebuilt.warnings.length === 0, "rebuilding clears the warning");
  expect(rebuilt.build.fingerprint !== fresh.build.fingerprint, "a new build gets a new fingerprint");

  // An uncommitted backend edit doesn't make the frontend build stale; a frontend edit does.
  writeFileSync(join(repo, "server.py"), "print('backend')\n");
  utimesSync(join(repo, "dist/app.js"), past, past);
  writeFileSync(join(repo, "src/app.js"), "say('v3')\n");
  const edited = await look();
  expect(!!edited.git?.dirty.includes("src/app.js") && !!edited.git?.dirty.includes("server.py"), `dirty files listed: ${edited.git?.dirty}`);
  expect(edited.warnings.some((w) => w.includes("uncommitted edit to src/app.js")), "an uncommitted frontend edit newer than the build is flagged");

  // Replays: same build vs. a new build.
  build();
  const s = new BrowserSession(mkdtempSync(join(runs, "r-")));
  await s.start(url);
  const b = await s.build();
  await s.stop();
  const report = { id: "t", goal: "Open the page", url, steps: s.steps, provenance: provenance(b, gitInfo(repo), url) } as unknown as RunReport;
  const replay = replayFromRun(report);
  if ("error" in replay) throw new Error(replay.error);
  expect(replay.recordedWith?.build === b.fingerprint, `replay remembers the build it was recorded on: ${replay.recordedWith?.build}`);
  const same = await runReplay(replay, { url, runDir: mkdtempSync(join(runs, "p-")) });
  expect(same.status === "match" && same.sameBuild === true, `replay on the same build: ${same.status}, sameBuild=${same.sameBuild}`);
  writeFileSync(join(repo, "src/app.js"), "say('v4')\n");
  build();
  const other = await runReplay(replay, { url, runDir: mkdtempSync(join(runs, "q-")) });
  expect(other.sameBuild === false, `replay on a new build: ${other.status}, sameBuild=${other.sameBuild}`);
} finally {
  server.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(runs, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
