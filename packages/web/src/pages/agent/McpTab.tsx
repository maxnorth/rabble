import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
    mutationFn: (body: {
      serverId: string;
      toolName: string;
      enabled?: boolean;
      authType?: "service" | "user";
    }) => api.updateAgentTool(agentId, body),
    onSuccess: refresh,
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
        Tools from the org's MCP server library. Every tool runs either under
        the org <span className="chip green">service</span> credential or{" "}
        <span className="chip amber">user</span>, as the person in the
        session, with an in-thread approval.
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
            {userCount > 0 && <span className="chip amber">{userCount} user</span>}
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
                <div className="segmented">
                  {(["service", "user"] as const).map((auth) => (
                    <button
                      key={auth}
                      disabled={!canEdit}
                      className={t.authType === auth ? "active" : ""}
                      onClick={() =>
                        updateTool.mutate({
                          serverId: t.serverId,
                          toolName: t.toolName,
                          authType: auth,
                        })
                      }
                    >
                      {auth}
                    </button>
                  ))}
                </div>
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
            {attachable.map((s) => (
              <div className="row" key={s.id}>
                <div className="grow">
                  <div className="title">{s.name}</div>
                  <div className="sub">
                    {s.category} · {count(s.tools.length, "tool")}
                  </div>
                </div>
                <button className="btn" onClick={() => attach.mutate(s.id)}>
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
