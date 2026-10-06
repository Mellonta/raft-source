import type { Response } from "express";
import { ChannelConversionInProgressError } from "../services/channelConversionFenceService";
import { DmTargetResolutionError } from "../services/dmTargetResolutionError";
import { TaskMutationConflictError } from "../services/taskService";

/** Preserve the same typed write-admission result on Web and Agent task routes. */
export function respondToTaskWriteError(error: unknown, res: Response): boolean {
  if (error instanceof ChannelConversionInProgressError) {
    res.status(error.status).json({ error: error.message, code: error.code, conversionEpoch: error.conversionEpoch });
    return true;
  }
  // A task target like dm:@Twin that names both a human and an agent.
  if (error instanceof DmTargetResolutionError) {
    res.status(error.status).json(error.toResponseBody());
    return true;
  }
  if (error instanceof TaskMutationConflictError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}
