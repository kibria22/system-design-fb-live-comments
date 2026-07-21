"use client";

import { useCallback, useEffect, useState } from "react";
import { createPost, createUser, listPosts } from "@/lib/api";
import { getOrCreateLocalUser, type LocalUser } from "@/lib/user";
import type { Post } from "@/lib/types";
import CommentsSection from "./CommentsSection";
import CreatePostModal from "./CreatePostModal";

export default function HomePage() {
  const [user, setUser] = useState<LocalUser | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const local = getOrCreateLocalUser();
    setUser(local);

    createUser(local.id, local.name).catch((err) => {
      console.error("Failed to create user", err);
      setError("Could not register session user with Post Service");
    });
  }, []);

  const refreshPosts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listPosts(null, 10);
      setPosts(data.items);
      setNextCursor(data.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load posts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshPosts();
  }, [refreshPosts]);

  async function handleCreatePost(content: string) {
    if (!user) throw new Error("User not ready");
    const post = await createPost(user.id, content);
    setPosts((prev) => [post, ...prev]);
  }

  async function loadMorePosts() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await listPosts(nextCursor, 10);
      setPosts((prev) => [...prev, ...data.items]);
      setNextCursor(data.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more posts");
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleComments(postId: string) {
    setExpandedPostId((current) => (current === postId ? null : postId));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">FB Live Comments</p>
          <h1>Live posts</h1>
        </div>
        <div className="topbar-actions">
          {user && (
            <span className="user-chip" title={user.id}>
              You: {user.name}
            </span>
          )}
          <button
            type="button"
            className="btn primary"
            onClick={() => setModalOpen(true)}
            disabled={!user}
          >
            Create Post
          </button>
        </div>
      </header>

      <main className="content">
        {error && <p className="error banner">{error}</p>}
        {loading && <p className="muted">Loading posts…</p>}

        {!loading && posts.length === 0 && (
          <div className="empty">
            <h2>No live posts yet</h2>
            <p>Create the first stream and start collecting comments.</p>
          </div>
        )}

        <ul className="post-list">
          {posts.map((post) => {
            const open = expandedPostId === post.id;
            return (
              <li key={post.id} className="post-item">
                <div className="post-body">
                  <div className="post-meta">
                    <strong>{post.user_name || post.user_id.slice(0, 8)}</strong>
                    <time dateTime={post.created_at}>
                      {new Date(post.created_at).toLocaleString()}
                    </time>
                  </div>
                  <p className="post-content">{post.content}</p>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => toggleComments(post.id)}
                  >
                    {open ? "Hide Comments" : "Comments"}
                  </button>
                </div>
                {open && user && (
                  <CommentsSection postId={post.id} userId={user.id} />
                )}
              </li>
            );
          })}
        </ul>

        {nextCursor && (
          <div className="load-more">
            <button
              type="button"
              className="btn ghost"
              onClick={() => void loadMorePosts()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more posts"}
            </button>
          </div>
        )}
      </main>

      <CreatePostModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={handleCreatePost}
      />
    </div>
  );
}
