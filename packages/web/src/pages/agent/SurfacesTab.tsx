import type { SurfaceResponseMode } from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api";

// ---------------------------------------------------------------------------
// surfaces
// ---------------------------------------------------------------------------

/**
 * Two-level Slack response control: a top-level choice of "every message" vs
 * "only when @mentioned", with an "auto-reply in thread" sub-option that only
 * applies under @mentioned. Maps to the stored enum — all: every message;
 * thread: mentioned + auto-reply to follow-ups; mention: mentioned every time.
 */
function ResponseModeControls({
  mode,
  disabled,
  onChange,
}: {
  mode: SurfaceResponseMode;
  disabled?: boolean;
  onChange: (mode: SurfaceResponseMode) => void;
}) {
  const mentionOnly = mode !== "all";
  return (
    <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
      <select
        value={mentionOnly ? "mention" : "all"}
        disabled={disabled}
        title="When this agent replies in the channel"
        // Switching to @mentioned defaults the sub-option to auto-reply on.
        onChange={(e) => onChange(e.target.value === "all" ? "all" : "thread")}
      >
        <option value="mention">Only when @mentioned</option>
        <option value="all">Every message in channel</option>
      </select>
      {mentionOnly && (
        <label
          style={{
            display: "inline-flex",
            gap: 4,
            alignItems: "center",
            fontSize: 13,
            color: "var(--text-dim)",
          }}
          title="After a tag, keep replying to follow-ups in that thread without re-tagging"
        >
          <input
            type="checkbox"
            disabled={disabled}
            checked={mode === "thread"}
            onChange={(e) => onChange(e.target.checked ? "thread" : "mention")}
          />
          Auto-reply in thread
        </label>
      )}
    </span>
  );
}

const VENDOR_GLYPHS: Record<string, { glyph: string; bg: string }> = {
  slack: { glyph: "#", bg: "#4A154B" },
  github: { glyph: "⎇", bg: "#24292f" },
};

function vendorBlurb(vendor: string): string {
  if (vendor === "slack") return "Slack · this agent's identity in the workspace";
  if (vendor === "github") return "GitHub · replies to issue comments in mapped repositories";
  return vendor;
}

