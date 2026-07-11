import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api";
import { count } from "../../lib/time";

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

export function McpTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const tools = useQuery({
    queryKey: ["agent-tools", agentId],
    queryFn: () => api.agentTools(agentId),
  });
  const servers = useQuery({ queryKey: ["mcp-servers"], queryFn: api.listMcpServers });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["agent-tools", agentId] });

  const attach = useMutation({
    mutationFn: (serverId: string) => api.attachMcpServer(agentId, serverId),
    onSuccess: refresh,
  });
  const detach = useMutation({
    mutationFn: (serverId: string) => api.detachMcpServer(agentId, serverId),
    onSuccess: refresh,
  });
  const updateTool = useMutation({
    mutationFn: (body: { serverId: string; toolName: string; enabled?: boolean }) =>
      api.updateAgentTool(agentId, body),
    onSuccess: refresh,
  });

  const [requested, setRequested] = useState<Set<string>>(new Set());
  const requestAccess = useMutation({
    mutationFn: (serverId: string) =>
      api.createAccessRequest({
        targetType: "mcp-server",
        targetId: serverId,
        accessRight: "use",
        reason: "Needs this server's tools on an agent",
      }),
    onSuccess: (_res, serverId) =>
      setRequested((prev) => new Set(prev).add(serverId)),
  });

  const attachedIds = new Set(tools.data?.servers ?? []);
  const attachable = (servers.data?.servers ?? []).filter((s) => !attachedIds.has(s.id));

  const byServer = new Map<string, typeof tools.data extends undefined ? never : NonNullable<typeof tools.data>["tools"]>();
  for (const t of tools.data?.tools ?? []) {
    const list = byServer.get(t.serverId) ?? [];
    list.push(t);
    byServer.set(t.serverId, list);
  }

  return (
    <>
      <p className="page-subtitle">
        Tools from the org's MCP server library. Each server's credential mode
        decides whose identity its calls carry: a{" "}
        <span className="chip green">service</span> server runs on the org
        credential; a <span className="chip amber">personal</span> server runs
        as the person in the session, with an in-thread approval. Set the mode
        where you register the server, in Admin › MCP servers.
      </p>
      {[...byServer.entries()].map(([serverId, serverTools]) => {
        const enabledTools = serverTools.filter((t) => t.enabled);
        const serviceCount = enabledTools.filter((t) => t.authType !== "user").length;
        const userCount = enabledTools.length - serviceCount;
        return (
        <div key={serverId} style={{ marginBottom: 20 }}>
          <div
            className="sidebar-title"
            style={{
              padding: "0 0 8px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {serverTools[0]?.serverName}
            <span style={{ textTransform: "none", letterSpacing: 0 }}>
              {enabledTools.length} of {serverTools.length} enabled
            </span>
            {serviceCount > 0 && (
              <span className="chip green">{serviceCount} service</span>
            )}
            {userCount > 0 && <span className="chip amber">{userCount} personal</span>}
            <span style={{ flex: 1 }} />
            {canEdit && (
              <button
                style={{ color: "var(--danger)", fontSize: 11 }}
                onClick={() => detach.mutate(serverId)}
              >
                Detach
              </button>
            )}
          </div>
          <div className="row-group">
            {serverTools.map((t) => (
              <div className="row" key={t.toolName}>
                <span
                  className={`toggle${t.enabled ? " on" : ""}`}
                  style={{ cursor: canEdit ? "pointer" : "default" }}
                  onClick={() =>
                    canEdit &&
                    updateTool.mutate({
                      serverId: t.serverId,
                      toolName: t.toolName,
                      enabled: !t.enabled,
                    })
                  }
                />
                <div className="grow">
                  <div className="title mono" style={{ fontSize: 12 }}>
                    {t.toolName}
                  </div>
                  <div className="sub">{t.description}</div>
                </div>
                <span className={`chip ${t.authType === "user" ? "amber" : "green"}`}>
                  {t.authType === "user" ? "personal" : "service"}
                </span>
              </div>
            ))}
          </div>
        </div>
        );
      })}
      {byServer.size === 0 && (
        <div className="empty-slot" style={{ marginBottom: 20 }}>
          No MCP servers attached yet.
        </div>
      )}
      {canEdit && attachable.length > 0 && (
        <>
          <div className="sidebar-title" style={{ padding: "0 0 8px" }}>
            Attach from library
          </div>
          <div className="row-group">
            {attachable.map((s) => {
              const available = s.tools.length - s.disabledTools.length;
              return (
                <div className="row" key={s.id}>
                  <div className="grow">
                    <div className="title">{s.name}</div>
                    <div className="sub">
                      {s.category} · {count(available, "tool")}
                    </div>
                  </div>
                  {s.canUse ? (
                    <button className="btn" onClick={() => attach.mutate(s.id)}>
                      Attach
                    </button>
                  ) : requested.has(s.id) ? (
                    <span className="chip green" title="An org admin has been notified.">
                      access requested ✓
                    </span>
                  ) : (
                    <>
                      <span
                        className="chip amber"
                        title="This server is restricted to specific teams or people."
                      >
                        restricted
                      </span>
                      <button
                        className="btn"
                        disabled={requestAccess.isPending}
                        onClick={() => requestAccess.mutate(s.id)}
                      >
                        Request access
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {attach.isError && (
            <p className="error-text" style={{ marginTop: 8 }}>
              {(attach.error as Error).message}
            </p>
          )}
        </>
      )}
    </>
  );
}
