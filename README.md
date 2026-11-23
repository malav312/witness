# Witness

**Agents don't get to say "it works" without a witness.**

Witness is a verification harness for coding agents. You give it a goal in plain English and a running web app. It drives the real app in a browser, records everything, and has a separate judge decide from that evidence alone whether the goal is actually met.

![Witness driving the demo app: adds a task, reloads, the task is gone, verdict FAIL](docs/demo.gif)

```bash
witness verify "A user can add a task with the Add button and it is still there after reloading the page"
```

```
FAIL  Clicking Add does add "Buy milk" and clears the input (step 2), but the task is gone after
      reloading (step 3 snapshot and screenshot show an empty list and "0 items left"). The same thing
      happens with Enter and "Walk dog" (steps 4–5), so tasks are not being saved.
  ✓ Typing a task and clicking the Add button adds it to the task list  [#1, #2]
  ✓ The input clears after adding  [#2]
  ✓ The items-left counter updates after adding  [#2]
  ✗ The added task is still in the list after reloading the page  [#3]
  ✗ The task persists whether it was added with Add or with Enter (consistency check)  [#4, #5]

evidence: .witness/runs/2026-11-22T21-14-10-236Z/report.html
```

<img src="docs/report.png" alt="Witness evidence report: FAIL verdict, criteria with step citations, what the agent said, and per-step screenshots" width="640">

## For coding agents: MCP server and skill

Witness is built to sit at the end of an agent's own task: the agent changes the code, Witness proves it. It runs as an MCP server:

```bash
claude mcp add witness -e WITNESS_URL=http://localhost:3000 -- node /path/to/witness/bin/witness.js mcp
```

| Tool | What it does |
|---|---|
| `witness_verify` | Drive the app to exercise a goal and return the judge's verdict, criteria, problems and evidence path. A pass is saved as a replay. |
| `witness_replay` | Re-check every verified goal with no LLM. `heal: true` re-verifies divergences. |
| `witness_map` | Build the Feature Map, or `check: true` to detect drift with no LLM. |
| `witness_auth` | Log in once, with `{{secret:NAME}}` credentials. Later runs start signed in. |
| `witness_replays` | List the verified goals. |

[`skills/witness/SKILL.md`](skills/witness/SKILL.md) is the playbook that goes with it. Copy it to `.claude/skills/witness/` in your project. It tells the agent:
- when to verify (after any user-facing change, before saying "done")
- how to write a goal (a user-visible outcome, not "test the add feature")
- that `fail` and `inconclusive` mean *not done*
- to run `witness_replay` before finishing

**Test drive.** I gave a fresh headless Claude Code session a copy of the demo app with a real typo bug: tasks saved under `witness-demo-todo` but loaded from `witness-demo-todos`. The prompt was only *"Users report that their tasks disappear after they reload the page… Fix it."* It never mentioned Witness. The session:

```
→ Glob, Read index.html, Read server.js
  "The save key is `witness-demo-todo` but load reads `witness-demo-todos`."
→ Edit index.html
→ Skill witness                         ← picked the skill up on its own
→ witness_verify "A user can add a task with the Add button, and after reloading the page the task is still in the list"
→ witness_replay
  "Witness: PASS. In a real browser, it added a task with the Add button, reloaded the page, and the task was
   still in the list. All 6 checks passed, with no console errors. Evidence: .witness/runs/…/report.html"
```

It also raised something on its own: tasks users saved under the old key won't come back by themselves, and it offered to migrate them.

## Tested on real open-source apps

