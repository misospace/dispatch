# Issue Execution Lane Classification

## Overview

Dispatch classifies synced GitHub issues into execution lanes to help queues and agents distinguish between normal local-worker tasks, elevated level tasks requiring higher-judgment support, and non-actionable backlog items.

Lane classification is stored as operational metadata in the `IssueLane` table. Multiple classifications may exist for an issue (history), with the most recent one used for routing decisions.

> **Dispatch remains generic.** This feature supports any agent/workflow, not a specific named agent. No hardcoded agent names, repo names, or owner names appear in classification prompts or logic.

---

## Lane Definitions

| Lane | Description |
|------|-------------|
| `normal` | Concrete, scoped, testable implementation work suitable for a normal/local worker. |
| `escalated` | Requires higher-judgment model support: architecture/security/API/auth boundary design, database/schema migration strategy, distributed/cross-service design, ambiguous product behavior, broad refactor planning, RFC/design/alternatives decisions, or audit parent decomposition. |
| `backlog` | Not actionable yet, placeholder, missing enough detail, or a parent/umbrella item with no direct work remaining. |

---

## Routing Rules

### Do NOT escalate for:
- Labels including `needs-escalation`, `escalated`, or `priority/p1` alone.
- Issues that came from an audit (unless they are broad parent/umbrella issues needing decomposition).

### DO escalate for:
- Broad audit parent/umbrella issues requiring decomposition/design.
- Architecture, security, API, or auth boundary design decisions.
- Database/schema migration strategy.
- Distributed/cross-service design.
- RFC/design/alternatives decisions.

### Default to `normal` for:
- Documentation updates.
- Tests, CI, lint changes.
- Release/version drift fixes.
- Bounded frontend/backend fixes with clear acceptance criteria.
- Concrete follow-up issues with implementation approaches already chosen.

### Default to `backlog` for:
- Issues where confidence is low and the issue is not actionable.
- Items explicitly marked as `status/backlog`.
- Research-type items (`type/research`).

---

## Custom Lane Configuration

Dispatch supports custom lane configurations that override the default `normal`, `escalated`, `backlog` lanes. This allows teams to use lane names that match their workflow terminology while maintaining compatibility with existing issue data.

### Configuring Custom Lanes

Custom lanes are configured via the `DISPATCH_LANE_CONFIG` environment variable, which accepts a JSON object:

```json
{
  "lanes": [
    {
      "id": "local",
      "title": "Local",
      "claimable": true,
      "role": "default",
      "color": "#4CAF50",
      "description": "Standard execution lane for concrete work."
    },
    {
      "id": "expert",
      "title": "Expert",
      "claimable": true,
      "role": "escalation",
      "color": "#FF9800",
      "description": "Higher-judgment tasks requiring expert review."
    },
    {
      "id": "parking-lot",
      "title": "Parking Lot",
      "claimable": false,
      "color": "#9E9E9E",
      "description": "Non-actionable items awaiting triage."
    }
  ]
}
```

### Lane Roles

Each lane configuration requires one of the following roles:

| Role | Required | Description |
|------|----------|-------------|
| `default` | Yes (exactly one) | The standard claimable lane for normal work. Equivalent to the default `normal` lane. |
| `escalation` | No | The lane for higher-judgment tasks. Equivalent to the default `escalated` lane. |
| *(none)* | Non-claimable lanes only | Non-claimable lanes (like backlog) do not need a role. |

### Migration Aliases

When deploying a custom lane configuration to an existing instance, issues may have `currentLane` values from the previous configuration. Migration aliases provide read-time compatibility by mapping old lane IDs to new configured lane IDs:

```json
{
  "lanes": [
    { "id": "local", "title": "Local", "claimable": true, "role": "default" },
    { "id": "parking-lot", "title": "Parking Lot", "claimable": false }
  ],
  "laneAliases": {
    "normal": "local",
    "escalated": "local",
    "backlog": "parking-lot"
  }
}
```

With this configuration:
- Issues with `currentLane: "normal"` are treated as if they're in `"local"`
- Issues with `currentLane: "escalated"` are treated as if they're in `"local"`
- Issues with `currentLane: "backlog"` are treated as if they're in `"parking-lot"`

### Unknown Lane Behavior

Issues with lane IDs that don't match any configured lane or alias are considered **unknown lanes**. These issues:

1. **Are NOT hidden** — they remain visible in issue listings and board views
2. Show an "Unknown: `<lane-id>`" badge on issue cards
3. Are tracked separately in the work summary API under `unknownLanes`
4. Are **never reclassified** by reconciliation (preserves data integrity)

