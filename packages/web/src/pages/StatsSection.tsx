import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type StatsResponse } from "../api";

const RANGES = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

const PAGES = ["Overview", "Eval performance", "Usage & spend", "Skill use"] as const;
type Page = (typeof PAGES)[number];

function Bars({
  rows,
  color = "var(--accent)",
  onSelect,
}: {
  rows: Array<{ label: string; value: number; suffix?: string; color?: string; key?: string }>;
  color?: string;
  onSelect?: (key: string) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bar-chart">
      {rows.map((r, i) => (
        <div
          className="bar-row"
          key={i}
          style={onSelect && r.key ? { cursor: "pointer" } : undefined}
          onClick={onSelect && r.key ? () => onSelect(r.key!) : undefined}
        >
          <span className="bar-label" title={r.label}>
            {r.label}
          </span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${(100 * r.value) / max}%`, background: r.color ?? color }}
            />
          </div>
          <span className="bar-value">
            {r.value}
            {r.suffix ?? ""}
          </span>
        </div>
      ))}
      {rows.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No data in this range.</p>
      )}
    </div>
  );
}

function Columns({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 4,
        height: 120,
        padding: "8px 2px 0",
      }}
    >
      {rows.map((r, i) => (
        <div
          key={i}
          title={`${r.label}: ${r.value}`}
          style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}
        >
          <div
            style={{
              height: Math.max(3, Math.round((92 * r.value) / max)),
              marginTop: "auto",
              borderRadius: "3px 3px 0 0",
              background: "var(--purple)",
              opacity: 0.55 + 0.45 * (r.value / max),
            }}
          />
          <span
            style={{
              fontSize: 8.5,
              color: "var(--text-muted)",
              textAlign: "center",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {r.label.slice(5)}
          </span>
        </div>
      ))}
      {rows.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No data in this range.</p>
      )}
    </div>
  );
}

function Kpi({
  value,
  label,
  delta,
}: {
  value: string | number;
  label: string;
  delta?: string;
}) {
  return (
    <div className="kpi">
      <div className="value">{value}</div>
      <div className="label">
        {label}
        {delta && (
          <span style={{ marginLeft: 6, color: "var(--text-muted)" }}>{delta}</span>
        )}
      </div>
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function deltaVsPrior(current: number, prior: number): string | undefined {
  if (prior === 0) return undefined;
  const pct = Math.round((100 * (current - prior)) / prior);
  return pct === 0 ? "· flat vs prior" : `· ${pct > 0 ? "↑" : "↓"} ${Math.abs(pct)}% vs prior`;
}
const sessionsDelta = deltaVsPrior;

function fmtUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`;
}

export function StatsSection() {
  const [days, setDays] = useState(30);
  const [agentId, setAgentId] = useState("");
  const [page, setPage] = useState<Page>("Overview");
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const stats = useQuery({
    queryKey: ["stats", days, agentId],
    queryFn: () => api.stats(days, agentId || undefined),
  });
  const data = stats.data;

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-title">Stats</div>
        {PAGES.map((p) => (
          <button
            key={p}
            className={`sidebar-item${page === p ? " active" : ""}`}
            onClick={() => setPage(p)}
          >
            <span className="label">{p}</span>
          </button>
        ))}
      </aside>
      <main className="main-pane">
        <div className="content-col" style={{ maxWidth: 880 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <h1 className="page-title">{page}</h1>
              <p className="page-subtitle">
                {page === "Overview" && "Usage, evals, and tool auth across the org."}
                {page === "Eval performance" && "Pass rates per criterion — where agents earn trust."}
                {page === "Usage & spend" && "Volume by agent and by model."}
                {page === "Skill use" && "Which tools agents actually call, and where."}
              </p>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                title="Filter by agent"
              >
                <option value="">All agents</option>
                {agents.data?.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
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
          </div>

          {page === "Overview" && data && <Overview data={data} />}
          {page === "Eval performance" && data && <EvalPerformance data={data} />}
          {page === "Usage & spend" && data && <UsageSpend data={data} />}
          {page === "Skill use" && data && <SkillUse data={data} />}
        </div>
      </main>
    </>
  );
}

function Overview({ data }: { data: StatsResponse }) {
  const totalToolCalls = data.toolAuthSplit.reduce((sum, s) => sum + s.count, 0);
  return (
    <>
      <div className="kpi-grid">
        <Kpi
          value={data.kpis.sessions}
          label="Sessions"
          delta={sessionsDelta(data.kpis.sessions, data.kpis.priorSessions)}
        />
        <Kpi
          value={data.kpis.messages}
          label="Messages"
          delta={deltaVsPrior(data.kpis.messages, data.kpis.priorMessages)}
        />
        <Kpi
          value={data.kpis.toolCalls}
          label="Tool calls"
          delta={deltaVsPrior(data.kpis.toolCalls, data.kpis.priorToolCalls)}
        />
        <Kpi value={data.kpis.avgTurns} label="Avg turns / session" />
        <Kpi value={data.kpis.activeUsers} label="Active users" />
        <Kpi
          value={`${data.kpis.activeAgents} / ${data.kpis.totalAgents}`}
          label="Active agents"
        />
        <Kpi
          value={data.kpis.evalPassRate !== null ? `${data.kpis.evalPassRate}%` : "—"}
          label="Eval pass rate"
        />
        <Kpi
          value={
            totalToolCalls > 0
              ? `${Math.round(
                  (100 *
                    (data.toolAuthSplit.find((s) => s.authType === "service")?.count ?? 0)) /
                    totalToolCalls,
                )}%`
              : "—"
          }
          label="Tool calls on service auth"
        />
      </div>
      <div className="chart-card">
        <h3>Sessions per agent</h3>
        <Bars
          rows={data.sessionsPerAgent.map((a) => ({ label: a.agentName, value: a.count }))}
        />
      </div>
      <div className="chart-card">
        <h3>Sessions per day</h3>
        <Columns rows={data.sessionsPerDay.map((d) => ({ label: d.day, value: d.count }))} />
      </div>
    </>
  );
}

function EvalPerformance({ data }: { data: StatsResponse }) {
  const [drillAgent, setDrillAgent] = useState<string | null>(null);
  const failures = useQuery({
    queryKey: ["stat-failures", drillAgent, data.days],
    queryFn: () => api.statFailures(drillAgent!, data.days),
    enabled: Boolean(drillAgent),
  });
  return (
    <>
      <div className="kpi-grid">
        <Kpi
          value={data.kpis.evalPassRate !== null ? `${data.kpis.evalPassRate}%` : "—"}
          label="Overall pass rate"
        />
        <Kpi value={data.kpis.evaluatedSessions} label="Evaluated sessions" />
        <Kpi value={data.perCriterion.length} label="Criteria with data" />
        <Kpi
          value={data.perCriterion.filter((c) => c.passRate < 70).length}
          label="Criteria below 70%"
        />
      </div>
      <div className="chart-card">
        <h3>Pass rate by agent</h3>
        <Bars
          onSelect={(id) => setDrillAgent((prev) => (prev === id ? null : id))}
          rows={data.evalByAgent.map((a) => ({
            key: a.agentId,
            label: `${a.agentName} (${a.results})`,
            value: a.passRate,
            suffix: "%",
            color:
              a.passRate >= 90
                ? "var(--green)"
                : a.passRate >= 70
                  ? "var(--blue)"
                  : "var(--amber)",
          }))}
        />
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
          Click an agent to see its failing cases.
        </p>
      </div>
      {drillAgent && (
        <div className="chart-card">
          <h3>Failing cases</h3>
          <div className="row-group">
            {failures.data?.failures.map((f) => (
              <div className="row" key={f.id}>
                <span className="chip amber">FAIL</span>
                <div className="grow">
                  <div className="title">{f.criterionName}</div>
                  <div className="sub">
                    "{f.sessionTitle}" · {f.reasoning || "no reasoning recorded"}
                  </div>
                </div>
                <a
                  href={`/sessions/${f.sessionId}`}
                  style={{ fontSize: 12, color: "var(--accent-text)" }}
                >
                  open session →
                </a>
              </div>
            ))}
            {failures.data?.failures.length === 0 && (
              <div className="row">
                <div className="sub">No failing cases in this window. 🎉</div>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="chart-card">
        <h3>Pass rate by criterion (worst first)</h3>
        <Bars
          rows={data.perCriterion.map((c) => ({
            label: `${c.agentName} — ${c.criterionName}`,
            value: c.passRate,
            suffix: "%",
            color:
              c.passRate >= 90
                ? "var(--green)"
                : c.passRate >= 70
                  ? "var(--blue)"
                  : "var(--amber)",
          }))}
        />
      </div>
    </>
  );
}

function UsageSpend({ data }: { data: StatsResponse }) {
  return (
    <>
      <div className="kpi-grid">
        <Kpi
          value={data.kpis.sessions}
          label="Sessions"
          delta={sessionsDelta(data.kpis.sessions, data.kpis.priorSessions)}
        />
        <Kpi value={fmtUsd(data.kpis.spend)} label="Spend" />
        <Kpi value={fmtUsd(data.kpis.avgCostPerSession)} label="Avg cost / session" />
        <Kpi value={fmtTokens(data.kpis.inputTokens)} label="Input tokens" />
        <Kpi
          value={fmtTokens(data.kpis.outputTokens)}
          label="Output tokens"
          delta={deltaVsPrior(data.kpis.outputTokens, data.kpis.priorOutputTokens)}
        />
        <Kpi value={data.kpis.avgTurns} label="Avg turns / session" />
      </div>
      <div className="chart-card">
        <h3>Spend by agent</h3>
        <Bars
          rows={data.spendByAgent
            .filter((a) => a.spend > 0)
            .map((a) => ({
              label: a.agentName,
              value: Math.round(a.spend * 100) / 100,
              suffix: " $",
            }))}
        />
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
          Token cost this period, at each agent's model rates. Models without
          pricing contribute $0 — set prices in Admin › Models.
        </p>
      </div>
      <div className="chart-card">
        <h3>Token use by model</h3>
        <Bars
          rows={data.perModel.map((m) => ({
            label: m.modelName,
            value: m.tokens,
          }))}
        />
      </div>
      <div className="chart-card">
        <h3>Sessions per agent</h3>
        <Bars
          rows={data.sessionsPerAgent.map((a) => ({ label: a.agentName, value: a.count }))}
          color="var(--purple)"
        />
      </div>
      <div className="chart-card">
        <h3>Turns per session</h3>
        <Bars
          rows={data.turnDistribution.map((t) => ({ label: t.label, value: t.count }))}
          color="var(--blue)"
        />
      </div>
    </>
  );
}

function SkillUse({ data }: { data: StatsResponse }) {
  const totalToolCalls = data.toolAuthSplit.reduce((sum, s) => sum + s.count, 0);
  return (
    <>
      <div className="kpi-grid">
        <Kpi value={data.kpis.toolCalls} label="Tool calls" />
        <Kpi value={data.perTool.length} label="Distinct tools used" />
        <Kpi
          value={data.toolAuthSplit.find((s) => s.authType === "user")?.count ?? 0}
          label="Ran as a user"
        />
        <Kpi
          value={
            totalToolCalls > 0
              ? `${Math.round(
                  (100 *
                    (data.toolAuthSplit.find((s) => s.authType === "service")?.count ?? 0)) /
                    totalToolCalls,
                )}%`
              : "—"
          }
          label="Service auth share"
        />
      </div>
      <div className="chart-card">
        <h3>Calls by tool</h3>
        <Bars
          rows={data.perTool.map((t) => ({
            label: t.server ? `${t.tool} (${t.server})` : t.tool,
            value: t.count,
          }))}
        />
      </div>
      <div className="chart-card">
        <h3>Tool calls by auth type</h3>
        <Bars
          rows={data.toolAuthSplit
            .filter((s) => s.authType)
            .map((s) => ({
              label: s.authType!,
              value: s.count,
              color: s.authType === "user" ? "var(--amber)" : "var(--green)",
            }))}
        />
      </div>
    </>
  );
}
