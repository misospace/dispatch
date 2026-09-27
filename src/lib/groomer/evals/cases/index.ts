import type { GroomingCase } from "../types";
import { alreadyDoneCloses } from "./already-done-closes";
import { alreadyDoneGrounded } from "./already-done-grounded";
import { alreadyFixedOnMain } from "./already-fixed-on-main";
import { automationCommentFalseClaim } from "./automation-comment-false-claim";
import { broadNeedsDecomposition } from "./broad-needs-decomposition";
import { dependencyAlreadyMerged } from "./dependency-already-merged";
import { duplicateCandidate } from "./duplicate-candidate";
import { exactlyOneStatus, exactlyOneStatusForeignLabel } from "./exactly-one-status";
import { inFlightUntouched } from "./in-flight-untouched";
import { movedCodeReference } from "./moved-code-reference";
import { selfReinforcingDeferral } from "./self-reinforcing-deferral";
import { siblingShippedNotThisIssue } from "./sibling-shipped-not-this-issue";
import { unpinnedSnapshot } from "./unpinned-snapshot";
import { unresolvedArchitecture } from "./unresolved-architecture";
import { wellGroomedStaysUnchanged } from "./well-groomed-stays-unchanged";

export const CASES: GroomingCase[] = [
  // The eight scenarios #1068 requires.
  movedCodeReference,
  dependencyAlreadyMerged,
  alreadyFixedOnMain,
  duplicateCandidate,
  broadNeedsDecomposition,
  unresolvedArchitecture,
  wellGroomedStaysUnchanged,
  automationCommentFalseClaim,
  // Regressions from Dispatch history.
  selfReinforcingDeferral,
  alreadyDoneCloses,
  exactlyOneStatus,
  exactlyOneStatusForeignLabel,
  siblingShippedNotThisIssue,
  alreadyDoneGrounded,
  // Safety edges.
  inFlightUntouched,
  unpinnedSnapshot,
];
