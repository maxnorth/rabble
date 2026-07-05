import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api";

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
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">
          <div className="rail-logo" style={{ marginBottom: 0 }}>
            R
          </div>
          Sign in to Rabble
        </div>
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
          Sign in
        </button>
      </form>
    </div>
  );
}
