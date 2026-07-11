import type { UserPreferences } from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { setThemePref, useThemePref } from "../lib/theme";

/** System / Light / Dark. Device-local (not synced to the server), applied
 * instantly — the rail's sun/moon button flips the same preference. */
function AppearancePicker() {
  const pref = useThemePref();
  return (
    <div className="segmented">
      {(
        [
          ["system", "System"],
          ["light", "Light"],
          ["dark", "Dark"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          className={pref === value ? "active" : ""}
          onClick={() => setThemePref(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const VENDORS = [
  { vendor: "github", scope: "Repos · pull requests · Actions" },
  { vendor: "linear", scope: "Issues · projects · cycles" },
  { vendor: "slack", scope: "DMs · channel messages" },
  { vendor: "datadog", scope: "Metrics · monitors · logs" },
  { vendor: "google", scope: "Calendar · Drive · Gmail" },
];

const PAGES = ["Connected accounts", "Agent preferences"] as const;
type Page = (typeof PAGES)[number];

export function ProfileSection() {
  const [page, setPage] = useState<Page>("Connected accounts");
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-title">Profile</div>
        {PAGES.map((p) => (
          <button
            key={p}
            className={`sidebar-item${page === p ? " active" : ""}`}
            onClick={() => setPage(p)}
          >
            <span className="label">{p}</span>
          </button>
        ))}
      </aside>
      <main className="main-pane">
        <div className="content-col">
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22 }}>
            <div
              className="rail-logo"
              style={{ width: 44, height: 44, fontSize: 16, background: "var(--purple)", marginBottom: 0 }}
            >
              {me.data?.user.name
                .split(/\s+/)
                .map((p) => p[0])
                .slice(0, 2)
                .join("")
                .toUpperCase()}
            </div>
            <div>
              <h1 className="page-title" style={{ marginBottom: 0 }}>
                {me.data?.user.name}
              </h1>
              <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {me.data?.user.email}
              </span>
            </div>
            <span
              className={`chip ${me.data?.user.role === "member" ? "" : "blue"}`}
            >
              {me.data?.user.role}
            </span>
          </div>
          {page === "Connected accounts" ? (
            <>
              <ConnectedAccounts />
              <ChangePassword />
            </>
          ) : (
            <AgentPreferences />
          )}
        </div>
      </main>
    </>
  );
}

function ConnectedAccounts() {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const [connecting, setConnecting] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");

  const connect = useMutation({
    mutationFn: (vendor: string) => api.connectAccount({ vendor, token, label }),
    onSuccess: () => {
      setConnecting(null);
      setToken("");
      setLabel("");
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const disconnect = useMutation({
    mutationFn: (vendor: string) => api.disconnectAccount(vendor),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });

  const connected = new Map(
    (accounts.data?.accounts ?? []).map((a) => [a.vendor, a]),
  );

  return (
    <>
      <div
        className="card"
        style={{
          padding: 12,
          marginBottom: 16,
          borderColor: "color-mix(in srgb, var(--blue) 40%, transparent)",
          fontSize: 12.5,
          color: "var(--text-dim)",
        }}
      >
        These are your personal connections. When an agent acts <strong>as you</strong>{" "}
        (user-auth tools), it uses these, separate from the org's service accounts.
      </div>
      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Connected accounts
      </div>
      <div className="row-group">
        {VENDORS.map(({ vendor, scope }) => {
          const account = connected.get(vendor);
          return (
            <div className="row" key={vendor}>
              <span className="chip blue mono">{vendor}</span>
              <div className="grow">
                <div className="title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {vendor.charAt(0).toUpperCase() + vendor.slice(1)}
                  {account && <span className="chip green">connected</span>}
                </div>
                <div className="sub">
                  {account?.label ? `${account.label} · ` : ""}
                  {scope}
                </div>
              </div>
              {account ? (
                <button className="btn danger" onClick={() => disconnect.mutate(vendor)}>
                  Disconnect
                </button>
              ) : connecting === vendor ? (
                <>
                  <input
                    autoFocus
                    placeholder="Username (for surface identity)"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    style={{ width: 190 }}
                  />
                  <input
                    type="password"
                    placeholder="Token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    style={{ width: 150 }}
                  />
                  <button
                    className="btn primary"
                    disabled={!token.trim() || connect.isPending}
                    onClick={() => connect.mutate(vendor)}
                  >
                    Save
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => setConnecting(vendor)}>
                  Connect
                </button>
              )}
            </div>
          );
        })}
      </div>
      <McpCredentials />
    </>
  );
}

function McpCredentials() {
  const queryClient = useQueryClient();
  const servers = useQuery({ queryKey: ["mcp-servers"], queryFn: api.listMcpServers, retry: false });
  const creds = useQuery({ queryKey: ["mcp-credentials"], queryFn: api.listMcpCredentials });
  const [connecting, setConnecting] = useState<string | null>(null);
  const [token, setToken] = useState("");

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["mcp-credentials"] });
  const connect = useMutation({
    mutationFn: (serverId: string) => api.connectMcpCredential(serverId, token),
    onSuccess: () => {
      setConnecting(null);
      setToken("");
      invalidate();
    },
  });
  const disconnect = useMutation({
    mutationFn: (serverId: string) => api.disconnectMcpCredential(serverId),
    onSuccess: invalidate,
  });
  const startOAuth = useMutation({
    mutationFn: (serverId: string) => api.startMcpOAuth(serverId),
    onSuccess: ({ authorizeUrl }) => window.open(authorizeUrl, "_blank", "noopener"),
  });

  // Only personal-credential servers need a per-user connection.
  const personal = (servers.data?.servers ?? []).filter(
    (s) => s.credentialMode === "personal",
  );
  if (personal.length === 0) return null;
  const connected = new Map((creds.data?.credentials ?? []).map((c) => [c.serverId, c]));

  return (
    <>
      <div className="sidebar-title" style={{ padding: "16px 0 8px" }}>
        MCP tool accounts
      </div>
      <div className="row-group">
        {personal.map((s) => {
          const cred = connected.get(s.id);
          return (
            <div className="row" key={s.id}>
              <span className="chip amber mono">{s.slug}</span>
              <div className="grow">
                <div className="title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {s.name}
                  {cred && <span className="chip green">connected</span>}
                </div>
                <div className="sub">
                  Personal credential. Agents using {s.name} call it as you.
                </div>
              </div>
              {cred ? (
                <button className="btn danger" onClick={() => disconnect.mutate(s.id)}>
                  Disconnect
                </button>
              ) : s.requiresOAuth ? (
                <button
                  className="btn primary"
                  disabled={startOAuth.isPending}
                  onClick={() => startOAuth.mutate(s.id)}
                >
                  Connect
                </button>
              ) : connecting === s.id ? (
                <>
                  <input
                    autoFocus
                    type="password"
                    placeholder="Your token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    style={{ width: 180 }}
                  />
                  <button
                    className="btn primary"
                    disabled={!token.trim() || connect.isPending}
                    onClick={() => connect.mutate(s.id)}
                  >
                    Save
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => setConnecting(s.id)}>
                  Connect
                </button>
              )}
            </div>
          );
        })}
      </div>
      {connect.isError && (
        <p className="error-text">{(connect.error as Error).message}</p>
      )}
    </>
  );
}

function AgentPreferences() {
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.getPreferences });
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (prefs.data) setPreferences(prefs.data.preferences);
  }, [prefs.data]);

  const save = useMutation({
    mutationFn: () => api.setPreferences(preferences!),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    },
  });

  if (!preferences) return null;

  const behaviors: Array<{
    key: "suggestNextSteps" | "inlineToolCalls" | "notifyOnBackground";
    label: string;
    hint: string;
  }> = [
    {
      key: "suggestNextSteps",
      label: "Let agents suggest next steps",
      hint: "Agents can propose follow-up actions without being asked",
    },
    {
      key: "inlineToolCalls",
      label: "Show tool calls inline",
      hint: "Expand each tool call & result in the thread",
    },
    {
      key: "notifyOnBackground",
      label: "Notify me when a background task finishes",
      hint: "Slack DM when an agent replies on a surface you're not watching",
    },
  ];

  return (
    <>
      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        When an agent wants to act as me
      </div>
      <div className="row-group" style={{ marginBottom: 6 }}>
        <div className="row">
          <div className="segmented">
            {(
              [
                ["ask", "Always ask"],
                ["session", "Once per session"],
                ["trust", "Trust me"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={preferences.approvalPosture === value ? "active" : ""}
                onClick={() => setPreferences({ ...preferences, approvalPosture: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="page-subtitle">
        Controls how often you're prompted before an agent uses your identity
        for a write action. An org-wide approval floor can override this.
      </p>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Appearance
      </div>
      <div className="row-group" style={{ marginBottom: 18 }}>
        <div className="row">
          <AppearancePicker />
        </div>
      </div>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Response style
      </div>
      <div className="row-group" style={{ marginBottom: 18 }}>
        <div className="row">
          <div className="segmented">
            {(["concise", "detailed"] as const).map((style) => (
              <button
                key={style}
                className={preferences.responseStyle === style ? "active" : ""}
                onClick={() => setPreferences({ ...preferences, responseStyle: style })}
              >
                {style.charAt(0).toUpperCase() + style.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Behavior
      </div>
      <div className="row-group" style={{ marginBottom: 18 }}>
        {behaviors.map((b) => (
          <div className="row" key={b.key}>
            <span
              className={`toggle${preferences[b.key] ? " on" : ""}`}
              style={{ cursor: "pointer" }}
              onClick={() =>
                setPreferences({ ...preferences, [b.key]: !preferences[b.key] })
              }
            />
            <div className="grow">
              <div className="title">{b.label}</div>
              <div className="sub">{b.hint}</div>
            </div>
          </div>
        ))}
      </div>

      <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
        {saved ? "Saved ✓" : "Save preferences"}
      </button>
    </>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    },
  });
  return (
    <>
      <div className="sidebar-title" style={{ padding: "18px 0 8px" }}>
        Security
      </div>
      <div className="row-group">
        <div className="row">
          <div className="grow">
            <div className="title">Password</div>
            <div className="sub">At least 8 characters.</div>
          </div>
          <input
            type="password"
            placeholder="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            style={{ width: 170 }}
          />
          <input
            type="password"
            placeholder="New password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            style={{ width: 170 }}
          />
          <button
            className="btn"
            disabled={!current || next.length < 8 || change.isPending}
            onClick={() => change.mutate()}
          >
            {done ? "Changed ✓" : "Change"}
          </button>
        </div>
      </div>
      {change.isError && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {(change.error as Error).message}
        </p>
      )}
    </>
  );
}
