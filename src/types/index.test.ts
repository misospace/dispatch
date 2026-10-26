import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, STATUS_LABELS, StatusLabel, normalizePrFixType, PR_FIX_TYPE_PRIORITY, VALID_PR_FIX_TYPES } from "./index";

describe("BOARD_COLUMNS", () => {
  it("has exactly six columns", () => {
    expect(BOARD_COLUMNS).toHaveLength(6);
  });

  it("defines columns in canonical order", () => {
    const expected: StatusLabel[] = [
      "status/backlog",
      "status/ready",
      "status/in-progress",
      "status/in-review",
      "status/blocked",
      "status/done",
    ];
    expect(BOARD_COLUMNS.map((c) => c.id)).toEqual(expected);
  });

  it("provides human-readable titles", () => {
    const expectedTitles = [
      "Backlog",
      "Ready",
      "In Progress",
      "In Review",
      "Blocked",
      "Done",
    ];
    expect(BOARD_COLUMNS.map((c) => c.title)).toEqual(expectedTitles);
  });

  it("has unique column ids", () => {
    const ids = BOARD_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("STATUS_LABELS derivation", () => {
  it("is derived from BOARD_COLUMNS and stays in sync", () => {
    expect(STATUS_LABELS).toEqual(BOARD_COLUMNS.map((c) => c.id));
  });

  it("contains all six status labels", () => {
    const expected: StatusLabel[] = [
      "status/backlog",
      "status/ready",
      "status/in-progress",
      "status/in-review",
      "status/blocked",
      "status/done",
    ];
    expect(STATUS_LABELS).toEqual(expected);
  });
});

describe("REBASE PrFixType (#1327)", () => {
  it("normalizes rebase spellings to the REBASE type", () => {
    expect(normalizePrFixType("rebase")).toBe("REBASE");
    expect(normalizePrFixType("REBASE")).toBe("REBASE");
    expect(normalizePrFixType(" rebase ")).toBe("REBASE");
  });

  it("keeps legacy MERGE_CONFLICT rows valid", () => {
    expect(normalizePrFixType("MERGE_CONFLICT")).toBe("MERGE_CONFLICT");
  });

  it("outranks code work alongside MERGE_CONFLICT", () => {
    expect(VALID_PR_FIX_TYPES).toContain("REBASE");
    expect(PR_FIX_TYPE_PRIORITY.REBASE).toBe(0);
  });
});