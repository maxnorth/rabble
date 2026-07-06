import type { User } from "@rabblehq/core";
import { useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "../api";

function RailIcon({ d }: { d: string }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

const icons = {
  sessions:
    "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  agents:
    "M12 8V4m0 0H8m4 0h4M5 12a7 7 0 0 1 14 0v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zm4 4h.01M15 16h.01",
  teams:
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  stats: "M3 3v18h18M18 17V9M13 17V5M8 17v-3",
  admin:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6m7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.4 7.4 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.4 7.4 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2",
};

export function Shell({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="app-shell">
      <nav className="icon-rail">
        <div
          className="rail-logo"
          title="Home — Sessions"
          style={{ cursor: "pointer" }}
          onClick={() => navigate("/sessions")}
        >
          R
        </div>
        {(
          [
            ["/sessions", "Sessions", icons.sessions],
            ["/agents", "Agents", icons.agents],
            ["/teams", "Teams", icons.teams],
            ["/stats", "Stats", icons.stats],
            ["/admin", "Admin", icons.admin],
          ] as const
        ).map(([to, label, d]) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `rail-btn${isActive ? " active" : ""}`}
            title={label}
          >
            <RailIcon d={d} />
            <span className="rail-label">{label}</span>
          </NavLink>
        ))}
        <div className="spacer" />
        <NavLink
          to="/profile"
          className={({ isActive }) => `rail-btn${isActive ? " active" : ""}`}
          title={`${user.name} — profile`}
        >
          <span style={{ fontSize: 11, fontWeight: 600 }}>{initials}</span>
        </NavLink>
        <button
          className="rail-btn"
          title={`${user.name} — sign out`}
          onClick={async () => {
            await api.logout();
            navigate("/");
            // Resetting refetches /api/auth/me, which now 401s and drops the
            // app back to the login screen.
            await queryClient.resetQueries();
          }}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9" />
          </svg>
        </button>
      </nav>
      <Outlet />
    </div>
  );
}
