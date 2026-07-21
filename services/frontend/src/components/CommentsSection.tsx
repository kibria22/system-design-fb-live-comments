"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createComment, listComments } from "@/lib/api";
import type { Comment } from "@/lib/types";

const PAGE_SIZE = 20;

type Props = {
  postId: string;
  userId: string;
};

function mergeComments(prev: Comment[], incoming: Comment[]): Comment[] {
  if (incoming.length === 0) return prev;
  const existing = new Set(prev.map((c) => c.id));
  const fresh = incoming.filter((c) => !existing.has(c.id));
  if (fresh.length === 0) return prev;
  // incoming from `since=` is oldest→newest; UI is newest-first
  return [...fresh.reverse(), ...prev];
}

export default function CommentsSection({ postId, userId }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const newestRef = useRef<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const rememberNewest = useCallback((items: Comment[]) => {
    if (items.length === 0) return;
    const latest = items.reduce((a, b) =>
      new Date(a.createdAt).getTime() >= new Date(b.createdAt).getTime() ? a : b
    );
    const iso = new Date(latest.createdAt).toISOString();
    if (
      !newestRef.current ||
      new Date(iso).getTime() > new Date(newestRef.current).getTime()
    ) {
      newestRef.current = iso;
    }
  }, []);

  const catchUpSince = useCallback(async () => {
    if (!newestRef.current) return;
    try {
      const data = await listComments(postId, {
        since: newestRef.current,
        limit: PAGE_SIZE,
      });
      if (data.items.length === 0) return;
      setComments((prev) => mergeComments(prev, data.items));
      rememberNewest(data.items);
    } catch {
      // Best-effort gap fill after SSE reconnect
    }
  }, [postId, rememberNewest]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listComments(postId, { limit: PAGE_SIZE });
      setComments(data.items);
      setNextCursor(data.next_cursor);
      newestRef.current =
        data.items.length > 0
          ? new Date(data.items[0].createdAt).toISOString()
          : new Date().toISOString();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load comments");
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  // Keep latest catch-up fn in a ref so the EventSource effect does not
  // re-create the connection when callback identities change.
  const catchUpSinceRef = useRef(catchUpSince);
  catchUpSinceRef.current = catchUpSince;
  const rememberNewestRef = useRef(rememberNewest);
  rememberNewestRef.current = rememberNewest;

  // One EventSource per mounted section (after history load).
  // `since=` catch-up runs only on *reconnect*, not the first open.
  useEffect(() => {
    if (loading) return;

    const url = `/v1/posts/${encodeURIComponent(postId)}/comments/stream`;
    const source = new EventSource(url);
    sourceRef.current = source;
    let sawOpen = false;

    source.onopen = () => {
      if (!sawOpen) {
        sawOpen = true;
        return;
      }
      // Reconnect after a drop — fill any Redis pub/sub gap.
      void catchUpSinceRef.current();
    };

    source.onmessage = (event) => {
      try {
        const comment = JSON.parse(event.data) as Comment;
        if (!comment?.id) return;
        setComments((prev) => {
          if (prev.some((c) => c.id === comment.id)) return prev;
          return [comment, ...prev];
        });
        rememberNewestRef.current([comment]);
      } catch {
        // Ignore malformed SSE payloads
      }
    };

    return () => {
      source.onopen = null;
      source.onmessage = null;
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    };
  }, [postId, loading]);

  async function loadOlder() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await listComments(postId, {
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      setComments((prev) => [...prev, ...data.items]);
      setNextCursor(data.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load older comments");
    } finally {
      setLoadingMore(false);
    }
  }

  function onScroll() {
    const el = listRef.current;
    if (!el || !nextCursor) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    if (nearBottom) {
      void loadOlder();
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;

    const content = text.trim();
    setText("");
    try {
      const created = await createComment(postId, userId, content);
      setComments((prev) => {
        if (prev.some((c) => c.id === created.id)) return prev;
        return [created, ...prev];
      });
      rememberNewest([created]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post comment");
      setText(content);
    }
  }

  return (
    <div className="comments">
      <form className="comment-form" onSubmit={handleSubmit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a live comment…"
          maxLength={2000}
        />
        <button type="submit" className="btn primary" disabled={!text.trim()}>
          Send
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading comments…</p>
      ) : (
        <div className="comment-list" ref={listRef} onScroll={onScroll}>
          {comments.length === 0 && (
            <p className="muted">No comments yet. Be the first.</p>
          )}
          {comments.map((comment) => (
            <div key={comment.id} className="comment-item">
              <div className="comment-meta">
                <span className="comment-user">
                  {comment.userId === userId
                    ? "You"
                    : `User ${comment.userId.slice(0, 8)}`}
                </span>
                <time dateTime={comment.createdAt}>
                  {new Date(comment.createdAt).toLocaleTimeString()}
                </time>
              </div>
              <p>{comment.content}</p>
            </div>
          ))}
          {loadingMore && <p className="muted">Loading older…</p>}
          {!nextCursor && comments.length > 0 && (
            <p className="muted">End of history</p>
          )}
        </div>
      )}
    </div>
  );
}
