import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

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
          <div className="content-col">
            <h1 className="page-title">Teams</h1>
            <p className="page-subtitle">
              The RBAC backbone. Grants to a team cascade to its sub-teams and
              members. Pick a team from the sidebar or create one.
            </p>
          </div>
        )}
      </main>
      {showNew && <NewTeamModal onClose={() => setShowNew(false)} />}
    </>
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
          : `${team.memberCount} members · grants cascade to sub-teams and members`}
      </p>

      <div className="tabs">
        {(["members", "sub-teams", "agent access"] as const).map((t) => (
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
                <div className="sub">{t.memberCount} members</div>
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
        <div className="row-group">
          {access.map((a) => (
            <div className="row" key={a.id}>
              <span className={`chip ${a.targetType === "domain" ? "purple" : "blue"}`}>
                {a.targetType}
              </span>
              <div className="grow">
                <div className="title">{a.targetName}</div>
                <div className="sub">{a.accessRight}</div>
              </div>
            </div>
          ))}
          {access.length === 0 && (
            <div className="row">
              <div className="sub">
                This team holds no grants. Grant access from an agent's access
                tab or a domain page.
              </div>
            </div>
          )}
        </div>
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
              <option value="">None — top level</option>
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
