import { afterEach, describe, expect, it } from "vitest";
import { withUnroutableLaneAnnotations } from "./lane-annotation";
import { getIssuesByStatus } from "./kanban";
import { resetLaneConfig, setLaneConfig } from "@/lib/lane-config";

describe("withUnroutableLaneAnnotations", () => {
  afterEach(() => resetLaneConfig());

  it("flags issues whose currentLane is not in the configured lane set", () => {
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });

    const [stranded, configured, laneless] = withUnroutableLaneAnnotations([
      { currentLane: "normal", state: "open" },
      { currentLane: "local", state: "open" },
      { currentLane: null, state: "open" },
    ]);

    expect(stranded.unroutableLane).toEqual({ rawId: "normal" });
    expect(configured.unroutableLane).toBeNull();
    expect(laneless.unroutableLane).toBeNull();
  });

  it("does not flag alias-resolvable lanes — they stay routable at read time", () => {
    setLaneConfig({
      lanes: [{ id: "local", title: "Local", claimable: true }],
      laneAliases: { normal: "local" },
    });

    const [aliased] = withUnroutableLaneAnnotations([{ currentLane: "normal", state: "open" }]);

    expect(aliased.unroutableLane).toBeNull();
  });

  it("does not flag closed issues — Done display wins over lane state", () => {
    setLaneConfig({
      lanes: [{ id: "local", title: "Local", claimable: true }],
    });

    const [closed] = withUnroutableLaneAnnotations([
      { currentLane: "normal", state: "closed" },
    ]);

    expect(closed.unroutableLane).toBeNull();
  });

  it("flags case-variant lane ids (lane matching is exact, like the request filter)", () => {
    setLaneConfig({
      lanes: [{ id: "local", title: "Local", claimable: true }],
    });

    const [upper] = withUnroutableLaneAnnotations([{ currentLane: "LOCAL", state: "open" }]);

    expect(upper.unroutableLane).toEqual({ rawId: "LOCAL" });
  });

  it("excludes un-routable lane issues from the blocked count (#1590)", () => {
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });

    const annotated = withUnroutableLaneAnnotations([
      { id: "stranded", labels: ["status/blocked"], state: "open", currentLane: "normal" },
      { id: "real-blocked", labels: ["status/blocked"], state: "open", currentLane: "local" },
    ]);

    const routable = annotated.filter((issue) => issue.unroutableLane === null);
    expect(getIssuesByStatus(routable, "status/blocked").map((issue) => issue.id)).toEqual(["real-blocked"]);
  });

  it("keeps dependency-blocked issues on a configured lane in the blocked count", () => {
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });

    const annotated = withUnroutableLaneAnnotations([
      {
        id: "dep-blocked",
        labels: ["status/blocked"],
        state: "open",
        currentLane: "local",
        dependencyBlockReason: "Blocked by misospace/dispatch#1",
      },
    ]);

    expect(annotated[0].unroutableLane).toBeNull();
    expect(getIssuesByStatus(annotated, "status/blocked").map((issue) => issue.id)).toEqual(["dep-blocked"]);
  });
});
