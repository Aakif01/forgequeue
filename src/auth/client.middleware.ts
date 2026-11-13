
import type {
  Request,
  Response,
  NextFunction,
} from "express";

import { createHash } from "node:crypto";
import { pool } from "../config/database.js";

export interface AuthenticatedRequest extends Request {
  clientId?: string;
}

export async function requireClient(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      res.status(401).json({
        error: "Missing API key",
      });
      return;
    }

    const apiKey = authorization.slice(7);

    if (!apiKey.startsWith("fq_live_")) {
      res.status(401).json({
        error: "Invalid API key",
      });
      return;
    }

    const apiKeyHash = createHash("sha256")
      .update(apiKey)
      .digest("hex");

    const result = await pool.query<{ id: string }>(
      `SELECT id
       FROM clients
       WHERE api_key_hash = $1
       AND is_active = TRUE`,
      [apiKeyHash]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        error: "Invalid or inactive API key",
      });
      return;
    }

    req.clientId = result.rows[0].id;

    next();
  } catch (error) {
    next(error);
  }
}
