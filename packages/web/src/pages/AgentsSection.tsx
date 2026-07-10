import type { AgentDirectoryRow, Domain } from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { AgentConfig } from "./AgentConfig";
import { relativeTime, count, AGENT_COLORS } from "../lib/time";
import {
  filterAndSortAgents,
  type SortKey,
  type DirectoryFilters,
} from "../lib/directory";

export function AgentsSection() {
  const { agentId, domainId } = useParams();
  const [showNew, setShowNew] = useState(false);
  const [showNewDomain, setShowNewDomain] = useState(false);
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });

  const favorites = (agents.data?.agents ?? []).filter((a) => a.starred);
  const recent = (agents.data?.agents ?? [])
    .filter((a) => !a.starred && a.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt! < a.lastUsedAt! ? -1 : 1))
    .slice(0, 3);

  return (
    <>
      <aside className="sidebar">
        <button className="btn" style={{ margin: "0 4px 12px" }} onClick={() => setShowNew(true)}>
          + New agent
        </button>
        {favorites.length === 0 && (
          <>
            <div className="sidebar-title">★ Favorites</div>
            <div
              className="sidebar-item"
              style={{ color: "var(--text-muted)", cursor: "default", fontSize: 12 }}
            >
              No favorites yet. Star agents in All agents to pin them here.
            </div>
          </>
        )}
        {favorites.length > 0 && (
          <>
            <div className="sidebar-title">★ Favorites</div>
            {favorites.map((a) => (
              <NavLink
                key={a.id}
                to={`/agents/${a.id}`}
                className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
              >
                <span
                  className="status-dot"
                  style={{
                    background: a.status === "active" ? "var(--green)" : "var(--amber)",
                  }}
                />
                <span className="label">
                  {a.name}
                  <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                    {a.scope} · {count(a.toolCount, "tool")}
                  </span>
                </span>
                <SidebarStar agent={a} />
              </NavLink>
            ))}
          </>
        )}
        {recent.length > 0 && (
          <>
            <div className="sidebar-title">Recent</div>
            {recent.map((a) => (
              <NavLink
                key={a.id}
                to={`/agents/${a.id}`}
                className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
              >
                <span
                  className="status-dot"
                  style={{
                    background: a.status === "active" ? "var(--green)" : "var(--amber)",
                  }}
                />
                <span className="label">
                  {a.name}
                  <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                    used {relativeTime(a.lastUsedAt)}
                  </span>
                </span>
                <SidebarStar agent={a} />
              </NavLink>
            ))}
          </>
        )}
        <div className="sidebar-title">Directory</div>
        <NavLink
          to="/agents"
          end
          className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
        >
          <span className="label">All agents</span>
        </NavLink>
        <div
          className="sidebar-title"
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
        >
          Domains
          <button
            title="Add domain"
            style={{ color: "var(--text-muted)", padding: "0 4px" }}
            onClick={() => setShowNewDomain(true)}
          >
            +
          </button>
        </div>
        {domains.data?.domains.map((d) => (
          <NavLink
            key={d.id}
            to={`/domains/${d.id}`}
            className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
          >
            <span className="label">{d.name}</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{d.agentCount}</span>
          </NavLink>
        ))}
      </aside>
      <main className="main-pane">
        {agentId ? (
          <AgentConfig agentId={agentId} />
        ) : domainId ? (
          <DomainDetail domainId={domainId} />
        ) : (
          <AgentDirectory />
        )}
      </main>
      {showNew && <NewAgentModal onClose={() => setShowNew(false)} />}
      {showNewDomain && <NewDomainModal onClose={() => setShowNewDomain(false)} />}
    </>
  );
}

function SidebarStar({ agent }: { agent: AgentDirectoryRow }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: async () =>
      agent.starred ? api.unstarAgent(agent.id) : api.starAgent(agent.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });
  return (
    <span
      className={`star-btn${agent.starred ? " starred" : ""}`}
      title={agent.starred ? "Unstar" : "Star to pin"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate();
      }}
    >
      {agent.starred ? "★" : "☆"}
    </span>
  );
}

type Filters = DirectoryFilters;

