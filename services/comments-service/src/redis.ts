import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export function commentChannel(postId: string): string {
  return `post:${postId}:comments`;
}

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    client.on("error", (err) => {
      console.error("Redis error", err);
    });
  }
  return client;
}

export async function publishComment(
  postId: string,
  payload: unknown
): Promise<void> {
  const channel = commentChannel(postId);
  await getRedis().publish(channel, JSON.stringify(payload));
}
