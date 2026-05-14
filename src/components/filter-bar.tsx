"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { PRIORITY_LABELS, AGENT_PREFIX, OWNER_PREFIX } from "@/types";

interface FilterBarProps {
  repos: { fullName: string }[];
  agents: string[];
  owners: string[];
  activeFilters: {
    repo: string;
    agent: string;
    owner: string;
    priority: string;
  };
}

export function FilterBar({ repos, agents, owners, activeFilters }: FilterBarProps) {
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
        title="Filters by agent/* label only"
        value={activeFilters.agent}
        onChange={(e) => updateFilter("agent", e.target.value)}
        className="h-9 px-3 rounded-md border border-input bg-background text-sm"
      >
        <option value="">All agent labels</option>
        {agents.map((a) => (
          <option key={a} value={a}>
            {a.replace(AGENT_PREFIX, "")}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by owner label"
        title="Filters by owner/* label only"
        value={activeFilters.owner}
        onChange={(e) => updateFilter("owner", e.target.value)}
        className="h-9 px-3 rounded-md border border-input bg-background text-sm"
      >
        <option value="">All owner labels</option>
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
    </div>
  );
}