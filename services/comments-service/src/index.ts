import express, {
  ErrorRequestHandler,
  Request,
  Response,
} from "express";
import cors from "cors";
import { connectDB } from "./db";
import commentsRouter from "./routes/comments";

const PORT = Number(process.env.PORT || 3001);

async function start(): Promise<void> {
  await connectDB();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.use("/v1/posts", commentsRouter);

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);

  app.listen(PORT, () => {
    console.log(`Comments service listening on port ${PORT}`);
  });
}

start().catch((err: unknown) => {
  console.error("Failed to start comments service", err);
  process.exit(1);
});
