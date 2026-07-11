import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { GrantEditor } from "../AgentsSection";

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------

export function AccessTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: ["grants", "agent", agentId],
    queryFn: () => api.listGrants("agent", agentId),
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.listTeams });
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  const agent = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });
  const domain = domains.data?.domains.find(
    (d) => d.id === agent.data?.agent.domainId,
  );

  return (
    <>
      <p className="page-subtitle">
        Who can use, configure, and administer this agent. Direct grants plus
        grants inherited from its domain. There is no owner. Rights come only
        from grants.
      </p>
      {domain ? (
        <div
          className="card"
          style={{
            padding: 12,
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12.5,
            color: "var(--text-dim)",
          }}
        >
          <span className="meta-note">domain</span>
          <span className="grow">
            This agent is in <strong>{domain.name}</strong>. Grants on the
            domain reach it too.
          </span>
          <Link to={`/domains/${domain.id}`} style={{ color: "var(--accent-text)" }}>
            Edit domain grants →
          </Link>
        </div>
      ) : (
        <div
          className="card"
          style={{
            padding: 12,
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12.5,
            color: "var(--text-dim)",
          }}
        >
          <span className="meta-note">no domain</span>
          <span className="grow">
            Not in a domain. Access here is direct grants only. Adding it to a
            domain lets team access flow in automatically.
          </span>
          <Link to={`/agents/${agentId}`} style={{ color: "var(--accent-text)" }}>
            + Add to domain
          </Link>
        </div>
      )}
      <GrantEditor
        targetType="agent"
        targetId={agentId}
        grants={grants.data?.grants ?? []}
        teams={teams.data?.teams ?? []}
        users={users.data?.users ?? []}
        onChanged={() =>
          void queryClient.invalidateQueries({ queryKey: ["grants", "agent", agentId] })
        }
      />
    </>
  );
}
