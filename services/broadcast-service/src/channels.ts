import { Response } from "express";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export function commentChannel(postId: string): string {
  return `post:${postId}:comments`;
}

type PostHub = {
  clients: Set<Response>;
  /** Resolves once Redis SUBSCRIBE for this channel has finished. */
  ready: Promise<void>;
};

const hubs = new Map<string, PostHub>();

let subscriber: Redis | null = null;

function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    subscriber.on("error", (err) => {
      console.error("Redis subscriber error", err);
    });
    subscriber.on("message", (channel, message) => {
      const hub = hubs.get(channel);
      if (!hub) return;
      for (const res of hub.clients) {
        res.write(`data: ${message}\n\n`);
      }
    });
  }
  return subscriber;
}

export async function addClient(postId: string, res: Response): Promise<void> {
  const channel = commentChannel(postId);
  let hub = hubs.get(channel);

  if (!hub) {
    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    hub = { clients: new Set(), ready };
    // Register client before await so a concurrent close cannot
    // unsubscribe while SUBSCRIBE is still in flight with an empty set.
    hub.clients.add(res);
    hubs.set(channel, hub);

    getSubscriber()
      .subscribe(channel)
      .then(() => resolveReady())
      .catch((err) => {
        // Roll back if subscribe failed and this hub is still current.
        if (hubs.get(channel) === hub) {
          hubs.delete(channel);
        }
        rejectReady(err);
      });
  } else {
    hub.clients.add(res);
  }

  await hub.ready;
}

export async function removeClient(
  postId: string,
  res: Response
): Promise<void> {
  const channel = commentChannel(postId);
  const hub = hubs.get(channel);
  if (!hub) return;

  hub.clients.delete(res);
  if (hub.clients.size > 0) return;

  hubs.delete(channel);

  // Wait for any in-flight SUBSCRIBE before UNSUBSCRIBE.
  try {
    await hub.ready;
  } catch {
    // Subscribe failed; nothing to unsubscribe.
    return;
  }

  // A new hub may have been created while we awaited.
  if (hubs.has(channel)) return;

  try {
    await getSubscriber().unsubscribe(channel);
  } catch (err) {
    console.error("Failed to unsubscribe", channel, err);
  }
}
