/**
 * The grants engine. Access is expressed as explicit, scoped, revocable
 * grants (who . right: use/edit/admin . agent or domain). Rules:
 *
 * - Org owners and admins hold admin on everything.
 * - An agent's creator holds admin on it (drafts run only for their maker).
 * - A grant to a team covers the team's members AND all descendant teams'
 *   members (grants cascade down the hierarchy).
 * - A grant on a domain applies to every agent in that domain.
 * - Rights are ordered: use < edit < admin; the effective right is the max.
 */
import { inArray, eq, and } from "drizzle-orm";
import { RIGHT_ORDER, type AccessRight } from "@rabblehq/core";
import { db } from "./db/client.js";
import { agents, grants, teamMembers, teams } from "./db/schema.js";
import type { AuthedUser } from "./auth.js";

function maxRight(a: AccessRight | null, b: AccessRight): AccessRight {
  if (!a) return b;
  return RIGHT_ORDER[b] > RIGHT_ORDER[a] ? b : a;
}

/**
 * All subject ids that can carry a grant reaching this user: the user id
 * plus every team they belong to and each of those teams' ancestors.
 */
export async function grantSubjectsFor(userId: string, orgId: string): Promise<{
  userIds: string[];
  teamIds: string[];
}> {
  const memberships = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));
  const direct = memberships.map((m) => m.teamId);
  if (direct.length === 0) return { userIds: [userId], teamIds: [] };

  const allTeams = await db
    .select({ id: teams.id, parentTeamId: teams.parentTeamId })
    .from(teams)
    .where(eq(teams.orgId, orgId));
  const parentOf = new Map(allTeams.map((t) => [t.id, t.parentTeamId]));

  const covered = new Set<string>();
  for (const teamId of direct) {
    let cursor: string | null | undefined = teamId;
    while (cursor && !covered.has(cursor)) {
      covered.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
  return { userIds: [userId], teamIds: [...covered] };
}

/** Effective right for every agent in the org the user can see, in bulk. */
export async function rightsForAllAgents(
  user: AuthedUser,
): Promise<Map<string, AccessRight>> {
  const rows = await db
    .select({ id: agents.id, domainId: agents.domainId, createdBy: agents.createdBy })
    .from(agents)
    .where(eq(agents.orgId, user.orgId));
  const result = new Map<string, AccessRight>();

  if (user.role === "owner" || user.role === "admin") {
    for (const row of rows) result.set(row.id, "admin");
    return result;
  }

  for (const row of rows) {
    if (row.createdBy === user.id) result.set(row.id, "admin");
  }

  const { userIds, teamIds } = await grantSubjectsFor(user.id, user.orgId);
  const subjectFilters = [];
  if (userIds.length > 0) {
    subjectFilters.push(
      and(eq(grants.subjectType, "user"), inArray(grants.subjectId, userIds)),
    );
  }
  if (teamIds.length > 0) {
    subjectFilters.push(
      and(eq(grants.subjectType, "team"), inArray(grants.subjectId, teamIds)),
    );
  }

  const applicable = [];
  for (const filter of subjectFilters) {
    const found = await db
      .select()
      .from(grants)
      .where(and(eq(grants.orgId, user.orgId), filter));
    applicable.push(...found);
  }

  const byDomain = new Map<string, AccessRight>();
  for (const grant of applicable) {
    if (grant.targetType === "agent") {
      result.set(
        grant.targetId,
        maxRight(result.get(grant.targetId) ?? null, grant.accessRight),
      );
    } else {
      byDomain.set(
        grant.targetId,
        maxRight(byDomain.get(grant.targetId) ?? null, grant.accessRight),
      );
    }
  }
  for (const row of rows) {
    if (row.domainId && byDomain.has(row.domainId)) {
      result.set(
        row.id,
        maxRight(result.get(row.id) ?? null, byDomain.get(row.domainId)!),
      );
    }
  }
  return result;
}

export async function rightForAgent(
  user: AuthedUser,
  agentId: string,
): Promise<AccessRight | null> {
  const all = await rightsForAllAgents(user);
  return all.get(agentId) ?? null;
}

export function hasRight(
  actual: AccessRight | null,
  required: AccessRight,
): boolean {
  return actual !== null && RIGHT_ORDER[actual] >= RIGHT_ORDER[required];
}