### Important Notes

- **No data migration required**: Aliases work at read time. Existing issues retain their original `currentLane` values.
- **No automatic data rewriting**: Dispatch does not update issue `currentLane` values based on aliases.
- **Alias validation**: Aliases must point to currently configured lane IDs. An alias pointing to an unconfigured lane is rejected.
- **Default config**: If no custom configuration is set, Dispatch uses the default lanes (`normal`, `escalated`, `backlog`).

---

## Data Model

The `IssueLane` model stores classification metadata:

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (cuid) | Primary key |
| `issueId` | String | Reference to the Issue |
| `lane` | String | One of: `normal`, `escalated`, `backlog` |
| `confidence` | String | One of: `high`, `medium`, `low` |
| `reason` | String (TEXT) | Human-readable explanation for the classification |
| `model` | String (nullable) | Model or source that produced this classification (e.g., `"heuristic"`, `"litellm/self-hosted"`) |
| `judgedAt` | DateTime | Timestamp of classification |

---

## API Endpoints

### POST `/api/issues/[issueId]/lane` — Classify or reclassify an issue

Classifies an issue's execution lane. Requires Bearer token authentication via `DISPATCH_AGENT_TOKEN`.

**Request body:**
```json
{
  "force": true,
  "model": "litellm/self-hosted",
  "classification": {
    "lane": "normal",
    "confidence": "high",
    "reason": "Concrete bug fix with acceptance criteria"
  }
}
```

**Fields:**
- `force` (boolean, optional): When `true`, forces reclassification even if a lane already exists.
- `model` (string, optional): Name of the model/source for this classification.
- `classification` (object, optional): Pre-computed classification to store. If omitted, heuristic fallback is used.

**Response (success):**
```json
{
  "success": true,
  "lane": "normal",
  "confidence": "high",
  "reason": "Concrete bug fix with acceptance criteria",
  "model": "heuristic"
}
```

**Response (existing lane, no force):**
```json
{
  "success": true,
  "lane": "escalated",
  "confidence": "medium",
  "reason": "Architecture decision needed",
  "model": "litellm/self-hosted",
  "judgedAt": "2026-05-15T10:30:00Z",
  "reclassifyAvailable": true
}
```

### GET `/api/issues/[issueId]/lane` — Get current lane classification

Returns the most recent lane classification for an issue.

**Response:**
```json
{
  "lane": "normal",
  "confidence": "high",
  "reason": "Concrete implementation work",
  "model": "heuristic",
  "judgedAt": "2026-05-15T10:30:00Z"
}
```

---

## Classification Sources

### Model-backed classification (future)

When a model is available, the system can invoke it via a prompt that includes the issue title, body, labels, and state. The prompt is designed to be generic — no hardcoded agent names, repo names, or owner names.

### Heuristic fallback

When no model classification is provided, the system uses label-based heuristics:
- `status/backlog` or `type/research` → `backlog` (high confidence)
- Architecture/design/audit decomposition keywords → `escalated` (medium confidence)
- Everything else → `normal` (medium confidence)

---

## Error Handling

- Classification failures **must not** break issue sync.
- Invalid model responses are rejected with a 400 error and the reason for rejection.
- If the issue is not found in the local cache, a 404 is returned.
- Authentication failures return 401.

---

## Validation Rules

| Field | Valid Values | Constraints |
|-------|-------------|-------------|
| `lane` | Configured lane IDs (default: `normal`, `escalated`, `backlog`) | Must be a currently configured lane ID |
| `confidence` | `high`, `medium`, `low` | Must be one of the three confidence levels |
| `reason` | Any string | Required, non-empty, truncated to 500 characters |
| `model` | Any string or null | Optional |

When custom lanes are configured, the `lane` field accepts any configured lane ID. Migration aliases allow old lane IDs to be mapped to new configured lane IDs at read time.

---

## Testing

Tests cover:
- Valid lane parsing (`normal`, `escalated`, `backlog`)
- Invalid model response handling (rejects unknown lanes/confidences)
- Confidence validation
- Reason truncation to 500 characters
- Heuristic classification for various label combinations
- API endpoint auth, validation, and business logic

---

## Future Considerations

- **Model-backed classification**: Integrate with the inference system for model-driven lane assignment.
- **Bulk sync-time classification**: Add a batch classification endpoint for issue sync operations, rate-limited to avoid overwhelming downstream services.
- **Lane-based queue filtering**: Once queue endpoints are fully implemented, filter and rank issues by lane.
- **UI exposure**: Display lane classification on issue cards and detail/list rows in the frontend.
