import { Router, Request, Response } from "express";
import { FilterQuery } from "mongoose";
import { Comment, CommentDoc } from "../models/Comment";
import { publishComment } from "../redis";
import {
  createCommentSchema,
  listCommentsQuerySchema,
} from "../schemas/comment";

const router = Router();

router.post(
  "/:postId/comments",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = createCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }

    const { postId } = req.params;
    const { userId, content } = parsed.data;

    const comment = await Comment.create({
      postId,
      userId,
      content,
    });

    const body = comment.toJSON();
    try {
      await publishComment(postId, body);
    } catch (err) {
      console.error("Failed to publish comment to Redis", err);
    }

    res.status(201).json(body);
  }
);

router.get(
  "/:postId/comments",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = listCommentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }

    const { postId } = req.params;
    const { cursor, since, limit } = parsed.data;

    // Live polling: fetch comments newer than `since`
    if (since) {
      const items = await Comment.find({
        postId,
        createdAt: { $gt: new Date(since) },
      })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();

      res.json({
        items: items.map(serialize),
        next_cursor: null,
      });
      return;
    }

    // History / infinite scroll: fetch older comments before `cursor`
    const filter: FilterQuery<CommentDoc> = { postId };
    if (cursor) {
      filter.createdAt = { $lt: new Date(cursor) };
    }

    const docs = await Comment.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const page = docs.slice(0, limit);
    const nextCursor =
      hasMore && page.length > 0
        ? new Date(page[page.length - 1].createdAt).toISOString()
        : null;

    res.json({
      items: page.map(serialize),
      next_cursor: nextCursor,
    });
  }
);

function serialize(doc: {
  _id: { toString(): string };
  postId: string;
  userId: string;
  content: string;
  createdAt: Date;
}) {
  return {
    id: doc._id.toString(),
    postId: doc.postId,
    userId: doc.userId,
    content: doc.content,
    createdAt: doc.createdAt,
  };
}

export default router;
