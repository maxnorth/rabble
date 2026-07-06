import type { UserPreferences } from "@rabble/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";

export function ProfileSection() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.getPreferences });

  const [form, setForm] = useState({ vendor: "github", label: "", token: "" });
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (prefs.data) setPreferences(prefs.data.preferences);
  }, [prefs.data]);

  const connect = useMutation({
    mutationFn: () => api.connectAccount(form),
    onSuccess: () => {
      setForm({ vendor: "github", label: "", token: "" });
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const disconnect = useMutation({
    mutationFn: (vendor: string) => api.disconnectAccount(vendor),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const savePrefs = useMutation({
    mutationFn: () => api.setPreferences(preferences!),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    },
  });

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-title">Profile</div>
        <div className="sidebar-item active">
          <span className="label">{me.data?.user.name ?? ""}</span>
        </div>
      </aside>
      <main className="main-pane">
        <div className="content-col">
          <h1 className="page-title">{me.data?.user.name}</h1>
          <p className="page-subtitle mono">{me.data?.user.email}</p>

          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Connected accounts
          </div>
          <p className="page-subtitle">
            Personal credentials used when an agent acts <strong>as you</strong>.
          </p>
          <div className="row-group" style={{ marginBottom: 24 }}>
            {accounts.data?.accounts.map((a) => (
              <div className="row" key={a.id}>
                <span className="chip blue mono">{a.vendor}</span>
                <div className="grow">
                  <div className="title">{a.label || a.vendor}</div>
                  <div className="sub">
                    Connected {new Date(a.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <button className="btn danger" onClick={() => disconnect.mutate(a.vendor)}>
                  Disconnect
                </button>
              </div>
            ))}
            {accounts.data?.accounts.length === 0 && (
              <div className="row">
                <div className="sub">No personal accounts connected.</div>
              </div>
            )}
            <div className="row">
              <select
                value={form.vendor}
                onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              >
                {["github", "slack", "linear", "datadog", "pagerduty"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <input
                placeholder="Label (optional)"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                style={{ width: 140 }}
              />
              <input
                type="password"
                placeholder="Token"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
                style={{ flex: 1 }}
              />
              <button
                className="btn primary"
                disabled={!form.token.trim() || connect.isPending}
                onClick={() => connect.mutate()}
              >
                Connect
              </button>
            </div>
          </div>

          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Agent preferences
          </div>
          {preferences && (
            <div className="row-group" style={{ marginBottom: 16 }}>
              <div className="row">
                <div className="grow">
                  <div className="title">Approval posture</div>
                  <div className="sub">
                    What happens when an agent wants to act as you
                  </div>
                </div>
                <div className="segmented">
                  {(
                    [
                      ["ask", "Ask every time"],
                      ["auto", "Auto-approve"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      className={preferences.approvalPosture === value ? "active" : ""}
                      onClick={() =>
                        setPreferences({ ...preferences, approvalPosture: value })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="row">
                <div className="grow">
                  <div className="title">Response style</div>
                  <div className="sub">How agents shape their replies to you</div>
                </div>
                <div className="segmented">
                  {(["concise", "balanced", "detailed"] as const).map((style) => (
                    <button
                      key={style}
                      className={preferences.responseStyle === style ? "active" : ""}
                      onClick={() =>
                        setPreferences({ ...preferences, responseStyle: style })
                      }
                    >
                      {style}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <button
            className="btn primary"
            disabled={!preferences || savePrefs.isPending}
            onClick={() => savePrefs.mutate()}
          >
            {saved ? "Saved ✓" : "Save preferences"}
          </button>
        </div>
      </main>
    </>
  );
}
