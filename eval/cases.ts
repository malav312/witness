// The eval set: each goal is run against the clean demo app (should pass)
// and against every bug that breaks it (should fail). The harmless
// "new-heading" change checks that a cosmetic UI change is not a false alarm.

export interface EvalGoal {
  id: string;
  goal: string;
  /** Bugs that break this goal: Witness must return "fail". */
  breaks: string[];
  /** Changes that must NOT break it: Witness must return "pass". */
  harmless?: string[];
}

export const GOALS: EvalGoal[] = [
  {
    id: "add-persist",
    goal: "A user can add a task with the Add button and it is still there after reloading the page",
    breaks: ["no-persist", "dead-add", "console-error"],
    harmless: ["new-heading"],
  },
  {
    id: "delete",
    goal: "With two or more tasks in the list, deleting one removes exactly that task and leaves the others",
    breaks: ["delete-wrong"],
  },
  {
    id: "complete-count",
    goal: "Checking a task's checkbox marks it as done, and the 'items left' counter always matches the number of unfinished tasks",
    breaks: ["toggle-noop", "count-off"],
  },
  {
    id: "clear-completed",
    goal: "'Clear completed' removes only the tasks marked done and keeps the unfinished ones",
    breaks: ["clear-all"],
  },
  {
    id: "no-blank",
    goal: "Submitting an empty or whitespace-only task does not add anything to the list",
    breaks: ["empty-allowed"],
  },
];

export interface EvalCase {
  key: string;
  goalId: string;
  goal: string;
  bugs: string; // "" = clean app
  expected: "pass" | "fail";
  kind: "clean" | "bug" | "harmless";
}

export function expandCases(goals = GOALS): EvalCase[] {
  return goals.flatMap((g) => [
    { key: `${g.id}/clean`, goalId: g.id, goal: g.goal, bugs: "", expected: "pass" as const, kind: "clean" as const },
    ...g.breaks.map((b) => ({
      key: `${g.id}/${b}`, goalId: g.id, goal: g.goal, bugs: b, expected: "fail" as const, kind: "bug" as const,
    })),
    ...(g.harmless ?? []).map((b) => ({
      key: `${g.id}/${b}`, goalId: g.id, goal: g.goal, bugs: b, expected: "pass" as const, kind: "harmless" as const,
    })),
  ]);
}
