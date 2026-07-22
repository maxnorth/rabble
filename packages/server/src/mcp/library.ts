import type { McpLibraryEntry } from "@rabblehq/core";

/**
 * The curated MCP library: popular platforms' hosted MCP servers,
 * preconfigured so an org adds them in a click instead of hunting for
 * endpoint URLs. Entries only prefill the register form — the resulting
 * row is an ordinary mcp_servers record (editable URL and all), and the
 * same entry can be added multiple times as differently-scoped copies.
 *
 * URLs are the vendors' published hosted endpoints. Hosted MCP servers
 * almost universally authenticate per-user via OAuth, so `personal` is
 * the default mode for most; `shared` fits token-based or self-hosted
 * gateways.
 */
export const MCP_LIBRARY: McpLibraryEntry[] = [
  {
    key: "github",
    name: "GitHub",
    description: "Repos, issues, pull requests, and Actions",
    url: "https://api.githubcopilot.com/mcp/",
    category: "Code",
    credentialMode: "personal",
    glyph: "⎇",
    brandColor: "#24292f",
  },
  {
    key: "notion",
    name: "Notion",
    description: "Pages, databases, and comments in your workspace",
    url: "https://mcp.notion.com/mcp",
    category: "Project",
    credentialMode: "personal",
    glyph: "N",
    brandColor: "#191919",
  },
  {
    key: "linear",
    name: "Linear",
    description: "Issues, projects, and cycles",
    url: "https://mcp.linear.app/mcp",
    category: "Project",
    credentialMode: "personal",
    glyph: "◫",
    brandColor: "#5E6AD2",
  },
  {
    key: "slack",
    name: "Slack",
    description: "Channels, messages, and search",
    url: "https://mcp.slack.com/mcp",
    category: "Comms",
    credentialMode: "personal",
    glyph: "#",
    brandColor: "#4A154B",
  },
  {
    // Built-in toolset: Slack's hosted MCP only takes its own OAuth, so
    // these tools are implemented in-platform against the Slack Web API,
    // acting as a Slack Connection's workspace bot. No endpoint involved —
    // the URL is the `builtin:slack` marker (mcp/slackTools.ts).
    key: "slack-workspace",
    name: "Slack (your workspace)",
    description: "Act as the workspace bot, via a connection you created",
    url: "builtin:slack",
    category: "Comms",
    credentialMode: "connection",
    glyph: "#",
    brandColor: "#4A154B",
  },
  {
    key: "sentry",
    name: "Sentry",
    description: "Issues, stack traces, and release health",
    url: "https://mcp.sentry.dev/mcp",
    category: "Ops",
    credentialMode: "personal",
    glyph: "◉",
    brandColor: "#362D59",
  },
  {
    key: "stripe",
    name: "Stripe",
    description: "Customers, invoices, and payment data",
    url: "https://mcp.stripe.com",
    category: "Ops",
    credentialMode: "shared",
    glyph: "S",
    brandColor: "#635BFF",
  },
  {
    key: "atlassian",
    name: "Atlassian",
    description: "Jira issues and Confluence pages",
    url: "https://mcp.atlassian.com/v1/mcp",
    category: "Project",
    credentialMode: "personal",
    glyph: "▲",
    brandColor: "#0052CC",
  },
  {
    key: "asana",
    name: "Asana",
    description: "Tasks, projects, and goals",
    url: "https://mcp.asana.com/mcp",
    category: "Project",
    credentialMode: "personal",
    glyph: "◗",
    brandColor: "#F06A6A",
  },
  {
    key: "intercom",
    name: "Intercom",
    description: "Conversations, contacts, and help center",
    url: "https://mcp.intercom.com/mcp",
    category: "Comms",
    credentialMode: "personal",
    glyph: "◍",
    brandColor: "#286EFA",
  },
  {
    key: "paypal",
    name: "PayPal",
    description: "Invoices, payments, and disputes",
    url: "https://mcp.paypal.com/mcp",
    category: "Ops",
    credentialMode: "personal",
    glyph: "P",
    brandColor: "#003087",
  },
  {
    key: "zapier",
    name: "Zapier",
    description: "Bridge to 7,000+ apps through your Zaps",
    url: "https://mcp.zapier.com/api/mcp/mcp",
    category: "Tools",
    credentialMode: "personal",
    glyph: "⚡",
    brandColor: "#FF4F00",
  },
  {
    key: "huggingface",
    name: "Hugging Face",
    description: "Models, datasets, and Spaces search",
    url: "https://huggingface.co/mcp",
    category: "Tools",
    credentialMode: "personal",
    glyph: "🤗",
    brandColor: "#FF9D00",
  },
];

export function libraryEntry(key: string): McpLibraryEntry | undefined {
  return MCP_LIBRARY.find((e) => e.key === key);
}
