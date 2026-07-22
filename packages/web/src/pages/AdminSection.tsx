import type { Connection, ConnectionRole, ModelProtocol, OrgSettings } from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { api } from "../api";
import { EditableTitle } from "../components/EditableTitle";
import { GrantEditor } from "./AgentsSection";
import type { McpLibraryEntry } from "@rabblehq/core";
import { relativeTime, count } from "../lib/time";

const ADMIN_PAGES = [
  { key: "connections", label: "Connections" },
  { key: "mcp", label: "MCP servers" },
  { key: "models", label: "Models" },
  { key: "access-requests", label: "Access requests" },
  { key: "api-keys", label: "API keys" },
  { key: "audit", label: "Audit log" },
  { key: "settings", label: "Settings" },
];

export function AdminSection() {
  const { page } = useParams();
  const openRequests = useQuery({
    queryKey: ["access-request-count"],
    queryFn: api.accessRequestCount,
    refetchInterval: 30_000,
  });

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
            {p.key === "access-requests" && (openRequests.data?.open ?? 0) > 0 && (
              <span className="chip amber">{openRequests.data!.open}</span>
            )}
          </NavLink>
        ))}
      </aside>
      <main className="main-pane">
        {page === "connections" && <ConnectionsPage />}
        {page === "mcp" && <McpServersPage />}
        {page === "models" && <ModelsPage />}
        {page === "access-requests" && <AccessRequestsPage />}
        {page === "api-keys" && <ApiKeysPage />}
        {page === "audit" && <AuditPage />}
        {page === "settings" && <SettingsPage />}
      </main>
    </>
  );
}

function EditModelModal({
  model,
  onClose,
  onDone,
}: {
  model: {
    id: string;
    displayName: string;
    modelId: string;
    baseUrl: string | null;
    priceInputPerMtok: number | null;
    priceOutputPerMtok: number | null;
  };
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    displayName: model.displayName,
    baseUrl: model.baseUrl ?? "",
    modelId: model.modelId,
    apiKey: "",
    priceIn: model.priceInputPerMtok != null ? String(model.priceInputPerMtok) : "",
    priceOut: model.priceOutputPerMtok != null ? String(model.priceOutputPerMtok) : "",
  });
  const save = useMutation({
    mutationFn: () =>
      api.updateModel(model.id, {
        displayName: form.displayName,
        baseUrl: form.baseUrl.trim() || null,
        modelId: form.modelId,
        // Blank keeps the stored key.
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
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
        <h2>Edit {model.displayName}</h2>
        <p className="page-subtitle">
          Agents reference this model by id, so nothing re-wires when you
          change the endpoint or pricing.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="field">
            <label>Display name</label>
            <input
              required
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Base URL</label>
            <input
              className="mono"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://llm.internal.acme.dev/v1"
            />
          </div>
          <div className="field">
            <label>Model id</label>
            <input
              required
              className="mono"
              value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })}
            />
          </div>
          <div className="field">
            <label>API key (set — leave blank to keep)</label>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>$ / M input tokens</label>
              <input
                value={form.priceIn}
                onChange={(e) => setForm({ ...form, priceIn: e.target.value })}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>$ / M output tokens</label>
              <input
                value={form.priceOut}
                onChange={(e) => setForm({ ...form, priceOut: e.target.value })}
              />
            </div>
          </div>
          {save.isError && <p className="error-text">{(save.error as Error).message}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={save.isPending}>
              Save changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Access requests (the Builder's request → notify → approve loop)
// ---------------------------------------------------------------------------

function AccessRequestsPage() {
  const queryClient = useQueryClient();
  const requests = useQuery({
    queryKey: ["access-requests"],
    queryFn: api.listAccessRequests,
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["access-requests"] });
    void queryClient.invalidateQueries({ queryKey: ["access-request-count"] });
  };
  const approve = useMutation({
    mutationFn: (id: string) => api.approveAccessRequest(id),
    onSuccess: invalidate,
  });
  const deny = useMutation({
    mutationFn: (id: string) => api.denyAccessRequest(id),
    onSuccess: invalidate,
  });

  const open = requests.data?.requests.filter((r) => r.status === "open") ?? [];
  const decided = requests.data?.requests.filter((r) => r.status !== "open") ?? [];

  return (
    <div className="content-col">
      <div className="page-head">
        <div>
          <h1 className="page-title">Access requests</h1>
          <p className="page-subtitle">
            People asking for rights. Approving materializes the grant and
            records it in the audit log.
          </p>
        </div>
      </div>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Awaiting review
      </div>
      <div className="row-group" style={{ marginBottom: 18 }}>
        {open.map((r) => (
          <div className="row" key={r.id}>
            <div className="grow">
              <div className="title">
                {r.requesterName} requests <strong>{r.accessRight}</strong> on{" "}
                {r.targetType} “{r.targetName}”
              </div>
              <div className="sub">
                {r.reason || "No reason given"} · {relativeTime(r.createdAt)}
                {r.evidence && r.targetType === "agent"
                  ? ` · ${
                      r.evidence.passRate30d === null
                        ? "no track record yet"
                        : `${r.evidence.passRate30d}% pass, ${r.evidence.graded30d} graded (30d)`
                    }`
                  : ""}
                {r.via === "builder" ? " · via Builder" : ""}
              </div>
            </div>
            {r.evidence && r.evidence.scopeViolations30d > 0 && (
              <span
                className="chip amber"
                title="Times the agent tried a tool outside its governed set in the last 30 days"
              >
                {r.evidence.scopeViolations30d} scope violation
                {r.evidence.scopeViolations30d === 1 ? "" : "s"}
              </span>
            )}
            <button
              className="btn primary"
              disabled={approve.isPending}
              onClick={() => approve.mutate(r.id)}
            >
              Approve
            </button>
            <button
              className="btn danger"
              disabled={deny.isPending}
              onClick={() => deny.mutate(r.id)}
            >
              Deny
            </button>
          </div>
        ))}
        {open.length === 0 && (
          <div className="row">
            <div className="sub">Nothing waiting. Requests land here when someone (or the Builder acting for them) asks for access.</div>
          </div>
        )}
      </div>

      {decided.length > 0 && (
        <>
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Decided
          </div>
          <div className="row-group">
            {decided.map((r) => (
              <div className="row" key={r.id}>
                <div className="grow">
                  <div className="title">
                    {r.requesterName} · {r.accessRight} on {r.targetType} “
                    {r.targetName}”
                  </div>
                  <div className="sub">
                    {r.status === "approved" ? "Approved" : "Denied"} by{" "}
                    {r.decidedByName ?? "—"}
                    {r.decidedAt ? ` · ${relativeTime(r.decidedAt)}` : ""}
                  </div>
                </div>

              </div>
            ))}
          </div>
        </>
      )}
    </div>
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
        // White only reads on a brand-colored tile; the neutral fallback
        // needs theme text + a border to stay visible in light mode.
        ...(tile
          ? { color: "#fff", background: tile.bg }
          : {
              color: "var(--text-dim)",
              background: "var(--surface-tool)",
              border: "1px solid var(--border-1)",
            }),
      }}
    >
      {tile?.glyph || vendor[0]?.toUpperCase()}
    </span>
  );
}

