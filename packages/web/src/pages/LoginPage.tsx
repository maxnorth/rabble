import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api";
import { ThemeToggle } from "../components/Shell";

const PILLARS = [
  {
    dot: "green",
    title: "Measured track records",
    body: "Every agent carries eval scores and trends — so you can trust one you didn't build.",
  },
  {
    dot: "blue",
    title: "Scoped access",
    body: "Grants gate exactly what each agent may touch. Access is earned, not assumed.",
  },
  {
    dot: "purple",
    title: "Full auditability",
    body: "Every action an agent takes is recorded, attributed, and reviewable.",
  },
];

export function LoginPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login({ email, password });
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
      setBusy(false);
    }
  };

  return (
    <div className="auth-split">
      <div className="auth-theme-toggle">
        <ThemeToggle className="btn icon-only" />
      </div>
      <aside className="auth-brand">
        <div className="auth-brand-inner">
          <div className="auth-brand-mark">
            <div className="rail-logo auth-brand-logo">R</div>
            <span className="auth-brand-word">Rabble</span>
          </div>
          <h1 className="auth-brand-headline">Where agents earn their access.</h1>
          <p className="auth-brand-sub">
            The org-wide platform where every agent has an identity, a measured
            track record, and access it has earned.
          </p>
          <ul className="auth-pillars">
            {PILLARS.map((p) => (
              <li key={p.title} className="auth-pillar">
                <span className={`auth-pillar-dot ${p.dot}`} />
                <div>
                  <div className="auth-pillar-title">{p.title}</div>
                  <div className="auth-pillar-body">{p.body}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="auth-form-pane">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-logo">
            <div className="rail-logo" style={{ marginBottom: 0 }}>
              R
            </div>
            Sign in to Rabble
          </div>
          <p className="auth-card-sub">Welcome back. Sign in to your workspace.</p>
          <div className="field">
            <label>Email</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              required
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button
            className="btn primary"
            disabled={busy}
            style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    </div>
  );
}
