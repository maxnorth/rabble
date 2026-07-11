import type {
  Agent,
  AgentDirectoryRow,
  AgentSurface,
  OrgSettings,
  AgentToolConfig,
  ApiKey,
  ApprovalDecisionRequest,
  AccessRequest,
  AuditEvent,
  Automation,
  CatalogModel,
  ConnectedAccount,
  Connection,
  ConnectionRole,
  CreateAgentRequest,
  CreateCustomModelRequest,
  Domain,
  EvalCase,
  EvalCriterion,
  EvalSuite,
  Grant,
  McpServer,
  Message,
  Model,
  ProviderKeyStatus,
  SessionEvalResult,
  SessionWithAgent,
  StreamEvent,
  SurfaceResponseMode,
  Team,
  TeamMember,
  UpdateAgentRequest,
  UpdateToolConfigRequest,
  User,
  UserPreferences,
} from "@rabblehq/core";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The full parsed error body — lets callers read structured detail
     *  (e.g. a gating block's per-case failures) beyond the message. */
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    let body: Record<string, unknown> | undefined;
    try {
      body = (await res.json()) as Record<string, unknown>;
      if (typeof body.error === "string") message = body.error;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, message, body);
  }
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

export interface TeamAccessEntry {
  id: string;
  accessRight: "use" | "edit" | "admin";
  targetType: "agent" | "domain";
  targetId: string;
  targetName: string;
  /** For domain grants: how many agents the domain currently reaches. */
  agentCount: number | null;
}

export interface StatsResponse {
  days: number;
  kpis: {
    sessions: number;
    priorSessions: number;
    activeUsers: number;
    messages: number;
    priorMessages: number;
    toolCalls: number;
    priorToolCalls: number;
    inputTokens: number;
    outputTokens: number;
    priorOutputTokens: number;
    spend: number;
    avgCostPerSession: number;
    avgTurns: number;
    activeAgents: number;
    totalAgents: number;
    evalPassRate: number | null;
    evaluatedSessions: number;
  };
  sessionsPerAgent: Array<{ agentId: string; agentName: string; count: number }>;
  sessionsPerDay: Array<{ day: string; count: number }>;
  toolAuthSplit: Array<{ authType: string | null; count: number }>;
  perTool: Array<{ tool: string; server: string | null; count: number }>;
  perModel: Array<{ modelName: string; count: number; tokens: number }>;
  spendByAgent: Array<{ agentName: string; sessions: number; spend: number }>;
  perCriterion: Array<{
    criterionId: string;
    criterionName: string;
    agentName: string;
    passRate: number;
    results: number;
  }>;
  evalByAgent: Array<{
    agentId: string;
    agentName: string;
    passRate: number;
    results: number;
  }>;
  turnDistribution: Array<{ label: string; count: number }>;
}

