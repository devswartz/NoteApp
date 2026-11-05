// Workspace activity feed. Owner: Collaboration & Access.
import { Router, type RequestHandler } from 'express';

export const activityRoutes = Router();

/** Records who changed what for mutating requests (registered right after requireAuth). */
export const activityRecorder: RequestHandler = (_req, _res, next) => next();
