import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import { AGENT_COLORS, AGENT_GLYPHS } from "../../lib/time";

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

export function IdentityTab({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agent = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const models = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });

  const [form, setForm] = useState<{
    name: string;
    description: string;
    instructions: string;
    tone: string;
    icon: string;
    color: string;
    modelId: string;
    domainId: string;
    status: "active" | "draft";
  } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (agent.data) {
      const a = agent.data.agent;
      setForm({
        name: a.name,
        description: a.description,
        instructions: a.instructions,
        tone: a.tone,
        icon: a.icon,
        color: a.color,
        modelId: a.modelId ?? "",
        domainId: a.domainId ?? "",
        status: a.status,
      });
    }
  }, [agent.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateAgent(agentId, {
        name: form!.name,
        description: form!.description,
        instructions: form!.instructions,
        tone: form!.tone,
        icon: form!.icon,
        color: form!.color,
        modelId: form!.modelId || null,
        domainId: form!.domainId || null,
        status: form!.status,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteAgent(agentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigate("/agents");
    },
  });
  const duplicate = useMutation({
    mutationFn: () => api.duplicateAgent(agentId),
    onSuccess: async ({ agent: copy }) => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigate(`/agents/${copy.id}`);
    },
  });

  if (!form) return null;
  const enabledModels = (models.data?.models ?? []).filter(
    (m) => m.enabled && (m.canUse || m.id === form.modelId),
  );

  return (
    <fieldset disabled={!canEdit} style={{ border: "none" }}>
      <div className="field">
        <label>Logo</label>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {AGENT_GLYPHS.map((glyph) => (
            <button
              key={glyph}
              type="button"
              onClick={() => setForm({ ...form, icon: glyph })}
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: `1px solid ${form.icon === glyph ? "var(--accent)" : "var(--border-1)"}`,
                background: form.icon === glyph ? "var(--hover-3)" : "var(--surface-group)",
                fontSize: 16,
                color: AGENT_COLORS[form.color] ?? "var(--accent-text)",
              }}
            >
              {glyph}
            </button>
          ))}
          <span style={{ width: 10 }} />
          {Object.entries(AGENT_COLORS).map(([name, value]) => (
            <button
              key={name}
              type="button"
              title={name}
              onClick={() => setForm({ ...form, color: name })}
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: `2px solid ${form.color === name ? "var(--text-1)" : "transparent"}`,
                background: value,
              }}
            />
          ))}
        </div>
        <span className="hint">Shown in chat, the rail, and the directory.</span>
      </div>
      <div className="field">
        <label>Name</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="field">
        <label>Description</label>
        <input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="What this agent is responsible for"
        />
      </div>
      <div className="field">
        <label>Instructions</label>
        <textarea
          rows={8}
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          placeholder="System instructions that define how this agent behaves"
        />
      </div>
      <div className="field">
        <label>Tone &amp; style</label>
        <input
          value={form.tone}
          onChange={(e) => setForm({ ...form, tone: e.target.value })}
          placeholder="Be concise and direct. Surface options before any write action."
        />
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Model</label>
          <select
            value={form.modelId}
            onChange={(e) => setForm({ ...form, modelId: e.target.value })}
          >
            <option value="">No model</option>
            {enabledModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
          <span className="hint">
            Limited to models you can use. Manage access in Admin › Models.
          </span>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Domain</label>
          <select
            value={form.domainId}
            onChange={(e) => setForm({ ...form, domainId: e.target.value })}
          >
            <option value="">No domain</option>
            {domains.data?.domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <span className="hint">Domain grants apply to every agent in it.</span>
        </div>
      </div>
      <div className="field">
        <label>Status</label>
        <div className="segmented">
          {(["draft", "active"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={form.status === s ? "active" : ""}
              onClick={() => setForm({ ...form, status: s })}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="hint">Only active agents appear in the session composer.</span>
      </div>

      {(save.isError || remove.isError) && (
        <p className="error-text" style={{ marginBottom: 12 }}>
          {((save.error ?? remove.error) as Error).message}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {saved ? "Saved ✓" : "Save changes"}
        </button>
        <button
          className="btn"
          disabled={duplicate.isPending}
          title="Copy this configuration (MCP wiring and sub-agents included) into a new draft"
          onClick={() => duplicate.mutate()}
        >
          {duplicate.isPending ? "Duplicating…" : "Duplicate"}
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn danger"
          disabled={remove.isPending}
          onClick={() => {
            if (confirm(`Delete agent "${form.name}"?`)) remove.mutate();
          }}
        >
          Delete agent
        </button>
      </div>
    </fieldset>
  );
}
