import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api";

export function SetupPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    orgName: "",
    name: "",
    email: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setup(form);
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup failed");
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
          Welcome to Rabble
        </div>
        <p className="page-subtitle">
          Set up your organization and owner account to get started.
        </p>
        <div className="field">
          <label>Organization name</label>
          <input
            required
            value={form.orgName}
            onChange={(e) => setForm({ ...form, orgName: e.target.value })}
            placeholder="Acme Corp"
          />
        </div>
        <div className="field">
          <label>Your name</label>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Alex Lin"
          />
        </div>
        <div className="field">
          <label>Email</label>
          <input
            required
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="alex@acme.com"
          />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            required
            type="password"
            minLength={8}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="At least 8 characters"
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button
          className="btn primary"
          disabled={busy}
          style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
        >
          Create owner account
        </button>
      </form>
    </div>
  );
}