type ConnectionRow = NonNullable<
  Awaited<ReturnType<typeof api.listConnections>>
>["connections"][number];

function ConnectionsPage() {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<ConnectionRow | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });

  return (
    <div className="content-col">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 24,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title">Connections</h1>
          <p className="page-subtitle">
            First-party platform connections. A vendor can host multiple apps;
            each connection plays one or more roles. Distinct from MCP servers
            (pure tool endpoints).
          </p>
        </div>
        <button
          className="btn"
          style={{ flexShrink: 0, whiteSpace: "nowrap" }}
          onClick={() => setShowAdd(true)}
        >
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
                    <div className="title">
                      {c.name}
                      {c.isPrimary && (
                        <span
                          className="primary-mark"
                          title="Rabble's primary connection: platform notifications go through it, and DMs to it route to the right agent by intent — Builder included."
                        >
                          ★
                        </span>
                      )}
                    </div>
                    <div className="sub">
                      {[
                        c.isPrimary ? "Primary connection" : null,
                        c.linkedAgentName ? `answers as ${c.linkedAgentName}` : null,
                        c.roles.join(", "),
                        c.hasAppToken ? "Socket Mode" : null,
                        c.tunnel ? "via tunnel" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  {c.status !== "connected" && (
                    <span className="chip amber">
                      {c.status === "needs-auth" ? "needs auth" : "error"}
                    </span>
                  )}
                  {!c.linkedAgentName && c.roles.includes("Interface") && !c.isPrimary && (
                    <span
                      className="chip amber"
                      title="Link an agent from its Surfaces tab; until then this app answers as no one"
                    >
                      no linked agent
                    </span>
                  )}
                  {c.vendor === "slack" && !c.hasAppToken && !c.hasSigningSecret && (
                    <span
                      className="chip amber"
                      title="Slack has no way to deliver channel messages to Rabble. Edit this connection to add an app-level token (Socket Mode, easiest, no public URL) or a signing secret (Events API webhooks)."
                    >
                      no event delivery
                    </span>
                  )}
                  {c.vendor === "github" && !c.hasSigningSecret && (
                    <span
                      className="chip amber"
                      title="No webhook secret. GitHub deliveries can't be verified, so issue comments never reach agents. Edit this connection to add the webhook secret."
                    >
                      no event delivery
                    </span>
                  )}
                  <button className="btn" onClick={() => setEditing(c)}>
                    Edit
                  </button>
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
        <div className="empty-slot">No connections yet.</div>
      )}
      {showAdd && <AddConnectionModal onClose={() => setShowAdd(false)} />}
      {editing && (
        <EditConnectionModal
          connection={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AddConnectionModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [vendor, setVendor] = useState("slack");
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<ConnectionRole[]>(["Interface"]);
  // Slack managed setup
  const [configToken, setConfigToken] = useState("");
  const [botName, setBotName] = useState("");
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  // Manual / advanced (non-Slack, or Slack "existing tokens")
  const [advanced, setAdvanced] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [appToken, setAppToken] = useState("");
  const [tunnel, setTunnel] = useState(false);
  const [isPrimary, setIsPrimary] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["connections"] });
  const toggleRole = (r: ConnectionRole) =>
    setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]));

  // Managed Slack: create the connection holding the config token, then have
  // Rabble create + configure the Slack app and return the install URL.
  const managed = useMutation({
    mutationFn: async () => {
      const { connection } = await api.createConnection({
        vendor: "slack",
        name: name.trim(),
        roles,
        configToken: configToken.trim(),
        isPrimary,
      });
      const res = await api.provisionSlackApp(connection.id, botName.trim());
      return res.installUrl;
    },
    onSuccess: (url) => {
      setInstallUrl(url);
      void invalidate();
    },
  });

  // Manual create: other vendors, or Slack with existing tokens.
  const create = useMutation({
    mutationFn: () =>
      api.createConnection({
        vendor,
        name: name.trim(),
        roles,
        baseUrl: baseUrl.trim() || null,
        token: token || undefined,
        signingSecret: signingSecret || undefined,
        appToken: appToken || undefined,
        tunnel,
        isPrimary,
      }),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });

  const isSlack = vendor === "slack";
  const useManaged = isSlack && !advanced;

  const VendorNameRoles = (
    <>
      <div className="field">
        <label>Vendor</label>
        <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
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
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isSlack ? "Acme Slack" : "Acme GitHub"}
        />
      </div>
      <div className="field">
        <label>Roles</label>
        <div style={{ display: "flex", gap: 6 }}>
          {(["Interface", "Automation", "Tools"] as const).map((r) => (
            <button
              type="button"
              key={r}
              className={`chip ${roles.includes(r) ? "blue" : ""}`}
              style={{ cursor: "pointer" }}
              onClick={() => toggleRole(r)}
            >
              {roles.includes(r) ? "✓ " : ""}
              {r}
            </button>
          ))}
        </div>
      </div>
      {isSlack && (
        <div className="field">
          <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />
            Use as Rabble's primary connection
          </label>
          <span className="hint">
            The org's front door: platform notifications go through it, and
            DMs to it route to the right agent automatically — including the
            Builder, so people can create and tune agents from Slack. One per
            org; you can change it any time.
          </span>
        </div>
      )}
    </>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add connection</h2>

        {installUrl ? (
          // Final step: the app is created + configured; install to grant the token.
          <div>
            <p style={{ marginBottom: 8 }}>
              ✅ Created and configured <b>{botName.trim()}</b> in Slack.
            </p>
            <p className="hint" style={{ marginBottom: 12 }}>
              Last step. Install it to your workspace. Click Allow; Rabble
              captures the bot token automatically and finishes the connection.
            </p>
            <a
              className="btn primary"
              href={installUrl}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-block", marginBottom: 12 }}
            >
              Install to Slack ↗
            </a>
            <p className="hint" style={{ marginBottom: 12 }}>
              After installing, give the app its voice: open an agent's
              Surfaces tab and link this connection. Until then it answers as
              no one.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || roles.length === 0) return;
              if (useManaged) managed.mutate();
              else create.mutate();
            }}
          >
            {VendorNameRoles}

            {useManaged ? (
              <>
                <div className="field">
                  <label>App configuration token</label>
                  <input
                    required
                    type="password"
                    placeholder="xoxe.xoxp-…"
                    value={configToken}
                    onChange={(e) => setConfigToken(e.target.value)}
                  />
                  <span className="hint">
                    Rabble uses this to create and configure your Slack app for
                    you.{" "}
                    <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
                      Generate one ↗
                    </a>
                    , below the app list, under “Your App Configuration Tokens”.
                  </span>
                </div>
                <div className="field">
                  <label>Bot name</label>
                  <input
                    required
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                    placeholder="Rabble"
                  />
                  <span className="hint">How the bot appears in Slack.</span>
                </div>
                <button
                  type="button"
                  className="link-btn"
                  style={{ background: "none", border: 0, color: "var(--blue)", cursor: "pointer", padding: 0, fontSize: 13 }}
                  onClick={() => setAdvanced(true)}
                >
                  Connect with existing tokens instead
                </button>
                {managed.isError && (
                  <p className="error-text">{(managed.error as Error).message}</p>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                  <button type="button" className="btn" onClick={onClose}>
                    Cancel
                  </button>
                  <button className="btn primary" disabled={managed.isPending}>
                    {managed.isPending ? "Creating app…" : "Create & configure"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label>API base URL (optional)</label>
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://slack.com"
                  />
                  <span className="hint">Override to point at a proxy or emulator.</span>
                </div>
                <div className="field">
                  <label>Token (optional)</label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </div>
                {(vendor === "slack" || vendor === "github") && (
                  <div className="field">
                    <label>
                      {vendor === "slack" ? "Signing secret" : "Webhook secret"} (optional)
                    </label>
                    <input
                      type="password"
                      placeholder={
                        vendor === "slack" ? "Slack app signing secret" : "GitHub webhook secret"
                      }
                      value={signingSecret}
                      onChange={(e) => setSigningSecret(e.target.value)}
                    />
                  </div>
                )}
                {vendor === "slack" && (
                  <div className="field">
                    <label>App-level token · Socket Mode (optional)</label>
                    <input
                      type="password"
                      placeholder="xapp-…"
                      value={appToken}
                      onChange={(e) => setAppToken(e.target.value)}
                    />
                  </div>
                )}
                <div className="field">
                  <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={tunnel}
                      onChange={(e) => setTunnel(e.target.checked)}
                    />
                    Reached through a private tunnel
                  </label>
                </div>
                {isSlack && (
                  <button
                    type="button"
                    style={{ background: "none", border: 0, color: "var(--blue)", cursor: "pointer", padding: 0, fontSize: 13 }}
                    onClick={() => setAdvanced(false)}
                  >
                    ← Back to managed setup
                  </button>
                )}
                {create.isError && <p className="error-text">{(create.error as Error).message}</p>}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                  <button type="button" className="btn" onClick={onClose}>
                    Cancel
                  </button>
                  <button className="btn primary" disabled={create.isPending}>
                    + Add
                  </button>
                </div>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

function EditConnectionModal({
  connection,
  onClose,
}: {
  connection: ConnectionRow;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: connection.name,
    roles: connection.roles,
    baseUrl: connection.baseUrl ?? "",
    tunnel: connection.tunnel,
    token: "",
    clearToken: false,
    signingSecret: "",
    clearSigningSecret: false,
    appToken: "",
    clearAppToken: false,
    isPrimary: connection.isPrimary ?? false,
  });
  const save = useMutation({
    mutationFn: () =>
      api.updateConnection(connection.id, {
        name: form.name,
        roles: form.roles,
        baseUrl: form.baseUrl.trim() || null,
        tunnel: form.tunnel,
        token: form.clearToken ? null : form.token || undefined,
        signingSecret: form.clearSigningSecret
          ? null
          : form.signingSecret || undefined,
        appToken: form.clearAppToken ? null : form.appToken || undefined,
        isPrimary: form.isPrimary,
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

  // Empty = keep the stored secret; type to replace; "Remove" clears it.
  const secretHint = (isSet: boolean | undefined) =>
    isSet ? "A value is set. Leave blank to keep it." : "Not set.";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Edit {connection.vendor} connection</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (form.name.trim() && form.roles.length > 0) save.mutate();
          }}
        >
          <div className="field">
            <label>Name</label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
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
          </div>
          <div className="field">
            <label>Token</label>
            <input
              type="password"
              placeholder="Leave blank to keep"
              disabled={form.clearToken}
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
            <span className="hint">{secretHint(connection.hasToken)}</span>
            {connection.hasToken && (
              <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.clearToken}
                  onChange={(e) => setForm({ ...form, clearToken: e.target.checked })}
                />
                Remove token
              </label>
            )}
          </div>
          {(connection.vendor === "slack" || connection.vendor === "github") && (
            <div className="field">
              <label>
                {connection.vendor === "slack" ? "Signing secret" : "Webhook secret"}
              </label>
              <input
                type="password"
                placeholder="Leave blank to keep"
                disabled={form.clearSigningSecret}
                value={form.signingSecret}
                onChange={(e) => setForm({ ...form, signingSecret: e.target.value })}
              />
              <span className="hint">{secretHint(connection.hasSigningSecret)}</span>
              {connection.hasSigningSecret && (
                <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={form.clearSigningSecret}
                    onChange={(e) =>
                      setForm({ ...form, clearSigningSecret: e.target.checked })
                    }
                  />
                  Remove secret
                </label>
              )}
            </div>
          )}
          {connection.vendor === "slack" && (
            <div className="field">
              <label>App-level token · Socket Mode</label>
              <input
                type="password"
                placeholder="xapp-… (leave blank to keep)"
                disabled={form.clearAppToken}
                value={form.appToken}
                onChange={(e) => setForm({ ...form, appToken: e.target.value })}
              />
              <span className="hint">
                {connection.hasAppToken
                  ? "Socket Mode is on. Leave blank to keep, type to rotate, or remove to switch back to webhooks."
                  : "Add an app-level token to stream events over a WebSocket. No public URL needed."}
              </span>
              {connection.hasAppToken && (
                <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={form.clearAppToken}
                    onChange={(e) => setForm({ ...form, clearAppToken: e.target.checked })}
                  />
                  Turn off Socket Mode (remove app token)
                </label>
              )}
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
          </div>
          {connection.vendor === "slack" && (
            <div className="field">
              <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.isPrimary}
                  onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
                />
                Rabble's primary connection
              </label>
              <span className="hint">
                Platform notifications go through the primary connection, and
                DMs to it route to the right agent by intent — Builder
                included. Promoting this one steps the current primary down.
              </span>
            </div>
          )}
          {save.isError && <p className="error-text">{(save.error as Error).message}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={save.isPending}>
              Save changes
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
  const library = useQuery({ queryKey: ["mcp-library"], queryFn: api.mcpLibrary });
  const libraryByKey = new Map(
    (library.data?.library ?? []).map((e) => [e.key, e]),
  );
  const [toolFilter, setToolFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [editingServer, setEditingServer] = useState(false);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMcpServer(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });
  const refresh = useMutation({
    mutationFn: (id: string) => api.refreshMcpServer(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });
  const donate = useMutation({
    mutationFn: (id: string) => api.donateMcpOAuth(id),
    onSuccess: ({ authorizeUrl }) => window.open(authorizeUrl, "_blank", "noopener"),
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateMcpServer(id),
    onSuccess: async ({ server }) => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      setDetail(server.id);
    },
  });
  const setDisabledTools = useMutation({
    mutationFn: ({ id, disabledTools }: { id: string; disabledTools: string[] }) =>
      api.updateMcpServer(id, { disabledTools }),
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
            {selected.libraryKey && libraryByKey.has(selected.libraryKey) && (
              <span
                className="mcp-library-glyph"
                style={{
                  background: libraryByKey.get(selected.libraryKey)!.brandColor,
                  marginTop: 2,
                }}
              >
                {libraryByKey.get(selected.libraryKey)!.glyph}
              </span>
            )}
            <div style={{ flex: 1 }}>
              <h1 className="page-title">
                <EditableTitle
                  value={selected.name}
                  onSave={async (name) => {
                    await api.updateMcpServer(selected.id, { name });
                    void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
                  }}
                />
              </h1>
              <p className="page-subtitle mono">{selected.url}</p>
            </div>
            <button className="btn" onClick={() => setEditingServer(true)}>
              Edit
            </button>
            <button
              className="btn"
              disabled={duplicate.isPending}
              title="A copy with the same endpoint but its own tool set and access scope. Credentials don't carry over."
              onClick={() => duplicate.mutate(selected.id)}
            >
              Duplicate
            </button>
            <button
              className="btn"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate(selected.id)}
            >
              {refresh.isPending ? "Testing…" : "Test connection"}
            </button>
          </div>
          {editingServer && (
            <EditMcpServerModal
              server={selected}
              onClose={() => setEditingServer(false)}
            />
          )}
          {refresh.isError && (
            <p className="error-text">{(refresh.error as Error).message}</p>
          )}
          <div
            className="card"
            style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap" }}
          >
            <span className="server-meta">
              {selected.status !== "connected" && (
                <span style={{ color: "var(--amber)" }}>unreachable · </span>
              )}
              {selected.category} ·{" "}
              {selected.credentialMode === "personal"
                ? "personal credentials"
                : selected.credentialMode === "connection"
                  ? `credential from ${selected.connectionName ?? "a deleted connection"}`
                  : "org credential"}{" "}
              · {count(selected.tools.length, "tool")}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-dim)", alignSelf: "center" }}>
              Test connection re-discovers the tool catalog. Enablement and
              service/user auth are set per agent on its MCP tab.
            </span>
          </div>
          {selected.requiresOAuth && selected.credentialMode === "shared" && (
            <div
              className="card"
              style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, alignItems: "center" }}
            >
              <span className="chip amber">OAuth</span>
              <div className="grow" style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                {selected.donatedByName ? (
                  <>
                    The org's <strong>{selected.name}</strong> access is{" "}
                    <strong>{selected.donatedByName}</strong>'s account. Every agent call runs
                    on it.
                  </>
                ) : (
                  <>
                    This server authenticates with OAuth. Connect your account to provide the
                    org credential every agent will use.
                  </>
                )}
              </div>
              <button
                className="btn primary"
                disabled={donate.isPending}
                onClick={() => donate.mutate(selected.id)}
              >
                {selected.donatedByName ? "Reconnect" : "Connect org account"}
              </button>
            </div>
          )}
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Tools
          </div>
          <p className="page-subtitle" style={{ marginBottom: 8 }}>
            Switching a tool off here removes it from every agent using this
            server — agents can only narrow further, never re-enable it.
          </p>
          {selected.tools.length > 8 && (
            <input
              placeholder="Filter tools…"
              value={toolFilter}
              onChange={(e) => setToolFilter(e.target.value)}
              style={{ marginBottom: 8, width: 260 }}
            />
          )}
          <div className="row-group" style={{ marginBottom: 18 }}>
            {selected.tools
              .filter(
                (t) =>
                  !toolFilter ||
                  t.name.toLowerCase().includes(toolFilter.toLowerCase()) ||
                  t.description.toLowerCase().includes(toolFilter.toLowerCase()),
              )
              .map((t) => {
              const off = selected.disabledTools.includes(t.name);
              const open = expandedTool === t.name;
              return (
                <div
                  className={`row tool-line${open ? " expanded" : ""}`}
                  key={t.name}
                  style={off ? { opacity: 0.6 } : undefined}
                  onClick={() => setExpandedTool(open ? null : t.name)}
                >
                  <span
                    className={`toggle${off ? "" : " on"}`}
                    role="switch"
                    aria-checked={!off}
                    aria-label={`${t.name} enabled`}
                    style={{ cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDisabledTools.mutate({
                        id: selected.id,
                        disabledTools: off
                          ? selected.disabledTools.filter((n) => n !== t.name)
                          : [...selected.disabledTools, t.name],
                      });
                    }}
                  />
                  <div className="grow">
                    <div className="title mono" style={{ fontSize: 12 }}>
                      {t.name}
                      <span className="tool-chevron">▶</span>
                    </div>
                    <div className="sub">{t.description}</div>
                  </div>
                  {off && <span className="chip amber">off for all agents</span>}
                </div>
              );
            })}
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
          <div style={{ marginTop: 16 }} />
          <McpServerAccess serverId={selected.id} />
          <p className="page-subtitle" style={{ marginTop: 8 }}>
            With no grants, anyone can attach this server to their agents and
            automations. Grants restrict attachment to the grantees (and org
            admins); people outside the scope can request access.
          </p>
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
                {s.libraryKey && libraryByKey.has(s.libraryKey) && (
                  <span
                    className="mcp-library-glyph"
                    style={{
                      width: 24,
                      height: 24,
                      fontSize: 12,
                      background: libraryByKey.get(s.libraryKey)!.brandColor,
                    }}
                  >
                    {libraryByKey.get(s.libraryKey)!.glyph}
                  </span>
                )}
                <span
                  className="status-dot"
                  style={{
                    background: s.status === "connected" ? "var(--green)" : "var(--red)",
                  }}
                />
                <div className="grow">
                  <div className="title">{s.name}</div>
                  <div className="sub">
                    {[
                      s.category,
                      s.credentialMode === "personal"
                        ? "personal credentials"
                        : s.credentialMode === "connection"
                          ? `via ${s.connectionName ?? "deleted connection"}`
                          : "org credential",
                      `${count(s.tools.length - s.disabledTools.length, "tool")}${
                        s.disabledTools.length > 0
                          ? ` (${s.disabledTools.length} off)`
                          : ""
                      }`,
                      s.usedByCount > 0 ? `used by ${s.usedByCount}` : null,
                      s.grantCount > 0 ? "restricted" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                {s.requiresOAuth && s.credentialMode === "shared" && !s.hasToken && (
                  <span className="chip amber" title="Authorize an org account on this server">
                    needs org account
                  </span>
                )}
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

/** Access scope for an MCP server — the same grants engine agents and
 * models use, so restriction semantics stay uniform across the platform. */
function McpServerAccess({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: ["grants", "mcp-server", serverId],
    queryFn: () => api.listGrants("mcp-server", serverId),
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.listTeams });
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  return (
    <GrantEditor
      targetType="mcp-server"
      targetId={serverId}
      grants={grants.data?.grants ?? []}
      teams={teams.data?.teams ?? []}
      users={users.data?.users ?? []}
      onChanged={() => {
        void queryClient.invalidateQueries({ queryKey: ["grants", "mcp-server", serverId] });
        void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      }}
    />
  );
}

function AddMcpServerModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const library = useQuery({ queryKey: ["mcp-library"], queryFn: api.mcpLibrary });
  // Connections that can lend their credential (e.g. a Slack workspace bot).
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.listConnections,
  });
  const lendable = (connections.data?.connections ?? []).filter((c) => c.hasToken);
  // Step 1: pick a platform from the curated library (or Custom). Step 2:
  // the register form, prefilled by the pick — everything stays editable,
  // and the same entry can be added again as another copy.
  const [picked, setPicked] = useState<null | "custom" | McpLibraryEntry>(null);
  const [form, setForm] = useState<{
    name: string; url: string; category: string;
    credentialMode: "shared" | "personal" | "connection";
    token: string; connectionId: string;
  }>({
    name: "", url: "", category: "Tools", credentialMode: "shared",
    token: "", connectionId: "",
  });
  const create = useMutation({
    mutationFn: () =>
      api.createMcpServer({
        name: form.name,
        url: form.url,
        category: form.category,
        credentialMode: form.credentialMode,
        token: form.token || undefined,
        connectionId:
          form.credentialMode === "connection" ? form.connectionId : undefined,
        libraryKey: picked && picked !== "custom" ? picked.key : undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      onClose();
    },
  });

  if (picked === null) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
          <h2>Add MCP server</h2>
          <p className="page-subtitle">
            Pick a platform — the endpoint comes preconfigured — or point at
            any MCP server. The same platform can be added more than once as
            separately-scoped copies.
          </p>
          <div className="mcp-library-grid">
            {(library.data?.library ?? []).map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="mcp-library-tile"
                onClick={() => {
                  setPicked(entry);
                  // Connection-mode tiles (built-in Slack tools) preselect
                  // a matching connection.
                  const defaultConn =
                    entry.credentialMode === "connection"
                      ? (lendable.find((c) => c.vendor === "slack") ?? lendable[0])
                          ?.id ?? ""
                      : "";
                  setForm({
                    name: entry.name,
                    url: entry.url,
                    category: entry.category,
                    credentialMode: entry.credentialMode,
                    token: "",
                    connectionId: defaultConn,
                  });
                }}
              >
                <span className="mcp-library-glyph" style={{ background: entry.brandColor }}>
                  {entry.glyph}
                </span>
                <span className="mcp-library-name">{entry.name}</span>
                <span className="mcp-library-desc">{entry.description}</span>
              </button>
            ))}
            <button
              type="button"
              className="mcp-library-tile custom"
              onClick={() => setPicked("custom")}
            >
              <span className="mcp-library-glyph custom">+</span>
              <span className="mcp-library-name">Custom server</span>
              <span className="mcp-library-desc">Any MCP endpoint — yours or a vendor's</span>
            </button>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          {picked === "custom" ? "Add MCP server" : `Add ${picked.name}`}
        </h2>
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
          {/* Built-in toolsets (builtin:…) have no endpoint to point at. */}
          {!form.url.startsWith("builtin:") && (
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
          )}
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
            <label>Credential</label>
            <select
              value={form.credentialMode}
              onChange={(e) =>
                setForm({
                  ...form,
                  credentialMode: e.target.value as "shared" | "personal" | "connection",
                  connectionId:
                    e.target.value === "connection"
                      ? form.connectionId || (lendable[0]?.id ?? "")
                      : form.connectionId,
                })
              }
            >
              <option value="shared">Shared</option>
              <option value="personal">Personal</option>
              <option value="connection" disabled={lendable.length === 0}>
                From a connection
              </option>
            </select>
            <span className="hint">
              {form.credentialMode === "shared"
                ? "Every agent call carries this one credential. Calls run as the org service account. If the server uses OAuth, leave the token blank and authorize an org account after."
                : form.credentialMode === "connection"
                  ? "Calls ride the selected connection's credential (e.g. your Slack workspace bot) and run as the org service account."
                  : "No org credential. Each person connects their own account under Profile; calls act as them, with an in-thread approval."}
              {lendable.length === 0 &&
                form.credentialMode !== "connection" &&
                " Connections you create under Admin, Connections can also lend their credential here."}
            </span>
          </div>
          {form.credentialMode === "shared" && (
            <div className="field">
              <label>Bearer token (optional, blank for OAuth)</label>
              <input
                type="password"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
              />
            </div>
          )}
          {form.credentialMode === "connection" && (
            <div className="field">
              <label>Connection</label>
              <select
                required
                value={form.connectionId}
                onChange={(e) => setForm({ ...form, connectionId: e.target.value })}
              >
                {lendable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.vendor})
                  </option>
                ))}
              </select>
            </div>
          )}
          {create.isError && <p className="error-text">{(create.error as Error).message}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => setPicked(null)}>
              ‹ Back
            </button>
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

