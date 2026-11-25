import { appendFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { inferSchema } from "../services/schemaInference.js";

/**
 * NFR-164: while the tests run with RECORD_RESPONSES_FILE set, every JSON answer a route gives is described as a
 * schema and appended to that file (one line per answer). scripts/mergeObservedResponses.ts folds the lines into
 * docs/observed-responses.json, which the OpenAPI generator uses for response schemas. Never active in production.
 */
export function responseRecorder() {
  const file = process.env.RECORD_RESPONSES_FILE;
  if (!file || process.env.NODE_ENV === "production") return (_req: Request, _res: Response, next: NextFunction) => next();
  return (req: Request, res: Response, next: NextFunction) => {
    const original = res.json.bind(res);
    let body: unknown;
    let captured = false;
    res.json = ((value: unknown) => {
      body = value;
      captured = true;
      return original(value);
    }) as Response["json"];
    res.on("finish", () => {
      if (!captured || res.statusCode < 200 || res.statusCode >= 300 || !req.route?.path || typeof req.route.path !== "string") return;
      try {
        const key = `${req.method.toUpperCase()} ${(req.baseUrl + req.route.path).replace(/\/$/, "")}`;
        appendFileSync(file, JSON.stringify({ key, status: res.statusCode, schema: inferSchema(body) }) + "\n");
      } catch {
        // Recording must never affect a request.
      }
    });
    next();
  };
}
