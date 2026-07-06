import type { ConnectionRole, ModelProtocol, OrgSettings } from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { api } from "../api";
import { GrantEditor } from "./AgentsSection";
import { relativeTime } from "../lib/time";

const ADMIN_PAGES = [
  { key: "connections", label: "Connections" },
  { key: "mcp", label: "MCP servers" },
  { key: "models", label: "Models" },
  { key: "api-keys", label: "API keys" },
  { key: "audit", label: "Audit log" },
  { key: "settings", label: "Settings" },
];

export function AdminSection() {
  const { page } = useParams();

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-title">Admin</div>
        {ADMIN_PAGES.map((p) => (
          <NavLink
            key={p.key}
            to={`/admin/${p.key}`}
            className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
          >
            <span className="label">{p.label}</span>
          </NavLink>
        ))}
      </aside>
      <main className="main-pane">
        {page === "connections" && <ConnectionsPage />}
        {page === "mcp" && <McpServersPage />}
        {page === "models" && <ModelsPage />}
        {page === "api-keys" && <ApiKeysPage />}
        {page === "audit" && <AuditPage />}
        {page === "settings" && <SettingsPage />}
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const VENDORS = ["slack", "github", "linear", "datadog", "pagerduty"];

/** Simple brand tiles — a letterform glyph on the vendor's accent. */
const VENDOR_TILES: Record<string, { glyph: string; bg: string }> = {
  slack: { glyph: "#", bg: "#4A154B" },
  github: { glyph: "", bg: "#24292f" },
  linear: { glyph: "◫", bg: "#5E6AD2" },
  datadog: { glyph: "🐾", bg: "#632CA6" },
  pagerduty: { glyph: "◉", bg: "#06AC38" },
};

function VendorTile({ vendor }: { vendor: string }) {
  const tile = VENDOR_TILES[vendor];
  return (
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
        color: "#fff",
        background: tile?.bg ?? "var(--surface-tool)",
      }}
    >
      {tile?.glyph || vendor[0]?.toUpperCase()}
    </span>
  );
}

