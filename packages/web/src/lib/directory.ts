import type { AgentDirectoryRow } from "@rabblehq/core";

export type SortKey =
  | "name"
  | "domainName"
  | "evalScore"
  | "updatedAt"
  | "toolCount"
  | "scope";

export interface DirectoryFilters {
  domain?: string | "none";
  starred?: boolean;
  youOwn?: boolean;
  evalAbove90?: boolean;
}

export interface DirectoryView {
  search?: string;
  filters?: DirectoryFilters;
  sortKey?: SortKey;
  sortAsc?: boolean;
}

/**
 * The agents directory's search + filter + sort, as one pure function so
 * the behavior is testable independent of React. Search matches name or
 * slug; domain "none" means unfiled; "you own" means admin right; the eval
 * filter treats a missing score as 0. Sort is null-safe and reversible.
 */
export function filterAndSortAgents(
  agents: AgentDirectoryRow[],
  view: DirectoryView = {},
): AgentDirectoryRow[] {
  const { search = "", filters = {}, sortKey = "name", sortAsc = true } = view;
  let list = agents;

  if (search) {
    const q = search.toLowerCase();
    list = list.filter(
      (a) => a.name.toLowerCase().includes(q) || a.slug.includes(q),
    );
  }
  if (filters.domain === "none") list = list.filter((a) => !a.domainName);
  else if (filters.domain) list = list.filter((a) => a.domainName === filters.domain);
  if (filters.starred) list = list.filter((a) => a.starred);
  if (filters.youOwn) list = list.filter((a) => a.myRight === "admin");
  if (filters.evalAbove90) list = list.filter((a) => (a.evalScore ?? 0) >= 90);

  const dir = sortAsc ? 1 : -1;
  return [...list].sort((a, b) => {
    const va = a[sortKey] ?? "";
    const vb = b[sortKey] ?? "";
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}
