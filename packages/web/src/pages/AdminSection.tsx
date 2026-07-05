import type { ModelProtocol } from "@rabble/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { api } from "../api";

const ADMIN_PAGES = [
  { key: "connections", label: "Connections", enabled: false },
  { key: "mcp", label: "MCP servers", enabled: false },
  { key: "models", label: "Models", enabled: true },
  { key: "api-keys", label: "API keys", enabled: false },
  { key: "audit", label: "Audit log", enabled: false },
  { key: "settings", label: "Settings", enabled: false },
];

export function AdminSection() {
  const { page } = useParams();

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-title">Admin</div>
        {ADMIN_PAGES.map((p) =>
          p.enabled ? (
            <NavLink
              key={p.key}
              to={`/admin/${p.key}`}
              className={({ isActive }) =>
                `sidebar-item${isActive ? " active" : ""}`
              }
            >
              <span className="label">{p.label}</span>
            </NavLink>
          ) : (
            <div
              key={p.key}
              className="sidebar-item"
              style={{ color: "var(--text-muted)", cursor: "default" }}
              title="Coming soon"
            >
              <span className="label">{p.label}</span>
            </div>
          ),
        )}
      </aside>
      <main className="main-pane">
        {page === "models" ? (
          <ModelsPage />
        ) : (
          <div className="content-col">
            <p className="page-subtitle">This admin surface is coming soon.</p>
          </div>
        )}
      </main>
    </>
  );
}

function ModelsPage() {
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.modelCatalog });
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: api.providerStatus,
  });
  const [showCustom, setShowCustom] = useState(false);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});

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
  const enable = useMutation({
    mutationFn: api.enableBuiltIn,
    onSuccess: refresh,
  });
  const removeModel = useMutation({
    mutationFn: api.deleteModel,
    onSuccess: refresh,
  });

  const registered = models.data?.models ?? [];
  const registeredCatalogIds = new Set(
    registered.filter((m) => m.catalogId).map((m) => m.catalogId),
  );

  return (
    <div className="content-col">
      <h1 className="page-title">Models</h1>
      <p className="page-subtitle">
        Built-in models use one provider key for the whole org. Custom models
        bring their own key and can point at any compatible endpoint or
        gateway.
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
              onChange={(e) =>
                setKeyDraft((d) => ({ ...d, [p.provider]: e.target.value }))
              }
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
          <div className="row" key={m.id}>
            <div className="grow">
              <div className="title">{m.displayName}</div>
              <div className="sub mono">
                {m.modelId}
                {m.baseUrl ? ` · ${m.baseUrl}` : ""}
              </div>
            </div>
            <span className={`chip ${m.kind === "built-in" ? "blue" : "purple"}`}>
              {m.kind}
            </span>
            <button
              className="btn danger"
              disabled={removeModel.isPending}
              onClick={() => {
                if (confirm(`Remove model "${m.displayName}"?`)) {
                  removeModel.mutate(m.id);
                }
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {registered.length === 0 && (
          <div className="row">
            <div className="sub">
              No models registered yet — enable a built-in model or add a
              custom one.
            </div>
          </div>
        )}
      </div>

      {showCustom && <CustomModelModal onClose={() => setShowCustom(false)} onDone={refresh} />}
    </div>
  );
}

function CustomModelModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    displayName: "",
    protocol: "anthropic" as ModelProtocol,
    baseUrl: "",
    modelId: "",
    apiKey: "",
  });
  const create = useMutation({
    mutationFn: () =>
      api.createCustomModel({
        displayName: form.displayName,
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim() || null,
        modelId: form.modelId,
        apiKey: form.apiKey,
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
            <span className="hint">
              Leave blank to use the provider's default endpoint.
            </span>
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
          {create.isError && (
            <p className="error-text">{(create.error as Error).message}</p>
          )}
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
