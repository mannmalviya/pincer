// POST /comments/:id/draft-reply
//
// Loads the comment + the parent post from SQLite, hands them to Nemotron
// Super via NIM, and returns a short, on-platform reply draft. The route
// is read-only on our side (no DB writes) — the dashboard decides whether
// to copy the draft into a real platform reply or discard it.
//
// Why post body for context: most launch posts ask a specific question or
// describe a specific feature. A reply that ignores the post and just
// reacts to the comment ends up generic ("Great question!"). Passing the
// post body keeps the draft grounded in the actual launch.

import type { FastifyInstance } from "fastify";

import { NIM_REPLY_MODEL } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../lib/log.js";
import { chatComplete, NimError, nimConfigured } from "../lib/nim.js";
import { projectContextForPrompt } from "../lib/project-context.js";

type CommentJoinRow = {
  comment_body: string | null;
  comment_author: string | null;
  comment_score: number | null;
  post_title: string | null;
  post_body: string | null;
  post_permalink: string;
  platform: "reddit" | "hn" | "bluesky";
};

export function registerReplyRoute(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    "/comments/:id/draft-reply",
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({
          error: { code: "bad_id", message: "comment id must be positive" },
        });
      }

      if (!nimConfigured()) {
        return reply.code(503).send({
          error: {
            code: "nim_not_configured",
            message:
              "Set NIM_API_KEY on the agent to enable reply drafting.",
          },
        });
      }

      const db = getDb();
      const row = db
        .prepare(
          `SELECT c.body       AS comment_body,
                  c.author     AS comment_author,
                  c.score      AS comment_score,
                  p.title      AS post_title,
                  p.body       AS post_body,
                  p.permalink  AS post_permalink,
                  p.platform   AS platform
             FROM comments c
             JOIN posts p ON p.id = c.post_id
            WHERE c.id = ?`,
        )
        .get(id) as CommentJoinRow | undefined;

      if (row === undefined) {
        return reply.code(404).send({
          error: { code: "not_found", message: `no comment with id ${id}` },
        });
      }

      const platformName =
        row.platform === "reddit"
          ? "Reddit"
          : row.platform === "hn"
            ? "Hacker News"
            : "Bluesky";
      const system = [
        `You are drafting a reply on ${platformName} on behalf of the original poster of a product launch.`,
        "Write in a conversational, first-person voice. No marketing fluff, no exclamation marks, no emojis.",
        "Keep it short: two to four sentences unless the question explicitly needs more detail.",
        "If the comment is hostile or low-effort, respond briefly and without escalating.",
        "Never invent facts about the product beyond what the launch post itself says.",
      ].join(" ");

      const ctxBlock = projectContextForPrompt();
      const userSections: string[] = [];
      if (ctxBlock) userSections.push(ctxBlock, "");
      userSections.push(
        "--- Launch post ---",
        `Title: ${row.post_title ?? "(no title)"}`,
        `Body: ${row.post_body ?? "(no body)"}`,
        "",
        "--- Comment to reply to ---",
        `Author: ${row.comment_author ?? "anonymous"}`,
        `Body: ${row.comment_body ?? "(empty)"}`,
        "",
        "Draft the reply now. Return only the reply text, no preamble.",
      );
      const user = userSections.join("\n");

      try {
        const text = await chatComplete({
          model: NIM_REPLY_MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.45,
          max_tokens: 400,
        });
        log.info("reply drafted", {
          commentId: id,
          platform: row.platform,
          chars: text.length,
          model: NIM_REPLY_MODEL,
        });
        return { draft: text, model: NIM_REPLY_MODEL };
      } catch (err) {
        if (err instanceof NimError) {
          log.error("reply drafting failed", {
            commentId: id,
            code: err.code,
            status: err.status,
            message: err.message,
          });
          const status = err.code === "http_error" ? 502 : 500;
          return reply.code(status).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );
}
