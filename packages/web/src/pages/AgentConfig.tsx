import { agentCapabilitiesSchema, type AgentCapabilities } from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { GrantEditor } from "./AgentsSection";
import { AGENT_COLORS, AGENT_GLYPHS } from "../lib/time";

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
type Tab = (typeof AGENT_TABS)[number];

export function AgentConfig({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const { tab } = useParams();
  const activeTab: Tab = AGENT_TABS.includes(tab as Tab) ? (tab as Tab) : "identity";
  const agent = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });

  const directory = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });

  if (!agent.data) {
    return <div className="content-col">{agent.isError ? "Agent not found." : ""}</div>;
  }
  const canEdit = agent.data.myRight === "edit" || agent.data.myRight === "admin";
  const row = directory.data?.agents.find((a) => a.id === agentId);
  const domainName = domains.data?.domains.find(
    (d) => d.id === agent.data!.agent.domainId,
  )?.name;

  return (
    <div className="content-col">
      <button className="btn" style={{ marginBottom: 16 }} onClick={() => navigate("/agents")}>
        ‹ All agents
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          className="avatar"
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: "var(--surface-tool)",
            border: "1px solid var(--border-1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
            color: AGENT_COLORS[agent.data.agent.color] ?? "var(--accent-text)",
          }}
        >
          {agent.data.agent.icon || agent.data.agent.name[0]}
        </div>
        <div style={{ flex: 1 }}>
          <h1 className="page-title" style={{ marginBottom: 2, display: "flex", gap: 8, alignItems: "center" }}>
            {agent.data.agent.name}
            <span
              className={`chip ${agent.data.agent.status === "active" ? "green" : ""}`}
            >
              {agent.data.agent.status}
            </span>
            {row && (
              <span
                className={`chip ${row.scope === "personal" ? "blue" : row.scope === "org-wide" ? "amber" : ""}`}
              >
                {row.scope}
              </span>
            )}
          </h1>
          <p className="page-subtitle mono" style={{ marginBottom: 0 }}>
            {agent.data.agent.slug}
            {domainName ? `  ·  in ${domainName}` : "  ·  not in a domain"}
            {!canEdit && "  ·  read-only (you need edit access to configure)"}
          </p>
        </div>
      </div>
      <div style={{ height: 14 }} />

      <div className="tabs">
        {AGENT_TABS.map((t) => (
          <button
            key={t}
            className={`tab${t === activeTab ? " active" : ""}`}
            onClick={() => navigate(`/agents/${agentId}/${t === "identity" ? "" : t}`)}
          >
            {t}
          </button>
        ))}
      </div>

      {activeTab === "identity" && (
        <IdentityTab agentId={agentId} canEdit={canEdit} />
      )}
      {activeTab === "surfaces" && <SurfacesTab agentId={agentId} canEdit={canEdit} />}
      {activeTab === "mcp" && <McpTab agentId={agentId} canEdit={canEdit} />}
      {activeTab === "agents" && <SubAgentsTab agentId={agentId} canEdit={canEdit} />}
      {activeTab === "automations" && (
        <AutomationsTab agentId={agentId} canEdit={canEdit} />
      )}
      {activeTab === "evals" && <EvalsTab agentId={agentId} canEdit={canEdit} />}
      {activeTab === "access" && <AccessTab agentId={agentId} />}
      {activeTab === "advanced" && (
        <AdvancedTab agentId={agentId} canEdit={canEdit} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

function IdentityTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agent = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const models = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });

  const [form, setForm] = useState<{
    name: string;
    description: string;
    instructions: string;
    tone: string;
    icon: string;
    color: string;
    modelId: string;
    domainId: string;
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
        tone: a.tone,
        icon: a.icon,
        color: a.color,
        modelId: a.modelId ?? "",
        domainId: a.domainId ?? "",
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
        tone: form!.tone,
        icon: form!.icon,
        color: form!.color,
        modelId: form!.modelId || null,
        domainId: form!.domainId || null,
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

  if (!form) return null;
  const enabledModels = (models.data?.models ?? []).filter(
    (m) => m.enabled && (m.canUse || m.id === form.modelId),
  );

  return (
    <fieldset disabled={!canEdit} style={{ border: "none" }}>
      <div className="field">
        <label>Logo</label>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {AGENT_GLYPHS.map((glyph) => (
            <button
              key={glyph}
              type="button"
              onClick={() => setForm({ ...form, icon: glyph })}
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: `1px solid ${form.icon === glyph ? "var(--accent)" : "var(--border-1)"}`,
                background: form.icon === glyph ? "var(--hover-3)" : "var(--surface-group)",
                fontSize: 16,
                color: AGENT_COLORS[form.color] ?? "var(--accent-text)",
              }}
            >
              {glyph}
            </button>
          ))}
          <span style={{ width: 10 }} />
          {Object.entries(AGENT_COLORS).map(([name, value]) => (
            <button
              key={name}
              type="button"
              title={name}
              onClick={() => setForm({ ...form, color: name })}
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: `2px solid ${form.color === name ? "var(--text-1)" : "transparent"}`,
                background: value,
              }}
            />
          ))}
        </div>
        <span className="hint">Shown in chat, the rail, and the directory.</span>
      </div>
      <div className="field">
        <label>Name</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
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
        <label>Tone &amp; style</label>
        <input
          value={form.tone}
          onChange={(e) => setForm({ ...form, tone: e.target.value })}
          placeholder="Be concise and direct. Surface options before any write action."
        />
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Model</label>
          <select
            value={form.modelId}
            onChange={(e) => setForm({ ...form, modelId: e.target.value })}
          >
            <option value="">— No model —</option>
            {enabledModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
          <span className="hint">
            Limited to models you can use. Manage access in Admin › Models.
          </span>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Domain</label>
          <select
            value={form.domainId}
            onChange={(e) => setForm({ ...form, domainId: e.target.value })}
          >
            <option value="">No domain</option>
            {domains.data?.domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <span className="hint">Domain grants apply to every agent in it.</span>
        </div>
      </div>
      <div className="field">
        <label>Status</label>
        <div className="segmented">
          {(["draft", "active"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={form.status === s ? "active" : ""}
              onClick={() => setForm({ ...form, status: s })}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="hint">Only active agents appear in the session composer.</span>
      </div>

      {(save.isError || remove.isError) && (
        <p className="error-text" style={{ marginBottom: 12 }}>
          {((save.error ?? remove.error) as Error).message}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {saved ? "Saved ✓" : "Save changes"}
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn danger"
          disabled={remove.isPending}
          onClick={() => {
            if (confirm(`Delete agent "${form.name}"?`)) remove.mutate();
          }}
        >
          Delete agent
        </button>
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// surfaces
// ---------------------------------------------------------------------------

function SurfacesTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const surfaces = useQuery({
    queryKey: ["surfaces", agentId],
    queryFn: () => api.listSurfaces(agentId),
  });
  const [connectionId, setConnectionId] = useState("");
  const [label, setLabel] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["surfaces", agentId] });
  const add = useMutation({
    mutationFn: () => api.addSurface(agentId, { connectionId, label: label.trim() }),
    onSuccess: () => {
      setConnectionId("");
      setLabel("");
      void invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (surfaceId: string) => api.removeSurface(agentId, surfaceId),
    onSuccess: () => void invalidate(),
  });

  const interfaces = (connections.data?.connections ?? []).filter((c) =>
    c.roles.includes("Interface"),
  );
  const attached = surfaces.data?.surfaces ?? [];
  const labelPlaceholder = (vendor?: string) =>
    vendor === "slack" ? "#eng-oncall" : vendor === "github" ? "acme/api" : "channel or path";
  const selected = interfaces.find((c) => c.id === connectionId);

  return (
    <>
      <p className="page-subtitle">
        Where this agent is reachable. Surfaces are delivery points — the
        platform owns the session either way. The web composer is always on;
        connection-backed surfaces (Slack channels, GitHub repos…) attach here
        once their connection is set up in Admin › Connections.
      </p>
      <div className="row-group" style={{ marginBottom: 16 }}>
        <div className="row">
          <span className="status-dot" style={{ background: "var(--green)" }} />
          <div className="grow">
            <div className="title">Web sessions</div>
            <div className="sub">The in-app composer — always available</div>
          </div>
          <span className="chip green">on</span>
        </div>
        {attached.map((s) => (
          <div className="row" key={s.id}>
            <span
              className="status-dot"
              style={{
                background: s.status === "connected" ? "var(--green)" : "var(--amber)",
              }}
            />
            <div className="grow">
              <div className="title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {s.connectionName}
                {s.label && <span className="mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>{s.label}</span>}
              </div>
              <div className="sub">
                {s.vendor} · sessions started here land in the same audited timeline
              </div>
            </div>
            <span className={`chip ${s.status === "connected" ? "green" : "amber"}`}>
              {s.status}
            </span>
            {canEdit && (
              <button
                className="btn danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(s.id)}
              >
                Detach
              </button>
            )}
          </div>
        ))}
      </div>

      {canEdit && interfaces.length > 0 && (
        <div className="row-group">
          <div className="row">
            <select
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              style={{ width: 220 }}
            >
              <option value="">Add a surface…</option>
              {interfaces.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.vendor})
                </option>
              ))}
            </select>
            <input
              placeholder={labelPlaceholder(selected?.vendor)}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={{ width: 200 }}
            />
            <button
              className="btn primary"
              disabled={!connectionId || add.isPending}
              onClick={() => add.mutate()}
            >
              Attach surface
            </button>
          </div>
        </div>
      )}
      {interfaces.length === 0 && (
        <p className="page-subtitle">
          No interface connections yet — add Slack (or similar) in Admin ›
          Connections to reach this agent outside the web app.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

function McpTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const tools = useQuery({
    queryKey: ["agent-tools", agentId],
    queryFn: () => api.agentTools(agentId),
  });
  const servers = useQuery({ queryKey: ["mcp-servers"], queryFn: api.listMcpServers });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["agent-tools", agentId] });

  const attach = useMutation({
    mutationFn: (serverId: string) => api.attachMcpServer(agentId, serverId),
    onSuccess: refresh,
  });
  const detach = useMutation({
    mutationFn: (serverId: string) => api.detachMcpServer(agentId, serverId),
    onSuccess: refresh,
  });
  const updateTool = useMutation({
    mutationFn: (body: {
      serverId: string;
      toolName: string;
      enabled?: boolean;
      authType?: "service" | "user";
    }) => api.updateAgentTool(agentId, body),
    onSuccess: refresh,
  });

  const attachedIds = new Set(tools.data?.servers ?? []);
  const attachable = (servers.data?.servers ?? []).filter((s) => !attachedIds.has(s.id));

  const byServer = new Map<string, typeof tools.data extends undefined ? never : NonNullable<typeof tools.data>["tools"]>();
  for (const t of tools.data?.tools ?? []) {
    const list = byServer.get(t.serverId) ?? [];
    list.push(t);
    byServer.set(t.serverId, list);
  }

  return (
    <>
      <p className="page-subtitle">
        Tools from the org's MCP server library. Every tool runs either under
        the org <span className="chip green">service</span> credential or{" "}
        <span className="chip amber">user</span> — as the person in the
        session, with an in-thread approval.
      </p>
      {[...byServer.entries()].map(([serverId, serverTools]) => (
        <div key={serverId} style={{ marginBottom: 20 }}>
          <div
            className="sidebar-title"
            style={{
              padding: "0 0 8px",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            {serverTools[0]?.serverName}
            {canEdit && (
              <button
                style={{ color: "var(--danger)", fontSize: 11 }}
                onClick={() => detach.mutate(serverId)}
              >
                Detach
              </button>
            )}
          </div>
          <div className="row-group">
            {serverTools.map((t) => (
              <div className="row" key={t.toolName}>
                <span
                  className={`toggle${t.enabled ? " on" : ""}`}
                  style={{ cursor: canEdit ? "pointer" : "default" }}
                  onClick={() =>
                    canEdit &&
                    updateTool.mutate({
                      serverId: t.serverId,
                      toolName: t.toolName,
                      enabled: !t.enabled,
                    })
                  }
                />
                <div className="grow">
                  <div className="title mono" style={{ fontSize: 12 }}>
                    {t.toolName}
                  </div>
                  <div className="sub">{t.description}</div>
                </div>
                <div className="segmented">
                  {(["service", "user"] as const).map((auth) => (
                    <button
                      key={auth}
                      disabled={!canEdit}
                      className={t.authType === auth ? "active" : ""}
                      onClick={() =>
                        updateTool.mutate({
                          serverId: t.serverId,
                          toolName: t.toolName,
                          authType: auth,
                        })
                      }
                    >
                      {auth}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {byServer.size === 0 && (
        <div className="row-group" style={{ marginBottom: 20 }}>
          <div className="row">
            <div className="sub">No MCP servers attached yet.</div>
          </div>
        </div>
      )}
      {canEdit && attachable.length > 0 && (
        <>
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Attach from library
          </div>
          <div className="row-group">
            {attachable.map((s) => (
              <div className="row" key={s.id}>
                <div className="grow">
                  <div className="title">{s.name}</div>
                  <div className="sub">
                    {s.category} · {s.tools.length} tools
                  </div>
                </div>
                <button className="btn" onClick={() => attach.mutate(s.id)}>
                  Attach
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// agents (sub-agents)
// ---------------------------------------------------------------------------

function SubAgentsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const subAgents = useQuery({
    queryKey: ["sub-agents", agentId],
    queryFn: () => api.subAgents(agentId),
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["sub-agents", agentId] });
  const link = useMutation({
    mutationFn: (subId: string) => api.linkSubAgent(agentId, subId),
    onSuccess: refresh,
  });
  const unlink = useMutation({
    mutationFn: (subId: string) => api.unlinkSubAgent(agentId, subId),
    onSuccess: refresh,
  });

  const linkedIds = new Set((subAgents.data?.subAgents ?? []).map((a) => a.id));
  const linkable = (agents.data?.agents ?? []).filter(
    (a) => a.id !== agentId && !linkedIds.has(a.id) && a.myRight,
  );

  return (
    <>
      <p className="page-subtitle">
        Other agents wired in as callable tools. You can only attach agents
        you hold use access on — the permission gate that keeps the mesh
        auditable.
      </p>
      <div className="row-group" style={{ marginBottom: 20 }}>
        {subAgents.data?.subAgents.map((a) => (
          <div className="row" key={a.id}>
            <span className="chip purple">agent</span>
            <div className="grow">
              <div className="title">{a.name}</div>
              <div className="sub mono">{a.slug}</div>
            </div>
            {canEdit && (
              <button className="btn danger" onClick={() => unlink.mutate(a.id)}>
                Remove
              </button>
            )}
          </div>
        ))}
        {subAgents.data?.subAgents.length === 0 && (
          <div className="row">
            <div className="sub">No connected agents.</div>
          </div>
        )}
      </div>
      {canEdit && linkable.length > 0 && (
        <>
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Attach an agent
          </div>
          <div className="row-group">
            {linkable.map((a) => (
              <div className="row" key={a.id}>
                <div className="grow">
                  <div className="title">{a.name}</div>
                  <div className="sub">{a.description || a.slug}</div>
                </div>
                {(link.isError && (
                  <span className="error-text">{(link.error as Error).message}</span>
                )) || null}
                <button className="btn" onClick={() => link.mutate(a.id)}>
                  Attach
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// automations
// ---------------------------------------------------------------------------

function AutomationsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const automations = useQuery({
    queryKey: ["automations", agentId],
    queryFn: () => api.listAutomations(agentId),
  });
  const [form, setForm] = useState({ name: "", schedule: "0 9 * * 1-5", prompt: "" });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["automations", agentId] });
  const create = useMutation({
    mutationFn: () => api.createAutomation(agentId, form),
    onSuccess: () => {
      setForm({ name: "", schedule: "0 9 * * 1-5", prompt: "" });
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.toggleAutomation(id, enabled),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: refresh,
  });

  return (
    <>
      <p className="page-subtitle">
        Scheduled runs of this agent. Definitions live here; execution runs on
        the platform's scheduling engine.
      </p>
      <div className="row-group" style={{ marginBottom: 20 }}>
        {automations.data?.automations.map((a) => (
          <div className="row" key={a.id}>
            <span
              className={`toggle${a.enabled ? " on" : ""}`}
              style={{ cursor: canEdit ? "pointer" : "default" }}
              onClick={() => canEdit && toggle.mutate({ id: a.id, enabled: !a.enabled })}
            />
            <div className="grow">
              <div className="title">{a.name}</div>
              <div className="sub mono">{a.schedule}</div>
            </div>
            {canEdit && (
              <button className="btn danger" onClick={() => remove.mutate(a.id)}>
                Delete
              </button>
            )}
          </div>
        ))}
        {automations.data?.automations.length === 0 && (
          <div className="row">
            <div className="sub">No automations yet.</div>
          </div>
        )}
      </div>
      {canEdit && (
        <div className="card" style={{ padding: 16 }}>
          <div className="field">
            <label>Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Morning digest"
            />
          </div>
          <div className="field">
            <label>Schedule (cron)</label>
            <input
              className="mono"
              value={form.schedule}
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Prompt</label>
            <textarea
              rows={3}
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="What the agent should do on each run"
            />
          </div>
          <button
            className="btn primary"
            disabled={!form.name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            + Add automation
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// evals
// ---------------------------------------------------------------------------

function EvalsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const criteria = useQuery({
    queryKey: ["criteria", agentId],
    queryFn: () => api.listCriteria(agentId),
  });
  const suites = useQuery({
    queryKey: ["suites", agentId],
    queryFn: () => api.listSuites(agentId),
  });
  const [criterionForm, setCriterionForm] = useState({ name: "", description: "" });
  const [suiteName, setSuiteName] = useState("");
  const [runError, setRunError] = useState<string | null>(null);

  const addCriterion = useMutation({
    mutationFn: () => api.createCriterion(agentId, criterionForm),
    onSuccess: () => {
      setCriterionForm({ name: "", description: "" });
      void queryClient.invalidateQueries({ queryKey: ["criteria", agentId] });
    },
  });
  const removeCriterion = useMutation({
    mutationFn: (id: string) => api.deleteCriterion(id),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["criteria", agentId] }),
  });
  const addSuite = useMutation({
    mutationFn: () => api.createSuite(agentId, { name: suiteName }),
    onSuccess: () => {
      setSuiteName("");
      void queryClient.invalidateQueries({ queryKey: ["suites", agentId] });
    },
  });
  const runSuite = useMutation({
    mutationFn: (suiteId: string) => api.runSuite(suiteId),
    onSuccess: () => {
      setRunError(null);
      void queryClient.invalidateQueries({ queryKey: ["suites", agentId] });
    },
    onError: (err) => setRunError(err instanceof Error ? err.message : "Run failed"),
  });

  return (
    <>
      <p className="page-subtitle">
        Criteria are evaluated live against real sessions; suites are offline
        test cases. Track record is evidence in access decisions.
      </p>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Live criteria
      </div>
      <div className="row-group" style={{ marginBottom: 12 }}>
        {criteria.data?.criteria.map((c) => (
          <div className="row" key={c.id}>
            <div className="grow">
              <div className="title">{c.name}</div>
              <div className="sub">{c.description || "—"}</div>
            </div>
            {c.passRate !== null ? (
              <span
                className={`chip ${c.passRate >= 90 ? "green" : c.passRate >= 70 ? "blue" : "amber"}`}
              >
                {c.passRate}% · {c.sessionCount} sessions
              </span>
            ) : (
              <span className="chip">no data yet</span>
            )}
            {canEdit && (
              <button className="btn danger" onClick={() => removeCriterion.mutate(c.id)}>
                Delete
              </button>
            )}
          </div>
        ))}
        {criteria.data?.criteria.length === 0 && (
          <div className="row">
            <div className="sub">No criteria — this agent is unmeasured.</div>
          </div>
        )}
        {canEdit && (
          <div className="row">
            <input
              placeholder="Criterion, e.g. Cites a runbook link"
              value={criterionForm.name}
              onChange={(e) =>
                setCriterionForm({ ...criterionForm, name: e.target.value })
              }
              style={{ flex: 1 }}
            />
            <input
              placeholder="What the judge should check (optional)"
              value={criterionForm.description}
              onChange={(e) =>
                setCriterionForm({ ...criterionForm, description: e.target.value })
              }
              style={{ flex: 1 }}
            />
            <button
              className="btn primary"
              disabled={!criterionForm.name.trim() || addCriterion.isPending}
              onClick={() => addCriterion.mutate()}
            >
              + Add
            </button>
          </div>
        )}
      </div>

      <div className="sidebar-title" style={{ padding: "14px 0 8px" }}>
        Suites
      </div>
      <div className="row-group">
        {suites.data?.suites.map((s) => (
          <div className="row" key={s.id}>
            <div className="grow">
              <div className="title">
                {s.name} {s.gating && <span className="chip amber">gating</span>}
              </div>
              <div className="sub">
                {s.caseCount} cases
                {s.lastRun
                  ? ` · last run ${s.lastRun.passed}/${s.lastRun.total} passed`
                  : " · never run"}
              </div>
            </div>
            {canEdit && (
              <button
                className="btn"
                disabled={runSuite.isPending}
                onClick={() => runSuite.mutate(s.id)}
              >
                {runSuite.isPending ? "Running…" : "Run suite"}
              </button>
            )}
          </div>
        ))}
        {suites.data?.suites.length === 0 && (
          <div className="row">
            <div className="sub">
              No suites yet. Freeze good sessions into cases to build one.
            </div>
          </div>
        )}
        {canEdit && (
          <div className="row">
            <input
              placeholder="New suite name"
              value={suiteName}
              onChange={(e) => setSuiteName(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="btn primary"
              disabled={!suiteName.trim() || addSuite.isPending}
              onClick={() => addSuite.mutate()}
            >
              + Add suite
            </button>
          </div>
        )}
      </div>
      {runError && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {runError}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------

function AccessTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: ["grants", "agent", agentId],
    queryFn: () => api.listGrants("agent", agentId),
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.listTeams });
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });

  return (
    <>
      <p className="page-subtitle">
        Who can use, configure, and administer this agent. Direct grants plus
        grants inherited from its domain. There is no owner — rights come only
        from grants.
      </p>
      <GrantEditor
        targetType="agent"
        targetId={agentId}
        grants={grants.data?.grants ?? []}
        teams={teams.data?.teams ?? []}
        users={users.data?.users ?? []}
        onChanged={() =>
          void queryClient.invalidateQueries({ queryKey: ["grants", "agent", agentId] })
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// advanced (capability toggles)
// ---------------------------------------------------------------------------

const CAPABILITIES: Array<{ key: keyof AgentCapabilities; label: string; hint: string }> = [
  { key: "codeSandbox", label: "Code sandbox", hint: "Isolated execution environment" },
  { key: "codeExecution", label: "Code execution", hint: "Run scripts, tests, build commands" },
  { key: "pullRequestAccess", label: "Pull request access", hint: "Create and update PRs on connected repos" },
  { key: "outboundWebAccess", label: "Outbound web access", hint: "Fetch external URLs during sessions" },
];

function AdvancedTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const agent = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const [caps, setCaps] = useState<AgentCapabilities | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (agent.data) {
      setCaps(agentCapabilitiesSchema.parse(agent.data.agent.capabilities ?? {}));
    }
  }, [agent.data]);

  const save = useMutation({
    mutationFn: () => api.updateAgent(agentId, { capabilities: caps! }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    },
  });

  if (!caps) return null;

  return (
    <>
      <p className="page-subtitle">
        Capability toggles. A simple Q&A agent has none of these; a full
        coding agent has all of them — same platform, different configuration.
      </p>
      <div className="row-group" style={{ marginBottom: 16 }}>
        {CAPABILITIES.map((c) => (
          <div className="row" key={c.key}>
            <span
              className={`toggle${caps[c.key] ? " on" : ""}`}
              style={{ cursor: canEdit ? "pointer" : "default" }}
              onClick={() => canEdit && setCaps({ ...caps, [c.key]: !caps[c.key] })}
            />
            <div className="grow">
              <div className="title">{c.label}</div>
              <div className="sub">{c.hint}</div>
            </div>
          </div>
        ))}
        <div className="row">
          <div className="grow">
            <div className="title">Network allowlist</div>
            <div className="sub">Restrict which hosts tools can reach (comma-separated)</div>
          </div>
          <input
            className="mono"
            disabled={!canEdit}
            style={{ width: 260 }}
            value={caps.networkAllowlist}
            onChange={(e) => setCaps({ ...caps, networkAllowlist: e.target.value })}
            placeholder="*.internal.acme.com"
          />
        </div>
      </div>
      {canEdit && (
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {saved ? "Saved ✓" : "Save changes"}
        </button>
      )}
    </>
  );
}
