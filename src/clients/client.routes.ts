
import { Router } from "express";
import { requireAdmin } from "../auth/admin.middleware.js";
import { registerClient } from "./client.service.js";

const router = Router();

router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const { name } = req.body;

    if (typeof name !== "string") {
      res.status(400).json({
        error: "Client name is required",
      });
      return;
    }

    const result = await registerClient(name);

    res.status(201).json({
      message: "Client registered successfully",
      client: result.client,
      apiKey: result.apiKey,
    });
  } catch (error) {
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
      return;
    }

    next(error);
  }
});

export default router;