export const api = {
  // setup & auth
  setupStatus: () => get<{ needsSetup: boolean }>("/api/setup"),
  setup: (body: { orgName: string; name: string; email: string; password: string }) =>
    post<{ user: User }>("/api/setup", body),
  login: (body: { email: string; password: string }) =>
    post<{ user: User }>("/api/auth/login", body),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  me: () => get<{ user: User }>("/api/auth/me"),

  // agents
  listAgents: () => get<{ agents: AgentDirectoryRow[] }>("/api/agents"),
  getAgent: (id: string) =>
    get<{ agent: Agent; myRight: "use" | "edit" | "admin" | null }>(
      `/api/agents/${id}`,
    ),
  createAgent: (body: Partial<CreateAgentRequest> & { name: string }) =>
    post<{ agent: Agent }>("/api/agents", body),
  updateAgent: (id: string, body: UpdateAgentRequest) =>
    patch<{ agent: Agent }>(`/api/agents/${id}`, body),
  duplicateAgent: (id: string) =>
    post<{ agent: Agent }>(`/api/agents/${id}/duplicate`),
  deleteAgent: (id: string) => del<{ ok: true }>(`/api/agents/${id}`),
  starAgent: (id: string) => put<{ ok: true }>(`/api/agents/${id}/star`),
  unstarAgent: (id: string) => del<{ ok: true }>(`/api/agents/${id}/star`),
  agentTools: (id: string) =>
    get<{ tools: AgentToolConfig[]; servers: string[] }>(`/api/agents/${id}/tools`),
  updateAgentTool: (agentId: string, body: UpdateToolConfigRequest) =>
    patch<{ ok: true }>(`/api/agents/${agentId}/tools`, body),
  attachMcpServer: (agentId: string, serverId: string) =>
    put<{ ok: true }>(`/api/agents/${agentId}/mcp-servers/${serverId}`),
  detachMcpServer: (agentId: string, serverId: string) =>
    del<{ ok: true }>(`/api/agents/${agentId}/mcp-servers/${serverId}`),
  subAgents: (id: string) =>
    get<{
      subAgents: Array<
        Agent & { note: string; evalScore: number | null; evalCount: number }
      >;
    }>(`/api/agents/${id}/sub-agents`),
  setSubAgentNote: (id: string, subId: string, note: string) =>
    patch<{ ok: true }>(`/api/agents/${id}/sub-agents/${subId}`, { note }),
  listSurfaces: (agentId: string) =>
    get<{ surfaces: AgentSurface[] }>(`/api/agents/${agentId}/surfaces`),
  addSurface: (
    agentId: string,
    body: { connectionId: string; label: string; responseMode?: SurfaceResponseMode },
  ) => post<{ surface: { id: string } }>(`/api/agents/${agentId}/surfaces`, body),
  updateSurface: (
    agentId: string,
    surfaceId: string,
    body: { responseMode?: SurfaceResponseMode; dmEnabled?: boolean },
  ) => patch<{ ok: true }>(`/api/agents/${agentId}/surfaces/${surfaceId}`, body),
  removeSurface: (agentId: string, surfaceId: string) =>
    del<{ ok: true }>(`/api/agents/${agentId}/surfaces/${surfaceId}`),
  linkSubAgent: (id: string, subId: string) =>
    put<{ ok: true }>(`/api/agents/${id}/sub-agents/${subId}`),
  unlinkSubAgent: (id: string, subId: string) =>
    del<{ ok: true }>(`/api/agents/${id}/sub-agents/${subId}`),

  // models
  modelCatalog: () => get<{ catalog: CatalogModel[] }>("/api/models/catalog"),
  listModels: () =>
    get<{ models: Array<Model & { usedBy: string[]; canUse: boolean }> }>("/api/models"),
  providerStatus: () => get<{ providers: ProviderKeyStatus[] }>("/api/models/providers"),
  setProviderKey: (body: { provider: string; apiKey: string }) =>
    put<{ ok: true }>("/api/models/providers", body),
  enableBuiltIn: (catalogId: string) =>
    post<{ model: Model }>("/api/models/built-in", { catalogId }),
  createCustomModel: (body: CreateCustomModelRequest) =>
    post<{ model: Model }>("/api/models/custom", body),
  deleteModel: (id: string) => del<{ ok: true }>(`/api/models/${id}`),
  updateModel: (
    id: string,
    body: Partial<{
      displayName: string;
      baseUrl: string | null;
      modelId: string;
      apiKey: string;
      priceInputPerMtok: number | null;
      priceOutputPerMtok: number | null;
    }>,
  ) => patch<{ model: Model }>(`/api/models/${id}`, body),

  // sessions
  listSessions: () => get<{ sessions: SessionWithAgent[] }>("/api/sessions"),
  createSession: (agentId: string | null, intent?: string) =>
    post<{ session: SessionWithAgent }>("/api/sessions", { agentId, intent }),
  renameSession: (id: string, title: string) =>
    patch<{ session: SessionWithAgent }>(`/api/sessions/${id}`, { title }),
  deleteSession: (id: string) => del<{ ok: true }>(`/api/sessions/${id}`),
  getSession: (id: string) =>
    get<{
      session: SessionWithAgent;
      messages: Message[];
      evalResults: SessionEvalResult[];
      pendingApprovals: Array<{
        approvalId: string;
        toolName: string;
        serverName: string | null;
        input: unknown;
      }>;
      pendingConnects: Array<{
        connectId: string;
        serverId: string;
        serverName: string;
        requiresOAuth: boolean;
      }>;
    }>(`/api/sessions/${id}`),
  decideApproval: (sessionId: string, approvalId: string, body: ApprovalDecisionRequest) =>
    post<{ ok: true }>(`/api/sessions/${sessionId}/approvals/${approvalId}`, body),
  freezeSession: (sessionId: string, suiteId: string, rubric?: string) =>
    post<{ case: EvalCase }>(`/api/sessions/${sessionId}/freeze`, { suiteId, rubric }),

  // teams
  listTeams: () => get<{ teams: Team[] }>("/api/teams"),
  createTeam: (body: { name: string; parentTeamId?: string | null }) =>
    post<{ team: Team }>("/api/teams", body),
  getTeam: (id: string) =>
    get<{
      team: Team;
      members: TeamMember[];
      subTeams: Team[];
      access: TeamAccessEntry[];
    }>(`/api/teams/${id}`),
  setTeamRole: (teamId: string, userId: string, teamRole: "lead" | "member") =>
    patch<{ ok: true }>(`/api/teams/${teamId}/members/${userId}`, { teamRole }),
  addTeamMember: (teamId: string, userId: string) =>
    post<{ ok: true }>(`/api/teams/${teamId}/members`, { userId }),
  removeTeamMember: (teamId: string, userId: string) =>
    del<{ ok: true }>(`/api/teams/${teamId}/members/${userId}`),
  deleteTeam: (id: string) => del<{ ok: true }>(`/api/teams/${id}`),
  updateTeam: (id: string, body: { name: string }) =>
    patch<{ team: Team }>(`/api/teams/${id}`, body),
  listUsers: () =>
    get<{
      users: Array<{
        id: string;
        name: string;
        email: string;
        role: string;
        active: boolean;
      }>;
    }>("/api/users"),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    post<{ ok: true }>("/api/auth/change-password", body),
  updateMember: (id: string, body: { role?: "admin" | "member"; active?: boolean }) =>
    patch<{ ok: true }>(`/api/members/${id}`, body),

  // domains
  listDomains: () => get<{ domains: Domain[] }>("/api/domains"),
  createDomain: (name: string) => post<{ domain: Domain }>("/api/domains", { name }),
  deleteDomain: (id: string) => del<{ ok: true }>(`/api/domains/${id}`),
  updateDomain: (id: string, body: { name: string }) =>
    patch<{ domain: Domain }>(`/api/domains/${id}`, body),

  // grants
  listGrants: (targetType: "agent" | "domain" | "model", targetId: string) =>
    get<{ grants: Grant[] }>(`/api/grants?targetType=${targetType}&targetId=${targetId}`),
  createGrant: (body: {
    subjectType: "user" | "team";
    subjectId: string;
    accessRight: "use" | "edit" | "admin";
    targetType: "agent" | "domain" | "model";
    targetId: string;
  }) => post<{ grant: Grant }>("/api/grants", body),
  deleteGrant: (id: string) => del<{ ok: true }>(`/api/grants/${id}`),

  // MCP servers
  listMcpServers: () =>
    get<{ servers: Array<McpServer & { usedBy: Array<{ id: string; name: string }> }> }>(
      "/api/mcp-servers",
    ),
  createMcpServer: (body: { name: string; url: string; category: string; credentialMode: "shared" | "personal"; token?: string }) =>
    post<{ server: McpServer }>("/api/mcp-servers", body),
  refreshMcpServer: (id: string) =>
    post<{ server: McpServer }>(`/api/mcp-servers/${id}/refresh`),
  deleteMcpServer: (id: string) => del<{ ok: true }>(`/api/mcp-servers/${id}`),
  listMcpCredentials: () =>
    get<{ credentials: Array<{ serverId: string; serverName: string; connectedAt: string }> }>(
      "/api/profile/mcp-credentials",
    ),
  connectMcpCredential: (serverId: string, token: string) =>
    put<{ ok: true }>(`/api/profile/mcp-credentials/${serverId}`, { token }),
  startMcpOAuth: (serverId: string) =>
    post<{ authorizeUrl: string }>(`/api/profile/mcp-credentials/${serverId}/oauth/start`),
  disconnectMcpCredential: (serverId: string) =>
    del<{ ok: true }>(`/api/profile/mcp-credentials/${serverId}`),
  updateMcpServer: (
    id: string,
    body: Partial<{ name: string; url: string; category: string; token: string | null }>,
  ) => patch<{ server: McpServer }>(`/api/mcp-servers/${id}`, body),

  // evals
  listCriteria: (agentId: string) =>
    get<{ criteria: EvalCriterion[] }>(`/api/agents/${agentId}/criteria`),
  createCriterion: (agentId: string, body: { name: string; description: string }) =>
    post<{ criterion: unknown }>(`/api/agents/${agentId}/criteria`, body),
  deleteCriterion: (id: string) => del<{ ok: true }>(`/api/criteria/${id}`),
  updateCriterion: (id: string, body: Partial<{ name: string; description: string }>) =>
    patch<{ criterion: EvalCriterion }>(`/api/criteria/${id}`, body),
  listSuites: (agentId: string) =>
    get<{ suites: EvalSuite[] }>(`/api/agents/${agentId}/suites`),
  disputeEvalResult: (resultId: string) =>
    post<{ ok: true }>(`/api/eval-results/${resultId}/dispute`),
  resolveEvalResult: (resultId: string, outcome: "upheld" | "overturned") =>
    post<{ ok: true }>(`/api/eval-results/${resultId}/resolve`, { outcome }),
  agentTrust: (agentId: string) =>
    get<{
      openReviews: Array<{
        id: string;
        criterionName: string;
        passed: boolean;
        reasoning: string;
        sessionId: string;
        sessionTitle: string;
        disputedAt: string | null;
      }>;
      scopeViolations30d: number;
      gradedCount: number;
      judgeModel: string | null;
    }>(`/api/agents/${agentId}/trust`),
  updateCase: (id: string, body: Partial<{ name: string; input: string; rubric: string }>) =>
    patch<{ case: EvalCase }>(`/api/cases/${id}`, body),
  updateSuite: (suiteId: string, body: { gating?: boolean; name?: string }) =>
    patch<{ ok: true }>(`/api/suites/${suiteId}`, body),
  createSuite: (agentId: string, body: { name: string; gating?: boolean }) =>
    post<{ suite: unknown }>(`/api/agents/${agentId}/suites`, body),
  listCases: (suiteId: string) => get<{ cases: EvalCase[] }>(`/api/suites/${suiteId}/cases`),
  createCase: (suiteId: string, body: { name: string; input: string; rubric: string }) =>
    post<{ case: EvalCase }>(`/api/suites/${suiteId}/cases`, body),
  runSuite: (suiteId: string) =>
    post<{
      run: {
        id: string;
        status: string;
        results: Array<{
          caseId: string;
          passed: boolean;
          output: string;
          reasoning: string;
        }>;
      };
    }>(`/api/suites/${suiteId}/run`),

  // automations
  schedulerStatus: () => get<{ active: boolean }>("/api/scheduler"),
  listAutomations: (agentId: string) =>
    get<{ automations: Automation[] }>(`/api/agents/${agentId}/automations`),
  createAutomation: (agentId: string, body: { name: string; schedule: string; prompt: string }) =>
    post<{ automation: Automation }>(`/api/agents/${agentId}/automations`, body),
  runAutomation: (id: string) =>
    post<{ sessionId: string; reply: string; toolCalls: number }>(
      `/api/automations/${id}/run`,
    ),
  toggleAutomation: (id: string, enabled: boolean) =>
    patch<{ automation: Automation }>(`/api/automations/${id}`, { enabled }),
  updateAutomation: (
    id: string,
    body: Partial<{ name: string; schedule: string; prompt: string }>,
  ) => patch<{ automation: Automation }>(`/api/automations/${id}`, body),
  deleteAutomation: (id: string) => del<{ ok: true }>(`/api/automations/${id}`),

  // admin
  listConnections: () =>
    get<{
      connections: Array<
        Connection & {
          tunnel: boolean;
          agentCount: number;
          linkedAgentId: string | null;
          linkedAgentName: string | null;
        }
      >;
    }>("/api/connections"),
  createConnection: (body: {
    vendor: string;
    name: string;
    roles: ConnectionRole[];
    baseUrl?: string | null;
    token?: string;
    tunnel?: boolean;
    signingSecret?: string;
    appToken?: string;
    configToken?: string;
    configRefreshToken?: string;
  }) => post<{ connection: Connection }>("/api/connections", body),
  updateConnection: (
    id: string,
    body: {
      name?: string;
      roles?: ConnectionRole[];
      baseUrl?: string | null;
      tunnel?: boolean;
      token?: string | null;
      signingSecret?: string | null;
      appToken?: string | null;
    },
  ) => patch<{ connection: Connection }>(`/api/connections/${id}`, body),
  deleteConnection: (id: string) => del<{ ok: true }>(`/api/connections/${id}`),
  saveSlackConfig: (id: string, accessToken: string, refreshToken: string) =>
    post<{ ok: true }>(`/api/connections/${id}/slack/config`, { accessToken, refreshToken }),
  syncSlackApp: (id: string, dryRun: boolean) =>
    post<{
      applied: boolean;
      reinstallRequired: boolean;
      addedScopes: string[];
      addedEvents: string[];
      socketModeChanged: boolean;
      interactivityChanged: boolean;
    }>(`/api/connections/${id}/slack/sync`, { dryRun }),
  provisionSlackApp: (id: string, botName: string) =>
    post<{ appId: string; installUrl: string }>(
      `/api/connections/${id}/slack/provision`,
      { botName },
    ),
  listApiKeys: () => get<{ keys: ApiKey[] }>("/api/api-keys"),
  createApiKey: (body: { name: string; scope: "read" | "write" | "admin" }) =>
    post<{ key: { id: string; name: string; scope: string; prefix: string }; token: string }>(
      "/api/api-keys",
      body,
    ),
  revokeApiKey: (id: string) => post<{ ok: true }>(`/api/api-keys/${id}/revoke`),
  listAccessRequests: () =>
    get<{ requests: AccessRequest[] }>("/api/access-requests"),
  createAccessRequest: (body: {
    targetType: "agent" | "domain" | "model";
    targetId: string;
    accessRight: "use" | "edit" | "admin";
    reason?: string;
  }) => post<{ request: { id: string; status: string } }>("/api/access-requests", body),
  accessRequestCount: () => get<{ open: number }>("/api/access-requests/count"),
  approveAccessRequest: (id: string) =>
    post<{ ok: true }>(`/api/access-requests/${id}/approve`),
  denyAccessRequest: (id: string) =>
    post<{ ok: true }>(`/api/access-requests/${id}/deny`),
  listAudit: (action?: string, offset = 0) =>
    get<{ events: AuditEvent[] }>(
      `/api/audit?offset=${offset}${action ? `&action=${action}` : ""}`,
    ),
  applyRetention: () =>
    post<{ deletedSessions: number }>("/api/org/retention/apply"),
  getOrg: () =>
    get<{
      org: { id: string; name: string; settings: OrgSettings; createdAt: string };
    }>("/api/org"),
  renameOrg: (name: string) => patch<{ ok: true }>("/api/org", { name }),
  updateOrgSettings: (settings: OrgSettings) =>
    patch<{ ok: true }>("/api/org", { settings }),
  inviteMember: (body: { name: string; email: string; role?: "admin" | "member" }) =>
    post<{ user: { id: string; name: string; email: string }; tempPassword: string }>(
      "/api/members",
      body,
    ),

  // profile
  listAccounts: () => get<{ accounts: ConnectedAccount[] }>("/api/profile/accounts"),
  connectAccount: (body: { vendor: string; label?: string; token: string }) =>
    put<{ ok: true }>("/api/profile/accounts", body),
  disconnectAccount: (vendor: string) =>
    del<{ ok: true }>(`/api/profile/accounts/${vendor}`),
  getPreferences: () => get<{ preferences: UserPreferences }>("/api/profile/preferences"),
  setPreferences: (body: UserPreferences) =>
    put<{ preferences: UserPreferences }>("/api/profile/preferences", body),

  // stats
  statFailures: (agentId: string, days = 30) =>
    get<{
      failures: Array<{
        id: string;
        criterionName: string;
        reasoning: string;
        sessionId: string;
        sessionTitle: string;
        createdAt: string;
      }>;
    }>(`/api/stats/failures?agentId=${agentId}&days=${days}`),
  stats: (days: number, agentId?: string, userId?: string) =>
    get<StatsResponse>(
      `/api/stats?days=${days}${agentId ? `&agentId=${agentId}` : ""}${userId ? `&userId=${userId}` : ""}`,
    ),
};

/**
 * Post a message and consume the SSE reply stream, invoking `onEvent` for
 * each event until the stream closes.
 */
export async function streamMessage(
  sessionId: string,
  content: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminal = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const event = JSON.parse(line.slice(5).trim()) as StreamEvent;
          if (event.type === "done" || event.type === "error") sawTerminal = true;
          onEvent(event);
        } catch {
          // skip malformed event
        }
      }
    }
  }
  // The server always ends a turn with a done/error event before closing. A
  // clean close without one means the stream dropped mid-reply (proxy/idle
  // timeout, server restart, network blip) — surface it so the caller resets
  // its streaming state instead of showing a forever-typing bubble.
  if (!sawTerminal) {
    throw new ApiError(0, "The connection closed before the reply finished.");
  }
}
