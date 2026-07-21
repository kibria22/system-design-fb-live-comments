import type {
  Comment,
  PaginatedComments,
  PaginatedPosts,
  Post,
  User,
} from "./types";

/**
 * Browser calls same-origin /v1/* (via Gateway API when served through the gateway).
 * Override with NEXT_PUBLIC_API_BASE_URL only if you want a different API origin.
 */
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Request failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export function createUser(id: string, name: string) {
  return request<User>("/v1/users", {
    method: "POST",
    body: JSON.stringify({ id, name }),
  });
}

export function listPosts(cursor?: string | null, limit = 10) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return request<PaginatedPosts>(`/v1/posts?${params.toString()}`);
}

export function createPost(userId: string, content: string) {
  return request<Post>("/v1/posts", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, content }),
  });
}

export function listComments(
  postId: string,
  options?: { cursor?: string | null; since?: string | null; limit?: number }
) {
  const params = new URLSearchParams({
    limit: String(options?.limit ?? 20),
  });
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.since) params.set("since", options.since);
  return request<PaginatedComments>(
    `/v1/posts/${postId}/comments?${params.toString()}`
  );
}

export function createComment(postId: string, userId: string, content: string) {
  return request<Comment>(`/v1/posts/${postId}/comments`, {
    method: "POST",
    body: JSON.stringify({ userId, content }),
  });
}
