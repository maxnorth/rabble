import type { Agent, Message } from "@rabble/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, streamMessage } from "../api";

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
            className={({ isActive }) =>
              `sidebar-item${isActive ? " active" : ""}`
            }
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
        {sessionId ? <SessionThread key={sessionId} sessionId={sessionId} /> : <SessionLanding />}
      </main>
    </>
  );
}

function AgentTargetPill({
  agents,
  target,
  onChange,
}: {
  agents: Agent[];
  target: Agent | null;
  onChange: (agent: Agent | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = agents.filter((a) => a.status === "active");
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="target-pill"
        onClick={() => setOpen((v) => !v)}
      >
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
          {active.map((a) => (
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
          {active.length === 0 && (
            <button type="button" disabled style={{ color: "var(--text-muted)" }}>
              No active agents yet
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
  const [target, setTarget] = useState<Agent | null>(null);
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

function SessionThread({ sessionId }: { sessionId: string }) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId),
  });

  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
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
  }, [messages, streamingText]);

  const send = async (content: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStreamingText("");
    try {
      await streamMessage(sessionId, content, (event) => {
        if (event.type === "user-message") {
          setMessages((prev) => [...prev, event.message]);
        } else if (event.type === "delta") {
          setStreamingText((prev) => (prev ?? "") + event.text);
        } else if (event.type === "done") {
          setMessages((prev) => [...prev, event.message]);
          setStreamingText(null);
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

  const agentName = session.data?.session.agentName ?? "Agent";
  const initials = agentName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="thread">
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
                  {m.content}
                </div>
              </div>
            ),
          )}
          {streamingText !== null && (
            <div className="msg-agent">
              <div className="avatar">{initials}</div>
              <div className="bubble">
                <div className="agent-name">{agentName}</div>
                <span className="typing-cursor">{streamingText}</span>
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
  );
}
