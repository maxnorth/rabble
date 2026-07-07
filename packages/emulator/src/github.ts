/**
 * GitHub API fake — the slice used by GitHub surface delivery: posting
 * issue comments and replying into PR review-comment threads. Identity
 * arrives in the webhook payload itself, so no directory is needed here.
 */
import type { FastifyInstance } from "fastify";
import { logRequest } from "./state.js";

export function mountGithub(app: FastifyInstance): void {
  app.post(
    "/mock/api.github.com/repos/:owner/:repo/issues/:number/comments",
    async (req) => {
      const { owner, repo, number } = req.params as {
        owner: string;
        repo: string;
        number: string;
      };
      logRequest(
        "api.github.com",
        "POST",
        `/repos/${owner}/${repo}/issues/${number}/comments`,
        req.body ?? null,
      );
      return {
        id: Math.floor(Math.random() * 1_000_000),
        body: (req.body as { body?: string })?.body ?? "",
        html_url: `https://github.acme/${owner}/${repo}/issues/${number}#comment`,
      };
    },
  );

  // Reply into a PR review-comment thread.
  app.post(
    "/mock/api.github.com/repos/:owner/:repo/pulls/:number/comments/:commentId/replies",
    async (req) => {
      const { owner, repo, number, commentId } = req.params as {
        owner: string;
        repo: string;
        number: string;
        commentId: string;
      };
      logRequest(
        "api.github.com",
        "POST",
        `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
        req.body ?? null,
      );
      return {
        id: Math.floor(Math.random() * 1_000_000),
        in_reply_to_id: Number(commentId),
        body: (req.body as { body?: string })?.body ?? "",
        html_url: `https://github.acme/${owner}/${repo}/pull/${number}#discussion`,
      };
    },
  );
}
