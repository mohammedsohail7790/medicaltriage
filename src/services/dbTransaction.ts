import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";

/**
 * Transaction helper (NFR-060). Runs `work` as one atomic unit. With `serializable`, a
 * read-then-write on the same row (for example appending to a JSON trace) cannot lose an update made
 * by another request at the same time: the database aborts one of them with a serialization failure,
 * and the work is retried a few times.
 */
export type TransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export async function runInTransaction<T>(
  work: (tx: TransactionClient) => Promise<T>,
  options: { serializable?: boolean; attempts?: number } = {}
): Promise<T> {
  const attempts = options.attempts ?? 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => work(tx as unknown as TransactionClient), options.serializable ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined);
    } catch (error) {
      const retryable = (error as { code?: string }).code === "P2034";
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}
