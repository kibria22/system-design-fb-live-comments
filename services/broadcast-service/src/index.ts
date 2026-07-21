import express, {
  ErrorRequestHandler,
  Request,
  Response,
} from "express";
import cors from "cors";
import { addClient, removeClient } from "./channels";

const PORT = Number(process.env.PORT || 3002);
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15000);

const app = express();
app.use(cors());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get(
  "/v1/posts/:postId/comments/stream",
  async (req: Request, res: Response): Promise<void> => {
    const { postId } = req.params;
    if (!postId) {
      res.status(400).json({ error: "postId is required" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    res.write(": connected\n\n");

    try {
      await addClient(postId, res);
    } catch (err) {
      console.error("Failed to subscribe for SSE", err);
      res.status(500).end();
      return;
    }

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      void removeClient(postId, res);
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  }
);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
};
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Broadcast service listening on port ${PORT}`);
});
