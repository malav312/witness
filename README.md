# Witness

**Agents don't get to say "it works" without a witness.**

Witness is a verification harness for coding agents. You give it a goal in plain English and a running web app. It drives the real app in a browser, records everything, and has a separate judge decide from that evidence alone whether the goal is actually met.

```bash
witness verify "A user can add a task with the Add button and it survives a reload" --url http://localhost:4173
```

```
FAIL  Tasks are added, but they disappear after reload.
  ✓ Typing a title and clicking Add shows the task in the list  [#2, #3]
  ✓ The input clears after adding  [#3]
  ✗ The task is still there after a page reload  [#5]

evidence: .witness/runs/2026-11-22T.../report.html
```

## Why

Coding agents report success when the code compiles or the tests they wrote pass. Witness makes "done" mean *evidence*: screenshots, console errors, failed requests and a replayable trace, judged by a model that never saw the agent's reasoning.

## How it works

| Piece | What it does |
|---|---|
| **Driver** (`src/driver.ts`) | Claude agent loop with browser tools (snapshot, click, type, press, navigate, reload, screenshot). It exercises the goal like a user would and reports what it did, not whether it worked. |
| **Evidence** (`src/browser.ts`) | Every action gets a screenshot, the accessibility tree afterwards, and new console errors and failed requests. The whole run is captured as a Playwright trace. |
| **Judge** (`src/judge.ts`) | A separate model call that sees only the evidence. It breaks the goal into criteria, cites step numbers for each, and returns `pass` / `fail` / `inconclusive`. Missing evidence is never a pass. |
| **Report** (`src/report.ts`) | `report.json` for machines, `report.html` for humans, with "what the agent claimed" shown next to what the judge found. |

## Try it

```bash
npm install
npx playwright install chromium
export ANTHROPIC_API_KEY=...

# Terminal 1: demo app, optionally with bugs turned on
WITNESS_BUGS=no-persist npm run demo

# Terminal 2
./bin/witness.js verify "A user can add a task and it is still there after reloading"
```

Demo bugs (`demo/server.js`): `no-persist`, `dead-add`, `count-off`, `delete-wrong`, `empty-allowed`, `toggle-noop`, `clear-all`, `console-error`.

Exit codes: `0` pass, `1` fail, `2` inconclusive, `3` error, so it can gate CI or an agent's "done".

No-LLM smoke test of the browser and evidence layer: `npx tsx test/browser-smoke.ts`

## Roadmap

- [x] Phase 1: Driver, Judge, evidence bundle, demo app
- [ ] Replay: save passing runs as plain Playwright scripts; re-run without an LLM, and call the model only when a replay breaks
- [ ] Mapper: crawl an app into a Feature Map (`.witness/map.yaml`) the driver reads first
- [ ] MCP server and skill, so Claude Code, Cursor and others can call `witness_verify`
- [ ] Eval: catch rate and false-positive rate across every demo bug
- [ ] `witness refresh` and a GitHub Action

Inspired by Lauren Tan's ([@potetotes](https://x.com/potetotes)) "verification is infrastructure" approach to agent harnesses.
