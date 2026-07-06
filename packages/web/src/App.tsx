import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError } from "./api";
import { Shell } from "./components/Shell";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";
import { SessionsSection } from "./pages/SessionsSection";
import { AgentsSection } from "./pages/AgentsSection";
import { AdminSection } from "./pages/AdminSection";
import { TeamsSection } from "./pages/TeamsSection";
import { StatsSection } from "./pages/StatsSection";
import { ProfileSection } from "./pages/ProfileSection";

export function App() {
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: setup.data?.needsSetup === false,
    retry: (count, err) =>
      !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  if (setup.isLoading || (setup.data?.needsSetup === false && me.isLoading)) {
    return null;
  }
  if (setup.isError) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p className="error-text">
            Can't reach the Rabble server. Is it running?
          </p>
        </div>
      </div>
    );
  }

  if (setup.data?.needsSetup) {
    return (
      <Routes>
        <Route path="*" element={<SetupPage />} />
      </Routes>
    );
  }

  const user = me.data?.user;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  // Invited with a temp password: set a real one before anything else.
  if (user.mustChangePassword) {
    return <ForcePasswordChange />;
  }

  return (
    <Routes>
      <Route element={<Shell user={user} />}>
        <Route path="/" element={<Navigate to="/sessions" replace />} />
        <Route path="/sessions" element={<SessionsSection />} />
        <Route path="/sessions/:sessionId" element={<SessionsSection />} />
        <Route path="/agents" element={<AgentsSection />} />
        <Route path="/agents/:agentId" element={<AgentsSection />} />
        <Route path="/agents/:agentId/:tab" element={<AgentsSection />} />
        <Route path="/domains/:domainId" element={<AgentsSection />} />
        <Route path="/teams" element={<TeamsSection />} />
        <Route path="/teams/:teamId" element={<TeamsSection />} />
        <Route path="/stats" element={<StatsSection />} />
        <Route path="/profile" element={<ProfileSection />} />
        <Route path="/admin" element={<Navigate to="/admin/connections" replace />} />
        <Route path="/admin/:page" element={<AdminSection />} />
        <Route path="*" element={<Navigate to="/sessions" replace />} />
      </Route>
    </Routes>
  );
}

function ForcePasswordChange() {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () =>
      api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["me"] }),
  });
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Set your password</h1>
        <p className="page-subtitle">
          You signed in with a temporary password. Pick your own to continue.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (current && next.length >= 8) change.mutate();
          }}
        >
          <div className="field">
            <label>Temporary password</label>
            <input
              type="password"
              autoFocus
              required
              placeholder="Temporary password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="field">
            <label>New password</label>
            <input
              type="password"
              required
              minLength={8}
              placeholder="At least 8 characters"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </div>
          {change.isError && (
            <p className="error-text">{(change.error as Error).message}</p>
          )}
          <button className="btn primary" disabled={change.isPending} style={{ width: "100%" }}>
            Save and continue
          </button>
        </form>
      </div>
    </div>
  );
}
