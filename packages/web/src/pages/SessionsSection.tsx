import type {
  AgentDirectoryRow,
  Message,
  SessionEvalResult,
  ToolCall,
} from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, streamMessage } from "../api";
import { relativeTime, count, AGENT_COLORS } from "../lib/time";
import { sessionToMarkdown, exportFilename } from "../lib/sessionExport";

interface PendingApproval {
  approvalId: string;
  toolName: string;
  serverName: string | null;
  input: unknown;
  resolved?: string;
}

interface PendingConnect {
  connectId: string;
  serverId: string;
  serverName: string;
  requiresOAuth: boolean;
  connected?: boolean;
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
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);

  // Shortcuts: "/" focuses search, "n" starts a session (outside inputs)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      ) {
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "n") {
        e.preventDefault();
        navigate("/sessions");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const visible = (sessions.data?.sessions ?? []).filter(
    (s) =>
      !query ||
      s.title.toLowerCase().includes(query.toLowerCase()) ||
      (s.agentName ?? "Auto").toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <aside className="sidebar">
        <NavLink to="/sessions" end className="btn" style={{ margin: "0 4px 12px" }}>
          + New session
        </NavLink>
        <input
          ref={searchRef}
          placeholder="Search sessions…  ( / )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ margin: "0 4px 10px", fontSize: 12 }}
        />
        <div className="sidebar-title">Recent sessions</div>
        {visible.map((s) => (
          <NavLink
            key={s.id}
            to={`/sessions/${s.id}`}
            className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
          >
            <span
              className="status-dot"
              style={{ background: AGENT_COLORS[s.agentColor ?? ""] ?? "var(--green)" }}
              title={s.agentName ?? "Auto"}
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
                {s.agentName ?? "Auto"} · {relativeTime(s.updatedAt)}
              </span>
            </span>
          </NavLink>
        ))}
        {visible.length === 0 && (
          <div className="sidebar-item" style={{ color: "var(--text-muted)" }}>
            {query ? "No sessions match" : "No sessions yet"}
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
  const usable = agents.filter((a) => a.status === "active" && a.myRight && a.webEnabled);
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

  // The built-in Builder doesn't count as "having an agent" — the
  // first-run checklist should still walk a fresh org through setup.
  const usable = (agents.data?.agents ?? []).filter(
    (a) => a.status === "active" && a.myRight && !a.builtin && a.webEnabled,
  );
  const isAdmin = me.data?.user.role !== "member";
  const models = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const hasModel = (models.data?.models ?? []).some((m) => m.enabled);

  return (
    <div className="session-landing">
      <div className="session-greeting">
        Good {dayPart}
        {firstName ? `, ${firstName}` : ""}
      </div>
      <p className="page-subtitle" style={{ marginTop: -14 }}>
        Start a session with an agent, or let Auto route you to the right one.
      </p>
      {agents.data && usable.length === 0 && (
        <div
          className="card"
          style={{ padding: 16, marginBottom: 16, maxWidth: 560 }}
        >
          <strong style={{ fontSize: 13.5 }}>
            {isAdmin ? "Let's get your first agent running" : "No agents yet"}
          </strong>
          {isAdmin ? (
            <ol style={{ margin: "10px 0 0 18px", fontSize: 12.5, color: "var(--text-dim)", display: "grid", gap: 6 }}>
              <li>
                {hasModel ? "✓ " : ""}
                <Link to="/admin/models" style={{ color: "var(--accent-text)" }}>
                  Register a model
                </Link>. Enable a built-in or point at your own endpoint
              </li>
              <li>
                <Link to="/agents" style={{ color: "var(--accent-text)" }}>
                  Create an agent
                </Link>, name, instructions, model, then set it active
              </li>
              <li>
                Grant access, on the agent's access tab, so teammates can use
                it (you already can, as its creator)
              </li>
            </ol>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "8px 0 0" }}>
              Nothing has been shared with you yet. Ask an org admin to grant
              you access to an agent.
            </p>
          )}
        </div>
      )}
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
      {usable.length > 0 && (
        <div className="agent-quick">
          <div className="agent-quick-head">
            <span>Your agents</span>
            <Link to="/agents">view all →</Link>
          </div>
          <div className="agent-quick-grid">
            {[...usable]
              .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
              .slice(0, 4)
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`agent-quick-card${target?.id === a.id ? " selected" : ""}`}
                  title={`Start a session with ${a.name}`}
                  onClick={() => setTarget(target?.id === a.id ? null : a)}
                >
                  <span
                    className="agent-quick-glyph"
                    style={{ color: AGENT_COLORS[a.color] ?? "var(--accent-text)" }}
                  >
                    {a.icon || a.name[0]}
                  </span>
                  <span className="agent-quick-name">{a.name}</span>
                  <span className="agent-quick-desc">{a.description || " "}</span>
                  {a.evalScore !== null && (
                    <span className="meta-note">{a.evalScore}% eval</span>
                  )}
                </button>
              ))}
          </div>
        </div>
      )}
      {(() => {
        const builder = (agents.data?.agents ?? []).find(
          (a) => a.builtin === "builder" && a.myRight,
        );
        if (!builder) return null;
        return (
          <p
            className="page-subtitle"
            style={{ marginTop: 18, fontSize: 12 }}
          >
            Need a new agent?{" "}
            <button
              type="button"
              onClick={() => setTarget(builder)}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: "var(--accent-text)",
                cursor: "pointer",
              }}
            >
              Have the Builder create one with you →
            </button>
          </p>
        );
      })()}
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
  // A sub-agent delegation (buildSubAgentTools names them ask_<slug>) is a
  // governed agent-to-agent call, not an MCP tool — render it as such so the
  // bounded-delegation story reads clearly in the transcript.
  const isDelegation = toolCall.name.startsWith("ask_") && !!toolCall.serverName;
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
          <span className="tool-name">
            {isDelegation ? `Delegated to ${toolCall.serverName}` : toolCall.name}
          </span>
          {!isDelegation && toolCall.serverName && (
            <span className="tool-server">{toolCall.serverName}</span>
          )}
          <span style={{ flex: 1 }} />
          {toolCall.durationMs != null && (
            <span className="tool-server">
              {(toolCall.durationMs / 1000).toFixed(1)}s · details
            </span>
          )}
          {isDelegation ? (
            <span className="tool-server">agent</span>
          ) : auth === "user" ? (
            <span
              className="chip amber"
              title="Ran as the person in the session, behind the approval gate"
            >
              user
            </span>
          ) : null}
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
  agentId,
  trackRecord,
  onViewTrackRecord,
}: {
  approval: PendingApproval;
  onDecide: (decision: "approve" | "deny") => void;
  agentId?: string;
  trackRecord?: { score: number | null };
  onViewTrackRecord?: () => void;
}) {
  const trust = useQuery({
    queryKey: ["trust", agentId],
    queryFn: () => api.agentTrust(agentId!),
    enabled: Boolean(agentId),
  });
  return (
    <div className={`approval-card${approval.resolved ? " resolved" : ""}`}>
      <div className="title">
        <span className="status-dot" style={{ background: "var(--amber)" }} />
        Approval needed · acting as you
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
          className="evidence"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderTop: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)",
            paddingTop: 10,
            marginBottom: 10,
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          Track record
          <span style={{ color: "var(--text-2)" }}>
            {trackRecord.score !== null
              ? `${trackRecord.score}% pass · ${trust.data?.gradedCount ?? 0} graded`
              : "unmeasured"}
          </span>
          <span
            style={
              (trust.data?.scopeViolations30d ?? 0) > 0
                ? { color: "var(--amber)" }
                : undefined
            }
          >
            · {trust.data?.scopeViolations30d ?? 0} scope violations (30d)
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
        </div>
      )}
    </div>
  );
}

