import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

const RECEIPT_RETENTION_DAYS = 30;

export class IdempotencyConflictError extends Error {
  constructor() {
    super("That idempotency key was already used with different content.");
    this.name = "IdempotencyConflictError";
  }
}

export async function readIdempotentResult<T extends Prisma.InputJsonObject>({
  clientId,
  operation,
  idempotencyKey,
  payload,
}: {
  clientId: string;
  operation: string;
  idempotencyKey: string;
  payload: unknown;
}): Promise<{ result: T; replayed: true } | null> {
  const existing = await prisma.connectorWriteReceipt.findUnique({
    where: { clientId_operation_idempotencyKey: { clientId, operation, idempotencyKey } },
  });
  if (!existing || existing.createdAt < new Date(Date.now() - RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000)) return null;
  if (existing.payloadHash !== hash(payload)) throw new IdempotencyConflictError();
  return { result: existing.result as T, replayed: true };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("The idempotency payload must be JSON serializable.");
  return encoded;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Runs a connector write once per authenticated client, operation, and key. */
export async function idempotentWrite<T extends Prisma.InputJsonObject>({
  clientId,
  operation,
  idempotencyKey,
  payload,
  work,
}: {
  clientId: string;
  operation: string;
  idempotencyKey: string;
  payload: unknown;
  work: (tx: Prisma.TransactionClient) => Promise<T>;
}): Promise<{ result: T; replayed: boolean }> {
  const payloadHash = hash(payload);
  const unique = { clientId_operation_idempotencyKey: { clientId, operation, idempotencyKey } };
  try {
    const result = await prisma.$transaction(async (tx) => {
      const expiredAt = new Date(Date.now() - RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      await tx.connectorWriteReceipt.deleteMany({ where: { createdAt: { lt: expiredAt } } });
      const receipt = await tx.connectorWriteReceipt.create({
        data: { clientId, operation, idempotencyKey, payloadHash, result: { pending: true } },
        select: { id: true },
      });
      const value = await work(tx);
      await tx.connectorWriteReceipt.update({ where: { id: receipt.id }, data: { result: value } });
      return value;
    });
    return { result, replayed: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const existing = await prisma.connectorWriteReceipt.findUnique({ where: unique });
    if (!existing) throw error;
    if (existing.payloadHash !== payloadHash) throw new IdempotencyConflictError();
    return { result: existing.result as T, replayed: true };
  }
}
