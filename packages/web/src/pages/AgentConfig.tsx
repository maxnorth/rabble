import {
  agentCapabilitiesSchema,
  describeCron,
  isValidCron,
  nextCronRun,
  type AgentCapabilities,
} from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { GrantEditor } from "./AgentsSection";
import { AGENT_COLORS, AGENT_GLYPHS, count, relativeFuture, relativeTime } from "../lib/time";

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
  const [shareOpen, setShareOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
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
        {agent.data.myRight === "admin" && !agent.data.agent.builtin && (
          <button className="btn primary" onClick={() => setShareOpen(true)}>
            Share
          </button>
        )}
        {(agent.data.myRight === null || agent.data.myRight === "use") &&
          !agent.data.agent.builtin && (
            <button className="btn" onClick={() => setRequestOpen(true)}>
              Request access
            </button>
          )}
      </div>
      {requestOpen && (
        <RequestAccessModal
          agentId={agentId}
          agentName={agent.data.agent.name}
          myRight={agent.data.myRight}
          onClose={() => setRequestOpen(false)}
        />
      )}
      {shareOpen && (
        <ShareModal
          agentId={agentId}
          agentName={agent.data.agent.name}
          status={agent.data.agent.status}
          evalScore={row?.evalScore ?? null}
          onClose={() => setShareOpen(false)}
        />
      )}
      <div style={{ height: 14 }} />

      <div className="tabs">
        {AGENT_TABS.map((t) => (
          <button
            key={t}
            className={`tab${t === activeTab ? " active" : ""}`}
            onClick={() => navigate(`/agents/${agentId}/${t === "identity" ? "" : t}`)}
          >
            {t === "mcp" ? "MCP" : t.charAt(0).toUpperCase() + t.slice(1)}
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
// Request access — the web-native half of the request → notify → approve
// loop (the Builder files the same rows conversationally).
// ---------------------------------------------------------------------------

function RequestAccessModal({
  agentId,
  agentName,
  myRight,
  onClose,
}: {
  agentId: string;
  agentName: string;
  myRight: string | null;
  onClose: () => void;
}) {
  const [right, setRight] = useState<"use" | "edit">(myRight === "use" ? "edit" : "use");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = useMutation({
    mutationFn: () =>
      api.createAccessRequest({
        targetType: "agent",
        targetId: agentId,
        accessRight: right,
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      setError(null);
      setSent(true);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Couldn't send the request"),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h2>Request access to {agentName}</h2>
        {sent ? (
          <>
            <p className="page-subtitle">
              Request sent — an org admin has been notified and can approve it
              under Admin › Access requests.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>What you need</label>
              <div style={{ display: "flex", gap: 6 }}>
                {(["use", "edit"] as const).map((r) => (
                  <button
                    type="button"
                    key={r}
                    className={`chip ${right === r ? "blue" : ""}`}
                    style={{
                      cursor: myRight === "use" && r === "use" ? "not-allowed" : "pointer",
                      opacity: myRight === "use" && r === "use" ? 0.5 : 1,
                    }}
                    disabled={myRight === "use" && r === "use"}
                    onClick={() => setRight(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <span className="hint">
                {right === "use"
                  ? "Talk to this agent in sessions."
                  : "Change how this agent behaves."}
              </span>
            </div>
            <div className="field">
              <label>Why (shown to the approver)</label>
              <textarea
                rows={3}
                placeholder="What are you trying to do?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {error && <p className="error-text">{error}</p>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={submit.isPending}
                onClick={() => submit.mutate()}
              >
                Send request
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Share — one verb (PRODUCT_CONTEXT §5): audience picker (teams first),
// plain-language rights sentence, track record as evidence, optional
// deploy-to-Slack, visible pause/unshare.
// ---------------------------------------------------------------------------

const RIGHT_SENTENCES: Record<"use" | "edit" | "admin", (who: string) => string> = {
  use: (who) => `${who} can talk to this agent in sessions.`,
  edit: (who) => `${who} can change how this agent behaves.`,
  admin: (who) => `${who} can manage access, gates, and deletion.`,
};

function ShareModal({
  agentId,
  agentName,
  status,
  evalScore,
  onClose,
}: {
  agentId: string;
  agentName: string;
  status: "active" | "draft";
  evalScore: number | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: ["grants", "agent", agentId],
    queryFn: () => api.listGrants("agent", agentId),
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.listTeams });
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  const trust = useQuery({
    queryKey: ["trust", agentId],
    queryFn: () => api.agentTrust(agentId),
  });
  // Deploy-to-Slack is offered when the org has a Slack interface
  // connection; the listing is admin-only, so just hide it on 403.
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.listConnections,
    retry: false,
  });
  const slackConnection = connections.data?.connections.find(
    (c) => c.vendor === "slack",
  );

  const [subject, setSubject] = useState("");
  const [right, setRight] = useState<"use" | "edit" | "admin">("use");
  const [channel, setChannel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["grants", "agent", agentId] });
    void queryClient.invalidateQueries({ queryKey: ["agents"] });
    void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
  };

  const share = useMutation({
    mutationFn: () => {
      const [subjectType, subjectId] = subject.split(":") as ["user" | "team", string];
      return api.createGrant({
        subjectType,
        subjectId,
        accessRight: right,
        targetType: "agent",
        targetId: agentId,
      });
    },
    onSuccess: () => {
      setSubject("");
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Couldn't share"),
  });
  const unshare = useMutation({
    mutationFn: (grantId: string) => api.deleteGrant(grantId),
    onSuccess: invalidate,
  });
  const setStatus = useMutation({
    mutationFn: (next: "active" | "draft") => api.updateAgent(agentId, { status: next }),
    onSuccess: invalidate,
  });
  const deploySlack = useMutation({
    mutationFn: () =>
      api.addSurface(agentId, {
        connectionId: slackConnection!.id,
        label: channel.startsWith("#") ? channel : `#${channel}`,
      }),
    onSuccess: () => {
      setChannel("");
      void queryClient.invalidateQueries({ queryKey: ["surfaces", agentId] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Couldn't attach"),
  });

  const audienceName = (() => {
    const [type, id] = subject.split(":");
    if (type === "team") return teams.data?.teams.find((t) => t.id === id)?.name;
    if (type === "user") return users.data?.users.find((u) => u.id === id)?.name;
    return undefined;
  })();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Share {agentName}
          <span
            className={`chip ${
              evalScore === null ? "" : evalScore >= 90 ? "green" : "amber"
            }`}
            title="Measured track record — the evidence behind this decision"
          >
            {evalScore === null
              ? "no track record yet"
              : `${evalScore}% eval score · ${trust.data?.gradedCount ?? 0} graded`}
          </span>
        </h2>

        <div className="field">
          <label>Audience</label>
          <select value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">Pick a team or person…</option>
            <optgroup label="Teams">
              {(teams.data?.teams ?? []).map((t) => (
                <option key={t.id} value={`team:${t.id}`}>
                  {t.isEveryone ? "Everyone (org-wide)" : t.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="People">
              {(users.data?.users ?? []).map((u) => (
                <option key={u.id} value={`user:${u.id}`}>
                  {u.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>

        <div className="field">
          <label>What they can do</label>
          <div style={{ display: "flex", gap: 6 }}>
            {(["use", "edit", "admin"] as const).map((r) => (
              <button
                type="button"
                key={r}
                className={`chip ${right === r ? "blue" : ""}`}
                style={{ cursor: "pointer" }}
                onClick={() => setRight(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <span className="hint">
            {RIGHT_SENTENCES[right](audienceName ?? "They")}
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            className="btn primary"
            disabled={!subject || share.isPending}
            onClick={() => share.mutate()}
          >
            Share
          </button>
        </div>

        {(grants.data?.grants ?? []).length > 0 && (
          <>
            <div className="sidebar-title" style={{ padding: "12px 0 6px" }}>
              Currently shared with
            </div>
            <div className="row-group">
              {(grants.data?.grants ?? []).map((g) => (
                <div className="row" key={g.id} style={{ padding: "8px 12px" }}>
                  <div className="grow">
                    <span style={{ fontSize: 12.5 }}>{g.subjectName}</span>{" "}
                    <span className="chip">{g.accessRight}</span>
                    {g.viaDomain && (
                      <span className="chip purple" title="Inherited from the domain">
                        via {g.viaDomain}
                      </span>
                    )}
                  </div>
                  {!g.viaDomain && (
                    <button className="btn danger" onClick={() => unshare.mutate(g.id)}>
                      Unshare
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {slackConnection && (
          <div className="field" style={{ marginTop: 12 }}>
            <label>Deploy to Slack (optional)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                placeholder="#channel"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              />
              <button
                className="btn"
                disabled={!channel.trim() || deploySlack.isPending}
                onClick={() => deploySlack.mutate()}
              >
                Attach
              </button>
            </div>
            <span className="hint">
              Messages in that channel become governed sessions with this agent
              (via {slackConnection.name}).
            </span>
          </div>
        )}

        <div
          className="card"
          style={{
            padding: 10,
            marginTop: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12.5,
            color: "var(--text-dim)",
          }}
        >
          {status === "active" ? (
            <>
              <span className="grow">
                Sharing is live — pausing sets the agent back to draft, so it
                runs only for people with edit access.
              </span>
              <button
                className="btn"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate("draft")}
              >
                Pause sharing
              </button>
            </>
          ) : (
            <>
              <span className="grow">
                This draft runs only for its editors until activated.
              </span>
              <button
                className="btn primary"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate("active")}
              >
                Activate
              </button>
            </>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
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
  const duplicate = useMutation({
    mutationFn: () => api.duplicateAgent(agentId),
    onSuccess: async ({ agent: copy }) => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigate(`/agents/${copy.id}`);
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

      {(save.isError || remove.isError) &&
        (() => {
          const err = (save.error ?? remove.error) as ApiError;
          const gate = err.body?.gate as
            | { suiteName?: string; failures?: Array<{ caseName: string; reasoning: string }> }
            | undefined;
          return (
            <div className="error-text" style={{ marginBottom: 12 }}>
              <p style={{ margin: 0 }}>{err.message}</p>
              {gate?.failures && gate.failures.length > 0 && (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {gate.failures.map((f, i) => (
                    <li key={i} style={{ marginBottom: 2 }}>
                      <strong>{f.caseName}</strong>: {f.reasoning}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {saved ? "Saved ✓" : "Save changes"}
        </button>
        <button
          className="btn"
          disabled={duplicate.isPending}
          title="Copy this configuration (MCP wiring and sub-agents included) into a new draft"
          onClick={() => duplicate.mutate()}
        >
          {duplicate.isPending ? "Duplicating…" : "Duplicate"}
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
      {[...byServer.entries()].map(([serverId, serverTools]) => {
        const enabledTools = serverTools.filter((t) => t.enabled);
        const serviceCount = enabledTools.filter((t) => t.authType !== "user").length;
        const userCount = enabledTools.length - serviceCount;
        return (
        <div key={serverId} style={{ marginBottom: 20 }}>
          <div
            className="sidebar-title"
            style={{
              padding: "0 0 8px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {serverTools[0]?.serverName}
            <span style={{ textTransform: "none", letterSpacing: 0 }}>
              {enabledTools.length} of {serverTools.length} enabled
            </span>
            {serviceCount > 0 && (
              <span className="chip green">{serviceCount} service</span>
            )}
            {userCount > 0 && <span className="chip amber">{userCount} user</span>}
            <span style={{ flex: 1 }} />
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
        );
      })}
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
                    {s.category} · {count(s.tools.length, "tool")}
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
  const setNote = useMutation({
    mutationFn: ({ subId, note }: { subId: string; note: string }) =>
      api.setSubAgentNote(agentId, subId, note),
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
            <input
              placeholder="When is it called? e.g. Before any deploy action"
              defaultValue={a.note}
              disabled={!canEdit}
              onBlur={(e) => {
                if (canEdit && e.target.value !== a.note) {
                  setNote.mutate({ subId: a.id, note: e.target.value });
                }
              }}
              style={{ width: 280, fontSize: 12 }}
            />
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
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: () => api.schedulerStatus(),
  });
  const [form, setForm] = useState({ name: "", schedule: "0 9 * * 1-5", prompt: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", schedule: "", prompt: "" });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["automations", agentId] });
  const create = useMutation({
    mutationFn: () => api.createAutomation(agentId, form),
    onSuccess: () => {
      setForm({ name: "", schedule: "0 9 * * 1-5", prompt: "" });
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (id: string) => api.updateAutomation(id, editForm),
    onSuccess: () => {
      setEditing(null);
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
  const run = useMutation({
    mutationFn: (id: string) => api.runAutomation(id),
    onSuccess: refresh,
  });

  return (
    <>
      <p className="page-subtitle">
        Scheduled runs of this agent. Each run is a real governed session on
        the Automation surface. Enable an automation to run it on its schedule;
        Run now executes it immediately either way.
      </p>
      {scheduler.data?.active === false &&
        automations.data?.automations.some((a) => a.enabled) && (
          <div
            role="status"
            style={{
              border: "1px solid var(--border-2)",
              borderLeft: "3px solid var(--amber)",
              background: "var(--surface-2)",
              borderRadius: 8,
              padding: "10px 12px",
              margin: "0 0 16px",
              fontSize: 13,
              color: "var(--text-2)",
            }}
          >
            The platform scheduler isn't running, so enabled automations won't
            fire on their schedule yet — use Run now until it's configured.
            Schedules resume automatically once the scheduler is live.
          </div>
        )}
      {run.isError && (
        <p className="error-text">{(run.error as Error).message}</p>
      )}
      <div className="row-group" style={{ marginBottom: 20 }}>
        {automations.data?.automations.map((a) =>
          editing === a.id ? (
            <div className="row" key={a.id}>
              <div className="grow" style={{ display: "grid", gap: 8 }}>
                <input
                  aria-label="Automation name"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                />
                <input
                  aria-label="Automation schedule"
                  className="mono"
                  value={editForm.schedule}
                  onChange={(e) => setEditForm({ ...editForm, schedule: e.target.value })}
                />
                {isValidCron(editForm.schedule) ? (
                  <span className="hint">{describeCron(editForm.schedule)}</span>
                ) : (
                  <span className="hint" style={{ color: "var(--amber)" }}>
                    Not a valid 5-field cron.
                  </span>
                )}
                <textarea
                  aria-label="Automation prompt"
                  rows={2}
                  value={editForm.prompt}
                  onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
                />
                {update.isError && (
                  <span className="error-text">{(update.error as Error).message}</span>
                )}
              </div>
              <button
                className="btn primary"
                disabled={
                  !editForm.name.trim() ||
                  !isValidCron(editForm.schedule) ||
                  update.isPending
                }
                onClick={() => update.mutate(a.id)}
              >
                {update.isPending ? "Saving…" : "Save"}
              </button>
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row" key={a.id}>
              <span
                className={`toggle${a.enabled ? " on" : ""}`}
                style={{ cursor: canEdit ? "pointer" : "default" }}
                onClick={() => canEdit && toggle.mutate({ id: a.id, enabled: !a.enabled })}
              />
              <div className="grow">
                <div className="title">{a.name}</div>
                <div className="sub">
                  <span title={a.schedule}>{describeCron(a.schedule)}</span>
                  {a.enabled && (() => {
                    const next = nextCronRun(a.schedule);
                    return next ? (
                      <>
                        {" · next "}
                        {relativeFuture(next.toISOString())}
                      </>
                    ) : null;
                  })()}
                  {a.lastRunAt && (
                    <>
                      {" · last ran "}
                      {relativeTime(a.lastRunAt)}
                      {a.lastSessionId && (
                        <>
                          {" · "}
                          <Link
                            to={`/sessions/${a.lastSessionId}`}
                            style={{ color: "var(--accent-text)" }}
                          >
                            view session →
                          </Link>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
              {canEdit && (
                <button
                  className="btn"
                  disabled={run.isPending}
                  onClick={() => run.mutate(a.id)}
                >
                  {run.isPending ? "Running…" : "Run now"}
                </button>
              )}
              {canEdit && (
                <button
                  className="btn"
                  onClick={() => {
                    setEditForm({
                      name: a.name,
                      schedule: a.schedule,
                      prompt: a.prompt,
                    });
                    setEditing(a.id);
                  }}
                >
                  Edit
                </button>
              )}
              {canEdit && (
                <button className="btn danger" onClick={() => remove.mutate(a.id)}>
                  Delete
                </button>
              )}
            </div>
          ),
        )}
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
            {isValidCron(form.schedule) ? (
              <span className="hint">
                {describeCron(form.schedule)}
                {(() => {
                  const next = nextCronRun(form.schedule);
                  return next ? ` · next occurrence ${relativeFuture(next.toISOString())}` : "";
                })()}
              </span>
            ) : (
              <span className="hint" style={{ color: "var(--amber)" }}>
                Not a valid 5-field cron (minute hour day-of-month month weekday).
              </span>
            )}
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
            disabled={!form.name.trim() || !isValidCron(form.schedule) || create.isPending}
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
  const setGating = useMutation({
    mutationFn: ({ id, gating }: { id: string; gating: boolean }) =>
      api.updateSuite(id, { gating }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["suites", agentId] }),
  });
  const trust = useQuery({
    queryKey: ["trust", agentId],
    queryFn: () => api.agentTrust(agentId),
  });
  const resolve = useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: "upheld" | "overturned" }) =>
      api.resolveEvalResult(id, outcome),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["trust", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["criteria", agentId] });
    },
  });

  const measured = (criteria.data?.criteria ?? []).filter((c) => c.passRate !== null);
  const evaluatedSessions = (criteria.data?.criteria ?? []).reduce(
    (sum, c) => Math.max(sum, c.sessionCount),
    0,
  );
  const overall =
    measured.length > 0
      ? Math.round(measured.reduce((sum, c) => sum + (c.passRate ?? 0), 0) / measured.length)
      : null;

  return (
    <>
      <p className="page-subtitle">
        Criteria are evaluated live against real sessions; suites are offline
        test cases. Gating suites run automatically before any behavior
        change ships — a regression blocks the save. Track record is
        evidence in access decisions.
      </p>

      <div
        className="card"
        style={{
          padding: 14,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 22,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              color:
                overall === null
                  ? "var(--text-muted)"
                  : overall >= 90
                    ? "var(--green)"
                    : overall >= 70
                      ? "var(--blue)"
                      : "var(--amber)",
            }}
          >
            {overall !== null ? `${overall}%` : "—"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>overall pass rate</div>
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{evaluatedSessions}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>sessions judged</div>
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>
            {suites.data?.suites.length ?? 0}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>suites</div>
        </div>
        <div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              color:
                (trust.data?.scopeViolations30d ?? 0) > 0
                  ? "var(--amber)"
                  : "var(--green)",
            }}
          >
            {trust.data?.scopeViolations30d ?? 0}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            scope violation{(trust.data?.scopeViolations30d ?? 0) === 1 ? "" : "s"} · 30d
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ textAlign: "right" }}>
          <Link to="/stats" style={{ fontSize: 12, color: "var(--accent-text)" }}>
            View in Stats →
          </Link>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 4 }}>
            judge: {trust.data?.judgeModel ?? "—"}
            {" · "}
            {trust.data?.openReviews.length ?? 0} in spot-check queue
          </div>
        </div>
      </div>

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
              <>
                <span
                  className={`chip ${c.passRate >= 90 ? "green" : c.passRate >= 70 ? "blue" : "amber"}`}
                >
                  {c.passRate}% · {count(c.sessionCount, "session")}
                </span>
                {c.trendDelta !== null && c.trendDelta !== 0 && (
                  <span
                    className={`chip ${c.trendDelta > 0 ? "green" : "amber"}`}
                    title="Pass rate: last 30 days vs the 30 before"
                  >
                    {c.trendDelta > 0 ? "+" : ""}
                    {c.trendDelta}% vs prior
                  </span>
                )}
              </>
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

      {(trust.data?.openReviews.length ?? 0) > 0 && (
        <>
          <div className="sidebar-title" style={{ padding: "14px 0 8px" }}>
            Spot-check queue
          </div>
          <div className="row-group" style={{ marginBottom: 12 }}>
            {trust.data!.openReviews.map((r) => (
              <div className="row" key={r.id}>
                <span className={`chip ${r.passed ? "green" : "amber"}`}>
                  {r.passed ? "PASS" : "FAIL"}
                </span>
                <div className="grow">
                  <div className="title">{r.criterionName}</div>
                  <div className="sub">
                    "{r.sessionTitle}" · judge said: {r.reasoning || "—"}
                  </div>
                </div>
                {canEdit && (
                  <>
                    <button
                      className="btn"
                      disabled={resolve.isPending}
                      title="The judge was right — keep the verdict"
                      onClick={() => resolve.mutate({ id: r.id, outcome: "upheld" })}
                    >
                      Uphold
                    </button>
                    <button
                      className="btn danger"
                      disabled={resolve.isPending}
                      title="The judge was wrong — flip the verdict"
                      onClick={() => resolve.mutate({ id: r.id, outcome: "overturned" })}
                    >
                      Overturn
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}

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
                {count(s.caseCount, "case")}
                {s.lastRun
                  ? ` · last run ${s.lastRun.passed}/${s.lastRun.total} passed`
                  : " · never run"}
              </div>
            </div>
            {canEdit && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--text-dim)",
                  cursor: "pointer",
                }}
                title="Gating suites must pass before changes to this agent ship"
              >
                <input
                  type="checkbox"
                  checked={s.gating}
                  onChange={(e) => setGating.mutate({ id: s.id, gating: e.target.checked })}
                />
                gating
              </label>
            )}
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
  const agent = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });
  const domain = domains.data?.domains.find(
    (d) => d.id === agent.data?.agent.domainId,
  );

  return (
    <>
      <p className="page-subtitle">
        Who can use, configure, and administer this agent. Direct grants plus
        grants inherited from its domain. There is no owner — rights come only
        from grants.
      </p>
      {domain ? (
        <div
          className="card"
          style={{
            padding: 12,
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12.5,
            color: "var(--text-dim)",
          }}
        >
          <span className="chip purple">domain</span>
          <span className="grow">
            This agent is in <strong>{domain.name}</strong> — grants on the
            domain reach it too.
          </span>
          <Link to={`/domains/${domain.id}`} style={{ color: "var(--accent-text)" }}>
            Edit domain grants →
          </Link>
        </div>
      ) : (
        <div
          className="card"
          style={{
            padding: 12,
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12.5,
            color: "var(--text-dim)",
          }}
        >
          <span className="chip">no domain</span>
          <span className="grow">
            Not in a domain — access here is direct grants only. Adding it to a
            domain lets team access flow in automatically.
          </span>
          <Link to={`/agents/${agentId}`} style={{ color: "var(--accent-text)" }}>
            + Add to domain
          </Link>
        </div>
      )}
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
