---
name: witness
description: Prove a web app change works by driving the running app in a real browser and getting an independent pass/fail verdict from recorded evidence. Use after changing user-facing behavior in a web app and before saying the work is done, when asked to "verify", "check it works", "test it in the browser" or "make sure nothing broke", or before committing UI changes. Needs the Witness MCP server (witness_verify, witness_replay, witness_map tools) and the app running locally.
---

# Witness: done means evidence

"It compiles" and "the tests I wrote pass" are not evidence that a user can do the thing. Witness drives the real app in a browser, records screenshots, accessibility trees, console errors and failed requests, and has a separate judge decide from that evidence alone. You don't grade your own work: the verdict does.

## When to use it

- You changed what a user can see or do in a web app: a feature, a fix, a form, a flow.
- Before you tell the user a UI change is done, or before you commit it.
- When the user asks you to check that something works, or that nothing broke.

Don't use it for pure refactors with no behavior change (use `witness_replay` for those), for backend-only code with no UI, or when the app isn't running.

## Workflow

1. **Make sure the app is running.** Start the dev server if needed, and pass its URL as `url` (or rely on `WITNESS_URL`).

2. **Write the goal as a user-visible outcome**, including what a user would implicitly expect:
   - Good: "A user can add a task with the Add button, the input clears, and the task is still there after reloading"
   - Good: "Submitting the signup form with an invalid email shows an error and does not create an account"
   - Bad: "Test the add feature" (no outcome to judge)
   - Bad: "The addTask function works" (not user-visible)

   For a bug fix, the goal is the behavior that was broken.

3. **Call `witness_verify`.** It takes about a minute.

4. **Act on the verdict.**
   - `pass`: done. Report the verdict and the evidence report path to the user. The run is saved as a replay automatically.
   - `fail`: not done. Read `problems` and the `not_met` criteria. They cite step numbers and usually point at the cause. Fix the code, then verify again with the same goal.
   - `inconclusive`: not done. Usually the goal was too vague or a criterion wasn't exercised. Make the goal more specific and verify again.

   Never describe a `fail` or `inconclusive` result as working. If you can't get to `pass`, tell the user what Witness found.

5. **Before you finish, call `witness_replay`** to re-check previously verified behavior. It takes about a second per replay and needs no LLM. If one diverges:
   - **You meant to change that UI:** call `witness_replay` with `heal: true`. It re-verifies, and re-records the replay if the goal still holds.
   - **You didn't mean to:** it's probably a regression. Look at the diff it shows.

## Feature Map

`witness_verify` reads `witness.map.yaml` automatically if it exists. If the app has several pages and no map yet, run `witness_map` once. After large UI changes, `witness_map` with `check: true` shows drift without using the model.

## Reporting to the user

Keep it short and lead with the verdict, for example:

> Witness: **PASS**. Adding a task works and it persists across a reload (6/6 criteria, steps 1–3). Evidence: `.witness/runs/…/report.html`

For a fail, say what was wrong, what you changed, and the final verdict.
