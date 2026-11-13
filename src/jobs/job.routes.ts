
import { Router } from "express";
import { getJob } from "./job.service.js";
import {
  cancelJob,
  requestJobCancellation,
} from "./job.service.js";

import {
  requireClient,
  type AuthenticatedRequest,
} from "../auth/client.middleware.js";

import { submitJob } from "./job.service.js";

const router = Router();

router.post(
  "/",
  requireClient,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { type, payload, idempotencyKey } = req.body ?? {};

      if (
        typeof type !== "string" ||
        typeof idempotencyKey !== "string" ||
        payload === undefined
      ) {
        res.status(400).json({
          error: "type, payload and idempotencyKey are required",
        });
        return;
      }

      const result = await submitJob({
        clientId: req.clientId!,
        type,
        payload,
        idempotencyKey,
      });

      res.status(result.created ? 201 : 200).json({
        message: result.created
          ? "Job submitted successfully"
          : "Existing job returned",
        job: result.job,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Idempotency key already used")
      ) {
        res.status(409).json({ error: error.message });
        return;
      }

      next(error);
    }
  }
);


router.get(
  "/:id",
  requireClient,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const jobId = req.params.id;

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (
  typeof jobId !== "string" ||
  !uuidRegex.test(jobId)
) {
  res.status(400).json({
    error: "Invalid job ID format",
  });
  return;
}

const job = await getJob(
  jobId,
  req.clientId!
);

      if (!job) {
        res.status(404).json({
          error: "Job not found",
        });
        return;
      }

      res.status(200).json({ job });
    } catch (error) {
      next(error);
    }
  }
);



router.delete(
  "/:id",
  requireClient,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const jobId = req.params.id;

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      if (typeof jobId !== "string" || !uuidRegex.test(jobId)) {
        res.status(400).json({ error: "Invalid job ID format" });
        return;
      }

      const result = await cancelJob(jobId, req.clientId!);

      if (!result.job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      // Pending job cancelled immediately
      if (result.cancelled) {
        res.status(200).json({
          message: "Job cancelled successfully",
          job: result.job,
        });
        return;
      }

      // Running job: request cooperative cancellation
      if (result.job.status === "running") {
        const cancellation = await requestJobCancellation(
          jobId,
          req.clientId!
        );

        if (cancellation) {
          res.status(202).json({
            message: "Job cancellation requested",
            job: cancellation,
          });
          return;
        }

        res.status(409).json({
          error: "Job state changed before cancellation could be requested",
        });
        return;
      }

      res.status(409).json({
        error: `Job cannot be cancelled. Current status: ${result.job.status}`,
      });
    } catch (error) {
      next(error);
    }
  }
);




export default router;
