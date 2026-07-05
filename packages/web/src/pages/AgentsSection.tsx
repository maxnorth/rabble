import type { Agent, Model } from "@rabble/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

const AGENT_TABS = [
  "identity",
  "surfaces",
  "mcp",
  "agents",
  "automations",
  "evals",
  "access",
  "advanced",
] as const;

export function AgentsSection() {
  const { agentId } = useParams();
  const [showNew, setShowNew] = useState(false);

  return (
    <>
      <aside className="sidebar">
        <button
          className="btn"
          style={{ margin: "0 4px 12px" }}
          onClick={() => setShowNew(true)}
        >
          + New agent
        </button>
        <div className="sidebar-title">Directory</div>
        <NavLink
          to="/agents"
          end
          className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
        >
          <span className="label">All agents</span>
        </NavLink>
      </aside>
      <main className="main-pane">
        {agentId ? <AgentConfig agentId={agentId} /> : <AgentDirectory />}
      </main>
      {showNew && <NewAgentModal onClose={() => setShowNew(false)} />}
    </>
  );
}

type SortKey = "name" | "status" | "model" | "updatedAt";

function AgentDirectory() {
  const navigate = useNavigate();
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const models = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);

  const modelName = (a: Agent) =>
    models.data?.models.find((m) => m.id === a.modelId)?.displayName ?? "—";

  const rows = useMemo(() => {
    const list = (agents.data?.agents ?? []).filter(
      (a) =>
        !search ||
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.slug.includes(search.toLowerCase()),
    );
    const dir = sortAsc ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = sortKey === "model" ? modelName(a) : a[sortKey];
      const vb = sortKey === "model" ? modelName(b) : b[sortKey];
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.data, models.data, search, sortKey, sortAsc]);

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

  return (
    <div className="content-col" style={{ maxWidth: 900 }}>
      <h1 className="page-title">All agents</h1>
      <p className="page-subtitle">
        Every agent in your org. Eval scores and grants land here next.
      </p>
      <input
        placeholder="Search agents…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 14, width: 260 }}
      />
      <table className="dir-table">
        <thead>
          <tr>
            {header("name", "Agent")}
            {header("status", "Status")}
            {header("model", "Model")}
            {header("updatedAt", "Last updated")}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} onClick={() => navigate(`/agents/${a.id}`)}>
              <td>
                <div style={{ fontWeight: 500, color: "var(--text-1)" }}>
                  {a.name}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {a.slug}
                </div>
              </td>
              <td>
                <span className={`chip ${a.status === "active" ? "green" : "amber"}`}>
                  {a.status}
                </span>
              </td>
              <td>{modelName(a)}</td>
              <td style={{ color: "var(--text-muted)" }}>
                {new Date(a.updatedAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "var(--text-muted)", cursor: "default" }}>
                {agents.isLoading ? "Loading…" : "No agents yet. Create your first with + New agent."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
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
              Agents start as drafts — configure them, then set them active.
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

function AgentConfig({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agent = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const models = useQuery({ queryKey: ["models"], queryFn: api.listModels });

  const [form, setForm] = useState<{
    name: string;
    description: string;
    instructions: string;
    modelId: string;
    status: "active" | "draft";
  } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (agent.data) {
      const a = agent.data.agent;
      setForm({
        name: a.name,
        description: a.description,
        instructions: a.instructions,
        modelId: a.modelId ?? "",
        status: a.status,
      });
    }
  }, [agent.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateAgent(agentId, {
        name: form!.name,
        description: form!.description,
        instructions: form!.instructions,
        modelId: form!.modelId || null,
        status: form!.status,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteAgent(agentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigate("/agents");
    },
  });

  if (!agent.data || !form) {
    return <div className="content-col">{agent.isError ? "Agent not found." : ""}</div>;
  }

  const enabledModels = (models.data?.models ?? []).filter((m) => m.enabled);

  return (
    <div className="content-col">
      <button
        className="btn"
        style={{ marginBottom: 16 }}
        onClick={() => navigate("/agents")}
      >
        ‹ All agents
      </button>
      <h1 className="page-title">{agent.data.agent.name}</h1>
      <p className="page-subtitle mono">{agent.data.agent.slug}</p>

      <div className="tabs">
        {AGENT_TABS.map((tab) => (
          <button
            key={tab}
            className={`tab${tab === "identity" ? " active" : ""}`}
            disabled={tab !== "identity"}
            title={tab === "identity" ? undefined : "Coming soon"}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="field">
        <label>Name</label>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </div>
      <div className="field">
        <label>Description</label>
        <input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="What this agent is responsible for"
        />
      </div>
      <div className="field">
        <label>Instructions</label>
        <textarea
          rows={8}
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          placeholder="System instructions that define how this agent behaves"
        />
      </div>
      <div className="field">
        <label>Model</label>
        <select
          value={form.modelId}
          onChange={(e) => setForm({ ...form, modelId: e.target.value })}
        >
          <option value="">— No model —</option>
          {enabledModels.map((m: Model) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
        {enabledModels.length === 0 && (
          <span className="hint">
            No models registered yet — add one in Admin › Models.
          </span>
        )}
      </div>
      <div className="field">
        <label>Status</label>
        <div className="segmented">
          {(["draft", "active"] as const).map((s) => (
            <button
              key={s}
              className={form.status === s ? "active" : ""}
              onClick={() => setForm({ ...form, status: s })}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="hint">
          Only active agents appear in the session composer.
        </span>
      </div>

      {(save.isError || remove.isError) && (
        <p className="error-text" style={{ marginBottom: 12 }}>
          {((save.error ?? remove.error) as Error).message}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          className="btn primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {saved ? "Saved ✓" : "Save changes"}
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn danger"
          disabled={remove.isPending}
          onClick={() => {
            if (confirm(`Delete agent "${agent.data.agent.name}"?`)) {
              remove.mutate();
            }
          }}
        >
          Delete agent
        </button>
      </div>
    </div>
  );
}
