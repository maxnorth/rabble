import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { AGENT_COLORS } from "../lib/time";
import { AccessTab } from "./agent/AccessTab";
import { AdvancedTab } from "./agent/AdvancedTab";
import { AutomationsTab } from "./agent/AutomationsTab";
import { EvalsTab } from "./agent/EvalsTab";
import { IdentityTab } from "./agent/IdentityTab";
import { McpTab } from "./agent/McpTab";
import { ShareModal } from "./agent/ShareModal";
import { SubAgentsTab } from "./agent/SubAgentsTab";
import { SurfacesTab } from "./agent/SurfacesTab";

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
              Request sent. An org admin has been notified and can approve it
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
