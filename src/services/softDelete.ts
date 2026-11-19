import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@prisma/client";

/**
 * Soft delete for more record types (NFR-013).
 *
 * Deleting a Dependent, CcpDraft or CcpWebhookRecord marks it deleted (deletedAt, deletedBy) instead of
 * removing it. Normal reads no longer see it; it stays until retention allows its purge, so the
 * history of what was deleted and by whom survives. Queue items have their own soft delete
 * (queueOrchestration.ts). Encounters are the clinical record and are never deleted by users.
 *
 * The user who deleted is taken from the request (runWithActor, set by the authentication
 * middleware). Reads can ask for deleted rows with `where: { deletedAt: { not: null } }`.
 */

export const SOFT_DELETE_MODELS = ["Dependent", "CcpDraft", "CcpWebhookRecord"] as const;
const softModels = new Set<string>(SOFT_DELETE_MODELS);

const actorStore = new AsyncLocalStorage<{ userId: string }>();
export function runWithActor<T>(userId: string, fn: () => T): T {
  return actorStore.run({ userId }, fn);
}
export function currentActor(): string | undefined {
  return actorStore.getStore()?.userId;
}

const READ_OPERATIONS = new Set(["findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy"]);

function mentionsDeletedAt(where: unknown): boolean {
  return typeof where === "object" && where !== null && "deletedAt" in (where as Record<string, unknown>);
}

export function withSoftDelete(client: PrismaClient): PrismaClient {
  const extended: PrismaClient = client.$extends({
    name: "soft-delete",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!softModels.has(model)) return query(args);
          const a = (args ?? {}) as Record<string, unknown>;
          if (READ_OPERATIONS.has(operation)) {
            return mentionsDeletedAt(a.where) ? query(args) : query({ ...a, where: { ...(a.where as object | undefined), deletedAt: null } });
          }
          const delegate = (extended as unknown as Record<string, Record<string, (x: unknown) => unknown>>)[model.charAt(0).toLowerCase() + model.slice(1)];
          if (operation === "delete") {
            return delegate.update({ where: a.where, data: { deletedAt: new Date(), deletedBy: currentActor() ?? null } });
          }
          if (operation === "deleteMany") {
            return delegate.updateMany({ where: { ...(a.where as object | undefined), deletedAt: null }, data: { deletedAt: new Date(), deletedBy: currentActor() ?? null } });
          }
          return query(args);
        }
      }
    }
  }) as unknown as PrismaClient;
  return extended;
}

/** Brings a soft-deleted row back. Uses the unwrapped client, which sees deleted rows. */
export async function restoreSoftDeleted(base: PrismaClient, model: (typeof SOFT_DELETE_MODELS)[number], id: string): Promise<boolean> {
  const delegate = (base as unknown as Record<string, { updateMany(x: unknown): Promise<{ count: number }> }>)[model.charAt(0).toLowerCase() + model.slice(1)];
  return (await delegate.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedBy: null } })).count === 1;
}
