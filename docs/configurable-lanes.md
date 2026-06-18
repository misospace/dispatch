# Configurable Execution Lanes

## What Are Lanes?

Execution lanes categorize issues by the type of work they require and whether agents may claim them. Lanes determine:

- **Queue visibility**: Which issues appear in an agent's task queue
- **Claimability**: Whether a worker agent can pick up an issue for implementation
- **Classification routing**: Where heuristic or model-backed classification places new issues

Lanes are distinct from GitHub status labels (`status/backlog`, `status/ready`, etc.). Status labels control Kanban board columns; lanes control agent queue behavior. See [Status Labels vs Execution Lanes](#status-labels-vs-execution-lanes) for details.

For classification logic and routing rules, see [Issue Lane Classification](./issue-lane-classification.md).
For queue behavior and worker contracts, see [Worker Execution Contract](./worker-execution-contract.md).

---

## Default Lane Setup

Out of the box, Dispatch configures three lanes:

| ID | Title | Claimable | Role | Color | Description |
|----|-------|-----------|------|-------|-------------|
| `normal` | Normal | Yes | `default` | `#3b82f6` (blue) | Standard execution lane for concrete, scoped implementation work |
| `escalated` | Escalated | Yes | `escalation` | `#f97316` (orange) | Higher-judgment tasks: architecture, design, cross-service |
| `backlog` | Backlog | No | — | `#6b7280` (gray) | Not actionable yet; needs grooming before work can start |

This default configuration requires no environment variables. Issues are classified into these lanes during sync via heuristic or model-backed classification.

---

## Lane Configuration Fields

Each lane is defined as a `LaneConfig` object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique identifier (e.g., `"normal"`, `"local"`, `"frontier"`) |
| `title` | `string` | Yes | Human-readable display name shown in the UI |
| `claimable` | `boolean` | Yes | Whether worker agents may claim issues in this lane |
| `role` | `"default"` \| `"escalation"` | No | Heuristic classification hint (see [Lane Roles](#lane-roles)) |
| `description` | `string` | No | Human-readable description of the lane's purpose |
| `color` | `string` | No | Hex color for UI rendering (e.g., `"#4CAF50"`) |
| `defaultAgent` | `string` | No | Default agent that handles this lane |

### Lane Roles

Roles guide heuristic classification when the system needs to decide which lane an issue belongs to:

- **`role: "default"`** — The standard claimable lane. Issues with no special signals route here. Exactly one claimable lane should have this role.
- **`role: "escalation"`** — The lane for higher-judgment tasks. Issues with architecture, design, or cross-service signals route here. Optional; at most one claimable lane should have this role.
- **No role** — Non-claimable lanes (like backlog) do not need a role.

When `classifyLaneFromSignals()` runs:
1. Backlog signals → routes to the non-claimable lane (if configured), otherwise falls back to the default claimable lane
2. Escalation signals → routes to the lane with `role: "escalation"`, or falls back to the default claimable lane
3. No signals → routes to the lane with `role: "default"`, or the first claimable lane

---

## Configuration Examples

### Single Claimable Lane + Backlog

A minimal setup with one work lane and a backlog for non-actionable items:

```json
{
  "lanes": [
    {
      "id": "work",
      "title": "Work",
      "claimable": true,
      "role": "default",
      "color": "#3b82f6",
      "description": "Actionable issues ready for agent work."
    },
    {
      "id": "backlog",
      "title": "Backlog",
      "claimable": false,
      "color": "#6b7280",
      "description": "Not actionable yet. Needs grooming."
    }
  ]
}
```

With this setup, all claimable issues go to the `work` lane regardless of complexity. There is no escalation path — every actionable issue is treated the same.

### Three Claimable Lanes + Backlog

A setup that distinguishes between routine work, complex work, and review-only items:

```json
{
  "lanes": [
    {
      "id": "routine",
      "title": "Routine",
      "claimable": true,
      "role": "default",
      "color": "#22c55e",
      "description": "Standard implementation work for local workers."
    },
    {
      "id": "complex",
      "title": "Complex",
      "claimable": true,
      "role": "escalation",
      "color": "#f97316",
      "description": "Higher-judgment tasks requiring expert models."
    },
    {
      "id": "review",
      "title": "Review",
      "claimable": true,
      "color": "#a855f7",
      "description": "Issues awaiting human review before work begins."
    },
    {
      "id": "backlog",
      "title": "Backlog",
      "claimable": false,
      "color": "#6b7280",
      "description": "Not actionable yet."
    }
  ]
}
```

Here, `routine` is the default lane, `complex` handles escalation signals, and `review` is an additional claimable lane that classification does not route to automatically (no role). Issues in `review` would be placed there manually via the lane API.

### Custom Lane IDs

Lane IDs are arbitrary strings — they do not need to match `normal`, `escalated`, or `backlog`. Any non-empty string is valid:

```json
{
  "lanes": [
    { "id": "local", "title": "Local", "claimable": true, "role": "default" },
    { "id": "frontier", "title": "Frontier", "claimable": true, "role": "escalation" },
    { "id": "parking-lot", "title": "Parking Lot", "claimable": false }
  ]
}
```

---

## Migration Aliases (`laneAliases`)

When deploying a custom lane configuration to an existing instance, issues may have `currentLane` values from the previous configuration. Migration aliases provide **read-time compatibility** by mapping old lane IDs to new configured lane IDs:

```json
{
  "lanes": [
    { "id": "local", "title": "Local", "claimable": true, "role": "default" },
    { "id": "frontier", "title": "Frontier", "claimable": true, "role": "escalation" },
    { "id": "parking-lot", "title": "Parking Lot", "claimable": false }
  ],
  "laneAliases": {
    "normal": "local",
    "escalated": "frontier",
    "backlog": "parking-lot"
  }
}
```

With this configuration:
- Issues stored with `currentLane: "normal"` resolve to `"local"`
- Issues stored with `currentLane: "escalated"` resolve to `"frontier"`
- Issues stored with `currentLane: "backlog"` resolve to `"parking-lot"`

### Key Properties of Aliases

- **No data migration required**: Aliases work at read time. Existing issues retain their original `currentLane` values.
- **No automatic rewriting**: Dispatch does not update issue `currentLane` values based on aliases.
- **Validation**: Aliases must point to currently configured lane IDs. An alias pointing to an unconfigured lane is rejected at startup.
- **Request-time filtering**: The `?lane=` query parameter also resolves through aliases, so `?lane=normal` will match issues aliased to `local`.

### Safe Migration Example

Migrating from default lanes (`normal`, `escalated`, `backlog`) to custom names:

```json
{
  "lanes": [
    { "id": "local", "title": "Local", "claimable": true, "role": "default" },
    { "id": "frontier", "title": "Frontier", "claimable": true, "role": "escalation" },
    { "id": "parking-lot", "title": "Parking Lot", "claimable": false }
  ],
  "laneAliases": {
    "normal": "local",
    "escalated": "frontier",
    "backlog": "parking-lot"
  }
}
```

Deploy this configuration. All existing issues remain visible and correctly categorized through alias resolution. New classifications will use the new lane IDs (`local`, `frontier`, `parking-lot`). Over time, as issues are reclassified, the aliases become less relevant but remain harmless.

---

## Status Labels vs Execution Lanes

**Status labels and execution lanes serve different purposes. Do not confuse them.**

| Aspect | Status Labels | Execution Lanes |
|--------|--------------|-----------------|
| **Purpose** | Control Kanban board column placement | Control agent queue behavior and claimability |
| **Stored as** | GitHub labels on the issue (`status/ready`, etc.) | Dispatch database (`IssueLane.currentLane`) |
| **Modified by** | Drag-and-drop on the board, `POST /api/issues/move` | Classification API, sync pipeline |
| **Values** | `backlog`, `ready`, `in-progress`, `in-review`, `done` | Configurable: `normal`, `escalated`, `backlog` (default) |
| **Agent impact** | None directly — agents read queue from lanes | Determines whether an agent can claim the issue |

### Important Warning

An issue can be `status/ready` (on the Ready board column) but in the `backlog` execution lane (not claimable by agents). This is valid and expected:

- The issue has been groomed enough to move off the Backlog column
- But it has not yet been classified as actionable work for an agent
- The agent queue will **not** surface this issue until its lane is changed to a claimable lane

Similarly, an issue can be `status/in-progress` but in the `escalated` lane. This means:

- Someone is actively working on it (board shows In Progress)
- It requires higher-judgment model support (queue routes to escalation-capable agents)

---

## Queue APIs and Lane Filtering

Agent queue endpoints accept a `?lane=` query parameter to filter by execution lane:

```bash
# Get next task from the normal lane
GET /api/agents/{agentName}/next-task?lane=normal

# Get next task from any claimable lane (omit lane param)
GET /api/agents/{agentName}/next-task
```

The `lane` parameter:
- Accepts configured lane IDs and resolved aliases
- Returns 400 for unknown lane values
- Defaults to all claimable lanes when omitted
- Excludes non-claimable lanes (backlog) from the queue by default

For full queue behavior details, see [Worker Execution Contract](./worker-execution-contract.md).

---

## Classification and Reconciliation Behavior

When issues are synced or explicitly classified:

1. **Heuristic classification** uses label-based signals to determine the lane
2. **Model-backed classification** (when available) sends issue metadata to a model for routing decisions
3. **Lane reconciliation** ensures every issue has a valid lane value

The `classifyLaneFromSignals()` function in `src/lib/lane-config.ts` maps classification signals to configured lanes:

- `isBacklog: true` → routes to the non-claimable lane (if configured), falls back to default claimable
- `isEscalation: true` → routes to the escalation lane (if configured), falls back to default claimable
- Neither signal → routes to the default claimable lane

For classification routing rules and signal definitions, see [Issue Lane Classification](./issue-lane-classification.md).

---

## Unknown / Unconfigured Lane Visibility

Issues with lane IDs that do not match any configured lane or alias are considered **unknown lanes**. These issues:

1. **Are NOT hidden** — they remain visible in issue listings and board views
2. Display an `"Unknown: <lane-id>"` indicator in the UI
3. Are tracked separately in the work summary API under `unknownLanes`
4. Are **never reclassified** by reconciliation (preserves data integrity)

This behavior ensures no issues are silently lost when deploying a new lane configuration. If you see unknown lanes, add an alias or manually reclassify the affected issues.

---

## Configuring via Environment Variable

Custom lane configurations are set via the `DISPATCH_LANE_CONFIG` environment variable:

```bash
export DISPATCH_LANE_CONFIG='{"lanes":[{"id":"local","title":"Local","claimable":true,"role":"default","color":"#22c55e"},{"id":"frontier","title":"Frontier","claimable":true,"role":"escalation","color":"#f97316"},{"id":"parking-lot","title":"Parking Lot","claimable":false,"color":"#6b7280"}],"laneAliases":{"normal":"local","escalated":"frontier","backlog":"parking-lot"}}'
```

The value must be a valid JSON string matching the `LaneConfigSet` interface. Dispatch validates the configuration at startup and throws on errors:

- At least one lane is required
- All lane IDs must be unique and non-empty
- At least one claimable lane is required
- Aliases must point to configured lane IDs

If `DISPATCH_LANE_CONFIG` is not set, Dispatch uses the [default lane setup](#default-lane-setup).

---

## API Reference

### Lane Configuration Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/issues/[issueId]/lane` | `GET` | Get current lane classification for an issue |
| `/api/issues/[issueId]/lane` | `POST` | Classify or reclassify an issue |

### Queue Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents/{agentName}/next-task?lane=<id>` | `GET` | Fetch next task, optionally filtered by lane |
| `/api/agents/{agentName}/queue?lane=<id>` | `GET` | List queued issues, optionally filtered by lane |

---

## Further Reading

- [Issue Lane Classification](./issue-lane-classification.md) — Classification logic, routing rules, data model, and API details
- [Worker Execution Contract](./worker-execution-contract.md) — How agents consume lanes via the queue, PR fix queue precedence, and worker boundaries
