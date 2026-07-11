import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api";
import { count } from "../../lib/time";

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

export function ShareModal({
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
  // Reachability is configured on the Surfaces tab; the share flow only
  // reports it (share = who may use it, surfaces = where it lives).
  const slackIdentity = (connections.data?.connections ?? []).find(
    (c) => c.vendor === "slack" && c.linkedAgentId === agentId,
  );

  const [subject, setSubject] = useState("");
  const [right, setRight] = useState<"use" | "edit" | "admin">("use");
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
          {(() => {
            const violations = trust.data?.scopeViolations30d ?? 0;
            // Evidence has two halves: the quality (eval score) and the safety
            // (recent scope violations). A violation flags the chip amber even
            // on a good score — the same signal the access-request queue shows.
            const chipClass =
              evalScore === null
                ? ""
                : violations > 0 || evalScore < 90
                  ? "amber"
                  : "green";
            return (
              <span
                className={`chip ${chipClass}`}
                title="Measured track record, the evidence behind this decision"
              >
                {evalScore === null
                  ? "no track record yet"
                  : `${evalScore}% eval score · ${trust.data?.gradedCount ?? 0} graded` +
                    (violations > 0
                      ? ` · ${count(violations, "scope violation")} · 30d`
                      : "")}
              </span>
            );
          })()}
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
                    <span className="meta-note">
                      {g.accessRight}
                      {g.viaDomain ? ` · via ${g.viaDomain}` : ""}
                    </span>
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

        <div className="field" style={{ marginTop: 12 }}>
          <label>Reachability</label>
          <span className="hint">
            {slackIdentity
              ? `Reachable in Slack as ${slackIdentity.name}. Configure channels on the Surfaces tab.`
              : "Web sessions only. Give it a Slack identity on the Surfaces tab to reach it from Slack."}
          </span>
        </div>

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
                Sharing is live. Pausing sets the agent back to draft, so it
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
