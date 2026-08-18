import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, STATUS_LABELS, StatusLabel } from "./index";

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