function EditMcpServerModal({
  server,
  onClose,
}: {
  server: { id: string; name: string; url: string; category: string; hasToken: boolean };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    url: server.url,
    category: server.category,
    token: "",
    clearToken: false,
  });
  const save = useMutation({
    mutationFn: () =>
      api.updateMcpServer(server.id, {
        url: form.url !== server.url ? form.url : undefined,
        category: form.category !== server.category ? form.category : undefined,
        // Tri-state: blank field keeps the current token unless cleared.
        token: form.clearToken ? null : form.token ? form.token : undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      onClose();
    },
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Edit {server.name}</h2>
        <p className="page-subtitle">
          Changing the URL or token re-discovers the tool list against the
          new endpoint before saving — agents keep their attachments.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {/* Built-in toolsets have no endpoint or token of their own. */}
          {!server.url.startsWith("builtin:") && (
            <div className="field">
              <label>URL</label>
              <input
                required
                className="mono"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
            </div>
          )}
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
          {!server.url.startsWith("builtin:") && (
          <div className="field">
            <label>
              Bearer token{" "}
              {server.hasToken ? "(set — leave blank to keep)" : "(none set)"}
            </label>
            <input
              type="password"
              disabled={form.clearToken}
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
            {server.hasToken && (
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={form.clearToken}
                  onChange={(e) =>
                    setForm({ ...form, clearToken: e.target.checked, token: "" })
                  }
                />
                Clear the stored token
              </label>
            )}
          </div>
          )}
          {save.isError && <p className="error-text">{(save.error as Error).message}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={save.isPending}>
              {save.isPending ? "Verifying…" : "Save changes"}
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
  const [editModel, setEditModel] = useState<string | null>(null);
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
                  : "No key configured. Built-in models won't run"}
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
              {isRegistered ? (
                <span className="sub" style={{ flexShrink: 0 }}>enabled ✓</span>
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
                <div className="sub">
                  <span className="mono">
                    {m.modelId}
                    {m.baseUrl ? ` · ${m.baseUrl}` : ""}
                  </span>
                  {` · ${m.kind}`}
                  {m.usedBy.length > 0
                    ? ` · ${m.usedBy.length} agent${m.usedBy.length === 1 ? "" : "s"}`
                    : ""}
                  {!m.canUse ? " · restricted" : ""}
                </div>
              </div>
              {m.kind === "custom" && (
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditModel(m.id);
                  }}
                >
                  Edit
                </button>
              )}
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
              No models registered yet. Enable a built-in model or add a custom one.
            </div>
          </div>
        )}
      </div>

      {showCustom && (
        <CustomModelModal onClose={() => setShowCustom(false)} onDone={refresh} />
      )}
      {editModel &&
        (() => {
          const m = registered.find((r) => r.id === editModel);
          return m ? (
            <EditModelModal
              model={m}
              onClose={() => setEditModel(null)}
              onDone={refresh}
            />
          ) : null;
        })()}
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
        to restrict it. Then only the grantees (and org admins) can.
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
          style={{ padding: 14, marginBottom: 16, borderColor: "color-mix(in srgb, var(--green) 45%, transparent)" }}
        >
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            Copy this key now. It won't be shown again.
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
                {k.prefix}_•••••••• · {k.scope} · created {relativeTime(k.createdAt)} by{" "}
                {k.createdByName ?? "?"} ·{" "}
                {k.lastUsedAt
                  ? `last used ${relativeTime(k.lastUsedAt)}`
                  : "never used"}
              </div>
            </div>
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

/** The expandable detail under an audit row — the metadata behind the
 *  summary (e.g. a gating block's failing cases + the judge's reasoning). */
function AuditDetail({ metadata }: { metadata: Record<string, unknown> }) {
  const failures = Array.isArray(metadata.failures)
    ? (metadata.failures as Array<{ case?: string; reasoning?: string }>)
    : null;
  return (
    <div
      className="row"
      style={{
        display: "block",
        background: "var(--surface-group)",
        padding: "8px 12px 10px 44px",
      }}
    >
      {failures ? (
        <>
          <div className="sub" style={{ marginBottom: 4 }}>
            Failing cases
          </div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {failures.map((f, i) => (
              <li key={i} style={{ fontSize: 12, marginBottom: 2 }}>
                <strong>{f.case}</strong>: {f.reasoning}
              </li>
            ))}
          </ul>
        </>
      ) : (
        Object.entries(metadata).map(([k, v]) => (
          <div key={k} style={{ fontSize: 12, wordBreak: "break-word" }}>
            <span className="mono" style={{ color: "var(--text-muted)" }}>
              {k}:
            </span>{" "}
            {typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}
          </div>
        ))
      )}
    </div>
  );
}

function AuditPage() {
  const [filter, setFilter] = useState("");
  const [pages, setPages] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const audit = useQuery({
    queryKey: ["audit", filter, pages],
    queryFn: async () => {
      const batches = await Promise.all(
        Array.from({ length: pages }, (_, i) =>
          api.listAudit(filter || undefined, i * 100),
        ),
      );
      return { events: batches.flatMap((b) => b.events) };
    },
  });

  return (
    <div className="content-col" style={{ maxWidth: 880 }}>
      <h1 className="page-title">Audit log</h1>
      <p className="page-subtitle">
        Control-plane state changes only. Session transcripts live on sessions.
      </p>
      <div className="filter-bar" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All actions</option>
          {[
            "agent",
            "automation",
            "grant",
            "access",
            "team",
            "domain",
            "model",
            "mcp",
            "connection",
            "api-key",
            "eval",
            "member",
            "profile",
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
          const hasDetail = e.metadata && Object.keys(e.metadata).length > 0;
          const isOpen = expanded.has(e.id);
          return (
            <div key={e.id}>
              <div
                className="row"
                style={{ cursor: hasDetail ? "pointer" : "default" }}
                onClick={hasDetail ? () => toggle(e.id) : undefined}
              >
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
                    {hasDetail && (
                      <span style={{ color: "var(--text-muted)", marginRight: 6 }}>
                        {isOpen ? "▾" : "▸"}
                      </span>
                    )}
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
              {isOpen && hasDetail && <AuditDetail metadata={e.metadata} />}
            </div>
          );
        })}
        {audit.data?.events.length === 0 && (
          <div className="row">
            <div className="sub">No events match.</div>
          </div>
        )}
      </div>
      {(audit.data?.events.length ?? 0) >= pages * 100 && (
        <button
          className="btn"
          style={{ marginTop: 10 }}
          onClick={() => setPages((p) => p + 1)}
        >
          Load older events
        </button>
      )}
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

  const retention = useMutation({ mutationFn: api.applyRetention });
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
          <button
            className="btn"
            disabled={retention.isPending}
            title="Delete sessions older than the saved retention window now (also runs at every server start)"
            onClick={() => retention.mutate()}
          >
            {retention.isPending
              ? "Applying…"
              : retention.data
                ? `Removed ${retention.data.deletedSessions}`
                : "Apply now"}
          </button>
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
          style={{ padding: 14, marginBottom: 12, borderColor: "color-mix(in srgb, var(--green) 45%, transparent)" }}
        >
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            Share these sign-in details. The temporary password won't be shown again.
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
              <span className="sub" style={{ flexShrink: 0 }}>owner</span>
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
