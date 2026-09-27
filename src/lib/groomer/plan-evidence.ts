import type { EvidenceProvenance, GroomingEvidenceSnapshot } from "./evidence-snapshot";

/**
 * The citable view of a run's evidence snapshot.
 *
 * A GroomingPlan cites evidence by id. The ids come from this catalog, which
 * is built from the snapshot after exploration, rendered into the grooming
 * prompt, enum-constrained in the response schema, and checked by the plan
 * validator. An id that is not in the catalog is not evidence.
 *
 * Id formats:
 * - `issue`             the groomed issue's live title/body/labels
 * - `comment:<id>`      one issue comment (human or automation)
 * - `repo:<path>`       a repository path read or surfaced this run
 * - `github:<kind>:...` related GitHub work, using the snapshot's evidence key
 */

export type EvidenceSubject = "issue" | "comment" | "repository" | "related_work";

export interface EvidenceCatalogEntry {
  id: string;
  subject: EvidenceSubject;
  provenance: EvidenceProvenance;
  /** False only for automation-authored comments: context, never authority. */
  authoritative: boolean;
  /** Repository sources only: read at the snapshot's pinned head SHA. */
  pinned: boolean;
  /** Related work only: the GitHub state observed for it. */
  state: "open" | "closed" | "merged" | null;
  /** Short description for the prompt and for history. */
  label: string;
}

/** What a plan is bound to: the snapshot identity it was derived from. */
export interface GroomingPlanEvidenceBinding {
  evidenceDigest: string;
  issueFingerprint: string;
  headSha: string | null;
  pinnedRef: string | null;
  defaultBranch: string | null;
  capturedAt: string;
}

export interface EvidenceCatalog {
  binding: GroomingPlanEvidenceBinding;
  entries: EvidenceCatalogEntry[];
}

export const ISSUE_EVIDENCE_ID = "issue";

const MAX_LABEL_CHARS = 160;

function clip(value: string, max = MAX_LABEL_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function repositoryEvidenceId(path: string): string {
  return `repo:${path}`;
}

export function commentEvidenceId(commentId: string): string {
  return `comment:${commentId}`;
}

/**
 * Build the catalog from a snapshot. Deterministic: entries keep snapshot
 * order (issue, comments, then sources) and duplicate ids keep the first.
 */
export function buildEvidenceCatalog(snapshot: GroomingEvidenceSnapshot): EvidenceCatalog {
  const entries: EvidenceCatalogEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: EvidenceCatalogEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(entry);
  };

  push({
    id: ISSUE_EVIDENCE_ID,
    subject: "issue",
    provenance: "github_issue",
    authoritative: true,
    pinned: false,
    state: null,
    label: `this issue (#${snapshot.issue.number}): title, body and labels as captured`,
  });

  for (const comment of snapshot.comments) {
    const automation = comment.provenance === "automation_comment";
    push({
      id: commentEvidenceId(comment.id),
      subject: "comment",
      provenance: comment.provenance,
      authoritative: comment.authoritative,
      pinned: false,
      state: null,
      label: clip(
        `comment by ${comment.author}${comment.createdAt ? ` at ${comment.createdAt}` : ""} (${
          automation ? "automation: context only, never authority" : "human"
        })`,
      ),
    });
  }

  for (const source of snapshot.sources) {
    if (source.provenance === "repository") {
      const pinned = source.ref !== null && source.ref === snapshot.headSha;
      push({
        id: repositoryEvidenceId(source.path),
        subject: "repository",
        provenance: "repository",
        authoritative: true,
        pinned,
        state: null,
        label: clip(`repository path${pinned ? ` at ${source.ref!.slice(0, 12)}` : " (unpinned read)"}`),
      });
    } else {
      push({
        id: source.key,
        subject: "related_work",
        provenance: source.provenance,
        authoritative: true,
        pinned: false,
        state: source.state,
        label: clip(
          `${source.provenance.replace("github_", "").replace("_", " ")}${source.state ? `, ${source.state}` : ""} (GitHub state via ${source.via})`,
        ),
      });
    }
  }

  return {
    binding: {
      evidenceDigest: snapshot.evidenceDigest,
      issueFingerprint: snapshot.issueFingerprint,
      headSha: snapshot.headSha,
      pinnedRef: snapshot.pinnedRef,
      defaultBranch: snapshot.defaultBranch,
      capturedAt: snapshot.capturedAt,
    },
    entries,
  };
}

export function catalogIds(catalog: EvidenceCatalog, subject?: EvidenceSubject): string[] {
  return catalog.entries.filter((entry) => !subject || entry.subject === subject).map((entry) => entry.id);
}

/**
 * Render the catalog for the grooming prompt. Bounded by the catalog itself
 * (the snapshot caps sources and comments), one line per entry.
 */
export function renderEvidenceCatalog(catalog: EvidenceCatalog): string {
  const lines = catalog.entries.map((entry) => `- ${entry.id} — ${entry.label}`);
  const pin = catalog.binding.headSha
    ? `Repository reads are pinned to ${catalog.binding.headSha.slice(0, 12)} on ${catalog.binding.defaultBranch ?? "the default branch"}.`
    : "Repository reads this run are NOT pinned to a head SHA, so they cannot support a ready verdict.";
  return [
    "## Evidence you can cite",
    "",
    "Cite these ids, exactly as written, wherever the plan asks for evidenceRefs or a ref. No other id is valid.",
    pin,
    "",
    ...lines,
  ].join("\n");
}
