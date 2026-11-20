import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// NFR-098: when the platform is deployed behind an API gateway, the application must refuse traffic
// that did not come through it. The gateway adds a shared secret header; GATEWAY_REQUIRED=true turns the
// check on. Health probes are exempt so the platform's own orchestrator keeps working.

const EXEMPT = new Set(["/healthz", "/readyz"]);

export function gatewayRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GATEWAY_REQUIRED === "true";
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function gatewayGuard(env: NodeJS.ProcessEnv = process.env) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!gatewayRequired(env) || EXEMPT.has(req.path)) return next();
    const secret = env.GATEWAY_SHARED_SECRET;
    const presented = req.header("x-gateway-secret");
    if (!secret || !presented || !safeEqual(presented, secret)) {
      return res.status(403).json({ error: "Requests must be made through the API gateway." });
    }
    return next();
  };
}
