import { z } from "zod";

const isoDateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Invalid ISO timestamp",
  });

export const createCommentSchema = z.object({
  userId: z.string().uuid(),
  content: z.string().trim().min(1).max(2000),
});

export const listCommentsQuerySchema = z.object({
  cursor: isoDateString.optional(),
  since: isoDateString.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;
