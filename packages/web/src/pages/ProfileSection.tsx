import type { UserPreferences } from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";

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
          {page === "Connected accounts" ? <ConnectedAccounts /> : <AgentPreferences />}
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

  const connect = useMutation({
    mutationFn: (vendor: string) => api.connectAccount({ vendor, token }),
    onSuccess: () => {
      setConnecting(null);
      setToken("");
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
          borderColor: "rgba(107, 159, 212, 0.35)",
          fontSize: 12.5,
          color: "var(--text-dim)",
        }}
      >
        These are your personal connections. When an agent acts <strong>as you</strong>{" "}
        (user-auth tools), it uses these — separate from the org's service accounts.
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
                    type="password"
                    autoFocus
                    placeholder="Token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    style={{ width: 180 }}
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
      hint: "Delivery lands with surfaces — stored for now",
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
