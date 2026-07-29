// @vitest-environment node
// Regression test for #655: the four domain facades introduced by #618 must
// remain intentionally empty and must not re-export from `./github`. See
// #655 for the reconciliation decision.
import { describe, expect, it } from "vitest";
import * as Auth from "./github-auth";
import * as Ci from "./github-ci";
import * as CodeSearch from "./github-code-search";
import * as Issues from "./github-issues";

describe("github domain facades (regression for #655)", () => {
  const facades = [
    ["github-auth", Auth],
    ["github-ci", Ci],
    ["github-code-search", CodeSearch],
    ["github-issues", Issues],
  ] as const;

  it.each(facades)("%s has no named exports", (_name, mod) => {
    expect(Object.keys(mod).sort()).toEqual([]);
  });
});
