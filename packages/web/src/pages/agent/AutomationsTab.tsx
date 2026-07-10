import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { relativeTime } from "../../lib/time";

// ---------------------------------------------------------------------------
// automations
// ---------------------------------------------------------------------------

export function AutomationsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const automations = useQuery({
    queryKey: ["automations", agentId],
    queryFn: () => api.listAutomations(agentId),
  });
  const [form, setForm] = useState({ name: "", schedule: "0 9 * * 1-5", prompt: "" });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["automations", agentId] });
  const create = useMutation({
    mutationFn: () => api.createAutomation(agentId, form),
    onSuccess: () => {
      setForm({ name: "", schedule: "0 9 * * 1-5", prompt: "" });
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
        the Automation surface. Run now executes immediately; recurring
        schedules land with the platform's scheduling engine.
      </p>
      {run.isError && (
        <p className="error-text">{(run.error as Error).message}</p>
      )}
      <div className="row-group" style={{ marginBottom: 20 }}>
        {automations.data?.automations.map((a) => (
          <div className="row" key={a.id}>
            <span
              className={`toggle${a.enabled ? " on" : ""}`}
              style={{ cursor: canEdit ? "pointer" : "default" }}
              onClick={() => canEdit && toggle.mutate({ id: a.id, enabled: !a.enabled })}
            />
            <div className="grow">
              <div className="title">{a.name}</div>
              <div className="sub mono">
                {a.schedule}
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
              <button className="btn danger" onClick={() => remove.mutate(a.id)}>
                Delete
              </button>
            )}
          </div>
        ))}
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
            disabled={!form.name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            + Add automation
          </button>
        </div>
      )}
    </>
  );
}