function ConnectionsPage() {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const [showAdd, setShowAdd] = useState(false);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });

  return (
    <div className="content-col">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="page-title">Connections</h1>
          <p className="page-subtitle">
            First-party platform connections. A vendor can host multiple apps;
            each connection plays one or more roles. Distinct from MCP servers
            (pure tool endpoints).
          </p>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}>
          + Add connection
        </button>
      </div>
      {(() => {
        const byVendor = new Map<string, NonNullable<typeof connections.data>["connections"]>();
        for (const c of connections.data?.connections ?? []) {
          const list = byVendor.get(c.vendor) ?? [];
          list.push(c);
          byVendor.set(c.vendor, list);
        }
        return [...byVendor.entries()].map(([vendor, list]) => (
          <div key={vendor} style={{ marginBottom: 18 }}>
            <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
              {vendor}
            </div>
            <div className="row-group">
              {list.map((c) => (
                <div className="row" key={c.id}>
                  <VendorTile vendor={c.vendor} />
                  <span
                    className="status-dot"
                    style={{
                      background:
                        c.status === "connected"
                          ? "var(--green)"
                          : c.status === "needs-auth"
                            ? "var(--amber)"
                            : "var(--red)",
                    }}
                  />
                  <div className="grow">
                    <div className="title">{c.name}</div>
                    <div className="sub mono">
                      {c.baseUrl || `${vendor} default endpoint`}
                    </div>
                  </div>
                  {c.roles.map((r) => (
                    <span
                      key={r}
                      className={`chip ${r === "Interface" ? "blue" : r === "Automation" ? "purple" : "green"}`}
                    >
                      {r}
                    </span>
                  ))}
                  {c.agentCount > 0 && (
                    <span className="chip" title="Agents reachable through this connection">
                      {c.agentCount} agent{c.agentCount === 1 ? "" : "s"}
                    </span>
                  )}
                  {c.tunnel && (
                    <span className="chip purple" title="Reached through a private tunnel">
                      tunnel
                    </span>
                  )}
                  <span className={`chip ${c.status === "connected" ? "green" : "amber"}`}>
                    {c.status}
                  </span>
                  <button
                    className="btn danger"
                    onClick={() => {
                      if (confirm(`Remove connection "${c.name}"?`)) remove.mutate(c.id);
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        ));
      })()}
      {connections.data?.connections.length === 0 && (
        <div className="row-group">
          <div className="row">
            <div className="sub">No connections yet.</div>
          </div>
        </div>
      )}
      {showAdd && <AddConnectionModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function AddConnectionModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    vendor: "slack",
    name: "",
    roles: ["Interface"] as ConnectionRole[],
    baseUrl: "",
    token: "",
    signingSecret: "",
    tunnel: false,
  });
  const create = useMutation({
    mutationFn: () =>
      api.createConnection({
        vendor: form.vendor,
        name: form.name,
        roles: form.roles,
        baseUrl: form.baseUrl.trim() || null,
        token: form.token || undefined,
        signingSecret: form.signingSecret || undefined,
        tunnel: form.tunnel,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["connections"] });
      onClose();
    },
  });

  const toggleRole = (role: ConnectionRole) =>
    setForm((f) => ({
      ...f,
      roles: f.roles.includes(role)
        ? f.roles.filter((r) => r !== role)
        : [...f.roles, role],
    }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add connection</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (form.name.trim() && form.roles.length > 0) create.mutate();
          }}
        >
          <div className="field">
            <label>Vendor</label>
            <select
              value={form.vendor}
              onChange={(e) => setForm({ ...form, vendor: e.target.value })}
            >
              {VENDORS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Name</label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Acme Slack"
            />
          </div>
          <div className="field">
            <label>Roles</label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["Interface", "Automation", "Tools"] as const).map((r) => (
                <button
                  type="button"
                  key={r}
                  className={`chip ${form.roles.includes(r) ? "blue" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleRole(r)}
                >
                  {form.roles.includes(r) ? "✓ " : ""}
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>API base URL (optional)</label>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://slack.com"
            />
            <span className="hint">Override to point at a proxy or emulator.</span>
          </div>
          <div className="field">
            <label>Token (optional)</label>
            <input
              type="password"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
          </div>
          {form.vendor === "slack" && (
            <div className="field">
              <label>Signing secret (optional)</label>
              <input
                type="password"
                placeholder="Slack app signing secret"
                value={form.signingSecret}
                onChange={(e) => setForm({ ...form, signingSecret: e.target.value })}
              />
              <span className="hint">
                Lets Slack deliver channel messages to agents — verify inbound
                events from your Slack app.
              </span>
            </div>
          )}
          <div className="field">
            <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={form.tunnel}
                onChange={(e) => setForm({ ...form, tunnel: e.target.checked })}
              />
              Reached through a private tunnel
            </label>
            <span className="hint">
              For self-hosted vendors behind a VPN or bastion — shown as a chip
              on the connection.
            </span>
          </div>
          {create.isError && <p className="error-text">{(create.error as Error).message}</p>}
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

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

function McpServersPage() {
  const queryClient = useQueryClient();
  const servers = useQuery({ queryKey: ["mcp-servers"], queryFn: api.listMcpServers });
  const [showAdd, setShowAdd] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMcpServer(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });
  const refresh = useMutation({
    mutationFn: (id: string) => api.refreshMcpServer(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  const selected = servers.data?.servers.find((s) => s.id === detail);

  return (
    <div className="content-col">
      {selected ? (
        <>
          <button className="btn" style={{ marginBottom: 16 }} onClick={() => setDetail(null)}>
            ‹ MCP servers
          </button>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <h1 className="page-title">{selected.name}</h1>
              <p className="page-subtitle mono">{selected.url}</p>
            </div>
            <button
              className="btn"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate(selected.id)}
            >
              {refresh.isPending ? "Testing…" : "Test connection"}
            </button>
          </div>
          {refresh.isError && (
            <p className="error-text">{(refresh.error as Error).message}</p>
          )}
          <div
            className="card"
            style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap" }}
          >
            <span className={`chip ${selected.status === "connected" ? "green" : "amber"}`}>
              {selected.status}
            </span>
            <span className="chip">{selected.category}</span>
            <span className="chip blue">{selected.tools.length} tools</span>
            <span style={{ fontSize: 12, color: "var(--text-dim)", alignSelf: "center" }}>
              Test connection re-discovers the tool catalog. Enablement and
              service/user auth are set per agent on its MCP tab.
            </span>
          </div>
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Tools
          </div>
          <div className="row-group" style={{ marginBottom: 18 }}>
            {selected.tools.map((t) => (
              <div className="row" key={t.name}>
                <div className="grow">
                  <div className="title mono" style={{ fontSize: 12 }}>
                    {t.name}
                  </div>
                  <div className="sub">{t.description}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Used by
          </div>
          {selected.usedBy.length > 0 ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {selected.usedBy.map((a) => (
                <span key={a.id} className="chip" style={{ gap: 6 }}>
                  {a.name}
                  <Link to={`/agents/${a.id}/mcp`} style={{ color: "var(--accent-text)" }}>
                    configure →
                  </Link>
                </span>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Not attached to any agent yet.
            </p>
          )}
        </>
      ) : (
        <>
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}
          >
            <div>
              <h1 className="page-title">MCP servers</h1>
              <p className="page-subtitle">
                Pure tool endpoints, defined once and reused across agents.
              </p>
            </div>
            <button className="btn" onClick={() => setShowAdd(true)}>
              + Add server
            </button>
          </div>
          <div className="row-group">
            {servers.data?.servers.map((s) => (
              <div
                className="row"
                key={s.id}
                style={{ cursor: "pointer" }}
                onClick={() => setDetail(s.id)}
              >
                <span
                  className="status-dot"
                  style={{
                    background: s.status === "connected" ? "var(--green)" : "var(--red)",
                  }}
                />
                <div className="grow">
                  <div className="title">{s.name}</div>
                  <div className="sub mono">{s.url}</div>
                </div>
                <span className="chip">{s.category}</span>
                <span className="chip blue">{s.tools.length} tools</span>
                <span className="chip purple">used by {s.usedByCount}</span>
                <button
                  className="btn danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Remove MCP server "${s.name}"?`)) remove.mutate(s.id);
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            {servers.data?.servers.length === 0 && (
              <div className="row">
                <div className="sub">No MCP servers registered.</div>
              </div>
            )}
          </div>
        </>
      )}
      {showAdd && <AddMcpServerModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function AddMcpServerModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", url: "", category: "Tools", token: "" });
  const create = useMutation({
    mutationFn: () =>
      api.createMcpServer({
        name: form.name,
        url: form.url,
        category: form.category,
        token: form.token || undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      onClose();
    },
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add MCP server</h2>
        <p className="page-subtitle">
          Rabble connects, discovers the tool list, and adds it to the library.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="field">
            <label>Name</label>
            <input
              autoFocus
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="GitHub"
            />
          </div>
          <div className="field">
            <label>URL</label>
            <input
              required
              className="mono"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://mcp.example.com/mcp"
            />
          </div>
          <div className="field">
            <label>Category</label>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {["Code", "Project", "Comms", "Ops", "Internal", "Tools"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Bearer token (optional)</label>
            <input
              type="password"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
          </div>
          {create.isError && <p className="error-text">{(create.error as Error).message}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={create.isPending}>
              {create.isPending ? "Connecting…" : "+ Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models (unchanged behavior from the first slice)
// ---------------------------------------------------------------------------

function ModelsPage() {
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.modelCatalog });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providerStatus });
  const [showCustom, setShowCustom] = useState(false);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [openModel, setOpenModel] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
  };

  const setKey = useMutation({
    mutationFn: (provider: string) =>
      api.setProviderKey({ provider, apiKey: keyDraft[provider] ?? "" }),
    onSuccess: (_data, provider) => {
      setKeyDraft((d) => ({ ...d, [provider]: "" }));
      refresh();
    },
  });
  const enable = useMutation({ mutationFn: api.enableBuiltIn, onSuccess: refresh });
  const removeModel = useMutation({ mutationFn: api.deleteModel, onSuccess: refresh });

  const registered = models.data?.models ?? [];
  const registeredCatalogIds = new Set(
    registered.filter((m) => m.catalogId).map((m) => m.catalogId),
  );

  return (
    <div className="content-col">
      <h1 className="page-title">Models</h1>
      <p className="page-subtitle">
        Built-in models use one provider key for the whole org. Custom models
        bring their own key and can point at any compatible endpoint or gateway.
      </p>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Provider keys
      </div>
      <div className="row-group" style={{ marginBottom: 26 }}>
        {providers.data?.providers.map((p) => (
          <div className="row" key={p.provider}>
            <div className="grow">
              <div className="title mono">{p.provider}</div>
              <div className="sub">
                {p.configured
                  ? p.fromEnv
                    ? "Configured via server environment"
                    : "Key configured"
                  : "No key configured — built-in models won't run"}
              </div>
            </div>
            <span className={`chip ${p.configured ? "green" : "amber"}`}>
              {p.configured ? "configured" : "missing"}
            </span>
            <input
              type="password"
              placeholder={p.configured ? "Replace key…" : "Paste API key…"}
              value={keyDraft[p.provider] ?? ""}
              onChange={(e) => setKeyDraft((d) => ({ ...d, [p.provider]: e.target.value }))}
              style={{ width: 180 }}
            />
            <button
              className="btn"
              disabled={!keyDraft[p.provider] || setKey.isPending}
              onClick={() => setKey.mutate(p.provider)}
            >
              Save
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Built-in catalog
      </div>
      <div className="row-group" style={{ marginBottom: 26 }}>
        {catalog.data?.catalog.map((c) => {
          const isRegistered = registeredCatalogIds.has(c.catalogId);
          return (
            <div className="row" key={c.catalogId}>
              <div className="grow">
                <div className="title">{c.displayName}</div>
                <div className="sub">{c.description}</div>
              </div>
              <span className="chip blue">built-in</span>
              {isRegistered ? (
                <span className="chip green">enabled</span>
              ) : (
                <button
                  className="btn"
                  disabled={enable.isPending}
                  onClick={() => enable.mutate(c.catalogId)}
                >
                  Enable
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div className="sidebar-title" style={{ padding: 0 }}>
          Registered models
        </div>
        <button className="btn" onClick={() => setShowCustom(true)}>
          + Add custom model
        </button>
      </div>
      <div className="row-group">
        {registered.map((m) => (
          <div key={m.id}>
            <div
              className="row"
              style={{ cursor: "pointer" }}
              onClick={() => setOpenModel(openModel === m.id ? null : m.id)}
            >
              <div className="grow">
                <div className="title">{m.displayName}</div>
                <div className="sub mono">
                  {m.modelId}
                  {m.baseUrl ? ` · ${m.baseUrl}` : ""}
                </div>
              </div>
              {m.usedBy.length > 0 && (
                <span className="chip">
                  {m.usedBy.length} agent{m.usedBy.length === 1 ? "" : "s"}
                </span>
              )}
              {!m.canUse && <span className="chip amber">restricted</span>}
              <span className={`chip ${m.kind === "built-in" ? "blue" : "purple"}`}>{m.kind}</span>
              <button
                className="btn danger"
                disabled={removeModel.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Remove model "${m.displayName}"?`)) removeModel.mutate(m.id);
                }}
              >
                Remove
              </button>
            </div>
            {openModel === m.id && <ModelDetail model={m} />}
          </div>
        ))}
        {registered.length === 0 && (
          <div className="row">
            <div className="sub">
              No models registered yet — enable a built-in model or add a custom one.
            </div>
          </div>
        )}
      </div>

      {showCustom && (
        <CustomModelModal onClose={() => setShowCustom(false)} onDone={refresh} />
      )}
    </div>
  );
}

function ModelDetail({
  model,
}: {
  model: { id: string; displayName: string; usedBy: string[] };
}) {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: ["grants", "model", model.id],
    queryFn: () => api.listGrants("model", model.id),
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.listTeams });
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const agentIdByName = new Map(
    (agents.data?.agents ?? []).map((a) => [a.name, a.id]),
  );

  return (
    <div
      className="card"
      style={{ padding: 16, margin: "6px 0 10px", background: "var(--surface-group)" }}
    >
      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Used by
      </div>
      {model.usedBy.length > 0 ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {model.usedBy.map((name) => {
            const agentId = agentIdByName.get(name);
            return (
              <span key={name} className="chip" style={{ gap: 6 }}>
                {name}
                {agentId && (
                  <Link to={`/agents/${agentId}`} style={{ color: "var(--accent-text)" }}>
                    configure →
                  </Link>
                )}
              </span>
            );
          })}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
          No agents run on this model yet.
        </p>
      )}
      <p className="page-subtitle" style={{ marginBottom: 8 }}>
        With no grants, every member can put agents on this model. Add a grant
        to restrict it — then only the grantees (and org admins) can.
      </p>
      <GrantEditor
        targetType="model"
        targetId={model.id}
        grants={grants.data?.grants ?? []}
        teams={teams.data?.teams ?? []}
        users={users.data?.users ?? []}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ["grants", "model", model.id] });
          void queryClient.invalidateQueries({ queryKey: ["models"] });
        }}
      />
    </div>
  );
}

function CustomModelModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    displayName: "",
    protocol: "anthropic" as ModelProtocol,
    baseUrl: "",
    modelId: "",
    apiKey: "",
    priceIn: "",
    priceOut: "",
  });
  const create = useMutation({
    mutationFn: () =>
      api.createCustomModel({
        displayName: form.displayName,
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim() || null,
        modelId: form.modelId,
        apiKey: form.apiKey,
        priceInputPerMtok: form.priceIn ? Number(form.priceIn) : null,
        priceOutputPerMtok: form.priceOut ? Number(form.priceOut) : null,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add custom model</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="field">
            <label>Display name</label>
            <input
              autoFocus
              required
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              placeholder="My gateway Sonnet"
            />
          </div>
          <div className="field">
            <label>Protocol</label>
            <div className="segmented">
              {(["anthropic", "openai"] as const).map((p) => (
                <button
                  type="button"
                  key={p}
                  className={form.protocol === p ? "active" : ""}
                  onClick={() => setForm({ ...form, protocol: p })}
                >
                  {p === "anthropic" ? "Anthropic" : "OpenAI-compatible"}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Base URL (optional)</label>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://my-gateway.example.com"
            />
            <span className="hint">Leave blank to use the provider's default endpoint.</span>
          </div>
          <div className="field">
            <label>Model ID</label>
            <input
              required
              className="mono"
              value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })}
              placeholder="claude-sonnet-5"
            />
          </div>
          <div className="field">
            <label>API key</label>
            <input
              required
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Input $ / MTok (optional)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="3.00"
                value={form.priceIn}
                onChange={(e) => setForm({ ...form, priceIn: e.target.value })}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Output $ / MTok (optional)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="15.00"
                value={form.priceOut}
                onChange={(e) => setForm({ ...form, priceOut: e.target.value })}
              />
            </div>
          </div>
          <span className="hint" style={{ display: "block", marginTop: -6, marginBottom: 10 }}>
            Powers the Usage &amp; spend dashboard. Leave blank to exclude this
            model from $ figures.
          </span>
          {create.isError && <p className="error-text">{(create.error as Error).message}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={create.isPending}>
              Add model
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function ApiKeysPage() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: api.listApiKeys });
  const [form, setForm] = useState({ name: "", scope: "read" as "read" | "write" | "admin" });
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createApiKey(form),
    onSuccess: (result) => {
      setFreshToken(result.token);
      setForm({ name: "", scope: "read" });
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  return (
    <div className="content-col">
      <h1 className="page-title">API keys</h1>
      <p className="page-subtitle">Programmatic access to the platform API.</p>

      {freshToken && (
        <div
          className="card"
          style={{ padding: 14, marginBottom: 16, borderColor: "rgba(52,211,153,0.4)" }}
        >
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            Copy this key now — it won't be shown again.
          </div>
          <code className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
            {freshToken}
          </code>
          <div style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => setFreshToken(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <div className="row-group" style={{ marginBottom: 16 }}>
        {keys.data?.keys.map((k) => (
          <div className="row" key={k.id}>
            <div className="grow">
              <div className="title">{k.name}</div>
              <div className="sub mono">
                {k.prefix}_•••••••• · created {relativeTime(k.createdAt)} by{" "}
                {k.createdByName ?? "?"} ·{" "}
                {k.lastUsedAt
                  ? `last used ${relativeTime(k.lastUsedAt)}`
                  : "never used"}
              </div>
            </div>
            <span
              className={`chip ${k.scope === "admin" ? "purple" : k.scope === "write" ? "blue" : "green"}`}
            >
              {k.scope}
            </span>
            {!k.lastUsedAt && !k.revokedAt && (
              <span className="chip" title="This key has never authenticated a request">
                unused
              </span>
            )}
            {k.revokedAt ? (
              <span className="chip amber">revoked</span>
            ) : (
              <button className="btn danger" onClick={() => revoke.mutate(k.id)}>
                Revoke
              </button>
            )}
          </div>
        ))}
        {keys.data?.keys.length === 0 && (
          <div className="row">
            <div className="sub">No API keys.</div>
          </div>
        )}
        <div className="row">
          <input
            placeholder="Key name, e.g. CI pipeline"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={{ flex: 1 }}
          />
          <div className="segmented">
            {(["read", "write", "admin"] as const).map((s) => (
              <button
                key={s}
                className={form.scope === s ? "active" : ""}
                onClick={() => setForm({ ...form, scope: s })}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={!form.name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            + Create key
          </button>
        </div>
      </div>
      {(create.isError || revoke.isError) && (
        <p className="error-text">{((create.error ?? revoke.error) as Error).message}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function AuditPage() {
  const [filter, setFilter] = useState("");
  const audit = useQuery({
    queryKey: ["audit", filter],
    queryFn: () => api.listAudit(filter || undefined),
  });

  return (
    <div className="content-col" style={{ maxWidth: 880 }}>
      <h1 className="page-title">Audit log</h1>
      <p className="page-subtitle">
        Control-plane state changes only — session transcripts live on sessions.
      </p>
      <div className="filter-bar" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All actions</option>
          {[
            "agent",
            "grant",
            "team",
            "domain",
            "model",
            "mcp",
            "connection",
            "api-key",
            "eval",
            "member",
            "org",
          ].map((a) => (
            <option key={a} value={a}>
              {a}.*
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <a
          className="btn"
          href={`/api/audit?format=csv${filter ? `&action=${encodeURIComponent(filter)}` : ""}`}
          download
        >
          Export CSV
        </a>
      </div>
      <div className="row-group">
        {audit.data?.events.map((e) => {
          const category = e.action.split(".")[0] ?? "";
          const chipColor =
            category === "grant" || category === "member"
              ? "purple"
              : category === "agent"
                ? "blue"
                : category === "eval"
                  ? "green"
                  : category === "org" || category === "api-key"
                    ? "amber"
                    : "";
          return (
            <div className="row" key={e.id}>
              <span
                className="rail-logo"
                title={e.actorName ?? "system"}
                style={{
                  width: 26,
                  height: 26,
                  fontSize: 10,
                  marginBottom: 0,
                  background: e.actorName ? "var(--surface-tool)" : "var(--purple)",
                  color: "var(--text-2)",
                  flexShrink: 0,
                }}
              >
                {(e.actorName ?? "sys")
                  .split(/\s+/)
                  .map((part) => part[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()}
              </span>
              <div className="grow">
                <div className="title" style={{ fontWeight: 400 }}>
                  {e.summary}
                </div>
                <div className="sub mono">{e.action}</div>
              </div>
              <span className={`chip ${chipColor}`}>{category}</span>
              <span
                style={{ fontSize: 11.5, color: "var(--text-muted)", width: 84, textAlign: "right" }}
                title={new Date(e.createdAt).toLocaleString()}
              >
                {relativeTime(e.createdAt)}
              </span>
            </div>
          );
        })}
        {audit.data?.events.length === 0 && (
          <div className="row">
            <div className="sub">No events match.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function OrgPolicies({ settings }: { settings: OrgSettings }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<OrgSettings>(settings);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => api.updateOrgSettings(draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    },
  });

  return (
    <>
      <div className="sidebar-title" style={{ padding: "14px 0 8px" }}>
        Policies
      </div>
      <div className="row-group" style={{ marginBottom: 12 }}>
        <div className="row">
          <div className="grow">
            <div className="title">Who can create agents</div>
            <div className="sub">
              "Designated" restricts creation to org admins and the owner.
            </div>
          </div>
          <div className="segmented">
            {(
              [
                ["everyone", "Everyone"],
                ["designated", "Designated"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={draft.whoCanCreateAgents === value ? "active" : ""}
                onClick={() => setDraft({ ...draft, whoCanCreateAgents: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span
            className={`toggle${draft.requireApprovalForUserTools ? " on" : ""}`}
            style={{ cursor: "pointer" }}
            onClick={() =>
              setDraft({
                ...draft,
                requireApprovalForUserTools: !draft.requireApprovalForUserTools,
              })
            }
          />
          <div className="grow">
            <div className="title">Always require approval for user-auth tools</div>
            <div className="sub">
              An org-wide floor: overrides personal "trust" and "once per
              session" postures.
            </div>
          </div>
        </div>
        <div className="row">
          <div className="grow">
            <div className="title">Session retention</div>
            <div className="sub">How long transcripts are kept (days).</div>
          </div>
          <input
            type="number"
            min={7}
            max={3650}
            value={draft.retentionDays}
            onChange={(e) =>
              setDraft({ ...draft, retentionDays: Number(e.target.value) || 7 })
            }
            style={{ width: 90 }}
          />
        </div>
      </div>
      <button
        className="btn primary"
        disabled={save.isPending}
        onClick={() => save.mutate()}
      >
        {saved ? "Saved ✓" : "Save policies"}
      </button>
      {save.isError && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {(save.error as Error).message}
        </p>
      )}
    </>
  );
}

function SettingsPage() {
  const queryClient = useQueryClient();
  const org = useQuery({ queryKey: ["org"], queryFn: api.getOrg });
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  const [orgName, setOrgName] = useState<string | null>(null);
  const [invite, setInvite] = useState({ name: "", email: "", role: "member" as "admin" | "member" });
  const [tempCredentials, setTempCredentials] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const rename = useMutation({
    mutationFn: () => api.renameOrg(orgName!),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["org"] }),
  });
  const updateMember = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: "admin" | "member"; active?: boolean }) =>
      api.updateMember(id, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["users"] }),
  });
  const doInvite = useMutation({
    mutationFn: () => api.inviteMember(invite),
    onSuccess: (result) => {
      setTempCredentials({ email: result.user.email, password: result.tempPassword });
      setInvite({ name: "", email: "", role: "member" });
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const name = orgName ?? org.data?.org.name ?? "";

  return (
    <div className="content-col">
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Organization and members.</p>

      <div className="field" style={{ maxWidth: 420 }}>
        <label>Organization name</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={name} onChange={(e) => setOrgName(e.target.value)} style={{ flex: 1 }} />
          <button
            className="btn primary"
            disabled={rename.isPending || !name.trim()}
            onClick={() => rename.mutate()}
          >
            Save
          </button>
        </div>
      </div>

      {org.data && <OrgPolicies settings={org.data.org.settings} />}

      <div className="sidebar-title" style={{ padding: "14px 0 8px" }}>
        Members
      </div>
      {tempCredentials && (
        <div
          className="card"
          style={{ padding: 14, marginBottom: 12, borderColor: "rgba(52,211,153,0.4)" }}
        >
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            Share these sign-in details — the temporary password won't be shown again.
          </div>
          <code className="mono" style={{ fontSize: 12 }}>
            {tempCredentials.email} / {tempCredentials.password}
          </code>
          <div style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => setTempCredentials(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      <div className="row-group">
        {users.data?.users.map((u) => (
          <div className="row" key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
            <div className="grow">
              <div className="title">{u.name}</div>
              <div className="sub mono">{u.email}</div>
            </div>
            {!u.active && <span className="chip amber">deactivated</span>}
            {u.role === "owner" ? (
              <span className="chip purple">owner</span>
            ) : (
              <>
                <div className="segmented">
                  {(["member", "admin"] as const).map((r) => (
                    <button
                      key={r}
                      className={u.role === r ? "active" : ""}
                      disabled={updateMember.isPending}
                      onClick={() =>
                        u.role !== r && updateMember.mutate({ id: u.id, role: r })
                      }
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <button
                  className={u.active ? "btn danger" : "btn"}
                  disabled={updateMember.isPending}
                  onClick={() => {
                    if (
                      !u.active ||
                      confirm(`Deactivate ${u.name}? They can't sign in until reactivated.`)
                    ) {
                      updateMember.mutate({ id: u.id, active: !u.active });
                    }
                  }}
                >
                  {u.active ? "Deactivate" : "Reactivate"}
                </button>
              </>
            )}
          </div>
        ))}
        <div className="row">
          <input
            placeholder="Name"
            value={invite.name}
            onChange={(e) => setInvite({ ...invite, name: e.target.value })}
            style={{ width: 140 }}
          />
          <input
            placeholder="Email"
            type="email"
            value={invite.email}
            onChange={(e) => setInvite({ ...invite, email: e.target.value })}
            style={{ flex: 1 }}
          />
          <div className="segmented">
            {(["member", "admin"] as const).map((r) => (
              <button
                key={r}
                className={invite.role === r ? "active" : ""}
                onClick={() => setInvite({ ...invite, role: r })}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={!invite.name.trim() || !invite.email.trim() || doInvite.isPending}
            onClick={() => doInvite.mutate()}
          >
            + Invite
          </button>
        </div>
      </div>
      {doInvite.isError && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {(doInvite.error as Error).message}
        </p>
      )}
    </div>
  );
}
