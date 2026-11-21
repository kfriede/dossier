import { createHash } from "node:crypto";

/** A content-only token for callers to detect when the context they read has changed. */
export function contextRevision(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;
}

export function documentRevision(document: { id: string; updatedAt: Date; units: unknown }): string {
  return contextRevision({ id: document.id, updatedAt: document.updatedAt.toISOString(), units: document.units });
}

export function postingRevision(posting: {
  text: string;
  url: string;
  source: string;
  complete: boolean;
  title?: string;
  company?: string;
  place?: string;
  sourceContext?: unknown;
}): string {
  return contextRevision(posting);
}
