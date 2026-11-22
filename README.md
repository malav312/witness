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

## Replay: verify once with an agent, re-check for free

A passing `verify` is saved as a **replay**: the exact steps, plus the accessibility tree expected after each one. Replays run with no LLM, in about a second.

```bash
witness replay            # all saved replays, deterministic, no model calls
witness replay --heal     # on divergence, ask the agent again
witness export            # write them as plain Playwright tests
```

```
✗ a-user-can-add-a-task-with-the-add-button-and-it-is-still  diverged at step 0 (open): page differs from the recorded run
    + - heading "My tasks" [level=1]
    - - heading "Tasks" [level=1]
      - textbox "New task":
      …
  healing: re-verifying "A user can add a task with the Add button…" with the agent…
  HEALED  The app changed, but the goal still holds. Replay re-recorded.
```

A divergence doesn't automatically mean a bug. With `--heal`, Witness sends the goal back to the agent and the judge:
- **HEALED**: the UI changed but the goal still holds, so the replay is re-recorded.
- **REGRESSION**: the goal is broken, with a full evidence report.

The model is used only when something actually changed.

Replays find elements by role and accessible name (`getByRole("button", { name: "Add" })`), not CSS selectors, so they survive markup refactors. `witness export` turns each one into a standalone `@playwright/test` spec using `toMatchAriaSnapshot`, so you can run it in any CI without Witness.

## Eval: does it actually catch bugs?

```bash
npm run eval                                 # all cases
npm run eval -- --only add-persist,delete    # some goals
npm run eval -- --trials 3                   # repeat each case to measure variance
```

There are 5 goals (in `eval/cases.ts`), and each runs against 3 kinds of app:
- the clean demo app, where it should pass
- each bug that breaks the goal, where it should fail
- a harmless UI change, where it should still pass

That is 14 cases. The eval reports:
- **bug catch rate**
- **false alarm rate**
- accuracy, time and tokens
- **replay catch rate**: each passing clean recording replayed against every variant with no LLM

Results go to `.witness/evals/<id>/summary.md` and `results.json`, with a link to every run's evidence report.

## Why

Coding agents report success when the code compiles or the tests they wrote pass. Witness makes "done" mean *evidence*: screenshots, console errors, failed requests and a replayable trace, judged by a model that never saw the agent's reasoning.

## How it works

| Piece | What it does |
|---|---|
| **Driver** (`src/driver.ts`) | Claude agent loop with browser tools (snapshot, click, type, press, navigate, reload, screenshot). It exercises the goal like a user would and reports what it did, not whether it worked. |
| **Evidence** (`src/browser.ts`) | Every action gets a screenshot, the accessibility tree afterwards, and new console errors and failed requests. The whole run is captured as a Playwright trace. |
| **Judge** (`src/judge.ts`) | A separate model call that sees only the evidence. It breaks the goal into criteria, cites step numbers for each, and returns `pass` / `fail` / `inconclusive`. Missing evidence is never a pass. |
| **Replay** (`src/replay.ts`) | Saves passing runs as role/name-targeted steps with expected aria snapshots; replays them with a line diff on divergence; exports Playwright specs. |
| **Report** (`src/report.ts`) | `report.json` for machines, `report.html` for humans, with "what the agent claimed" shown next to what the judge found. |

## Try it

```bash
npm install
npx playwright install chromium

# Terminal 1: demo app, optionally with bugs turned on
WITNESS_BUGS=no-persist npm run demo

# Terminal 2
./bin/witness.js verify "A user can add a task and it is still there after reloading"
```

### Backends

| `--backend` | Uses | Notes |
|---|---|---|
| `claude-code` (default with no API key) | Your local Claude Code sign-in, e.g. a Claude subscription | Runs `claude -p` headless. Witness serves its browser tools to it over a local MCP server, so evidence is still recorded in-process. The judge opens screenshots with Claude Code's Read tool. |
| `api` (default when `ANTHROPIC_API_KEY` is set) | The Claude API | The agent loop runs inside Witness (`claude-opus-5-5` by default, override with `WITNESS_MODEL`). |

Demo bugs (`demo/server.js`): `no-persist`, `dead-add`, `count-off`, `delete-wrong`, `empty-allowed`, `toggle-noop`, `clear-all`, `console-error`. There is also `new-heading`, a harmless UI change for trying `--heal`.

Exit codes: `0` pass, `1` fail, `2` inconclusive, `3` error, so it can gate CI or an agent's "done".

No-LLM tests: `npx tsx test/browser-smoke.ts` (browser and evidence layer) and `npx tsx test/replay-smoke.ts` (replay matches the clean app and diverges at the right step on each bug).

## Roadmap

- [x] Phase 1: Driver, Judge, evidence bundle, demo app
- [x] Claude Code backend: run on a Claude subscription, with the browser tools served over MCP
- [x] Replay: passing runs re-run without an LLM, `--heal` calls the model only when a replay diverges, and export to Playwright tests
- [ ] Mapper: crawl an app into a Feature Map (`.witness/map.yaml`) the driver reads first
- [ ] Standalone MCP server and skill, so Claude Code, Cursor and others can call `witness_verify` directly
- [x] Eval: catch rate, false-alarm rate and no-LLM replay catch rate across every demo bug
- [ ] `witness refresh` and a GitHub Action

Inspired by Lauren Tan's ([@potetotes](https://x.com/potetotes)) "verification is infrastructure" approach to agent harnesses.