export function SurfacesTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const agent = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const surfaces = useQuery({
    queryKey: ["surfaces", agentId],
    queryFn: () => api.listSurfaces(agentId),
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [exceptionFor, setExceptionFor] = useState<string | null>(null);
  const [exceptionLabel, setExceptionLabel] = useState("");
  const [exceptionMode, setExceptionMode] = useState<SurfaceResponseMode>("thread");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["surfaces", agentId] });
    void queryClient.invalidateQueries({ queryKey: ["connections"] });
  };
  const add = useMutation({
    mutationFn: (body: {
      connectionId: string;
      label: string;
      responseMode?: SurfaceResponseMode;
      dmEnabled?: boolean;
    }) => api.addSurface(agentId, body),
    onSuccess: () => {
      setMenuOpen(false);
      setExceptionFor(null);
      setExceptionLabel("");
      setExceptionMode("thread");
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: (vars: {
      surfaceId: string;
      responseMode?: SurfaceResponseMode;
      dmEnabled?: boolean;
    }) =>
      api.updateSurface(agentId, vars.surfaceId, {
        responseMode: vars.responseMode,
        dmEnabled: vars.dmEnabled,
      }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (surfaceId: string) => api.removeSurface(agentId, surfaceId),
    onSuccess: invalidate,
  });
  const detach = useMutation({
    mutationFn: (surfaceIds: string[]) =>
      Promise.all(surfaceIds.map((id) => api.removeSurface(agentId, id))),
    onSuccess: invalidate,
  });
  const setWeb = useMutation({
    mutationFn: (v: boolean) => api.updateAgent(agentId, { webEnabled: v }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const attached = surfaces.data?.surfaces ?? [];
  const byConnection = new Map<string, typeof attached>();
  for (const s of attached) {
    const list = byConnection.get(s.connectionId) ?? [];
    list.push(s);
    byConnection.set(s.connectionId, list);
  }

  // The link menu offers unclaimed interface connections; connections owned
  // by other agents show who has them and stay disabled.
  const linkable = (connections.data?.connections ?? []).filter(
    (c) => c.roles.includes("Interface") && !byConnection.has(c.id),
  );
  const busy = add.isPending || update.isPending || remove.isPending || detach.isPending;
  const webOn = agent.data?.agent.webEnabled ?? true;
  const error = (add.error ?? update.error ?? detach.error) as Error | null;

  return (
    <>
      <p className="page-subtitle">
        Where this agent is reachable. The web composer is always on. Linking a
        connection makes this agent that app's identity: it alone answers
        there, and every conversation lands in the same audited timeline.
      </p>

      <div className="row-group" style={{ marginBottom: 14 }}>
        <div className="row">
          <span
            className="status-dot"
            style={{ background: webOn ? "var(--green)" : "var(--text-muted)" }}
          />
          <div className="grow">
            <div className="title">Web sessions</div>
            <div className="sub">
              {webOn
                ? "The in-app composer, including Auto routing"
                : "Off: hidden from the composer and Auto routing"}
            </div>
          </div>
          <span
            role="switch"
            aria-checked={webOn}
            aria-label="Web sessions"
            tabIndex={canEdit ? 0 : -1}
            className={`toggle${webOn ? " on" : ""}`}
            style={{ cursor: canEdit ? "pointer" : "default", display: "inline-block" }}
            onClick={() => canEdit && !setWeb.isPending && setWeb.mutate(!webOn)}
            onKeyDown={(e) => {
              if (canEdit && !setWeb.isPending && (e.key === "Enter" || e.key === " "))
                setWeb.mutate(!webOn);
            }}
          />
        </div>
      </div>

      {[...byConnection.entries()].map(([connectionId, rows]) => {
        const meta = rows[0]!;
        const workspace = rows.find((r) => r.label === "");
        const channels = rows.filter((r) => r.label !== "");
        const tile = VENDOR_GLYPHS[meta.vendor];
        const defaultMode = workspace?.responseMode ?? "thread";
        const dmOn = workspace?.dmEnabled ?? true;
        const setDefaultMode = (m: SurfaceResponseMode) =>
          workspace
            ? update.mutate({ surfaceId: workspace.id, responseMode: m })
            : add.mutate({ connectionId, label: "", responseMode: m });
        const setDm = (v: boolean) =>
          workspace
            ? update.mutate({ surfaceId: workspace.id, dmEnabled: v })
            : add.mutate({ connectionId, label: "", dmEnabled: v });
        const exceptionsTitle =
          meta.vendor === "slack" ? "Channel exceptions" : "Repositories";
        const addExceptionText =
          meta.vendor === "slack" ? "+ Add a channel exception" : "+ Add a repository";

        return (
          <div className="card surface-card" key={connectionId}>
            <div className="surface-card-head">
              <span
                className="vendor-glyph"
                style={{ background: tile?.bg ?? "var(--accent)" }}
              >
                {tile?.glyph ?? meta.vendor[0]?.toUpperCase()}
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="title" style={{ fontSize: 14 }}>{meta.connectionName}</div>
                <div className="sub">{vendorBlurb(meta.vendor)}</div>
              </div>
              {meta.status === "connected" ? (
                <span className="meta-note">connected</span>
              ) : (
                <span className="chip amber">{meta.status}</span>
              )}
              {canEdit && (
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={() => detach.mutate(rows.map((r) => r.id))}
                >
                  Detach
                </button>
              )}
            </div>

            {meta.vendor === "slack" && (
              <div className="setting-rows">
                <div className="setting-row">
                  <div>
                    <div className="setting-name">In channels</div>
                    <div className="setting-help">When it replies in channels it's invited to</div>
                  </div>
                  <ResponseModeControls
                    mode={defaultMode}
                    disabled={!canEdit || busy}
                    onChange={setDefaultMode}
                  />
                </div>
                <div className="setting-row">
                  <div>
                    <div className="setting-name">Direct messages</div>
                    <div className="setting-help">Answer 1:1 messages sent to this app</div>
                  </div>
                  <div>
                    <span
                      role="switch"
                      aria-checked={dmOn}
                      aria-label="Direct messages"
                      tabIndex={canEdit ? 0 : -1}
                      className={`toggle${dmOn ? " on" : ""}`}
                      style={{ cursor: canEdit ? "pointer" : "default", display: "inline-block" }}
                      onClick={() => canEdit && !busy && setDm(!dmOn)}
                      onKeyDown={(e) => {
                        if (canEdit && !busy && (e.key === "Enter" || e.key === " ")) setDm(!dmOn);
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {(meta.vendor !== "slack" || channels.length > 0 || canEdit) && (
              <div style={{ borderTop: "1px solid var(--border-row)" }}>
                <div className="sidebar-title surface-section-title">
                  {exceptionsTitle}
                </div>
                {channels.map((s) => (
                  <div className="row surface-item" key={s.id}>
                    <span className="mono" style={{ fontSize: 12.5, color: "var(--accent-text)" }}>
                      {s.label}
                    </span>
                    {meta.vendor === "slack" && (
                      <ResponseModeControls
                        mode={s.responseMode}
                        disabled={!canEdit || busy}
                        onChange={(m) => update.mutate({ surfaceId: s.id, responseMode: m })}
                      />
                    )}
                    {canEdit && (
                      <button
                        className="btn"
                        style={{ marginLeft: "auto", color: "var(--text-muted)" }}
                        title="Remove"
                        disabled={busy}
                        onClick={() => remove.mutate(s.id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {canEdit && exceptionFor !== connectionId && (
                  <button
                    className="btn quiet-add"
                    onClick={() => {
                      setExceptionFor(connectionId);
                      setExceptionLabel("");
                      setExceptionMode("thread");
                    }}
                  >
                    {addExceptionText}
                  </button>
                )}
                {canEdit && exceptionFor === connectionId && (
                  <div className="row surface-item">
                    <input
                      placeholder={meta.vendor === "slack" ? "#eng-oncall" : "acme/api"}
                      value={exceptionLabel}
                      onChange={(e) => setExceptionLabel(e.target.value)}
                      style={{ width: 180 }}
                      autoFocus
                    />
                    {meta.vendor === "slack" && (
                      <ResponseModeControls mode={exceptionMode} onChange={setExceptionMode} />
                    )}
                    <button
                      className="btn primary"
                      disabled={!exceptionLabel.trim() || busy}
                      onClick={() =>
                        add.mutate({
                          connectionId,
                          label: exceptionLabel.trim(),
                          responseMode: exceptionMode,
                        })
                      }
                    >
                      Add
                    </button>
                    <button className="btn" onClick={() => setExceptionFor(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {error && (
        <p className="sub" style={{ color: "var(--red)", margin: "0 0 12px" }}>
          {error.message}
        </p>
      )}

      {canEdit && linkable.length > 0 && (
        <div>
          <button className="btn primary" onClick={() => setMenuOpen((v) => !v)}>
            + Link a connection
          </button>
          {menuOpen && (
            <div className="row-group" style={{ marginTop: 10, maxWidth: 420 }}>
              {linkable.map((c) => {
                const taken = !!c.linkedAgentId && c.linkedAgentId !== agentId;
                return (
                  <div className="row" key={c.id} style={{ opacity: taken ? 0.45 : 1 }}>
                    <div className="grow">
                      <div className="title">{c.name}</div>
                      <div className="sub">
                        {taken ? `identity of ${c.linkedAgentName}` : c.vendor}
                      </div>
                    </div>
                    {!taken && (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => add.mutate({ connectionId: c.id, label: "" })}
                      >
                        Link
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {linkable.length === 0 && (
        <p className="page-subtitle">
          {byConnection.size === 0
            ? "No interface connections yet. Add Slack (or similar) in Admin › Connections to reach this agent outside the web app."
            : "Every connection is already linked. Create another in Admin › Connections to add a surface."}
        </p>
      )}
    </>
  );
}
