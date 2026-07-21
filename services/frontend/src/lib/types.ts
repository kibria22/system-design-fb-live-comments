export type User = {
  id: string;
  name: string;
  created_at: string;
};

export type Post = {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
  updated_at: string;
  user_name?: string | null;
};

export type Comment = {
  id: string;
  postId: string;
  userId: string;
  content: string;
  createdAt: string;
};

export type PaginatedPosts = {
  items: Post[];
  next_cursor: string | null;
};

export type PaginatedComments = {
  items: Comment[];
  next_cursor: string | null;
};
