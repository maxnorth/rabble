import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { count } from "../../lib/time";

// ---------------------------------------------------------------------------
// agents (sub-agents)
// ---------------------------------------------------------------------------

export function SubAgentsTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const subAgents = useQuery({
    queryKey: ["sub-agents", agentId],
    queryFn: () => api.subAgents(agentId),
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["sub-agents", agentId] });
  const link = useMutation({
    mutationFn: (subId: string) => api.linkSubAgent(agentId, subId),
    onSuccess: refresh,
  });
  const unlink = useMutation({
    mutationFn: (subId: string) => api.unlinkSubAgent(agentId, subId),
    onSuccess: refresh,
  });
  const setNote = useMutation({
    mutationFn: ({ subId, note }: { subId: string; note: string }) =>
      api.setSubAgentNote(agentId, subId, note),
    onSuccess: refresh,
  });

  const linkedIds = new Set((subAgents.data?.subAgents ?? []).map((a) => a.id));
  const linkable = (agents.data?.agents ?? []).filter(
    (a) => a.id !== agentId && !linkedIds.has(a.id) && a.myRight,
  );

  return (
    <>
      <p className="page-subtitle">
        Other agents wired in as callable tools. You can only attach agents
        you hold use access on, the permission gate that keeps the mesh
        auditable.
      </p>
      <div className="row-group" style={{ marginBottom: 20 }}>
        {subAgents.data?.subAgents.map((a) => (
          <div className="row" key={a.id}>
            <div className="grow">
              <div className="title">{a.name}</div>
              <div className="sub mono">{a.slug}</div>
            </div>
            <span
              className="meta-note"
              style={
                a.evalScore !== null && a.evalScore < 70
                  ? { color: "var(--amber)" }
                  : undefined
              }
              title="The callee's measured track record, evidence for wiring it in as a tool"
            >
              {a.evalScore === null
                ? "no track record"
                : `${a.evalScore}% · ${count(a.evalCount, "graded")}`}
            </span>
            <input
              placeholder="When is it called? e.g. Before any deploy action"
              defaultValue={a.note}
              disabled={!canEdit}
              onBlur={(e) => {
                if (canEdit && e.target.value !== a.note) {
                  setNote.mutate({ subId: a.id, note: e.target.value });
                }
              }}
              style={{ width: 280, fontSize: 12 }}
            />
            {canEdit && (
              <button className="btn danger" onClick={() => unlink.mutate(a.id)}>
                Remove
              </button>
            )}
          </div>
        ))}
        {subAgents.data?.subAgents.length === 0 && (
          <div className="row">
            <div className="sub">No connected agents.</div>
          </div>
        )}
      </div>
      {canEdit && linkable.length > 0 && (
        <>
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Attach an agent
          </div>
          <div className="row-group">
            {linkable.map((a) => (
              <div className="row" key={a.id}>
                <div className="grow">
                  <div className="title">{a.name}</div>
                  <div className="sub">{a.description || a.slug}</div>
                </div>
                {(link.isError && (
                  <span className="error-text">{(link.error as Error).message}</span>
                )) || null}
                <button className="btn" onClick={() => link.mutate(a.id)}>
                  Attach
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
