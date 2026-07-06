import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

const RANGES = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

export function StatsSection() {
  const [days, setDays] = useState(30);
  const stats = useQuery({
    queryKey: ["stats", days],
    queryFn: () => api.stats(days),
  });

  const data = stats.data;
  const maxAgent = Math.max(1, ...(data?.sessionsPerAgent.map((a) => a.count) ?? [1]));
  const maxDay = Math.max(1, ...(data?.sessionsPerDay.map((d) => d.count) ?? [1]));
  const totalToolCalls = (data?.toolAuthSplit ?? []).reduce((sum, s) => sum + s.count, 0);

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-title">Stats</div>
        <div className="sidebar-item active">
          <span className="label">Overview</span>
        </div>
      </aside>
      <main className="main-pane">
        <div className="content-col" style={{ maxWidth: 880 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <h1 className="page-title">Overview</h1>
              <p className="page-subtitle">Usage, evals, and tool auth across the org.</p>
            </div>
            <div className="segmented">
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  className={days === r.days ? "active" : ""}
                  onClick={() => setDays(r.days)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="kpi-grid">
            <div className="kpi">
              <div className="value">{data?.kpis.sessions ?? "—"}</div>
              <div className="label">Sessions</div>
            </div>
            <div className="kpi">
              <div className="value">{data?.kpis.messages ?? "—"}</div>
              <div className="label">Messages</div>
            </div>
            <div className="kpi">
              <div className="value">{data?.kpis.toolCalls ?? "—"}</div>
              <div className="label">Tool calls</div>
            </div>
            <div className="kpi">
              <div className="value">{data?.kpis.activeUsers ?? "—"}</div>
              <div className="label">Active users</div>
            </div>
            <div className="kpi">
              <div className="value">
                {data?.kpis.activeAgents ?? "—"}
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  {" "}
                  / {data?.kpis.totalAgents ?? "—"}
                </span>
              </div>
              <div className="label">Active agents</div>
            </div>
            <div className="kpi">
              <div className="value">
                {data?.kpis.evalPassRate !== null && data?.kpis.evalPassRate !== undefined
                  ? `${data.kpis.evalPassRate}%`
                  : "—"}
              </div>
              <div className="label">Eval pass rate</div>
            </div>
            <div className="kpi">
              <div className="value">{data?.kpis.evaluatedSessions ?? "—"}</div>
              <div className="label">Evaluated sessions</div>
            </div>
            <div className="kpi">
              <div className="value">
                {totalToolCalls > 0
                  ? `${Math.round(
                      (100 *
                        (data?.toolAuthSplit.find((s) => s.authType === "service")?.count ?? 0)) /
                        totalToolCalls,
                    )}%`
                  : "—"}
              </div>
              <div className="label">Tool calls on service auth</div>
            </div>
          </div>

          <div className="chart-card">
            <h3>Sessions per agent</h3>
            <div className="bar-chart">
              {data?.sessionsPerAgent.map((a) => (
                <div className="bar-row" key={a.agentId}>
                  <span className="bar-label">{a.agentName}</span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${(100 * a.count) / maxAgent}%` }}
                    />
                  </div>
                  <span className="bar-value">{a.count}</span>
                </div>
              ))}
              {data?.sessionsPerAgent.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No sessions yet.</p>
              )}
            </div>
          </div>

          <div className="chart-card">
            <h3>Sessions per day</h3>
            <div className="bar-chart">
              {data?.sessionsPerDay.map((d) => (
                <div className="bar-row" key={d.day}>
                  <span className="bar-label mono" style={{ fontSize: 11 }}>
                    {d.day}
                  </span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${(100 * d.count) / maxDay}%`, background: "var(--purple)" }}
                    />
                  </div>
                  <span className="bar-value">{d.count}</span>
                </div>
              ))}
              {data?.sessionsPerDay.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No sessions yet.</p>
              )}
            </div>
          </div>

          <div className="chart-card">
            <h3>Tool calls by auth type</h3>
            <div className="bar-chart">
              {data?.toolAuthSplit.map((s) => (
                <div className="bar-row" key={s.authType ?? "unknown"}>
                  <span className="bar-label">{s.authType ?? "unknown"}</span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{
                        width: `${(100 * s.count) / Math.max(1, totalToolCalls)}%`,
                        background: s.authType === "user" ? "var(--amber)" : "var(--green)",
                      }}
                    />
                  </div>
                  <span className="bar-value">{s.count}</span>
                </div>
              ))}
              {totalToolCalls === 0 && (
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No tool calls yet.</p>
              )}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
