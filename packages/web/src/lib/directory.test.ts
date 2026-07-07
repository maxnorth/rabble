import { describe, expect, it } from "vitest";
import type { AgentDirectoryRow } from "@rabblehq/core";
import { filterAndSortAgents } from "./directory";

const agent = (o: Partial<AgentDirectoryRow>): AgentDirectoryRow =>
  ({
    name: "X",
    slug: "x",
    domainName: null,
    evalScore: null,
    starred: false,
    myRight: null,
    scope: "personal",
    toolCount: 0,
    updatedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as unknown as AgentDirectoryRow;

const eng = agent({ name: "Eng On-Call", slug: "eng-on-call", domainName: "Engineering" });
const deploy = agent({ name: "Deploy Gate", slug: "deploy-gate", domainName: "Engineering", evalScore: 95, myRight: "admin", starred: true });
const docs = agent({ name: "Docs Writer", slug: "docs-writer", domainName: null, evalScore: 60 });
const all = [eng, deploy, docs];

const names = (rows: AgentDirectoryRow[]) => rows.map((r) => r.name);

describe("filterAndSortAgents", () => {
  it("searches name or slug, case-insensitively", () => {
    expect(names(filterAndSortAgents(all, { search: "deploy" }))).toEqual(["Deploy Gate"]);
    expect(names(filterAndSortAgents(all, { search: "ENG" }))).toEqual(["Eng On-Call"]);
    expect(names(filterAndSortAgents(all, { search: "-writer" }))).toEqual(["Docs Writer"]);
  });

  it("filters by domain, including 'none' for unfiled", () => {
    expect(names(filterAndSortAgents(all, { filters: { domain: "Engineering" } })).sort()).toEqual([
      "Deploy Gate",
      "Eng On-Call",
    ]);
    expect(names(filterAndSortAgents(all, { filters: { domain: "none" } }))).toEqual(["Docs Writer"]);
  });

  it("starred / you-own / eval≥90 filters", () => {
    expect(names(filterAndSortAgents(all, { filters: { starred: true } }))).toEqual(["Deploy Gate"]);
    // you-own is admin right only
    expect(names(filterAndSortAgents(all, { filters: { youOwn: true } }))).toEqual(["Deploy Gate"]);
    // 90 cutoff; a missing score counts as 0, not a pass
    expect(names(filterAndSortAgents(all, { filters: { evalAbove90: true } }))).toEqual(["Deploy Gate"]);
  });

  it("sorts by a key, reversible, and doesn't mutate the input", () => {
    const asc = names(filterAndSortAgents(all, { sortKey: "name", sortAsc: true }));
    expect(asc).toEqual(["Deploy Gate", "Docs Writer", "Eng On-Call"]);
    const desc = names(filterAndSortAgents(all, { sortKey: "name", sortAsc: false }));
    expect(desc).toEqual(["Eng On-Call", "Docs Writer", "Deploy Gate"]);
    // original array order untouched
    expect(names(all)).toEqual(["Eng On-Call", "Deploy Gate", "Docs Writer"]);
  });

  it("combines search + filter + sort", () => {
    const got = filterAndSortAgents(all, {
      filters: { domain: "Engineering" },
      sortKey: "name",
      sortAsc: true,
    });
    expect(names(got)).toEqual(["Deploy Gate", "Eng On-Call"]);
  });
});
