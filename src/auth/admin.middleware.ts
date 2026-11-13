
import type {
  Request,
  Response,
  NextFunction,
} from "express";

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    res.status(500).json({
      error: "Admin authentication is not configured",
    });
    return;
  }

  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Missing admin credentials",
    });
    return;
  }

  const providedSecret = authorization.slice(7);

  if (providedSecret !== adminSecret) {
    res.status(403).json({
      error: "Invalid admin credentials",
    });
    return;
  }

  next();
}