function ConnectCard({
  connect,
  onConnected,
}: {
  connect: PendingConnect;
  onConnected: () => void;
}) {
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () => api.connectMcpCredential(connect.serverId, token),
    onSuccess: onConnected,
  });
  // OAuth: open the provider's authorize page; the callback stores the
  // credential and the paused turn resumes on its own (server-side resolve),
  // reflected here by the pendingConnects hydration flipping this to done.
  const startOAuth = useMutation({
    mutationFn: () => api.startMcpOAuth(connect.serverId),
    onSuccess: ({ authorizeUrl }) => window.open(authorizeUrl, "_blank", "noopener"),
  });
  const done = connect.connected;
  return (
    <div className={`approval-card${done ? " resolved" : ""}`}>
      <div className="title">
        <span
          className="status-dot"
          style={{ background: done ? "var(--green)" : "var(--amber)" }}
        />
        {done ? "Account connected" : "Connect your account"}
      </div>
      <div className="detail">
        {done ? (
          <>
            Your <span className="mono">{connect.serverName}</span> account is connected. The
            agent is continuing.
          </>
        ) : connect.requiresOAuth ? (
          <>
            <span className="mono">{connect.serverName}</span> runs as you. Authorize your
            account to continue.
          </>
        ) : (
          <>
            <span className="mono">{connect.serverName}</span> runs as you. Paste your token to
            connect your account, or add it under Profile, Connected accounts.
          </>
        )}
      </div>
      {!done && connect.requiresOAuth && (
        <div style={{ marginTop: 10 }}>
          <button
            className="btn primary"
            disabled={startOAuth.isPending}
            onClick={() => startOAuth.mutate()}
          >
            Connect {connect.serverName}
          </button>
        </div>
      )}
      {!done && !connect.requiresOAuth && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            type="password"
            placeholder="Your token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            className="btn primary"
            disabled={!token.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            Connect
          </button>
        </div>
      )}
      {save.isError && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {(save.error as Error).message}
        </p>
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
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.getPreferences });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const inlineToolCalls = prefs.data?.preferences.inlineToolCalls ?? true;
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  const navigate = useNavigate();
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (title: string) => api.renameSession(sessionId, title),
    onSuccess: () => {
      setEditingTitle(null);
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const removeSession = useMutation({
    mutationFn: () => api.deleteSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate("/sessions");
    },
  });

  const [messages, setMessages] = useState<Message[]>([]);
  const [liveTools, setLiveTools] = useState<Array<{ toolCall: ToolCall; running: boolean }>>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [connects, setConnects] = useState<PendingConnect[]>([]);

  // Approvals raised by surface turns (Slack/GitHub) while nobody had the
  // web session open: surface them as cards on load — either place decides.
  useEffect(() => {
    const pending = session.data?.pendingApprovals ?? [];
    if (pending.length === 0) return;
    setApprovals((prev) => {
      const known = new Set(prev.map((a) => a.approvalId));
      const fresh = pending.filter((a) => !known.has(a.approvalId));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, [session.data]);

  useEffect(() => {
    const pending = session.data?.pendingConnects ?? [];
    if (pending.length === 0) return;
    setConnects((prev) => {
      const known = new Set(prev.map((c) => c.connectId));
      const fresh = pending.filter((c) => !known.has(c.connectId));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, [session.data]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<DrawerContent | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);
  const streamAbort = useRef<AbortController | null>(null);
  const judgeTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Abandon any in-flight stream and pending judge-refetch timers when the
  // session changes or the thread unmounts — the POST is cancelled (no wasted
  // turn) and no timer fires an invalidate against a session that's gone.
  useEffect(() => {
    return () => {
      streamAbort.current?.abort();
      for (const t of judgeTimers.current) clearTimeout(t);
      judgeTimers.current = [];
    };
  }, [sessionId]);

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
  }, [messages, streamingText, liveTools, approvals, connects]);

  const send = async (content: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStreamingText("");
    setLiveTools([]);
    setApprovals([]);
    setConnects([]);
    const abort = new AbortController();
    streamAbort.current = abort;
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
        } else if (event.type === "connect-request") {
          setConnects((prev) => [
            ...prev,
            {
              connectId: event.connectId,
              serverId: event.serverId,
              serverName: event.serverName,
              requiresOAuth: event.requiresOAuth,
            },
          ]);
        } else if (event.type === "turn-start") {
          // Multi-party: the next responder begins — restyle the live bubble.
          setStreamingAgent({
            name: event.agentName,
            glyph:
              event.agentIcon ||
              event.agentName
                .split(/\s+/)
                .map((p: string) => p[0])
                .slice(0, 2)
                .join("")
                .toUpperCase(),
            color: AGENT_COLORS[event.agentColor ?? ""] ?? "var(--accent-text)",
          });
          setStreamingText("");
        } else if (event.type === "done") {
          // One responder finished; more may follow in the same round.
          setMessages((prev) => [...prev, event.message]);
          setStreamingText(null);
          setLiveTools([]);
          // Approval outcomes live on in the persisted tool-call chips
          setApprovals([]);
          setConnects([]);
          void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
          // Live judging lands a few seconds AFTER the turn — refetch so the
          // criteria chip reflects the fresh verdict, not the previous one.
          // Tracked so they're cancelled if the session changes/unmounts.
          for (const delay of [2500, 7000]) {
            judgeTimers.current.push(
              setTimeout(() => {
                void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
              }, delay),
            );
          }
        } else if (event.type === "error") {
          setError(event.error);
          setStreamingText(null);
          setLiveTools([]);
          setApprovals([]);
          // The failed turn was persisted — refetch so it renders inline in
          // the thread (and survives the next reload), not just as a banner.
          void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        }
      }, abort.signal);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (err) {
      // A user-initiated abort (navigated away / switched session) isn't an
      // error to surface — the thread is unmounting anyway.
      if (!abort.signal.aborted) {
        setError(err instanceof Error ? err.message : "Message failed");
        // The stream dropped with no terminal event — reconcile with whatever
        // the server persisted (a completed reply, or a failed-turn record).
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      }
    } finally {
      // Always clear streaming state — a stream that closes without a
      // done/error event must not leave a permanent typing indicator or
      // spinning tool chips.
      setStreamingText(null);
      setStreamingAgent(null);
      setLiveTools([]);
      setApprovals([]);
      if (streamAbort.current === abort) streamAbort.current = null;
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
    decision: "approve" | "deny",
  ) => {
    try {
      // Async approvals: by the time this resolves, the platform has run
      // the approved call and the agent has already replied in a follow-up
      // turn — refetch the session so both land in the transcript.
      await api.decideApproval(sessionId, approval.approvalId, { decision });
      // The decided ask leaves the thread — the flipped tool-call chip and
      // the agent's follow-up turn are the durable record.
      setApprovals((prev) =>
        prev.filter((a) => a.approvalId !== approval.approvalId),
      );
      await queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    }
  };

  const isAuto = session.data ? session.data.session.agentId === null : false;
  const agentName = session.data?.session.agentName ?? (isAuto ? "Auto" : "Agent");
  const glyphFor = (name: string, icon?: string | null) =>
    icon ||
    name
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  const agentGlyph = isAuto ? "✳" : glyphFor(agentName, session.data?.session.agentIcon);
  const agentColor =
    AGENT_COLORS[session.data?.session.agentColor ?? ""] ?? "var(--accent-text)";
  // Multi-party sessions carry per-message identity; pinned sessions fall
  // back to the session's agent.
  const bubbleIdentity = (m: Message) => ({
    name: m.agentName ?? agentName,
    glyph: m.agentName ? glyphFor(m.agentName, m.agentIcon) : agentGlyph,
    color: m.agentColor ? (AGENT_COLORS[m.agentColor] ?? agentColor) : agentColor,
    agentId: m.agentId ?? session.data?.session.agentId ?? null,
  });
  // While streaming, turn-start stamps who is speaking (Auto sessions can
  // stream several responders to one message).
  const [streamingAgent, setStreamingAgent] = useState<{
    name: string;
    glyph: string;
    color: string;
  } | null>(null);
  const evalResults = session.data?.evalResults ?? [];

  const passedCount = evalResults.filter((r) => r.passed).length;

  return (
    <div className="session-with-drawer">
      <div className="thread">
        <div
          className="thread-head"
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
          {editingTitle !== null ? (
            <input
              className="mono"
              autoFocus
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editingTitle.trim()) rename.mutate(editingTitle);
                if (e.key === "Escape") setEditingTitle(null);
              }}
              onBlur={() => setEditingTitle(null)}
              style={{ fontSize: 13, width: 280 }}
            />
          ) : (
            <span
              className="mono"
              style={{ fontSize: 13, color: "var(--text-1)", cursor: "text" }}
              title="Click to rename"
              onClick={() =>
                setEditingTitle(session.data?.session.title ?? "")
              }
            >
              {session.data?.session.title || "New session"}
            </span>
          )}
          <span className="thread-surface meta-note">
            {session.data?.session.surface ?? "Web"}
          </span>
          {(() => {
            const others = [
              ...new Set(
                messages
                  .filter((m) => m.role === "user" && m.authorName)
                  .map((m) => m.authorName!)
                  .filter((n) => n !== me.data?.user.name),
              ),
            ];
            return others.length > 0 ? (
              <span
                className="thread-surface meta-note"
                title={`Shared thread · also here: ${others.join(", ")}`}
              >
                +{others.length} teammate{others.length === 1 ? "" : "s"}
              </span>
            ) : null;
          })()}
          <button
            title="Export transcript (Markdown)"
            style={{ color: "var(--text-muted)", fontSize: 12, padding: "2px 4px" }}
            onClick={() => {
              const data = session.data;
              if (!data) return;
              const md = sessionToMarkdown(
                data.session,
                messages,
                evalResults,
                new Date().toLocaleString(),
              );
              const blob = new Blob([md], { type: "text/markdown" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = exportFilename(data.session.title);
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            ⇩ export
          </button>
          <button
            title="Delete session"
            style={{ color: "var(--text-muted)", fontSize: 13, padding: "2px 4px" }}
            onClick={() => {
              if (confirm("Delete this session and its transcript?")) {
                removeSession.mutate();
              }
            }}
          >
            🗑
          </button>
          {(() => {
            const builder = agentsQuery.data?.agents.find(
              (a) => a.builtin === "builder" && a.myRight,
            );
            if (!builder || agentRow?.builtin) return null;
            return (
              <button
                title="Start a Builder session that drafts an agent for this kind of work"
                style={{ color: "var(--text-muted)", fontSize: 12, padding: "2px 4px" }}
                onClick={async () => {
                  const asks = messages
                    .filter((m) => m.role === "user")
                    .map((m) => `- ${m.content.slice(0, 200)}`)
                    .slice(0, 5)
                    .join("\n");
                  const { session: created } = await api.createSession(builder.id);
                  await queryClient.invalidateQueries({ queryKey: ["sessions"] });
                  navigate(`/sessions/${created.id}`, {
                    state: {
                      initialMessage:
                        `I keep doing this kind of work by hand. Draft an agent for it. ` +
                        `From my session "${session.data?.session.title ?? ""}", here's what I asked:\n${asks}\n` +
                        `Propose a draft with eval criteria and confirm what you inferred.`,
                    },
                  });
                }}
              >
                ✦ agent from this
              </button>
            );
          })()}
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
              session.data.session.agentId &&
              setDrawer({ kind: "agent", agentId: session.data.session.agentId })
            }
          >
            <span style={{ fontSize: 13, fontWeight: 500 }}>{agentName}</span>
            <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
              {agentRow ? `${count(agentRow.toolCount, "tool")} · ` : ""}view agent →
            </span>
          </button>
        </div>
        <div className="thread-scroll" ref={scrollRef}>
          <div className="thread-messages">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="msg-user">
                  {m.authorName && m.authorName !== me.data?.user.name && (
                    <div
                      style={{
                        fontSize: 10.5,
                        color: "var(--text-muted)",
                        marginBottom: 3,
                        textAlign: "right",
                      }}
                    >
                      {m.authorName}
                    </div>
                  )}
                  {m.content}
                </div>
              ) : (
                <div key={m.id} className="msg-agent">
                  <div
                    className="avatar"
                    style={{ cursor: "pointer", color: bubbleIdentity(m).color }}
                    title="Agent profile"
                    onClick={() => {
                      const target = bubbleIdentity(m).agentId;
                      if (target) setDrawer({ kind: "agent", agentId: target });
                    }}
                  >
                    {bubbleIdentity(m).glyph}
                  </div>
                  <div className="bubble">
                    <div className="agent-name">{bubbleIdentity(m).name}</div>
                    {!inlineToolCalls &&
                      m.toolCalls.length > 0 &&
                      !expandedTools.has(m.id) && (
                        <button
                          className="chip"
                          style={{ marginBottom: 6 }}
                          title="Tool calls are collapsed (Profile › Agent preferences)"
                          onClick={() =>
                            setExpandedTools((prev) => new Set(prev).add(m.id))
                          }
                        >
                          {m.toolCalls.length} tool call
                          {m.toolCalls.length === 1 ? "" : "s"} · show
                        </button>
                      )}
                    {(inlineToolCalls || expandedTools.has(m.id)) &&
                      m.toolCalls.map((tc) =>
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
                    {m.error && (
                      <div
                        className="error-text"
                        style={{ marginTop: m.content ? 6 : 0 }}
                      >
                        ⚠ The agent couldn't finish this turn: {m.error}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
            {(streamingText !== null || liveTools.length > 0 || approvals.length > 0) && (
              <div className="msg-agent">
                <div className="avatar" style={{ color: streamingAgent?.color ?? agentColor }}>
                  {streamingAgent?.glyph ?? agentGlyph}
                </div>
                <div className="bubble">
                  <div className="agent-name">{streamingAgent?.name ?? agentName}</div>
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
                      agentId={session.data?.session.agentId ?? undefined}
                      trackRecord={{ score: agentRow?.evalScore ?? null }}
                      onViewTrackRecord={() => {
                        const target = session.data?.session.agentId;
                        if (target) setDrawer({ kind: "track-record", agentId: target });
                      }}
                    />
                  ))}
                  {connects.map((c) => (
                    <ConnectCard
                      key={c.connectId}
                      connect={c}
                      onConnected={() =>
                        setConnects((prev) =>
                          prev.map((x) =>
                            x.connectId === c.connectId ? { ...x, connected: true } : x,
                          ),
                        )
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
              placeholder={isAuto ? "Message your agents…" : `Message ${agentName}…`}
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
              <span className="composer-agent meta-note">{agentName}</span>
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
              <div className="server-meta" style={{ margin: "8px 0", display: "block" }}>
                {drawer.toolCall.authType ?? "service"} auth
                {drawer.toolCall.serverName ? ` · ${drawer.toolCall.serverName}` : ""}
                {drawer.toolCall.approval && (
                  <>
                    {" · "}
                    <span
                      style={
                        drawer.toolCall.approval.status === "approved" ||
                        drawer.toolCall.approval.status === "auto-approved"
                          ? undefined
                          : { color: "var(--amber)" }
                      }
                    >
                      {drawer.toolCall.approval.status}
                    </span>
                  </>
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
              {drawer.toolCall.childSessionId && (
                <Link
                  to={`/sessions/${drawer.toolCall.childSessionId}`}
                  style={{ color: "var(--accent-text)", fontSize: 13 }}
                  onClick={() => setDrawer(null)}
                >
                  view delegated session →
                </Link>
              )}
            </>
          ) : (
            <>
              <h3>Eval results</h3>
              <p className="page-subtitle">
                Live criteria evaluated against this session.
              </p>
              {(session.data?.evalResults ?? drawer.results).map((r) => (
                <EvalResultRow key={r.id} result={r} sessionId={sessionId} />
              ))}
              <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Every grade is spot-checkable. Disagree to queue it for human
                review on the agent's evals tab.
              </p>
              {(() => {
                // Freeze targets one agent's suites: the pinned agent, or —
                // in a multi-party Auto session — whoever answered last.
                const lastAuthor = [...messages]
                  .reverse()
                  .find((m) => m.role === "agent" && m.agentId)?.agentId;
                const freezeAgent = session.data?.session.agentId ?? lastAuthor;
                return freezeAgent ? (
                  <FreezeCard sessionId={sessionId} agentId={freezeAgent} />
                ) : null;
              })()}
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
      <div
        className="server-meta"
        style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0" }}
      >
        {agent.status !== "active" && <span className="chip amber">draft</span>}
        <span>
          {[
            agent.status === "active" ? "active" : null,
            agent.domainName ?? null,
            agent.evalScore !== null ? `eval ${agent.evalScore}%` : null,
            count(agent.toolCount, "tool"),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
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
              <span key={server} className="server-meta mono">
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
              <span key={s.id} className="server-meta">
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
  const input = toolCall.input as {
    file_path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
  };
  const name = input.file_path ?? "file";
  const content = input.content ?? input.new_string ?? String(toolCall.output ?? "");
  const lines = content.split("\n").length;
  // edit_file carries a diff shape: show +added −removed like the prototype
  const meta =
    toolCall.name === "edit_file" && input.old_string != null
      ? `diff · +${(input.new_string ?? "").split("\n").length} −${input.old_string.split("\n").length}`
      : `file · ${lines} lines`;
  return (
    <div className="tool-call" onClick={() => onOpen(name, content)}>
      <span style={{ color: "var(--text-dim)" }}>≡</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="tool-name">{name}</span>
        <span className="tool-server" style={{ marginLeft: 8 }}>
          {meta}
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
        suite. It re-runs on demand so this behavior can't silently regress.
      </p>
      {done ? (
        <span className="sub">Added to suite ✓</span>
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
          No suites yet. Create one on the agent's evals tab first.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function EvalResultRow({
  result,
  sessionId,
}: {
  result: SessionEvalResult;
  sessionId: string;
}) {
  const queryClient = useQueryClient();
  const dispute = useMutation({
    mutationFn: () => api.disputeEvalResult(result.id),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
  });
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className={`chip ${result.passed ? "green" : "amber"}`}>
          {result.passed ? "PASS" : "FAIL"}
        </span>
        <strong style={{ fontSize: 13, flex: 1 }}>{result.criterionName}</strong>
        {result.reviewStatus === "open" ? (
          <span className="chip blue">in review</span>
        ) : result.reviewStatus ? (
          <span className="chip">{result.reviewStatus}</span>
        ) : (
          <button
            style={{ fontSize: 11, color: "var(--text-muted)" }}
            title="Queue this verdict for human review"
            disabled={dispute.isPending}
            onClick={() => dispute.mutate()}
          >
            Disagree →
          </button>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
        {result.reasoning}
      </p>
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
  const trust = useQuery({
    queryKey: ["trust", agentId],
    queryFn: () => api.agentTrust(agentId),
  });
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
        <div style={{ fontSize: 12, marginTop: 4 }}>
          <span
            style={{
              color:
                (trust.data?.scopeViolations30d ?? 0) > 0
                  ? "var(--amber)"
                  : "var(--green)",
            }}
          >
            {trust.data?.scopeViolations30d ?? 0} scope violation
            {(trust.data?.scopeViolations30d ?? 0) === 1 ? "" : "s"} · 30d
          </span>
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
