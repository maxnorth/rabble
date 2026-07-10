import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { count } from "../lib/time";

export function TeamsSection() {
  const { teamId } = useParams();
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.listTeams });
  const [showNew, setShowNew] = useState(false);

  const all = teams.data?.teams ?? [];
  const everyone = all.find((t) => t.isEveryone);
  const roots = all.filter((t) => !t.isEveryone && !t.parentTeamId);
  const childrenOf = (id: string) => all.filter((t) => t.parentTeamId === id);

  return (
    <>
      <aside className="sidebar">
        <button className="btn" style={{ margin: "0 4px 12px" }} onClick={() => setShowNew(true)}>
          + New team
        </button>
        {everyone && (
          <>
            <div className="sidebar-title">Org-wide</div>
            <NavLink
              to={`/teams/${everyone.id}`}
              className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
            >
              <span className="label">Everyone</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {everyone.memberCount}
              </span>
            </NavLink>
          </>
        )}
        <div className="sidebar-title">Teams</div>
        {roots.map((t) => (
          <div key={t.id}>
            <NavLink
              to={`/teams/${t.id}`}
              className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
            >
              <span className="label">{t.name}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t.memberCount}</span>
            </NavLink>
            {childrenOf(t.id).map((c) => (
              <NavLink
                key={c.id}
                to={`/teams/${c.id}`}
                className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
                style={{ paddingLeft: 26 }}
              >
                <span className="label">› {c.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{c.memberCount}</span>
              </NavLink>
            ))}
          </div>
        ))}
        {roots.length === 0 && (
          <div className="sidebar-item" style={{ color: "var(--text-muted)" }}>
            No teams yet
          </div>
        )}
      </aside>
      <main className="main-pane">
        {teamId ? (
          <TeamDetail key={teamId} teamId={teamId} />
        ) : (
          <TeamsOverview onNewTeam={() => setShowNew(true)} />
        )}
      </main>
      {showNew && <NewTeamModal onClose={() => setShowNew(false)} />}
    </>
  );
}

