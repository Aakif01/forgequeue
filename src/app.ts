import express from "express";
import { pool } from "./config/database.js";
import clientRoutes from "./clients/client.routes.js";
import jobRoutes from "./jobs/job.routes.js";

export const app = express();

app.use(express.json({ limit: "1mb" }));

app.use("/jobs", jobRoutes);
app.use("/admin/clients", clientRoutes);

app.get("/health/live", (_req, res) => {
  res.status(200).json({
    status: "alive",
    service: "forgequeue",
  });
});

app.get("/health/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.status(200).json({
      status: "ready",
      database: "connected",
    });
  } catch {
    res.status(503).json({
      status: "not_ready",
      database: "unavailable",
    });
  }
});
