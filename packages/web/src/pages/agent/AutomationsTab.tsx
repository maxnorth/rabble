import { describeCron, isValidCron, nextCronRun } from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { relativeFuture, relativeTime } from "../../lib/time";

// ---------------------------------------------------------------------------
// automations
// ---------------------------------------------------------------------------

export function AutomationsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const automations = useQuery({
    queryKey: ["automations", agentId],
    queryFn: () => api.listAutomations(agentId),
  });
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: () => api.schedulerStatus(),
  });
  const [form, setForm] = useState({ name: "", schedule: "0 9 * * 1-5", prompt: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", schedule: "", prompt: "" });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["automations", agentId] });
  const create = useMutation({
    mutationFn: () => api.createAutomation(agentId, form),
    onSuccess: () => {
      setForm({ name: "", schedule: "0 9 * * 1-5", prompt: "" });
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (id: string) => api.updateAutomation(id, editForm),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.toggleAutomation(id, enabled),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: refresh,
  });
  const run = useMutation({
    mutationFn: (id: string) => api.runAutomation(id),
    onSuccess: refresh,
  });

  return (
    <>
      <p className="page-subtitle">
        Scheduled runs of this agent. Each run is a real governed session on
        the Automation surface. Enable an automation to run it on its schedule;
        Run now executes it immediately either way.
      </p>
      {scheduler.data?.active === false &&
        automations.data?.automations.some((a) => a.enabled) && (
          <div
            role="status"
            style={{
              border: "1px solid var(--border-2)",
              borderLeft: "3px solid var(--amber)",
              background: "var(--surface-2)",
              borderRadius: 8,
              padding: "10px 12px",
              margin: "0 0 16px",
              fontSize: 13,
              color: "var(--text-2)",
            }}
          >
            The platform scheduler isn't running, so enabled automations won't
            fire on their schedule yet. Use Run now until it's configured.
            Schedules resume automatically once the scheduler is live.
          </div>
        )}
      {run.isError && (
        <p className="error-text">{(run.error as Error).message}</p>
      )}
      <div className="row-group" style={{ marginBottom: 20 }}>
        {automations.data?.automations.map((a) =>
          editing === a.id ? (
            <div className="row" key={a.id}>
              <div className="grow" style={{ display: "grid", gap: 8 }}>
                <input
                  aria-label="Automation name"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                />
                <input
                  aria-label="Automation schedule"
                  className="mono"
                  value={editForm.schedule}
                  onChange={(e) => setEditForm({ ...editForm, schedule: e.target.value })}
                />
                {isValidCron(editForm.schedule) ? (
                  <span className="hint">{describeCron(editForm.schedule)}</span>
                ) : (
                  <span className="hint" style={{ color: "var(--amber)" }}>
                    Not a valid 5-field cron.
                  </span>
                )}
                <textarea
                  aria-label="Automation prompt"
                  rows={2}
                  value={editForm.prompt}
                  onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
                />
                {update.isError && (
                  <span className="error-text">{(update.error as Error).message}</span>
                )}
              </div>
              <button
                className="btn primary"
                disabled={
                  !editForm.name.trim() ||
                  !isValidCron(editForm.schedule) ||
                  update.isPending
                }
                onClick={() => update.mutate(a.id)}
              >
                {update.isPending ? "Saving…" : "Save"}
              </button>
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row" key={a.id}>
              <span
                className={`toggle${a.enabled ? " on" : ""}`}
                style={{ cursor: canEdit ? "pointer" : "default" }}
                onClick={() => canEdit && toggle.mutate({ id: a.id, enabled: !a.enabled })}
              />
              <div className="grow">
                <div className="title">{a.name}</div>
                <div className="sub">
                  <span title={a.schedule}>{describeCron(a.schedule)}</span>
                  {a.enabled && (() => {
                    const next = nextCronRun(a.schedule);
                    return next ? (
                      <>
                        {" · next "}
                        {relativeFuture(next.toISOString())}
                      </>
                    ) : null;
                  })()}
                  {a.lastRunAt && (
                    <>
                      {" · last ran "}
                      {relativeTime(a.lastRunAt)}
                      {a.lastSessionId && (
                        <>
                          {" · "}
                          <Link
                            to={`/sessions/${a.lastSessionId}`}
                            style={{ color: "var(--accent-text)" }}
                          >
                            view session →
                          </Link>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
              {canEdit && (
                <button
                  className="btn"
                  disabled={run.isPending}
                  onClick={() => run.mutate(a.id)}
                >
                  {run.isPending ? "Running…" : "Run now"}
                </button>
              )}
              {canEdit && (
                <button
                  className="btn"
                  onClick={() => {
                    setEditForm({
                      name: a.name,
                      schedule: a.schedule,
                      prompt: a.prompt,
                    });
                    setEditing(a.id);
                  }}
                >
                  Edit
                </button>
              )}
              {canEdit && (
                <button className="btn danger" onClick={() => remove.mutate(a.id)}>
                  Delete
                </button>
              )}
            </div>
          ),
        )}
        {automations.data?.automations.length === 0 && (
          <div className="row">
            <div className="sub">No automations yet.</div>
          </div>
        )}
      </div>
      {canEdit && (
        <div className="card" style={{ padding: 16 }}>
          <div className="field">
            <label>Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Morning digest"
            />
          </div>
          <div className="field">
            <label>Schedule (cron)</label>
            <input
              className="mono"
              value={form.schedule}
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            />
            {isValidCron(form.schedule) ? (
              <span className="hint">
                {describeCron(form.schedule)}
                {(() => {
                  const next = nextCronRun(form.schedule);
                  return next ? ` · next occurrence ${relativeFuture(next.toISOString())}` : "";
                })()}
              </span>
            ) : (
              <span className="hint" style={{ color: "var(--amber)" }}>
                Not a valid 5-field cron (minute hour day-of-month month weekday).
              </span>
            )}
          </div>
          <div className="field">
            <label>Prompt</label>
            <textarea
              rows={3}
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="What the agent should do on each run"
            />
          </div>
          <button
            className="btn primary"
            disabled={!form.name.trim() || !isValidCron(form.schedule) || create.isPending}
            onClick={() => create.mutate()}
          >
            + Add automation
          </button>
        </div>
      )}
    </>
  );
}