Two agent sessions used Witness to fix four real open issues:
- [Actual Budget](https://github.com/actualbudget/actual), which runs entirely in the browser: [#3051](https://github.com/actualbudget/actual/issues/3051) and [#8972](https://github.com/actualbudget/actual/issues/8972)
- [Uptime Kuma](https://github.com/louislam/uptime-kuma), a full-stack app with Node, Socket.IO, SQLite and a login: [#7805](https://github.com/louislam/uptime-kuma/issues/7805) and [#7897](https://github.com/louislam/uptime-kuma/issues/7897)

Witness reproduced each bug as a FAIL before the fix. After the fix it gave PASS on three of them. On the fourth, #3051, it gave a false FAIL, because the Driver had no way to click empty space.

Those runs also exposed what breaks on real apps. All of these are fixed now, and each fix is checked again on the live Uptime Kuma instance:

| Found on a real app | Fix |
|---|---|
| The test password ended up in 29 report and replay files, and in file names | **Secrets**: goals use `{{secret:NAME}}`; values are typed for the agent and redacted everywhere. Re-test: 0 files. |
| Every run spent its first steps logging in, and the map crawled only the login page (2 pages) | **`witness auth`** saves a login once. Re-test: the map found 20 pages and 10 features. |
| Live counters (heartbeats, "31m") made every replay diverge, even right after a heal | **Live-data learning**: number-only changes are flagged, and `--heal` learns them as volatile. Re-test: 3/3 stable replays. |
| Element names with live numbers in them ("Heartbeat history: 18 checks") | Replays match those names with the numbers as wildcards |
| The agent couldn't click empty space, which caused #3051's false FAIL | **`click_at`** tool |
| The agent couldn't pick from `<select>` dropdowns | **`select_option`** tool |
| Goals with the same opening overwrote each other's replays, and heal left duplicates | Replay names get a short hash, and heal keeps the name |
| A run that hit the usage limit died with no evidence | Aborted runs are **INCONCLUSIVE**, keep their evidence, and write `progress.log` as they go |
| The branch said `master`, but the server still served the previous branch's build, so a manual test contradicted Witness | **What was tested**: every report records the commit and a fingerprint of the JavaScript the browser loaded, and warns when the served build is older than the code. See below. |

## Secrets and signing in

```bash
echo 'APP_USER=test-admin' >> .witness/secrets.env      # or WITNESS_SECRET_APP_USER=...
echo 'APP_PASS=...'        >> .witness/secrets.env
witness auth "Log in as {{secret:APP_USER}} with password {{secret:APP_PASS}}"
witness map                # now crawls the signed-in app
witness verify "Signed in, a user can create an MQTT monitor and it is still listed after a reload"
```

- **Goals refer to credentials by placeholder.** The Driver types `{{secret:APP_PASS}}`, Witness swaps in the value at the moment of typing, and every recorded artifact is redacted back to the placeholder: steps, snapshots, reports, replays, logs and file names.
- **Screenshots** black out any field holding a secret.
- **The Playwright trace is skipped** while secrets are configured, since it stores raw DOM values.
- **Exported tests** read secrets from `WITNESS_SECRET_*` at run time.
- **`witness auth`** keeps the login only if the Judge confirms you're signed in. The cookies go to `.witness/auth.json`, which is gitignored. Use `--no-auth` to ignore it.

## What was tested

A verdict is only as useful as knowing which code it was about. Every report has a **What was tested** section:

```
tested:   code 33cd7c7 (fix/mqtt-hostname) + 1 uncommitted · build 441701d9312e (1 script) · service worker active
  ⚠ The app's JavaScript may be an old build: the newest script the server sent was last modified 12:40,
    before the latest code change (HEAD moved to 33cd7c7, 12:52). Rebuild or restart the app, then run again.
```

- **code**: the commit, branch and uncommitted files in the repo Witness runs from.
- **build**: a hash of the scripts the first page loaded. The same build gives the same fingerprint, so you can tell two runs tested identical JavaScript.
- **Stale-build warning**: for an app on this machine, if the server's `Last-Modified` on its scripts is older than the latest code change (a checkout, a commit or an uncommitted frontend edit), the served build probably isn't the code you think you're testing.
- **Replays** remember the build they were recorded on. When one diverges on the same build, the cause is data, the backend or the environment, not the frontend code.

Witness starts every run in a fresh browser. A tab you already had open, or a service worker, can keep running an older build, so hard-reload before checking by hand.

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

**Live data.** If only the numbers on some lines changed, such as counters, timestamps or uptime %, the replay says so. `--heal` re-verifies the goal with the agent. If it still holds, it learns those lines as `volatile`: their numbers are masked from then on. Masking is per line, so a wrong count elsewhere is still caught. You can also add regexes to a replay's `ignore` list by hand.

A divergence doesn't automatically mean a bug. With `--heal`, Witness sends the goal back to the agent and the judge:
- **HEALED**: the UI changed but the goal still holds, so the replay is re-recorded.
- **REGRESSION**: the goal is broken, with a full evidence report.

The model is used only when something actually changed.

Replays find elements by role and accessible name (`getByRole("button", { name: "Add" })`), not CSS selectors, so they survive markup refactors. `witness export` turns each one into a standalone `@playwright/test` spec using `toMatchAriaSnapshot`, so you can run it in any CI without Witness.

## Feature Map: what the agent reads first

```bash
witness map           # crawl the app and write witness.map.yaml
witness map --check   # re-crawl and report drift, no LLM (exit 1 on drift)
```

The Mapper has two parts:
- A **deterministic crawl**: every same-origin page, its title, accessibility tree and controls.
- **One model call**: turns the crawl, plus the newest lesson per goal from past `verify` runs, into features. Each feature gets how to reach it, the controls it uses, what should happen, and *traps*, such as a setting on another page that changes behavior here.

Pages and controls in the map come from the crawl, not the model, so `--check` can diff them and name the features whose controls disappeared:

```
✗ witness.map.yaml has drifted from the app:
  + /: button "Add task"
  - /: button "Add"
  ! feature "Add a task" relies on missing button "Add"
```

`verify` gives the map to the Driver automatically when `witness.map.yaml` exists (`--no-map` to skip). The Judge never sees the map, so the verdict still rests on evidence only. The map is plain YAML, meant to be edited and committed. See [witness.map.yaml](witness.map.yaml) for the demo app's map.

Lessons from runs are written as things to check, with a date ("reload to confirm tasks persist; a run on 2026-11-22 found they did not"), never as facts. A bug that has since been fixed shouldn't become permanent lore.

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

### Latest results ([3 trials](docs/eval/2026-11-22-trials3.md) · [first run](docs/eval/2026-11-22.md))

| Metric | Result |
|---|---|
| Bug catch rate | **24/24 (100%)** |
| False alarm rate | **0/18 (0%)**, including a harmless UI change |
| Same verdict on all 3 trials | **14/14 cases** |
| No-LLM replay catch rate | **8/8 (100%)**, mean 1.3s per replay |
| Agent run | mean 41s, 9.8 browser actions |

These came from the `claude-code` backend (Claude Opus 5.5 on a Claude subscription), 3 trials per case, 42 agent runs in all. Verdicts never varied between trials; only the path did (for example, `clear-all` took 15–18 actions).

Every FAIL verdict named the actual bug, citing specific steps. Examples:
- *"clicking Delete 'Bravo' removed Charlie and left Bravo"*
- *"the counter is always one too high"*
- *"clicking Add threw an uncaught error … so the flow did not run cleanly"*, where the UI itself looked fine

**Caveats:**
- The demo bugs are deliberately clear-cut, and the same author wrote both the bugs and the goals.
- The next step is seeded bugs in a real app, plus subtler bugs such as race conditions and visual-only regressions.

## Why

Coding agents report success when the code compiles or the tests they wrote pass. Witness makes "done" mean *evidence*: screenshots, console errors, failed requests and a replayable trace, judged by a model that never saw the agent's reasoning.

## How it works

| Piece | What it does |
|---|---|
| **Driver** (`src/driver.ts`) | Claude agent loop with browser tools (snapshot, click, type, select_option, click_at, press, navigate, reload, screenshot). It exercises the goal like a user would and reports what it did, not whether it worked. |
| **Evidence** (`src/browser.ts`) | Every action gets a screenshot, the accessibility tree afterwards, new console errors, failed requests and dialogs. Dialogs are accepted the way a user would, and their text is kept. The whole run is captured as a Playwright trace. |
| **Judge** (`src/judge.ts`) | A separate model call that sees only the evidence. It breaks the goal into criteria, cites step numbers for each, and returns `pass` / `fail` / `inconclusive`. Missing evidence is never a pass. |
| **Mapper** (`src/map.ts`) | Crawls the app into a Feature Map for the Driver, and detects drift with no LLM. |
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

Demo bugs (`demo/server.js`): `no-persist`, `dead-add`, `count-off`, `delete-wrong`, `empty-allowed`, `toggle-noop`, `clear-all`, `console-error`. There are also two harmless changes: `new-heading`, for trying `--heal`, and `rename-add`, for trying `map --check`. The demo has a `/settings` page whose options change behavior on the task list.

Exit codes: `0` pass, `1` fail, `2` inconclusive, `3` error, so it can gate CI or an agent's "done".

`WITNESS_VIDEO=<dir>` records the browser session for demos (that's how `docs/demo.gif` was made). It briefly outlines each element before it's used, and removes the outline before the evidence screenshot.

No-LLM tests, run with `npm test`:
- `test/browser-smoke.ts`: the browser and evidence layer
- `test/replay-smoke.ts`: replay matches the clean app and diverges at the right step on each bug
- `test/map-smoke.ts`: the crawl and drift check
- `test/mcp-smoke.ts`: a real MCP client over stdio lists the tools and calls the ones that need no LLM
- `test/gaps-smoke.ts`: secrets, select_option, click_at, saved logins, live-data masking, unique replay names, and aborted runs

## Roadmap

- [x] Phase 1: Driver, Judge, evidence bundle, demo app
- [x] Claude Code backend: run on a Claude subscription, with the browser tools served over MCP
- [x] Replay: passing runs re-run without an LLM, `--heal` calls the model only when a replay diverges, and export to Playwright tests
- [x] Mapper: crawl the app into a Feature Map (`witness.map.yaml`) that the Driver reads first, with `--check` for drift
- [x] Standalone MCP server (`witness mcp`) and a Claude Code skill, so agents can verify their own work
- [x] Eval: catch rate, false-alarm rate and no-LLM replay catch rate across every demo bug
- [ ] `witness refresh` and a GitHub Action

Inspired by Lauren Tan's ([@poteto](https://github.com/poteto)) "verification is infrastructure" approach to agent harnesses.

## License

MIT. See [LICENSE](LICENSE).
