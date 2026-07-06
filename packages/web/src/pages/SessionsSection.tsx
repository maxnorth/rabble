import type {
  AgentDirectoryRow,
  Message,
  SessionEvalResult,
  ToolCall,
} from "@rabblehq/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, streamMessage } from "../api";
import { relativeTime, AGENT_COLORS } from "../lib/time";

interface PendingApproval {
  approvalId: string;
  toolName: string;
  serverName: string | null;
  input: unknown;
  resolved?: string;
}

type DrawerContent =
  | { kind: "tool"; toolCall: ToolCall }
  | { kind: "evals"; results: SessionEvalResult[] }
  | { kind: "agent"; agentId: string }
  | { kind: "track-record"; agentId: string }
  | { kind: "file"; name: string; content: string };

export function SessionsSection() {
  const { sessionId } = useParams();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.listSessions });

  return (
    <>
      <aside className="sidebar">
        <NavLink to="/sessions" end className="btn" style={{ margin: "0 4px 12px" }}>
          + New session
        </NavLink>
        <div className="sidebar-title">Recent sessions</div>
        {sessions.data?.sessions.map((s) => (
          <NavLink
            key={s.id}
            to={`/sessions/${s.id}`}
            className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
          >
            <span
              className="status-dot"
              style={{ background: AGENT_COLORS[s.agentColor] ?? "var(--green)" }}
              title={s.agentName}
            />
            <span className="label">
              {s.title || "New session"}
              <span
                style={{
                  display: "block",
                  fontSize: 11,
                  color: "var(--text-muted)",
                }}
              >
                {s.agentName} · {relativeTime(s.updatedAt)}
              </span>
            </span>
          </NavLink>
        ))}
        {sessions.data?.sessions.length === 0 && (
          <div className="sidebar-item" style={{ color: "var(--text-muted)" }}>
            No sessions yet
          </div>
        )}
      </aside>
      <main className="main-pane">
        {sessionId ? (
          <SessionThread key={sessionId} sessionId={sessionId} />
        ) : (
          <SessionLanding />
        )}
      </main>
    </>
  );
}

