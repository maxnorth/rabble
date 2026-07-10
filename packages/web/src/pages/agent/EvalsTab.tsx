import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";

// ---------------------------------------------------------------------------
// evals
// ---------------------------------------------------------------------------

export function EvalsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const criteria = useQuery({
    queryKey: ["criteria", agentId],
    queryFn: () => api.listCriteria(agentId),
  });
  const suites = useQuery({
    queryKey: ["suites", agentId],
    queryFn: () => api.listSuites(agentId),
  });
  const [criterionForm, setCriterionForm] = useState({ name: "", description: "" });
  const [suiteName, setSuiteName] = useState("");
  const [runError, setRunError] = useState<string | null>(null);

  const addCriterion = useMutation({
    mutationFn: () => api.createCriterion(agentId, criterionForm),
    onSuccess: () => {
      setCriterionForm({ name: "", description: "" });
      void queryClient.invalidateQueries({ queryKey: ["criteria", agentId] });
    },
  });
  const removeCriterion = useMutation({
    mutationFn: (id: string) => api.deleteCriterion(id),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["criteria", agentId] }),
  });
  const addSuite = useMutation({
    mutationFn: () => api.createSuite(agentId, { name: suiteName }),
    onSuccess: () => {
      setSuiteName("");
      void queryClient.invalidateQueries({ queryKey: ["suites", agentId] });
    },
  });
  const runSuite = useMutation({
    mutationFn: (suiteId: string) => api.runSuite(suiteId),
    onSuccess: () => {
      setRunError(null);
      void queryClient.invalidateQueries({ queryKey: ["suites", agentId] });
    },
    onError: (err) => setRunError(err instanceof Error ? err.message : "Run failed"),
  });
  const setGating = useMutation({
    mutationFn: ({ id, gating }: { id: string; gating: boolean }) =>
      api.updateSuite(id, { gating }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["suites", agentId] }),
  });
  const trust = useQuery({
    queryKey: ["trust", agentId],
    queryFn: () => api.agentTrust(agentId),
  });
  const resolve = useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: "upheld" | "overturned" }) =>
      api.resolveEvalResult(id, outcome),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["trust", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["criteria", agentId] });
    },
  });

  const measured = (criteria.data?.criteria ?? []).filter((c) => c.passRate !== null);
  const evaluatedSessions = (criteria.data?.criteria ?? []).reduce(
    (sum, c) => Math.max(sum, c.sessionCount),
    0,
  );
  const overall =
    measured.length > 0
      ? Math.round(measured.reduce((sum, c) => sum + (c.passRate ?? 0), 0) / measured.length)
      : null;

  return (
    <>
      <p className="page-subtitle">
        Criteria are evaluated live against real sessions; suites are offline
        test cases. Gating suites run automatically before any behavior
        change ships. A regression blocks the save. Track record is
        evidence in access decisions.
      </p>

      <div
        className="card"
        style={{
          padding: 14,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 22,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              color:
                overall === null
                  ? "var(--text-muted)"
                  : overall >= 90
                    ? "var(--green)"
                    : overall >= 70
                      ? "var(--blue)"
                      : "var(--amber)",
            }}
          >
            {overall !== null ? `${overall}%` : "—"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>overall pass rate</div>
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{evaluatedSessions}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>sessions judged</div>
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>
            {suites.data?.suites.length ?? 0}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>suites</div>
        </div>
        <div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              color:
                (trust.data?.scopeViolations30d ?? 0) > 0
                  ? "var(--amber)"
                  : "var(--green)",
            }}
          >
            {trust.data?.scopeViolations30d ?? 0}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            scope violation{(trust.data?.scopeViolations30d ?? 0) === 1 ? "" : "s"} · 30d
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ textAlign: "right" }}>
          <Link to="/stats" style={{ fontSize: 12, color: "var(--accent-text)" }}>
            View in Stats →
          </Link>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 4 }}>
            judge: {trust.data?.judgeModel ?? "—"}
            {" · "}
            {trust.data?.openReviews.length ?? 0} in spot-check queue
          </div>
        </div>
      </div>

      <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
        Live criteria
      </div>
      <div className="row-group" style={{ marginBottom: 12 }}>
        {criteria.data?.criteria.map((c) => (
          <div className="row" key={c.id}>
            <div className="grow">
              <div className="title">{c.name}</div>
              <div className="sub">{c.description || "—"}</div>
            </div>
            {c.passRate !== null ? (
              <>
                <span
                  className={`chip ${c.passRate >= 90 ? "green" : c.passRate >= 70 ? "blue" : "amber"}`}
                >
                  {c.passRate}% · {c.sessionCount} sessions
                </span>
                {c.trendDelta !== null && c.trendDelta !== 0 && (
                  <span
                    className={`chip ${c.trendDelta > 0 ? "green" : "amber"}`}
                    title="Pass rate: last 30 days vs the 30 before"
                  >
                    {c.trendDelta > 0 ? "+" : ""}
                    {c.trendDelta}% vs prior
                  </span>
                )}
              </>
            ) : (
              <span className="chip">no data yet</span>
            )}
            {canEdit && (
              <button className="btn danger" onClick={() => removeCriterion.mutate(c.id)}>
                Delete
              </button>
            )}
          </div>
        ))}
        {criteria.data?.criteria.length === 0 && (
          <div className="row">
            <div className="sub">No criteria. This agent is unmeasured.</div>
          </div>
        )}
        {canEdit && (
          <div className="row">
            <input
              placeholder="Criterion, e.g. Cites a runbook link"
              value={criterionForm.name}
              onChange={(e) =>
                setCriterionForm({ ...criterionForm, name: e.target.value })
              }
              style={{ flex: 1 }}
            />
            <input
              placeholder="What the judge should check (optional)"
              value={criterionForm.description}
              onChange={(e) =>
                setCriterionForm({ ...criterionForm, description: e.target.value })
              }
              style={{ flex: 1 }}
            />
            <button
              className="btn primary"
              disabled={!criterionForm.name.trim() || addCriterion.isPending}
              onClick={() => addCriterion.mutate()}
            >
              + Add
            </button>
          </div>
        )}
      </div>

      {(trust.data?.openReviews.length ?? 0) > 0 && (
        <>
          <div className="sidebar-title" style={{ padding: "14px 0 8px" }}>
            Spot-check queue
          </div>
          <div className="row-group" style={{ marginBottom: 12 }}>
            {trust.data!.openReviews.map((r) => (
              <div className="row" key={r.id}>
                <span className={`chip ${r.passed ? "green" : "amber"}`}>
                  {r.passed ? "PASS" : "FAIL"}
                </span>
                <div className="grow">
                  <div className="title">{r.criterionName}</div>
                  <div className="sub">
                    "{r.sessionTitle}" · judge said: {r.reasoning || "—"}
                  </div>
                </div>
                {canEdit && (
                  <>
                    <button
                      className="btn"
                      disabled={resolve.isPending}
                      title="The judge was right. Keep the verdict"
                      onClick={() => resolve.mutate({ id: r.id, outcome: "upheld" })}
                    >
                      Uphold
                    </button>
                    <button
                      className="btn danger"
                      disabled={resolve.isPending}
                      title="The judge was wrong. Flip the verdict"
                      onClick={() => resolve.mutate({ id: r.id, outcome: "overturned" })}
                    >
                      Overturn
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="sidebar-title" style={{ padding: "14px 0 8px" }}>
        Suites
      </div>
      <div className="row-group">
        {suites.data?.suites.map((s) => (
          <div className="row" key={s.id}>
            <div className="grow">
              <div className="title">
                {s.name} {s.gating && <span className="chip amber">gating</span>}
              </div>
              <div className="sub">
                {s.caseCount} cases
                {s.lastRun
                  ? ` · last run ${s.lastRun.passed}/${s.lastRun.total} passed`
                  : " · never run"}
              </div>
            </div>
            {canEdit && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--text-dim)",
                  cursor: "pointer",
                }}
                title="Gating suites must pass before changes to this agent ship"
              >
                <input
                  type="checkbox"
                  checked={s.gating}
                  onChange={(e) => setGating.mutate({ id: s.id, gating: e.target.checked })}
                />
                gating
              </label>
            )}
            {canEdit && (
              <button
                className="btn"
                disabled={runSuite.isPending}
                onClick={() => runSuite.mutate(s.id)}
              >
                {runSuite.isPending ? "Running…" : "Run suite"}
              </button>
            )}
          </div>
        ))}
        {suites.data?.suites.length === 0 && (
          <div className="row">
            <div className="sub">
              No suites yet. Freeze good sessions into cases to build one.
            </div>
          </div>
        )}
        {canEdit && (
          <div className="row">
            <input
              placeholder="New suite name"
              value={suiteName}
              onChange={(e) => setSuiteName(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="btn primary"
              disabled={!suiteName.trim() || addSuite.isPending}
              onClick={() => addSuite.mutate()}
            >
              + Add suite
            </button>
          </div>
        )}
      </div>
      {runError && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {runError}
        </p>
      )}
    </>
  );
}