function TeamsOverview({ onNewTeam }: { onNewTeam: () => void }) {
  const navigate = useNavigate();
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.listTeams });
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });

  const all = teams.data?.teams ?? [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const regular = all.filter((t) => !t.isEveryone);
  // Roots first, each followed by its sub-teams (one level of nesting).
  const ordered = regular
    .filter((t) => !t.parentTeamId)
    .flatMap((t) => [t, ...regular.filter((c) => c.parentTeamId === t.id)]);

  return (
    <div className="content-col">
      <h1 className="page-title">Teams &amp; people</h1>
      <p className="page-subtitle">
        The RBAC backbone. Grants to a team cascade to its sub-teams and
        members; the pinned Everyone team reaches the whole org.
      </p>
      <div
        className="card"
        style={{
          padding: 12,
          marginBottom: 18,
          borderColor: "color-mix(in srgb, var(--blue) 40%, transparent)",
          fontSize: 12.5,
          color: "var(--text-dim)",
        }}
      >
        Access flows through teams, not individuals: grant an agent to{" "}
        <strong>Engineering</strong> and every sub-team inherits it. There are
        no owners anywhere, only grants.
      </div>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Teams
      </div>
      <div className="row-group" style={{ marginBottom: 22 }}>
        {ordered.map((t) => (
          <div
            className="row"
            key={t.id}
            style={{ cursor: "pointer", paddingLeft: t.parentTeamId ? 34 : undefined }}
            onClick={() => navigate(`/teams/${t.id}`)}
          >
            <div className="grow">
              <div className="title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {t.parentTeamId ? "› " : ""}
                {t.name}
                {t.parentTeamId && (
                  <span className="chip">
                    sub-team of {byId.get(t.parentTeamId)?.name ?? "?"}
                  </span>
                )}
              </div>
              <div className="sub">
                {count(t.memberCount, "member")}
                {t.domainGrantCount > 0 &&
                  ` · ${t.domainGrantCount} domain grant${t.domainGrantCount === 1 ? "" : "s"}`}
                {t.agentGrantCount > 0 &&
                  ` · ${t.agentGrantCount} agent grant${t.agentGrantCount === 1 ? "" : "s"}`}
              </div>
            </div>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>configure →</span>
          </div>
        ))}
        {ordered.length === 0 && (
          <div className="row">
            <div className="sub">No teams yet.</div>
            <button className="btn" onClick={onNewTeam}>
              + New team
            </button>
          </div>
        )}
      </div>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        People
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        {(users.data?.users ?? []).map((u) => (
          <div
            className="card"
            key={u.id}
            style={{ padding: 12, display: "flex", gap: 10, alignItems: "center" }}
          >
            <div
              className="rail-logo"
              style={{
                width: 34,
                height: 34,
                fontSize: 13,
                marginBottom: 0,
                background: u.role === "member" ? "var(--surface-tool)" : "var(--purple)",
              }}
            >
              {u.name
                .split(/\s+/)
                .map((p) => p[0])
                .slice(0, 2)
                .join("")
                .toUpperCase()}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="title" style={{ fontSize: 13 }}>
                {u.name}
              </div>
              <div
                className="sub mono"
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {u.email}
              </div>
            </div>
            <span className={`chip${u.role === "member" ? "" : " blue"}`} style={{ marginLeft: "auto" }}>
              {u.role}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type TeamTab = "members" | "sub-teams" | "agent access";

function TeamDetail({ teamId }: { teamId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["team", teamId],
    queryFn: () => api.getTeam(teamId),
  });
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  const [tab, setTab] = useState<TeamTab>("members");
  const [pickUser, setPickUser] = useState("");

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["team", teamId] });
  const addMember = useMutation({
    mutationFn: () => api.addTeamMember(teamId, pickUser),
    onSuccess: () => {
      setPickUser("");
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
  });
  const setRole = useMutation({
    mutationFn: ({ userId, teamRole }: { userId: string; teamRole: "lead" | "member" }) =>
      api.setTeamRole(teamId, userId, teamRole),
    onSuccess: refresh,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.removeTeamMember(teamId, userId),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
  });
  const removeTeam = useMutation({
    mutationFn: () => api.deleteTeam(teamId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
      navigate("/teams");
    },
  });

  if (!detail.data) return <div className="content-col" />;
  const { team, members, subTeams, access } = detail.data;
  const memberIds = new Set(members.map((m) => m.userId));
  const addable = (users.data?.users ?? []).filter((u) => !memberIds.has(u.id));

  return (
    <div className="content-col">
      <h1 className="page-title">{team.name}</h1>
      <p className="page-subtitle">
        {team.isEveryone
          ? "The pinned org-wide team. Every member of the org belongs here automatically."
          : `${count(team.memberCount, "member")} · grants cascade to sub-teams and members`}
      </p>

      <div className="tabs">
        {(subTeams.length > 0
          ? (["members", "sub-teams", "agent access"] as const)
          : (["members", "agent access"] as const)
        ).map((t) => (
          <button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "members" && (
        <div className="row-group">
          {members.map((m) => (
            <div className="row" key={m.userId}>
              <div className="grow">
                <div className="title">{m.name}</div>
                <div className="sub mono">{m.email}</div>
              </div>
              {!team.isEveryone && (
                <button
                  className={`chip ${m.teamRole === "lead" ? "purple" : ""}`}
                  title="Team label only. Access still comes from grants"
                  onClick={() =>
                    setRole.mutate({
                      userId: m.userId,
                      teamRole: m.teamRole === "lead" ? "member" : "lead",
                    })
                  }
                >
                  {m.teamRole}
                </button>
              )}
              <span className="chip">{m.role}</span>
              {!team.isEveryone && (
                <button className="btn danger" onClick={() => removeMember.mutate(m.userId)}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {!team.isEveryone && addable.length > 0 && (
            <div className="row">
              <select value={pickUser} onChange={(e) => setPickUser(e.target.value)} style={{ flex: 1 }}>
                <option value="">Add a member…</option>
                {addable.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
              <button
                className="btn primary"
                disabled={!pickUser || addMember.isPending}
                onClick={() => addMember.mutate()}
              >
                + Add
              </button>
            </div>
          )}
        </div>
      )}

      {tab === "sub-teams" && (
        <div className="row-group">
          {subTeams.map((t) => (
            <div
              className="row"
              key={t.id}
              style={{ cursor: "pointer" }}
              onClick={() => navigate(`/teams/${t.id}`)}
            >
              <div className="grow">
                <div className="title">{t.name}</div>
                <div className="sub">{count(t.memberCount, "member")}</div>
              </div>
            </div>
          ))}
          {subTeams.length === 0 && (
            <div className="row">
              <div className="sub">No sub-teams. Create one with + New team and pick this team as parent.</div>
            </div>
          )}
        </div>
      )}

      {tab === "agent access" && (
        <>
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Domain grants
          </div>
          <div className="row-group" style={{ marginBottom: 16 }}>
            {access
              .filter((a) => a.targetType === "domain")
              .map((a) => (
                <div className="row" key={a.id}>
                  <span className="chip purple">domain</span>
                  <div className="grow">
                    <div className="title">{a.targetName}</div>
                    <div className="sub">{a.accessRight}</div>
                  </div>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {a.agentCount ?? 0} agents
                  </span>
                </div>
              ))}
            {access.filter((a) => a.targetType === "domain").length === 0 && (
              <div className="row">
                <div className="sub">
                  No domain grants. This team has no access through domains.
                </div>
              </div>
            )}
          </div>
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Direct agent grants
          </div>
          <div className="row-group">
            {access
              .filter((a) => a.targetType === "agent")
              .map((a) => (
                <div className="row" key={a.id}>
                  <span className="chip blue">agent</span>
                  <div className="grow">
                    <div className="title">{a.targetName}</div>
                    <div className="sub">{a.accessRight}</div>
                  </div>
                </div>
              ))}
            {access.filter((a) => a.targetType === "agent").length === 0 && (
              <div className="row">
                <div className="sub">
                  None. This team's access comes entirely from domain grants.
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {!team.isEveryone && (
        <div style={{ marginTop: 28 }}>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Delete team "${team.name}"? Its grants are revoked.`)) {
                removeTeam.mutate();
              }
            }}
          >
            Delete team
          </button>
        </div>
      )}
    </div>
  );
}

function NewTeamModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.listTeams });
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const create = useMutation({
    mutationFn: () => api.createTeam({ name, parentTeamId: parent || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["teams"] });
      onClose();
    },
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New team</h2>
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
              placeholder="Platform"
            />
          </div>
          <div className="field">
            <label>Parent team (optional)</label>
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">None · top level</option>
              {teams.data?.teams
                .filter((t) => !t.isEveryone)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </div>
          {create.isError && <p className="error-text">{(create.error as Error).message}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={create.isPending}>
              Create team
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
