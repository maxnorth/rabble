# Agent Platform — Handoff

> Handoff for **implementation**. This document covers the product: what it is, why it wins, what's been designed, what's decided, and what's still open. Technical implementation details (stack, architecture, conventions) are intentionally excluded — they will be provided separately.

---

## 1. What this product is

A platform where a **whole organization** uses AI agents and a flexible subset of people create, configure, and govern them. Think "GitHub for agents": agents as governed org citizens with identities, scoped access, measured track records, and full auditability.

Two modes in **one app**, split by navigation, not by product:
- **User mode** — talk to agents (ChatGPT-like sessions). The thread *is* the session.
- **Management mode** — configure agents, teams, domains, connections, models; view stats and audit.

### The thesis (this is the product's spine — everything serves it)

Orgs under-use agents for two compounding reasons:

1. **The risk ceiling.** The most valuable agent work (touching prod, moving money, acting on customer data) is never attempted — not because agents can't do it, but because nobody can *bound* the risk, so no one can sign a defensible yes. It's not that approval is slow; the work is forbidden by default.
2. **The maturity gap.** The work that *is* attempted never matures. People throw agents together like spaghetti at the wall — no way to know how consistently they work, no iterative improvement loop, no practice of evaluation. Bots get built, kind of work, and quietly die (the graveyard).

The product's answer is the **trust flywheel**: measure → trust → grant → run → measure more → grant more. Evaluation produces the evidence (track records, pass rates) that lets an approver grant bounded access; bounded access produces the real-world sessions that feed evaluation. Governance is sold as the **unlock**, not the tax — the thing that makes forbidden work allowable.

### Core product pillars (preserve these)

1. **Session-first.** A Slack thread, a ticket comment chain, a PR review — each is one session. Surfaces are delivery points, not the primitive. The platform owns conversational continuity.
2. **Service vs. user auth, visible everywhere.** Every tool call runs either under an org **service** credential or **as the user** (with consent prompt). Surfaced at every level: per-tool config, inline session approval, analytics, personal connections.
3. **Bounded delegation.** Access is expressed as explicit, scoped, revocable **grants** (who · right: use/edit/admin · agent or domain). Agents calling agents is permission-gated. Every edge is auditable.
4. **Evals as a first-class citizen.** Agents carry criteria (live-evaluated against real sessions) and suites (offline mock-session test cases) with pass rates and trends. Sessions can be frozen into test cases. Track record is *evidence in access decisions* — this connection is the differentiator; no competitor has it.
5. **Full audit trail.** Sessions are complete records (messages, tool calls, approvals). Separately, an admin audit log records control-plane changes.

---

## 2. Files in this project

| File | Role |
|---|---|
| **`Agent Platform - App.dc.html`** | **Single source of truth.** Full interactive hi-fi prototype: session experience + complete management surface. |
| `HANDOFF.md` | This document. |
| `Journey Map - J1 First Agent.dc.html` | J1 (idea → working agent → shared) mapped stage-by-stage with red/amber/green gaps, interview probes, and **the planned solutions** (the Builder agent — see §5). |
| `Bullseye Customer - Research Doc.dc.html` | Who we validate with first: segment definition, personas, rings, qualification rubric, pivot triggers. |
| `Competitor Landscape - Research Doc.dc.html` | Five competitor lanes, gaps ranked by defensibility, threats. Dust is the real head-to-head competitor. |
| `Operating System - One Page.dc.html` | The founder's decision discipline (predict → look → get surprised → update) with the three live bets. |
| `support.js` / `doc-page.js` | Runtime files — never edit. |

The research docs are context, not specs: they explain *why* the design is shaped this way and what's still a hypothesis.

---

## 3. Information architecture (as prototyped)

**Icon rail (primary nav):** Logo → Sessions · Agents · Teams · Stats · Admin · (bottom) Profile.

### Sessions (user mode)
- Rail: + New session, recent session history with per-agent status dots.
- Landing: centered greeting + one composer with an **agent target pill defaulting to "Auto"** (picker of Auto + agents). Deliberately minimal — no roster grid.
- Active session: user messages right-aligned, agent messages left with **inline tool calls** (click → detail drawer), file artifacts, and the signature **inline approval card** ("acting as you… Approve as me / Deny / Run as service account").
- Session **eval results** are visible on sessions (pass/fail per criterion) — sessions are where quality becomes tangible.
- Right detail drawer: tool detail (input/output, auth chip), file artifact, agent profile (with "Configure →" as the seam into management).