function AgentDirectory() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [filters, setFilters] = useState<Filters>({});
  const [filterOpen, setFilterOpen] = useState<false | "root" | "domain">(false);

  const rows = useMemo(
    () =>
      filterAndSortAgents(agents.data?.agents ?? [], {
        search,
        filters,
        sortKey,
        sortAsc,
      }),
    [agents.data, search, sortKey, sortAsc, filters],
  );

  const toggleStar = useMutation({
    mutationFn: async (agent: AgentDirectoryRow) =>
      agent.starred ? api.unstarAgent(agent.id) : api.starAgent(agent.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });

  const header = (key: SortKey, label: string) => (
    <th
      onClick={() => {
        if (sortKey === key) setSortAsc(!sortAsc);
        else {
          setSortKey(key);
          setSortAsc(true);
        }
      }}
    >
      {label}
      {sortKey === key ? (sortAsc ? " ↑" : " ↓") : ""}
    </th>
  );

  const activeChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (filters.domain) {
    activeChips.push({
      key: "domain",
      label: `Domain: ${filters.domain === "none" ? "No domain" : filters.domain}`,
      clear: () => setFilters((f) => ({ ...f, domain: undefined })),
    });
  }
  if (filters.starred) {
    activeChips.push({
      key: "starred",
      label: "Starred",
      clear: () => setFilters((f) => ({ ...f, starred: undefined })),
    });
  }
  if (filters.youOwn) {
    activeChips.push({
      key: "youOwn",
      label: "You own",
      clear: () => setFilters((f) => ({ ...f, youOwn: undefined })),
    });
  }
  if (filters.evalAbove90) {
    activeChips.push({
      key: "eval",
      label: "Eval ≥ 90%",
      clear: () => setFilters((f) => ({ ...f, evalAbove90: undefined })),
    });
  }
  if (filters.needsAttention) {
    activeChips.push({
      key: "needsAttention",
      label: "Needs attention",
      clear: () => setFilters((f) => ({ ...f, needsAttention: undefined })),
    });
  }

  return (
    <div className="content-col" style={{ maxWidth: 980 }}>
      <h1 className="page-title">All agents</h1>
      <p className="page-subtitle">
        The org's agent directory. Eval scores and grants tell you whether to
        rely on an agent you didn't build.
      </p>
      <div className="filter-bar">
        <input
          placeholder="Search agents…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
        <div style={{ position: "relative" }}>
          <button
            className="btn"
            onClick={() => setFilterOpen(filterOpen ? false : "root")}
          >
            + Filter
          </button>
          {filterOpen === "root" && (
            <div className="filter-popup">
              <button onClick={() => setFilterOpen("domain")}>
                Domain <span style={{ color: "var(--text-muted)" }}>▸</span>
              </button>
              <button
                onClick={() => {
                  setFilters((f) => ({ ...f, starred: true }));
                  setFilterOpen(false);
                }}
              >
                Starred
              </button>
              <button
                onClick={() => {
                  setFilters((f) => ({ ...f, youOwn: true }));
                  setFilterOpen(false);
                }}
              >
                You own
              </button>
              <button
                onClick={() => {
                  setFilters((f) => ({ ...f, evalAbove90: true }));
                  setFilterOpen(false);
                }}
              >
                Eval ≥ 90%
              </button>
              <button
                onClick={() => {
                  setFilters((f) => ({ ...f, needsAttention: true }));
                  setFilterOpen(false);
                }}
              >
                Needs attention
              </button>
            </div>
          )}
          {filterOpen === "domain" && (
            <div className="filter-popup">
              <button
                onClick={() => {
                  setFilters((f) => ({ ...f, domain: "none" }));
                  setFilterOpen(false);
                }}
              >
                No domain
              </button>
              {domains.data?.domains.map((d) => (
                <button
                  key={d.id}
                  onClick={() => {
                    setFilters((f) => ({ ...f, domain: d.name }));
                    setFilterOpen(false);
                  }}
                >
                  {d.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {activeChips.map((chip) => (
          <span key={chip.key} className="filter-chip">
            {chip.label}
            <button onClick={chip.clear}>✕</button>
          </span>
        ))}
      </div>
      <table className="dir-table">
        <thead>
          <tr>
            <th style={{ width: 30 }} />
            {header("name", "Agent")}
            {header("domainName", "Domain")}
            {header("evalScore", "Eval score")}
            {header("updatedAt", "Last updated")}
            {header("toolCount", "Tools")}
            {header("scope", "Scope")}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} onClick={() => navigate(`/agents/${a.id}`)}>
              <td
                onClick={(e) => {
                  e.stopPropagation();
                  toggleStar.mutate(a);
                }}
              >
                <span className={`star-btn${a.starred ? " starred" : ""}`}>
                  {a.starred ? "★" : "☆"}
                </span>
              </td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      fontSize: 13,
                      background: "var(--surface-tool)",
                      border: "1px solid var(--border-1)",
                      color: AGENT_COLORS[a.color] ?? "var(--accent-text)",
                    }}
                  >
                    {a.icon || a.name[0]}
                  </span>
                  <span>
                    <span style={{ fontWeight: 500, color: "var(--text-1)", display: "block" }}>
                      {a.name}{" "}
                      {a.status === "draft" && <span className="chip amber">draft</span>}
                      {a.builtin && (
                        <span
                          className="chip purple"
                          title="Ships with the platform. Creates and configures agents conversationally"
                        >
                          built-in
                        </span>
                      )}
                      {a.needsAttention && (
                        <span
                          className="chip amber"
                          title="Open spot-check reviews or scope violations in the last 30 days. See the evals tab"
                        >
                          needs attention
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {a.description || <span className="mono">{a.slug}</span>}
                    </span>
                  </span>
                </div>
              </td>
              <td>{a.domainName ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
              <td>
                {a.evalScore !== null ? (
                  <span
                    className={`chip ${a.evalScore >= 90 ? "green" : a.evalScore >= 70 ? "blue" : "amber"}`}
                    title={`All-time pass rate across ${a.evalCount ?? 0} eval ${
                      (a.evalCount ?? 0) === 1 ? "result" : "results"
                    }. Stats › Eval performance shows windowed rates.`}
                  >
                    {a.evalScore}%
                  </span>
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>—</span>
                )}
              </td>
              <td style={{ color: "var(--text-muted)" }}>
                {relativeTime(a.updatedAt)}
                {a.updatedByEmail && (
                  <span
                    className="mono"
                    style={{ display: "block", fontSize: 10.5, color: "var(--text-label)" }}
                  >
                    {a.updatedByEmail}
                  </span>
                )}
              </td>
              <td>{a.toolCount}</td>
              <td>
                <span
                  className={`chip ${a.scope === "personal" ? "blue" : a.scope === "org-wide" ? "amber" : ""}`}
                >
                  {a.scope}
                </span>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: "var(--text-muted)", cursor: "default" }}>
                {agents.isLoading
                  ? "Loading…"
                  : "No agents match. Create one with + New agent."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p style={{ fontSize: 11.5, color: "var(--text-label)", marginTop: 12 }}>
        {rows.length} of {agents.data?.agents.length ?? 0} agents · click a row
        to configure · ★ pins to the sidebar
      </p>
    </div>
  );
}

function DomainDetail({ domainId }: { domainId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const grants = useQuery({
    queryKey: ["grants", "domain", domainId],
    queryFn: () => api.listGrants("domain", domainId),
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.listTeams });
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });

  const domain: Domain | undefined = domains.data?.domains.find((d) => d.id === domainId);
  const members = (agents.data?.agents ?? []).filter((a) => a.domainId === domainId);

  const removeDomain = useMutation({
    mutationFn: () => api.deleteDomain(domainId),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      navigate("/agents");
    },
  });

  if (!domain) return <div className="content-col" />;

  return (
    <div className="content-col">
      <h1 className="page-title">{domain.name}</h1>
      <p className="page-subtitle">
        Flat, optional collection of agents. Grants set here apply to every
        agent in the domain. The domain itself carries no inherent
        permissions.
      </p>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Agents in this domain
      </div>
      <div className="row-group" style={{ marginBottom: 24 }}>
        {members.map((a) => (
          <div
            className="row"
            key={a.id}
            style={{ cursor: "pointer" }}
            onClick={() => navigate(`/agents/${a.id}`)}
          >
            <span
              className="status-dot"
              style={{ background: a.status === "active" ? "var(--green)" : "var(--amber)" }}
            />
            <div className="grow">
              <div className="title">{a.name}</div>
              <div className="sub mono">{a.slug}</div>
            </div>
            {a.evalScore !== null && (
              <span
                className="chip blue"
                title={`All-time pass rate across ${a.evalCount ?? 0} eval ${
                  (a.evalCount ?? 0) === 1 ? "result" : "results"
                }.`}
              >
                {a.evalScore}%
              </span>
            )}
          </div>
        ))}
        {members.length === 0 && (
          <div className="row">
            <div className="sub">
              No agents yet. Assign one from its identity tab.
            </div>
          </div>
        )}
      </div>

      <GrantEditor
        targetType="domain"
        targetId={domainId}
        grants={grants.data?.grants ?? []}
        teams={teams.data?.teams ?? []}
        users={users.data?.users ?? []}
        onChanged={() =>
          void queryClient.invalidateQueries({ queryKey: ["grants", "domain", domainId] })
        }
      />

      <div style={{ marginTop: 28 }}>
        <button
          className="btn danger"
          onClick={() => {
            if (confirm(`Delete domain "${domain.name}"? Agents are kept.`)) {
              removeDomain.mutate();
            }
          }}
        >
          Delete domain
        </button>
      </div>
    </div>
  );
}

export function GrantEditor({
  targetType,
  targetId,
  grants,
  teams,
  users,
  onChanged,
}: {
  targetType: "agent" | "domain" | "model";
  targetId: string;
  grants: Array<{
    id: string;
    subjectType: string;
    subjectName: string;
    accessRight: string;
    viaDomain?: string | null;
  }>;
  teams: Array<{ id: string; name: string; isEveryone: boolean }>;
  users: Array<{ id: string; name: string }>;
  onChanged: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [right, setRight] = useState<"use" | "edit" | "admin">("use");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => {
      const [subjectType, subjectId] = subject.split(":") as ["user" | "team", string];
      return api.createGrant({
        subjectType,
        subjectId,
        accessRight: right,
        targetType,
        targetId,
      });
    },
    onSuccess: () => {
      setSubject("");
      setError(null);
      onChanged();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteGrant(id),
    onSuccess: onChanged,
    onError: (err) => setError(err instanceof Error ? err.message : "Failed"),
  });

  const rightSentence: Record<string, string> = {
    use: "can talk to it",
    edit: "can configure it",
    admin: "can manage access",
  };

  return (
    <>
      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Access
      </div>
      <div className="row-group">
        {grants.map((g) => (
          <div className="row" key={g.id}>
            <span className={`chip ${g.subjectType === "team" ? "purple" : "blue"}`}>
              {g.subjectType}
            </span>
            <div className="grow">
              <div className="title">{g.subjectName}</div>
              <div className="sub">
                {g.accessRight} · {rightSentence[g.accessRight]}
                {g.viaDomain ? ` · via domain ${g.viaDomain}` : ""}
              </div>
            </div>
            {!g.viaDomain && (
              <button className="btn danger" onClick={() => remove.mutate(g.id)}>
                Revoke
              </button>
            )}
          </div>
        ))}
        {grants.length === 0 && (
          <div className="row">
            <div className="sub">No grants yet. Access comes only from grants.</div>
          </div>
        )}
        <div className="row">
          <select value={subject} onChange={(e) => setSubject(e.target.value)} style={{ flex: 1 }}>
            <option value="">Choose who…</option>
            <optgroup label="Teams">
              {teams.map((t) => (
                <option key={t.id} value={`team:${t.id}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="People">
              {users.map((u) => (
                <option key={u.id} value={`user:${u.id}`}>
                  {u.name}
                </option>
              ))}
            </optgroup>
          </select>
          <div className="segmented">
            {(["use", "edit", "admin"] as const).map((r) => (
              <button key={r} className={right === r ? "active" : ""} onClick={() => setRight(r)}>
                {r}
              </button>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={!subject || add.isPending}
            onClick={() => add.mutate()}
          >
            + Add
          </button>
        </div>
      </div>
      {error && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
    </>
  );
}

function NewAgentModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createAgent({ name }),
    onSuccess: async ({ agent }) => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      onClose();
      navigate(`/agents/${agent.id}`);
    },
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New agent</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="field">
            <label>Name</label>
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Eng On-Call"
            />
            <span className="hint">
              Agents start as drafts and run only for you until shared.
            </span>
          </div>
          {create.isError && (
            <p className="error-text">{(create.error as Error).message}</p>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={create.isPending}>
              Create draft
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function NewDomainModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createDomain(name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      onClose();
    },
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add domain</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="field">
            <label>Name</label>
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Engineering"
            />
            <span className="hint">
              Natural-cased single word. Domains are flat and carry grants.
            </span>
          </div>
          {create.isError && (
            <p className="error-text">{(create.error as Error).message}</p>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={create.isPending}>
              + Add
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
