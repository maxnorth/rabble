import type {
  AgentDirectoryRow,
  Message,
  SessionEvalResult,
  ToolCall,
} from "@rabble/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, streamMessage } from "../api";

interface PendingApproval {
  approvalId: string;
  toolName: string;
  serverName: string | null;
  input: unknown;
  resolved?: string;
}

type DrawerContent =
  | { kind: "tool"; toolCall: ToolCall }
  | { kind: "evals"; results: SessionEvalResult[] };

export function SessionsSection() {
  const { sessionId } = useParams();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.listSessions });

  return (
    <>
      <aside className="sidebar">
        <NavLink to="/sessions" end className="btn" style={{ margin: "0 4px 12px" }}>
          + New session
        </NavLink>
        <div className="sidebar-title">Recent</div>
        {sessions.data?.sessions.map((s) => (
          <NavLink
            key={s.id}
            to={`/sessions/${s.id}`}
            className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
          >
            <span
              className="status-dot"
              style={{ background: "var(--green)" }}
              title={s.agentName}
            />
            <span className="label">{s.title || "New session"}</span>
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
          style={{ background: target ? "var(--green)" : "var(--blue)" }}
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
            Auto
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
              <span className="status-dot" style={{ background: "var(--green)" }} />
              {a.name}
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
      const { session } = await api.createSession(target?.id ?? null);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/sessions/${session.id}`, { state: { initialMessage: content } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start session");
      setBusy(false);
    }
  };

  return (
    <div className="session-landing">
      <div className="session-greeting">What are we working on?</div>
      <div className="composer">
        <textarea
          placeholder="Message an agent…"
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
      <span className="tool-name">{toolCall.name}</span>
      {toolCall.serverName && <span className="tool-server">{toolCall.serverName}</span>}
      <span style={{ flex: 1 }} />
      <span className={`chip ${auth === "service" ? "green" : "amber"}`}>{auth}</span>
    </div>
  );
}

function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: PendingApproval;
  onDecide: (decision: "approve" | "deny" | "run-as-service") => void;
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
  const evalResults = session.data?.evalResults ?? [];

  return (
    <div className="session-with-drawer">
      <div className="thread">
        {evalResults.length > 0 && (
          <div style={{ borderBottom: "1px solid var(--border-row)", padding: "8px 24px" }}>
            <div className="eval-strip">
              {evalResults.map((r) => (
                <button
                  key={r.criterionId}
                  className={`chip ${r.passed ? "green" : "amber"}`}
                  title={r.reasoning}
                  onClick={() => setDrawer({ kind: "evals", results: evalResults })}
                >
                  {r.passed ? "✓" : "✕"} {r.criterionName}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="thread-scroll" ref={scrollRef}>
          <div className="thread-messages">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="msg-user">
                  {m.content}
                </div>
              ) : (
                <div key={m.id} className="msg-agent">
                  <div className="avatar">{initials}</div>
                  <div className="bubble">
                    <div className="agent-name">{agentName}</div>
                    {m.toolCalls.map((tc) => (
                      <ToolCallChip
                        key={tc.id}
                        toolCall={tc}
                        onClick={() => setDrawer({ kind: "tool", toolCall: tc })}
                      />
                    ))}
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
          {drawer.kind === "tool" ? (
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
            </>
          )}
        </aside>
      )}
    </div>
  );
}
