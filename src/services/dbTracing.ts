import type { PrismaClient } from "@prisma/client";
import { withSpan } from "../observability/tracing.js";

/** Records a span for every database operation: the model and the operation, never the values (NFR-101). */
export function withTracing(client: PrismaClient): PrismaClient {
  // Tests replace the Prisma client with a minimal stand-in that cannot be extended.
  if (typeof (client as { $extends?: unknown }).$extends !== "function") return client;
  return client.$extends({
    name: "tracing",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return withSpan(`db ${model}.${operation}`, "client", { "db.system": "postgresql", "db.model": model, "db.operation": operation }, () => query(args));
        }
      }
    }
  }) as unknown as PrismaClient;
}
