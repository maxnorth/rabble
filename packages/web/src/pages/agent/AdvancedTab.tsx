import { agentCapabilitiesSchema, type AgentCapabilities } from "@rabblehq/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api";

// ---------------------------------------------------------------------------
// advanced (capability toggles)
// ---------------------------------------------------------------------------

const CAPABILITIES: Array<{ key: keyof AgentCapabilities; label: string; hint: string }> = [
  { key: "codeSandbox", label: "Code sandbox", hint: "Isolated execution environment" },
  { key: "codeExecution", label: "Code execution", hint: "Run scripts, tests, build commands" },
  { key: "pullRequestAccess", label: "Pull request access", hint: "Create and update PRs on connected repos" },
  { key: "outboundWebAccess", label: "Outbound web access", hint: "Gives a governed fetch_url tool, bound to the allowlist below" },
];

export function AdvancedTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const agent = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const [caps, setCaps] = useState<AgentCapabilities | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (agent.data) {
      setCaps(agentCapabilitiesSchema.parse(agent.data.agent.capabilities ?? {}));
    }
  }, [agent.data]);

  const save = useMutation({
    mutationFn: () => api.updateAgent(agentId, { capabilities: caps! }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    },
  });

  if (!caps) return null;

  return (
    <>
      <p className="page-subtitle">
        Capability toggles. A simple Q&A agent has none of these; a full
        coding agent has all of them. Same platform, different configuration.
      </p>
      <div className="row-group" style={{ marginBottom: 16 }}>
        {CAPABILITIES.map((c) => (
          <div className="row" key={c.key}>
            <span
              className={`toggle${caps[c.key] ? " on" : ""}`}
              style={{ cursor: canEdit ? "pointer" : "default" }}
              onClick={() => canEdit && setCaps({ ...caps, [c.key]: !caps[c.key] })}
            />
            <div className="grow">
              <div className="title">{c.label}</div>
              <div className="sub">{c.hint}</div>
            </div>
          </div>
        ))}
        <div className="row">
          <div className="grow">
            <div className="title">Network allowlist</div>
            <div className="sub">Hosts fetch_url may reach, exact or *.wildcard, comma-separated. Empty means no web access.</div>
          </div>
          <input
            className="mono"
            disabled={!canEdit}
            style={{ width: 260 }}
            value={caps.networkAllowlist}
            onChange={(e) => setCaps({ ...caps, networkAllowlist: e.target.value })}
            placeholder="*.internal.acme.com"
          />
        </div>
      </div>
      {canEdit && (
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {saved ? "Saved ✓" : "Save changes"}
        </button>
      )}
    </>
  );
}
