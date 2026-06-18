"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { PRIORITY_LABELS, AGENT_PREFIX, OWNER_PREFIX } from "@/types";
import { LABEL_FILTER_HELP } from "@/lib/issue-filters";

interface LaneOption {
  id: string;
  title: string;
  claimable: boolean;
}

interface FilterBarProps {
  repos: { fullName: string }[];
  agents: string[];
  owners: string[];
  lanes?: LaneOption[];
  activeFilters: {
    repo: string;
    agent: string;
    owner: string;
    priority: string;
    lane?: string;
  };
}

export function FilterBar({ repos, agents, owners, lanes, activeFilters }: FilterBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap gap-3 p-4 bg-muted/30 rounded-lg">
      <select
        value={activeFilters.repo}
        onChange={(e) => updateFilter("repo", e.target.value)}
        className="h-9 px-3 rounded-md border border-input bg-background text-sm"
      >
        <option value="">All Repos</option>
        {repos.map((r) => (
          <option key={r.fullName} value={r.fullName}>
            {r.fullName}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by agent label"
        title={LABEL_FILTER_HELP.agent}
        value={activeFilters.agent}
        onChange={(e) => updateFilter("agent", e.target.value)}
        className="h-9 px-3 rounded-md border border-input bg-background text-sm"
      >
        <option value="">All agent labels</option>
        {agents.length === 0 && (
          <option value="" disabled>
            No agent/* labels found
          </option>
        )}
        {agents.map((a) => (
          <option key={a} value={a}>
            {a.replace(AGENT_PREFIX, "")}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by owner label"
        title={LABEL_FILTER_HELP.owner}
        value={activeFilters.owner}
        onChange={(e) => updateFilter("owner", e.target.value)}
        className="h-9 px-3 rounded-md border border-input bg-background text-sm"
      >
        <option value="">All owner labels</option>
        {owners.length === 0 && (
          <option value="" disabled>
            No owner/* labels found
          </option>
        )}
        {owners.map((o) => (
          <option key={o} value={o}>
            {o.replace(OWNER_PREFIX, "")}
          </option>
        ))}
      </select>

      <select
        value={activeFilters.priority}
        onChange={(e) => updateFilter("priority", e.target.value)}
        className="h-9 px-3 rounded-md border border-input bg-background text-sm"
      >
        <option value="">All Priorities</option>
        {PRIORITY_LABELS.map((p) => (
          <option key={p} value={p}>
            {p.replace("priority/", "p")}
          </option>
        ))}
      </select>

      {lanes && lanes.length > 0 && (
        <select
          aria-label="Filter by execution lane"
          value={activeFilters.lane || ""}
          onChange={(e) => updateFilter("lane", e.target.value)}
          className="h-9 px-3 rounded-md border border-input bg-background text-sm"
        >
          <option value="">All Lanes</option>
          {lanes.map((l) => (
            <option key={l.id} value={l.id}>
              {l.title}{!l.claimable ? " (non-claimable)" : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