### Agents
- Rail: + New agent, **★ Favorites** (starred agents pin here), then **All agents** entry.
- **All agents directory**: a sortable table (click column headers: Agent / Domain / Eval score / Last updated / Tools; click again to flip) with text search and **dynamic filters** ("+ Filter" popup → Domain submenu, Starred, You own, Eval ≥ 90%; applied filters are removable chips). The directory doubles as a *trust surface*: eval scores and attributes tell a stranger whether to rely on an agent they didn't build.
- **Agent config**: 8 tabs — Identity · Surfaces · MCP · Agents (sub-agents) · Automations · **Evals** · Access · Advanced. (Corrected to the prototype's Title Case — an earlier transcription had these lowercase.)
  - **Evals tab**: criteria (live, evaluated against real sessions, with pass %, trend, session counts) + suites (offline mock-session test cases, with gating flags). Track-record view.
  - **Access tab**: direct grants + domain grants, plain-language rights (use · edit · admin).

### Teams (RBAC backbone)
- Hierarchical (GitHub-style: Engineering › Platform, Data; People) + a pinned org-wide "Everyone".
- Team detail: Members · Sub-teams · Agent access (owns vs. granted-use — the ownership-vs-use story). Grants cascade to sub-teams and members.

### Domains (grouping + shared grants)
- **Flat** collections of agents (no nesting — decided; resist tree UIs). Names are natural-cased single words ("Engineering", "People", "Data").
- Purpose: assign grants once at domain level, applied to every agent in it. A domain has **no inherent permissions** until granted.
- **Optional** — agents can have no domain ("No domain" is a first-class filter state).
- **There is no single "owner" concept.** Any number of teams/people can hold rights on an agent, directly or via domain. This replaced an earlier owner/folder model — don't reintroduce it.

### Stats
- Overview · Eval performance · Usage & spend · Skill use. Filter bar + time range + KPI grid + charts.

### Admin
- **Connections** (renamed from Integrations — first-party platform connections: Slack, GitHub, Linear, Datadog, PagerDuty…; a vendor can host multiple apps; role badges: Interface / Automation / Tools).
- **MCP servers** (pure tool endpoints — deliberately distinct from Connections; a vendor like Datadog can appear in both).
- **Models** (proprietary / BYO key / gateway; per-model access grants; used-by lists).
- **API keys** (programmatic access: name, scope chip read/write/admin, masked prefix, creator, last-used, revoke).
- **Audit log** (control-plane state changes only — NOT a session log).
- **Settings** (org, defaults, members).

### Profile
- Connected accounts (personal credentials used when an agent acts *as you*) · Agent preferences (approval posture, response style).

---

## 4. Naming & concept decisions (locked — don't relitigate)

- **Domains** (not Spaces, not folders): flat, optional, grant-carrying agent collections.
- **Connections** (not Integrations) in Admin.
- **Natural casing for display names** — agents and domains display as "Eng On-Call", "Deploy Gate", "Engineering"; slugs (`eng-oncall`) exist internally only.
- Analytics = **"Stats"**; admin = **"Admin"**; agent tools tab = **"MCP"**; agent reachability tab = **"Surfaces"** (tabs are Title Case, per the prototype).
- Connections vs. MCP servers are intentionally separate concepts.
- "+ Add" / "Attach" phrasing (not "Create") for shared resources.
- No per-agent "owner"; rights come from grants (direct or domain).
- Sort by clicking table column headers; filters via "+ Filter" popup with chips (no segmented filter/sort controls on the directory).

---

## 5. The Builder (v1 SHIPPED — conversational creation + access requests)

> Status: a v1 exists. Every org ships with a built-in **Builder** agent
> (usable by Everyone; directory shows a "built-in" chip) whose platform
> tools — `create_agent_draft`, `add_eval_criterion`, `attach_mcp_server`,
> `list_mcp_servers`, `request_access` — run through the standard governed
> tool pipeline: inline tool-call UI, the user-auth consent gate, rights
> enforced per-tool against the asking user, audit rows attributed
> "via Builder". `request_access` feeds Admin › Access requests (below).
> Still open from the original vision: trial-session test-case mining,
> "create an agent from this session", and the Share verb.

From the J1 journey mapping (full detail in the journey map doc's "Planned solutions" section):

**Creation is a session.** A built-in first-party agent — working name **the Builder** — creates and configures agents conversationally, operating the platform through its own MCP (create draft, attach tools, add eval criteria, freeze sessions as test cases, request access). Key decisions already made:

- The Builder **visibly calls platform tools** in the standard inline tool-call UI — the medium teaches the product's own model.
- **Extract conservatively, be correctable** ("here's what I saw you do; fix what I got wrong") — never over-claim magic.
- Review lands on the **existing config tabs, pre-filled** — no separate wizard UI. Every Builder action is audit-attributed as "user, via Builder."
- **Agents are born measured**: the Builder drafts eval criteria from the stated job, mines test cases from trial sessions (user corrections become labeled examples), and proposes adversarial mock cases ("what's the worst thing this agent could do?"). User approves/edits; Builder critiques criteria that won't discriminate.
- The Builder detects access limits and **requests access on the user's behalf**; an admin is notified with context auto-attached (who, via Builder, for what agent, what scope). This pulls the request → notify → approve loop onto the critical path.
- Trigger surfaces: a quiet build-your-own affordance on the Sessions landing + "create an agent from this session" on repeated-pattern sessions. Reactive only (user's own sessions); ambient org-wide scanning is deferred behind an org opt-in.
- Drafts run only for their maker until shared. **Share is one verb**: audience picker (team-first default), plain-language rights sentence, track-record chip as evidence, optional deploy-to-Slack, visible pause/unshare.

## 6. Other open threads (not yet built)

- **Grant editing** is display-only everywhere (agent Access tab, team Agent-access, domain grants, model access). Wiring it end-to-end is the biggest missing interaction after the Builder.
- ~~The **approval screen for access requests**~~ — SHIPPED: Admin ›
  Access requests (open-count badge, approve materializes the grant with
  right-upgrade semantics, deny recorded; admins get a Slack DM ping when
  a request lands; everything audited).
- **The "cap lifted" hero flow** (the pitch demo): risky action → blocked → owner grants scoped access with track-record evidence → action runs → audit trail. Pieces exist; the connected flow doesn't.
- Creation flows are stubs (+ New agent/team, Register model, Add connection, + Create key…).
- Only **one scripted session** (Eng On-Call CI triage). More scripted sessions hitting different personas would strengthen demos.
- Stats/Audit filters and exports are display-only. Model selector and logo picker on Identity are static.
- Stage 7 of J1 (pulse-back: digests, pass-rate-drop alerts) is acknowledged but undesigned.

---

## 7. Strategy context (read the research docs for full versions)

- **Positioning:** "Gateways govern traffic. Eval tools grade outputs. Builders make demos. We're the only platform where an agent's measured track record earns it real access."
- **Bullseye customer:** 200–2,000-person, tech-forward, regulated-adjacent org, post-AI-pilot, with a mandate-vs-veto standoff; champion = platform/AI-enablement lead. SaaS-first go-to-market; open-core-ready architecture (self-host demand is a qualifying signal, not the default motion).
- **Real competitor: Dust** (same shape, same buyer, shipped). Daylight: they have no eval system, no write-side bounded delegation, no approver-as-user. **Microsoft** wins the M365-captive org — don't fight there.
- **Three live bets** (pre-registered in the Operating System doc, currently being validated via customer interviews): risk-is-the-blocker (not reliability), evidence-can-earn-access, the-champion-exists. If interviews break these, the pivot paths are written down — check before making big product commitments.

## 8. Working style the user prefers

- Concise and direct. Small targeted changes stay targeted; frequent small iterations, often reacting to a screenshot with a one-line ask.
- Dark/technical aesthetic of the prototype is intentional; this project is standalone (ignore any design-system bindings).
- The user cares deeply about **naming precision** and **conceptual clarity** (service-vs-user auth, grants-vs-ownership, connections-vs-MCP, audit-vs-session). Honor the distinctions in §4; when adding UI, match the existing visual vocabulary.
- Strategy discussions are part of the work: the user often wants to think out loud, be challenged, and have holes poked before building. Suggestion-before-implementation is appreciated ("suggestion only, no changes" is a common mode).
