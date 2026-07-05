import type {
  Agent,
  CatalogModel,
  CreateAgentRequest,
  CreateCustomModelRequest,
  Message,
  Model,
  ProviderKeyStatus,
  SessionWithAgent,
  StreamEvent,
  UpdateAgentRequest,
  User,
} from "@rabble/core";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  // setup & auth
  setupStatus: () => request<{ needsSetup: boolean }>("/api/setup"),
  setup: (body: {
    orgName: string;
    name: string;
    email: string;
    password: string;
  }) =>
    request<{ user: User }>("/api/setup", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  login: (body: { email: string; password: string }) =>
    request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ user: User }>("/api/auth/me"),

  // agents
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  getAgent: (id: string) => request<{ agent: Agent }>(`/api/agents/${id}`),
  createAgent: (body: Partial<CreateAgentRequest> & { name: string }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (id: string, body: UpdateAgentRequest) =>
    request<{ agent: Agent }>(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ ok: true }>(`/api/agents/${id}`, { method: "DELETE" }),

  // models
  modelCatalog: () => request<{ catalog: CatalogModel[] }>("/api/models/catalog"),
  listModels: () => request<{ models: Model[] }>("/api/models"),
  providerStatus: () =>
    request<{ providers: ProviderKeyStatus[] }>("/api/models/providers"),
  setProviderKey: (body: { provider: string; apiKey: string }) =>
    request<{ ok: true }>("/api/models/providers", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  enableBuiltIn: (catalogId: string) =>
    request<{ model: Model }>("/api/models/built-in", {
      method: "POST",
      body: JSON.stringify({ catalogId }),
    }),
  createCustomModel: (body: CreateCustomModelRequest) =>
    request<{ model: Model }>("/api/models/custom", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteModel: (id: string) =>
    request<{ ok: true }>(`/api/models/${id}`, { method: "DELETE" }),

  // sessions
  listSessions: () => request<{ sessions: SessionWithAgent[] }>("/api/sessions"),
  createSession: (agentId: string | null) =>
    request<{ session: SessionWithAgent }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId }),
    }),
  getSession: (id: string) =>
    request<{ session: SessionWithAgent; messages: Message[] }>(
      `/api/sessions/${id}`,
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
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
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
          onEvent(JSON.parse(line.slice(5).trim()) as StreamEvent);
        } catch {
          // skip malformed event
        }
      }
    }
  }
}
