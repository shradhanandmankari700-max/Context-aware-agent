// Owner: P6. Everyone adds their router in routes/ and P6 mounts it here. Keep this file tiny.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { AppMetadata } from "@cab/contracts";

import { uiRouter } from "./routes/ui";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:5173" }));
app.use(express.json({ limit: "5mb" }));
app.use(uiRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, contractsLoaded: typeof AppMetadata.parse === "function", demoNow: process.env.DEMO_NOW });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`backend on :${port}`));
