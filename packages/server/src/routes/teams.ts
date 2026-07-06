import type { FastifyInstance } from "fastify";
import { createTeamSchema, slugify } from "@rabble/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents, domains, grants, teamMembers, teams, users } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { recordAudit } from "../audit.js";

function serializeTeam(
  row: typeof teams.$inferSelect,
  memberCount: number,
) {
  return {
    id: row.id,
    orgId: row.orgId,
    parentTeamId: row.parentTeamId,
    slug: row.slug,
    name: row.name,
    isEveryone: row.isEveryone,
    memberCount,
    createdAt: row.createdAt.toISOString(),
  };
}

async function memberCounts(orgId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ teamId: teamMembers.teamId, count: sql<number>`count(*)::int` })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teams.orgId, orgId))
    .groupBy(teamMembers.teamId);
  return new Map(rows.map((r) => [r.teamId, r.count]));
}

export async function teamRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/teams", async (req) => {
    const rows = await db
      .select()
      .from(teams)
      .where(eq(teams.orgId, req.user!.orgId))
      .orderBy(teams.name);
    const counts = await memberCounts(req.user!.orgId);
    return { teams: rows.map((t) => serializeTeam(t, counts.get(t.id) ?? 0)) };
  });

  app.post("/api/teams", async (req, reply) => {
    const body = createTeamSchema.parse(req.body);
    const slug = slugify(body.name) || "team";
    const [existing] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, req.user!.orgId), eq(teams.slug, slug)))
      .limit(1);
    if (existing) {
      return reply.code(409).send({ error: "A team with that name already exists" });
    }
    const [row] = await db
      .insert(teams)
      .values({
        orgId: req.user!.orgId,
        parentTeamId: body.parentTeamId ?? null,
        slug,
        name: body.name,
      })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "team.create",
      targetType: "team",
      targetId: row!.id,
      summary: `Created team "${body.name}"`,
    });
    return { team: serializeTeam(row!, 0) };
  });

  app.get("/api/teams/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.orgId, req.user!.orgId)))
      .limit(1);
    if (!team) return reply.code(404).send({ error: "Team not found" });

    const members = await db
      .select({ userId: users.id, name: users.name, email: users.email, role: users.role })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(eq(teamMembers.teamId, id))
      .orderBy(users.name);

    const subTeams = await db
      .select()
      .from(teams)
      .where(eq(teams.parentTeamId, id))
      .orderBy(teams.name);
    const counts = await memberCounts(req.user!.orgId);

    // Agent access this team holds: direct agent grants + domain grants
    const held = await db
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.orgId, req.user!.orgId),
          eq(grants.subjectType, "team"),
          eq(grants.subjectId, id),
        ),
      );
    const agentIds = held.filter((g) => g.targetType === "agent").map((g) => g.targetId);
    const domainIds = held.filter((g) => g.targetType === "domain").map((g) => g.targetId);
    const agentRows = agentIds.length
      ? await db.select().from(agents).where(inArray(agents.id, agentIds))
      : [];
    const domainRows = domainIds.length
      ? await db.select().from(domains).where(inArray(domains.id, domainIds))
      : [];
    const agentName = new Map(agentRows.map((a) => [a.id, a.name]));
    const domainName = new Map(domainRows.map((d) => [d.id, d.name]));

    return {
      team: serializeTeam(team, counts.get(id) ?? 0),
      members,
      subTeams: subTeams.map((t) => serializeTeam(t, counts.get(t.id) ?? 0)),
      access: held.map((g) => ({
        id: g.id,
        accessRight: g.accessRight,
        targetType: g.targetType,
        targetId: g.targetId,
        targetName:
          g.targetType === "agent"
            ? (agentName.get(g.targetId) ?? "(deleted)")
            : (domainName.get(g.targetId) ?? "(deleted)"),
      })),
    };
  });

  app.post("/api/teams/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = req.body as { userId: string };
    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.orgId, req.user!.orgId)))
      .limit(1);
    if (!team) return reply.code(404).send({ error: "Team not found" });
    if (team.isEveryone) {
      return reply.code(400).send({ error: "Everyone membership is automatic" });
    }
    const [member] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, req.user!.orgId)))
      .limit(1);
    if (!member) return reply.code(404).send({ error: "User not found" });

    await db
      .insert(teamMembers)
      .values({ teamId: id, userId })
      .onConflictDoNothing();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "team.member.add",
      targetType: "team",
      targetId: id,
      summary: `Added ${member.name} to team "${team.name}"`,
    });
    return { ok: true };
  });

  app.delete("/api/teams/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.orgId, req.user!.orgId)))
      .limit(1);
    if (!team) return reply.code(404).send({ error: "Team not found" });
    if (team.isEveryone) {
      return reply.code(400).send({ error: "Everyone membership is automatic" });
    }
    await db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId)));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "team.member.remove",
      targetType: "team",
      targetId: id,
      summary: `Removed a member from team "${team.name}"`,
    });
    return { ok: true };
  });

  app.delete("/api/teams/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.orgId, req.user!.orgId)))
      .limit(1);
    if (!team) return reply.code(404).send({ error: "Team not found" });
    if (team.isEveryone) {
      return reply.code(400).send({ error: "The Everyone team can't be deleted" });
    }
    await db.delete(grants).where(
      and(
        eq(grants.orgId, req.user!.orgId),
        eq(grants.subjectType, "team"),
        eq(grants.subjectId, id),
      ),
    );
    await db.delete(teams).where(eq(teams.id, id));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "team.delete",
      targetType: "team",
      targetId: id,
      summary: `Deleted team "${team.name}"`,
    });
    return { ok: true };
  });

  // Org members (for pickers and Settings)
  app.get("/api/users", async (req) => {
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.orgId, req.user!.orgId))
      .orderBy(users.name);
    return { users: rows };
  });
}
