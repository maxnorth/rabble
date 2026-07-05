# Handoff: Agent Platform

**Read this first. Then read `PRODUCT_CONTEXT.md`. Then open the prototype.**

## Overview

You are implementing the **Agent Platform**: a web app where a whole organization uses AI agents (ChatGPT-like sessions) and a subset of people create, configure, and govern them (agents, teams, domains, connections, models, evals, audit). The product thesis, information architecture, personas, and all locked naming decisions are in `PRODUCT_CONTEXT.md` — it is required reading before writing code.

## About the design files — IMPORTANT

The `.dc.html` files in this bundle are **design references, not production code**. They are hi-fi interactive prototypes built in an HTML-based design tool with a proprietary runtime (`support.js`). **Do not ship, port, or copy this code.** Your task is to **recreate the design** in the target codebase's environment and patterns (the project owner will supply the stack and technical constraints separately — ask if not provided; do not assume).

To view the main prototype: open `Agent Platform - App.dc.html` in a browser from this folder (it loads `support.js` beside it; needs a local file server or direct file open with internet access for fonts). Click through everything — the prototype is the spec for layout, interaction, and copy.

The three research `.dc.html` docs and the journey map are **context documents** (they render the same way, using `doc-page.js`). They explain strategy and planned-but-unbuilt features. Do not implement anything from them unless the prototype shows it or the owner asks.

## Fidelity

**High-fidelity.** Colors, typography, spacing, copy, and interaction patterns in the prototype are intentional. Recreate the UI faithfully using the codebase's component conventions. Where the prototype is display-only (noted below), implement real functionality with the prototype's UI as the contract.

## The app in one paragraph

A 54px icon rail (Sessions · Agents · Teams · Stats · Admin · Profile) selects a section; each section has a 248px contextual sidebar and a main content area (max-width ~760px for content columns). User mode is Sessions: a landing page with one composer targeting "Auto" or a chosen agent, and session threads where user messages are right-aligned bubbles, agent messages are left-aligned with inline tool calls, file artifacts, and inline approval cards; a 420px right drawer shows tool/file/agent detail. Management mode covers: an Agents directory (sortable columns, text search, additive filter chips via a "+ Filter" popup) plus 8-tab agent config (identity, surfaces, MCP, agents, automations, evals, access, advanced); hierarchical Teams with grant displays; Stats dashboards (CSS bar charts); and Admin (Connections, MCP servers, Models, API keys, Audit log, Settings). Profile holds personal connected accounts and approval preferences.

## Design tokens

**Fonts:** `Inter` (UI) · `JetBrains Mono` (slugs, tool names, code, emails, IDs, chips). Google Fonts.

**Palette (dark/technical — use these exactly, do not invent):**
```
Backgrounds:  #0E0F11 app · #121317 rail/panel · #0B0C0E icon rail
Surfaces:     #16181C, #141519 cards · #101216 grouping box · #131419 tool call
Hover:        #1A1C21, #191B20, #1E2026
Borders:      #22252C primary · #2A2D35 · #1E2127 row divider · #1C1F24 icon rail
Text:         #E8EAF0 primary · #C9CDD4 · #9CA3AF dim · #6B7280 muted · #5A6069 labels
Accent blue:  #4A6FA5 actions · #6B9FD4 accent text/icons
Semantic:     green #34D399 · blue #6B9FD4 · purple #A78BFA · amber #FBBF24 · red #F87171
Danger:       #E5484D (revoke/destructive)
```

**Semantic color usage:** green = connected / service auth / passing; amber = needs-auth / user-auth / warning / failing-ish; blue = primary / proprietary; purple = agent-as-tool / team; muted = neutral. Applied consistently to avatars, status chips, and chart bars.

**Shape language:** small radii (6–10px), 1px borders, dense lists with row dividers, small mono status chips, segmented controls, toggle switches. No gradients, no big shadows.

## Interactions & behavior (what must actually work)

- Navigation: icon rail → section; sidebar → sub-view; back buttons (‹) on detail views.
- Sessions: composer target picker (Auto + agents); history opens sessions; inline tool calls and artifacts open the right drawer; the approval card offers "Approve as me / Deny / Run as service account".
- Agents directory: click column headers to sort (second click flips direction, ↑/↓ indicator); text search; "+ Filter" popup (Domain ▸ submenu, Starred, You own, Eval ≥ 90%) producing removable filter chips; ★ star pins agents to the sidebar Favorites.
- Agent config: tab navigation; MCP tab has working per-tool on/off toggles and per-tool service/user segmented control.
- Teams: hierarchy navigation, tab switching.
- Display-only in the prototype but should be REAL in implementation: grant editing (agent access, domain grants, model access), all "+ New / + Add / + Create" flows, Stats/Audit filters and export, model selector, logo picker. Where no design exists, follow the prototype's visual vocabulary and ask the owner rather than inventing UX.

## State & data

The prototype's sample data (Acme Corp; agents Eng On-Call, Deploy Gate, PR Summarizer, HR Assist, Data Analyst; domains Engineering/People/Data; user Alex Lin) defines the shape of the domain model: agents (slug + natural-cased title, domain optional, status active/draft, eval scores, tools), flat domains carrying grants, hierarchical teams, grants (who · use/edit/admin · agent-or-domain), connections with roles (Interface/Automation/Tools), MCP servers, models with access lists, API keys with scopes, eval criteria (live, per-session) and suites (offline test cases), audit events. Natural casing for display, slugs internal — everywhere.

## Non-negotiables (from PRODUCT_CONTEXT.md §4 — do not rename or restructure)

Domains are flat, optional, and carry grants; there is no per-agent "owner". "Connections" not "Integrations". Service-vs-user auth is surfaced at every level. Audit log ≠ session log. Connections ≠ MCP servers.

## Files in this bundle

| File | What it is |
|---|---|
| `README.md` | This file — start here |
| `PRODUCT_CONTEXT.md` | Product thesis, full IA, locked decisions, planned work — **required reading** |
| `Agent Platform - App.dc.html` + `support.js` | The interactive hi-fi prototype (the spec) |
| `Journey Map - J1 First Agent.dc.html` | Journey analysis + planned "Builder" feature (context; not in scope unless asked) |
| `Bullseye Customer - Research Doc.dc.html` | Target customer definition (context) |
| `Competitor Landscape - Research Doc.dc.html` | Market analysis (context) |
| `doc-page.js` | Rendering support for the three docs above — not part of the product |

## Suggested implementation order

1. App shell: icon rail + sidebar + main layout, dark theme tokens.
2. Sessions: landing + one session thread with tool calls, approval card, right drawer.
3. Agents: directory (sort/search/filter/star) + config tabs (read-only first).
4. Teams, Domains, and real grant editing (the biggest gap between prototype and product).
5. Admin surfaces (Connections, MCP, Models, API keys, Audit, Settings), Stats, Profile.

Ask the project owner before deviating from the prototype or inventing flows it doesn't show.
