import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { count } from "../../lib/time";

// ---------------------------------------------------------------------------
// evals
// ---------------------------------------------------------------------------

// "Agents are born measured" — starter criteria for the manual path (the
// Builder drafts these conversationally, but a hand-made agent starts blank).
// Clicking one fills the form for review, not a silent add — human in the loop.
const CRITERION_STARTERS: Array<{ name: string; description: string }> = [
  {
    name: "Stays on topic",
    description:
      "The reply addresses what was asked and doesn't wander into unrelated areas.",
  },
  {
    name: "Grounded, not fabricated",
    description:
      "Claims are supported by the tools or context; it never invents facts, names, or numbers.",
  },
  {
    name: "Cites its source",
    description:
      "When it states a fact or makes a recommendation, it points to where that came from.",
  },
  {
    name: "Respects its scope",
    description:
      "It declines requests outside its stated job instead of attempting them.",
  },
  {
    name: "Gives a next step",
    description:
      "The reply ends with a concrete action, not just a restatement of the problem.",
  },
];

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
          <CriterionRow
            key={c.id}
            criterion={c}
            canEdit={canEdit}
            onDelete={() => removeCriterion.mutate(c.id)}
          />
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
        {canEdit &&
          (() => {
            const have = new Set(
              (criteria.data?.criteria ?? []).map((c) => c.name.toLowerCase()),
            );
            const starters = CRITERION_STARTERS.filter(
              (s) => !have.has(s.name.toLowerCase()),
            );
            if (starters.length === 0) return null;
            return (
              <div
                className="row"
                style={{ flexWrap: "wrap", gap: 6, alignItems: "center" }}
              >
                <span className="sub" style={{ marginRight: 2 }}>
                  Starters
                </span>
                {starters.map((s) => (
                  <button
                    key={s.name}
                    className="chip"
                    title={`${s.description} Fills the form; review, then Add`}
                    onClick={() => setCriterionForm({ ...s })}
                  >
                    + {s.name}
                  </button>
                ))}
              </div>
            );
          })()}
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
                {count(s.caseCount, "case")}
                {s.lastRun
                  ? ` · last run ${s.lastRun.passed}/${s.lastRun.total} passed`
                  : " · never run"}
              </div>
              {s.runHistory.length >= 2 && (
                <div
                  className="suite-trend"
                  style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 18, marginTop: 5 }}
                  title="Pass rate across recent runs (oldest → newest)"
                >
                  {s.runHistory.map((r) => {
                    const pct = r.total > 0 ? (r.passed / r.total) * 100 : 0;
                    const color =
                      pct >= 100 ? "var(--green)" : pct > 0 ? "var(--amber)" : "var(--red)";
                    return (
                      <div
                        key={r.id}
                        style={{
                          width: 5,
                          height: Math.max(3, Math.round((pct / 100) * 16)),
                          background: color,
                          borderRadius: 1,
                          opacity: 0.85,
                        }}
                        title={`${r.passed}/${r.total} passed · ${new Date(
                          r.startedAt,
                        ).toLocaleDateString()}`}
                      />
                    );
                  })}
                </div>
              )}
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

/**
 * One live criterion. Criteria evolve with the job, so the row is editable
 * in place — Edit swaps name/description into inputs and PATCHes; past
 * results keep pointing at the same criterion, so the track record
 * survives a wording cleanup.
 */
function CriterionRow({
  criterion,
  canEdit,
  onDelete,
}: {
  criterion: {
    id: string;
    name: string;
    description: string;
    passRate: number | null;
    sessionCount: number;
    trendDelta: number | null;
  };
  canEdit: boolean;
  onDelete: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(criterion.name);
  const [description, setDescription] = useState(criterion.description);
  const save = useMutation({
    mutationFn: () => api.updateCriterion(criterion.id, { name, description }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["criteria"] });
      setEditing(false);
    },
  });

  if (editing) {
    return (
      <div className="row">
        <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Criterion name"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What the judge should check"
          />
          {save.isError && <p className="error-text">{(save.error as Error).message}</p>}
        </div>
        <button
          className="btn primary"
          disabled={save.isPending || !name.trim()}
          onClick={() => save.mutate()}
        >
          Save
        </button>
        <button
          className="btn"
          disabled={save.isPending}
          onClick={() => {
            setEditing(false);
            setName(criterion.name);
            setDescription(criterion.description);
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="row">
      <div className="grow">
        <div className="title">{criterion.name}</div>
        <div className="sub">{criterion.description || "—"}</div>
      </div>
      {criterion.passRate !== null ? (
        <>
          <span
            className={`chip ${criterion.passRate >= 90 ? "green" : criterion.passRate >= 70 ? "blue" : "amber"}`}
          >
            {criterion.passRate}% · {count(criterion.sessionCount, "session")}
          </span>
          {criterion.trendDelta !== null && criterion.trendDelta !== 0 && (
            <span
              className={`chip ${criterion.trendDelta > 0 ? "green" : "amber"}`}
              title="Pass rate: last 30 days vs the 30 before"
            >
              {criterion.trendDelta > 0 ? "+" : ""}
              {criterion.trendDelta}% vs prior
            </span>
          )}
        </>
      ) : (
        <span className="chip">no data yet</span>
      )}
      {canEdit && (
        <>
          <button className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="btn danger" onClick={onDelete}>
            Delete
          </button>
        </>
      )}
    </div>
  );
}