function AgentTargetPill({
  agents,
  target,
  onChange,
}: {
  agents: AgentDirectoryRow[];
  target: AgentDirectoryRow | null;
  onChange: (agent: AgentDirectoryRow | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const usable = agents.filter((a) => a.status === "active" && a.myRight);
  return (
    <div style={{ position: "relative" }}>
      <button type="button" className="target-pill" onClick={() => setOpen((v) => !v)}>
        <span
          className="status-dot"
          style={{
            background: target
              ? (AGENT_COLORS[target.color] ?? "var(--green)")
              : "var(--blue)",
          }}
        />
        {target ? target.name : "Auto"}
        <span style={{ color: "var(--text-muted)" }}>▾</span>
      </button>
      {open && (
        <div className="target-menu">
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            <span className="status-dot" style={{ background: "var(--blue)" }} />
            <span style={{ flex: 1, textAlign: "left" }}>
              Auto
              <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                Route to the best agent
              </span>
            </span>
          </button>
          {usable.map((a) => (
            <button
              type="button"
              key={a.id}
              onClick={() => {
                onChange(a);
                setOpen(false);
              }}
            >
              <span
                className="status-dot"
                style={{ background: AGENT_COLORS[a.color] ?? "var(--green)" }}
              />
              <span style={{ flex: 1, textAlign: "left" }}>
                {a.name}
                {a.description && (
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: 220,
                    }}
                  >
                    {a.description}
                  </span>
                )}
              </span>
            </button>
          ))}
          {usable.length === 0 && (
            <button type="button" disabled style={{ color: "var(--text-muted)" }}>
              No agents available to you
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SessionLanding() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const hour = new Date().getHours();
  const dayPart = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const firstName = me.data?.user.name.split(/\s+/)[0] ?? "";
  const [text, setText] = useState("");
  const [target, setTarget] = useState<AgentDirectoryRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await api.createSession(
        target?.id ?? null,
        target ? undefined : content,
      );
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/sessions/${session.id}`, { state: { initialMessage: content } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start session");
      setBusy(false);
    }
  };

  return (
    <div className="session-landing">
      <div className="session-greeting">
        Good {dayPart}
        {firstName ? `, ${firstName}` : ""}
      </div>
      <p className="page-subtitle" style={{ marginTop: -14 }}>
        Start a session with an agent — or let Auto route you to the right one.
      </p>
      <div className="composer">
        <textarea
          placeholder="Describe what you need help with…"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <div className="composer-row">
          <AgentTargetPill
            agents={agents.data?.agents ?? []}
            target={target}
            onChange={setTarget}
          />
          <button
            className="btn primary"
            disabled={busy || !text.trim()}
            onClick={() => void start()}
          >
            Send
          </button>
        </div>
      </div>
      {error && (
        <p className="error-text" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
    </div>
  );
}

function ToolCallChip({
  toolCall,
  running,
  onClick,
}: {
  toolCall: ToolCall;
  running?: boolean;
  onClick: () => void;
}) {
  const auth = toolCall.authType ?? "service";
  return (
    <div className="tool-call" onClick={onClick}>
      {running ? (
        <span className="spin" />
      ) : (
        <span
          className="status-dot"
          style={{
            background:
              toolCall.approval?.status === "denied" ||
              toolCall.approval?.status === "timed-out"
                ? "var(--red)"
                : "var(--green)",
          }}
        />
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="tool-name">{toolCall.name}</span>
          {toolCall.serverName && (
            <span className="tool-server">{toolCall.serverName}</span>
          )}
          <span style={{ flex: 1 }} />
          {toolCall.durationMs != null && (
            <span className="tool-server">
              {(toolCall.durationMs / 1000).toFixed(1)}s · details
            </span>
          )}
          <span className={`chip ${auth === "service" ? "green" : "amber"}`}>{auth}</span>
        </span>
        {typeof toolCall.output === "string" && toolCall.output && (
          <span
            className="mono"
            style={{
              display: "block",
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 3,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            → {toolCall.output.slice(0, 90)}
          </span>
        )}
      </span>
    </div>
  );
}

function ApprovalCard({
  approval,
  onDecide,
  trackRecord,
  onViewTrackRecord,
}: {
  approval: PendingApproval;
  onDecide: (decision: "approve" | "deny" | "run-as-service") => void;
  trackRecord?: { score: number | null };
  onViewTrackRecord?: () => void;
}) {
  return (
    <div className={`approval-card${approval.resolved ? " resolved" : ""}`}>
      <div className="title">
        <span className="status-dot" style={{ background: "var(--amber)" }} />
        Approval needed
      </div>
      <div className="detail">
        The agent wants to run <span className="mono">{approval.toolName}</span>
        {approval.serverName ? (
          <>
            {" "}
            via <span className="mono">{approval.serverName}</span>
          </>
        ) : null}{" "}
        <strong>acting as you</strong>.
        {approval.input != null && (
          <pre
            style={{
              background: "var(--surface-group)",
              border: "1px solid var(--border-1)",
              borderRadius: 6,
              padding: 8,
              marginTop: 8,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              whiteSpace: "pre-wrap",
            }}
          >
            {JSON.stringify(approval.input, null, 2)}
          </pre>
        )}
      </div>
      {trackRecord && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderTop: "1px solid rgba(251, 191, 36, 0.25)",
            paddingTop: 10,
            marginBottom: 10,
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          Track record
          <span className={`chip ${trackRecord.score !== null && trackRecord.score >= 90 ? "green" : "blue"}`}>
            {trackRecord.score !== null ? `${trackRecord.score}% pass` : "unmeasured"}
          </span>
          {onViewTrackRecord && (
            <button
              style={{ color: "var(--accent-text)", fontSize: 12 }}
              onClick={onViewTrackRecord}
            >
              view →
            </button>
          )}
        </div>
      )}
      {approval.resolved ? (
        <span className="chip">{approval.resolved}</span>
      ) : (
        <div className="actions">
          <button className="btn primary" onClick={() => onDecide("approve")}>
            Approve as me
          </button>
          <button className="btn danger" onClick={() => onDecide("deny")}>
            Deny
          </button>
          <button className="btn" onClick={() => onDecide("run-as-service")}>
            Run as service account
          </button>
        </div>
      )}
    </div>
  );
}

/** A thread item: message, live tool call, or approval card, in order. */
type ThreadItem =
  | { kind: "message"; message: Message }
  | { kind: "live-tool"; toolCall: ToolCall; running: boolean }
  | { kind: "approval"; approval: PendingApproval };

function SessionThread({ sessionId }: { sessionId: string }) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId),
  });
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const agentRow = agentsQuery.data?.agents.find(
    (a) => a.id === session.data?.session.agentId,
  );

  const [messages, setMessages] = useState<Message[]>([]);
  const [liveTools, setLiveTools] = useState<Array<{ toolCall: ToolCall; running: boolean }>>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<DrawerContent | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);

  useEffect(() => {
    // Merge instead of overwrite: the query snapshot may be stale if a reply
    // is streaming in while it resolves.
    if (session.data) {
      const server = session.data.messages;
      setMessages((prev) => {
        const seen = new Set(server.map((m) => m.id));
        return [...server, ...prev.filter((m) => !seen.has(m.id))];
      });
    }
  }, [session.data]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamingText, liveTools, approvals]);

  const send = async (content: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStreamingText("");
    setLiveTools([]);
    setApprovals([]);
    try {
      await streamMessage(sessionId, content, (event) => {
        if (event.type === "user-message") {
          setMessages((prev) => [...prev, event.message]);
        } else if (event.type === "delta") {
          setStreamingText((prev) => (prev ?? "") + event.text);
        } else if (event.type === "tool-start") {
          setLiveTools((prev) => [...prev, { toolCall: event.toolCall, running: true }]);
        } else if (event.type === "tool-end") {
          setLiveTools((prev) =>
            prev.map((t) =>
              t.toolCall.id === event.toolCall.id
                ? { toolCall: event.toolCall, running: false }
                : t,
            ),
          );
          setApprovals((prev) =>
            prev.map((a) =>
              a.toolName === event.toolCall.name && !a.resolved && event.toolCall.approval
                ? { ...a, resolved: event.toolCall.approval.status }
                : a,
            ),
          );
        } else if (event.type === "approval-request") {
          setApprovals((prev) => [
            ...prev,
            {
              approvalId: event.approvalId,
              toolName: event.toolName,
              serverName: event.serverName,
              input: event.input,
            },
          ]);
        } else if (event.type === "done") {
          setMessages((prev) => [...prev, event.message]);
          setStreamingText(null);
          setLiveTools([]);
          // Approval outcomes live on in the persisted tool-call chips
          setApprovals([]);
          void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        } else if (event.type === "error") {
          setError(event.error);
          setStreamingText(null);
        }
      });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message failed");
      setStreamingText(null);
    } finally {
      setBusy(false);
    }
  };

  // A session started from the landing page arrives with its first message
  // in navigation state; send it once the thread mounts.
  useEffect(() => {
    const initial = (location.state as { initialMessage?: string } | null)
      ?.initialMessage;
    if (initial && !sentInitial.current) {
      sentInitial.current = true;
      window.history.replaceState({}, "");
      void send(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (
    approval: PendingApproval,
    decision: "approve" | "deny" | "run-as-service",
  ) => {
    try {
      await api.decideApproval(sessionId, approval.approvalId, { decision });
      setApprovals((prev) =>
        prev.map((a) =>
          a.approvalId === approval.approvalId ? { ...a, resolved: decision } : a,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    }
  };

  const agentName = session.data?.session.agentName ?? "Agent";
  const initials = agentName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const agentGlyph = session.data?.session.agentIcon || initials;
  const agentColor =
    AGENT_COLORS[session.data?.session.agentColor ?? ""] ?? "var(--accent-text)";
  const evalResults = session.data?.evalResults ?? [];

  const passedCount = evalResults.filter((r) => r.passed).length;

  return (
    <div className="session-with-drawer">
      <div className="thread">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: "1px solid var(--border-row)",
            padding: "10px 24px",
            minHeight: 48,
          }}
        >
          <span
            className="avatar"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              background: "var(--surface-tool)",
              border: "1px solid var(--border-1)",
              color: agentColor,
            }}
            title={agentName}
          >
            {agentGlyph}
          </span>
          <span className="mono" style={{ fontSize: 13, color: "var(--text-1)" }}>
            {session.data?.session.title || "New session"}
          </span>
          <span className="chip">{session.data?.session.surface ?? "Web"}</span>
          {evalResults.length > 0 && (
            <button
              className={`chip ${passedCount === evalResults.length ? "green" : "amber"}`}
              title="Live criteria graded on this session"
              onClick={() => setDrawer({ kind: "evals", results: evalResults })}
            >
              {passedCount === evalResults.length ? "✓" : "!"} {passedCount}/
              {evalResults.length} criteria
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button
            style={{
              textAlign: "right",
              padding: "4px 8px",
              borderRadius: 7,
              color: "var(--text-2)",
            }}
            onClick={() =>
              session.data &&
              setDrawer({ kind: "agent", agentId: session.data.session.agentId })
            }
          >
            <span style={{ fontSize: 13, fontWeight: 500 }}>{agentName}</span>
            <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
              {agentRow ? `${agentRow.toolCount} tools · ` : ""}view agent →
            </span>
          </button>
        </div>
        <div className="thread-scroll" ref={scrollRef}>
          <div className="thread-messages">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="msg-user">
                  {m.content}
                </div>
              ) : (
                <div key={m.id} className="msg-agent">
                  <div
                    className="avatar"
                    style={{ cursor: "pointer", color: agentColor }}
                    title="Agent profile"
                    onClick={() =>
                      session.data &&
                      setDrawer({ kind: "agent", agentId: session.data.session.agentId })
                    }
                  >
                    {agentGlyph}
                  </div>
                  <div className="bubble">
                    <div className="agent-name">{agentName}</div>
                    {m.toolCalls.map((tc) =>
                      isFileArtifact(tc) ? (
                        <FileArtifactCard
                          key={tc.id}
                          toolCall={tc}
                          onOpen={(name, content) =>
                            setDrawer({ kind: "file", name, content })
                          }
                        />
                      ) : (
                        <ToolCallChip
                          key={tc.id}
                          toolCall={tc}
                          onClick={() => setDrawer({ kind: "tool", toolCall: tc })}
                        />
                      ),
                    )}
                    {m.content}
                  </div>
                </div>
              ),
            )}
            {(streamingText !== null || liveTools.length > 0 || approvals.length > 0) && (
              <div className="msg-agent">
                <div className="avatar">{initials}</div>
                <div className="bubble">
                  <div className="agent-name">{agentName}</div>
                  {liveTools.map((t) => (
                    <ToolCallChip
                      key={t.toolCall.id}
                      toolCall={t.toolCall}
                      running={t.running}
                      onClick={() => setDrawer({ kind: "tool", toolCall: t.toolCall })}
                    />
                  ))}
                  {approvals.map((a) => (
                    <ApprovalCard
                      key={a.approvalId}
                      approval={a}
                      onDecide={(d) => void decide(a, d)}
                      trackRecord={{ score: agentRow?.evalScore ?? null }}
                      onViewTrackRecord={() =>
                        session.data &&
                        setDrawer({
                          kind: "track-record",
                          agentId: session.data.session.agentId,
                        })
                      }
                    />
                  ))}
                  {streamingText !== null && (
                    <span className="typing-cursor">{streamingText}</span>
                  )}
                </div>
              </div>
            )}
            {error && <p className="error-text">{error}</p>}
          </div>
        </div>
        <div className="thread-composer">
          <div className="composer">
            <textarea
              placeholder={`Message ${agentName}…`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const content = text.trim();
                  if (content && !busy) {
                    setText("");
                    void send(content);
                  }
                }
              }}
            />
            <div className="composer-row">
              <span className="chip green">{agentName}</span>
              <button
                className="btn primary"
                disabled={busy || !text.trim()}
                onClick={() => {
                  const content = text.trim();
                  if (content) {
                    setText("");
                    void send(content);
                  }
                }}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
      {drawer && (
        <aside className="drawer">
          <button className="drawer-close" onClick={() => setDrawer(null)}>
            ✕
          </button>
          {drawer.kind === "agent" ? (
            <AgentProfileDrawer
              agentId={drawer.agentId}
              onStartSession={() => setDrawer(null)}
            />
          ) : drawer.kind === "track-record" ? (
            <TrackRecordDrawer agentId={drawer.agentId} />
          ) : drawer.kind === "file" ? (
            <>
              <h3 className="mono">{drawer.name}</h3>
              <div className="section-label">Contents</div>
              <pre style={{ maxHeight: 480 }}>{drawer.content}</pre>
            </>
          ) : drawer.kind === "tool" ? (
            <>
              <h3 className="mono">{drawer.toolCall.name}</h3>
              <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
                <span
                  className={`chip ${drawer.toolCall.authType === "user" ? "amber" : "green"}`}
                >
                  {drawer.toolCall.authType ?? "service"} auth
                </span>
                {drawer.toolCall.serverName && (
                  <span className="chip">{drawer.toolCall.serverName}</span>
                )}
                {drawer.toolCall.approval && (
                  <span className="chip amber">{drawer.toolCall.approval.status}</span>
                )}
              </div>
              <div className="section-label">Input</div>
              <pre>{JSON.stringify(drawer.toolCall.input, null, 2)}</pre>
              <div className="section-label">Output</div>
              <pre>
                {typeof drawer.toolCall.output === "string"
                  ? drawer.toolCall.output
                  : JSON.stringify(drawer.toolCall.output, null, 2)}
              </pre>
            </>
          ) : (
            <>
              <h3>Eval results</h3>
              <p className="page-subtitle">
                Live criteria evaluated against this session.
              </p>
              {drawer.results.map((r) => (
                <div key={r.criterionId} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className={`chip ${r.passed ? "green" : "amber"}`}>
                      {r.passed ? "PASS" : "FAIL"}
                    </span>
                    <strong style={{ fontSize: 13 }}>{r.criterionName}</strong>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
                    {r.reasoning}
                  </p>
                </div>
              ))}
              {session.data && (
                <FreezeCard
                  sessionId={sessionId}
                  agentId={session.data.session.agentId}
                />
              )}
            </>
          )}
        </aside>
      )}
    </div>
  );
}

function AgentProfileDrawer({
  agentId,
  onStartSession,
}: {
  agentId: string;
  onStartSession?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const tools = useQuery({
    queryKey: ["agent-tools", agentId],
    queryFn: () => api.agentTools(agentId),
  });
  const surfaces = useQuery({
    queryKey: ["surfaces", agentId],
    queryFn: () => api.listSurfaces(agentId),
  });
  const agent = agents.data?.agents.find((a) => a.id === agentId);
  if (!agent) return <h3>Agent</h3>;
  const canConfigure = agent.myRight === "edit" || agent.myRight === "admin";
  const byServer = new Map<string, { service: number; user: number }>();
  for (const t of tools.data?.tools ?? []) {
    if (!t.enabled) continue;
    const entry = byServer.get(t.serverName) ?? { service: 0, user: 0 };
    entry[t.authType] += 1;
    byServer.set(t.serverName, entry);
  }
  return (
    <>
      <h3>{agent.name}</h3>
      <p className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {agent.slug}
      </p>
      <div style={{ display: "flex", gap: 6, margin: "10px 0", flexWrap: "wrap" }}>
        <span className={`chip ${agent.status === "active" ? "green" : "amber"}`}>
          {agent.status}
        </span>
        {agent.domainName && <span className="chip purple">{agent.domainName}</span>}
        {agent.evalScore !== null && (
          <span className={`chip ${agent.evalScore >= 90 ? "green" : "blue"}`}>
            eval {agent.evalScore}%
          </span>
        )}
        <span className="chip">{agent.toolCount} tools</span>
      </div>
      {agent.description && (
        <>
          <div className="section-label">Role</div>
          <p style={{ fontSize: 13, color: "var(--text-2)", margin: "6px 0 14px" }}>
            {agent.description}
          </p>
        </>
      )}
      <div className="section-label">Your access</div>
      <p style={{ fontSize: 13, color: "var(--text-2)", margin: "6px 0 14px" }}>
        {agent.myRight ?? "none"}
      </p>
      {byServer.size > 0 && (
        <>
          <div className="section-label">Connected tools</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0 14px" }}>
            {[...byServer.entries()].map(([server, counts]) => (
              <span
                key={server}
                className={`chip ${counts.user > 0 ? (counts.service > 0 ? "" : "amber") : "green"}`}
              >
                {server}::* ·{" "}
                {counts.user > 0 && counts.service > 0
                  ? "mixed"
                  : counts.user > 0
                    ? "user"
                    : "service"}
              </span>
            ))}
          </div>
        </>
      )}
      {(surfaces.data?.surfaces.length ?? 0) > 0 && (
        <>
          <div className="section-label">Also reachable on</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0 14px" }}>
            {surfaces.data!.surfaces.map((s) => (
              <span key={s.id} className="chip">
                {s.vendor}
                {s.label ? ` ${s.label}` : ""}
              </span>
            ))}
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          className="btn primary"
          onClick={async () => {
            const { session } = await api.createSession(agent.id);
            await queryClient.invalidateQueries({ queryKey: ["sessions"] });
            onStartSession?.();
            navigate(`/sessions/${session.id}`);
          }}
        >
          Start session
        </button>
        {canConfigure && (
          <Link to={`/agents/${agent.id}`} className="btn" style={{ display: "inline-flex" }}>
            Configure →
          </Link>
        )}
      </div>
    </>
  );
}


function isFileArtifact(tc: ToolCall): boolean {
  return (
    (tc.name === "write_file" || tc.name === "edit_file") &&
    typeof (tc.input as { file_path?: string })?.file_path === "string"
  );
}

function FileArtifactCard({
  toolCall,
  onOpen,
}: {
  toolCall: ToolCall;
  onOpen: (name: string, content: string) => void;
}) {
  const input = toolCall.input as { file_path?: string; content?: string };
  const name = input.file_path ?? "file";
  const content = input.content ?? String(toolCall.output ?? "");
  const lines = content.split("\n").length;
  return (
    <div className="tool-call" onClick={() => onOpen(name, content)}>
      <span style={{ color: "var(--text-dim)" }}>≡</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="tool-name">{name}</span>
        <span className="tool-server" style={{ marginLeft: 8 }}>
          file · {lines} lines
        </span>
      </span>
      <span style={{ color: "var(--accent-text)", fontSize: 12 }}>open →</span>
    </div>
  );
}

function FreezeCard({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const queryClient = useQueryClient();
  const suites = useQuery({
    queryKey: ["suites", agentId],
    queryFn: () => api.listSuites(agentId),
  });
  const [suiteId, setSuiteId] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      style={{
        border: "1px dashed var(--border-2)",
        borderRadius: 10,
        padding: 12,
        marginTop: 16,
      }}
    >
      <strong style={{ fontSize: 13 }}>Freeze as test case</strong>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 10px" }}>
        Snapshot this session's input and expected outcome into an offline
        suite — it re-runs on demand so this behavior can't silently regress.
      </p>
      {done ? (
        <span className="chip green">Added to suite ✓</span>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} style={{ flex: 1 }}>
            <option value="">Choose a suite…</option>
            {suites.data?.suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            disabled={!suiteId}
            onClick={async () => {
              try {
                await api.freezeSession(sessionId, suiteId);
                setDone(true);
                void queryClient.invalidateQueries({ queryKey: ["suites", agentId] });
              } catch (err) {
                setError(err instanceof Error ? err.message : "Freeze failed");
              }
            }}
          >
            + Add to suite
          </button>
        </div>
      )}
      {suites.data?.suites.length === 0 && (
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
          No suites yet — create one on the agent's evals tab first.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function TrackRecordDrawer({ agentId }: { agentId: string }) {
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const criteria = useQuery({
    queryKey: ["criteria", agentId],
    queryFn: () => api.listCriteria(agentId),
  });
  const suites = useQuery({
    queryKey: ["suites", agentId],
    queryFn: () => api.listSuites(agentId),
  });
  const agent = agents.data?.agents.find((a) => a.id === agentId);
  const graded =
    (criteria.data?.criteria.reduce((sum, c) => sum + c.sessionCount, 0) ?? 0) +
    (suites.data?.suites.reduce((sum, s) => sum + (s.lastRun?.total ?? 0), 0) ?? 0);

  return (
    <>
      <h3>{agent?.name ?? "Agent"} · track record</h3>
      <div style={{ margin: "14px 0" }}>
        <div style={{ fontSize: 34, fontWeight: 600 }}>
          {agent?.evalScore !== null && agent?.evalScore !== undefined
            ? `${agent.evalScore}%`
            : "—"}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Overall pass rate · {graded} graded sessions &amp; cases
        </div>
      </div>
      <div className="section-label">Live criteria</div>
      {criteria.data?.criteria.map((c) => (
        <div
          key={c.id}
          style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}
        >
          <span className="mono" style={{ fontSize: 12, flex: 1 }}>
            {c.name}
          </span>
          <div
            style={{
              width: 90,
              height: 5,
              borderRadius: 3,
              background: "var(--surface-group)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${c.passRate ?? 0}%`,
                height: "100%",
                background: "var(--green)",
              }}
            />
          </div>
          <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>
            {c.passRate !== null ? `${c.passRate}%` : "—"}
          </span>
        </div>
      ))}
      {criteria.data?.criteria.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No live criteria yet.</p>
      )}
      <div className="section-label">Offline suites</div>
      {suites.data?.suites.map((s) => (
        <div
          key={s.id}
          style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}
        >
          <span className="mono" style={{ fontSize: 12, flex: 1 }}>
            {s.name}
          </span>
          <span style={{ fontSize: 12 }}>
            {s.lastRun ? `${s.lastRun.passed}/${s.lastRun.total}` : "never run"}
          </span>
        </div>
      ))}
      {suites.data?.suites.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No suites yet.</p>
      )}
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 14 }}>
        This record is attached as evidence whenever the agent requests
        approval or new access.
      </p>
    </>
  );
}
