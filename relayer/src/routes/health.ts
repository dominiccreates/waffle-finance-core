/**
 * /health HTTP endpoint for the relayer.
 *
 * Returns a JSON body with overall service status, uptime, and per-service
 * health details suitable for use by container orchestrators and external
 * monitors.  No secrets or sensitive data are included.
 *
 * HTTP status codes:
 *   200 — healthy or degraded (service is running, some components may be impaired)
 *   503 — unhealthy (service cannot fulfil requests) or health check itself failed
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMonitor } from '../services/monitoring.js';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  uptime: number;
  version: string;
  services: Array<{ name: string; status: string; lastCheck: number }>;
}

export function healthRouter(): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    try {
      const monitor = getMonitor();
      const metrics = monitor.getMetrics();
      const status = monitor.getSystemStatus();

      const body: HealthStatus = {
        status,
        timestamp: Date.now(),
        uptime: metrics.uptime,
        version: metrics.version,
        services: metrics.services.map((s) => ({
          name: s.name,
          status: s.status,
          lastCheck: s.lastCheck,
        })),
      };

      const httpStatus = status === 'unhealthy' ? 503 : 200;
      res.status(httpStatus).json(body);
    } catch (err: unknown) {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: Date.now(),
        uptime: 0,
        version: 'unknown',
        services: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
