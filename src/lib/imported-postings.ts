import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";

import { PostingSource } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { linkKey, safeLink } from "@/lib/job-search/search";

import { idempotentWrite } from "./connector/idempotency";

export const MAX_IMPORTED_POSTINGS = 25;

const importedPostingInput = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  company: z.string().trim().min(1).max(300).optional(),
  place: z.string().trim().max(300).optional(),
  remote: z.boolean().nullable().optional(),
  salary: z.string().trim().max(200).optional(),
  posted_at: z.iso.datetime().nullable().optional(),
  posting_url: z.string().max(2000).optional(),
  posting_text: z.string().max(100_000).optional(),
  complete: z.boolean().optional(),
  source_kind: z.string().trim().min(1).max(100).optional(),
  source_url: z.string().max(2000).optional(),
  reported_retrieved_at: z.iso.datetime().nullable().optional(),
  reported_checked_at: z.iso.datetime().nullable().optional(),
  requisition_id: z.string().trim().min(1).max(200).optional(),
  research_notes: z.string().max(2000).optional(),
}).strict();

export const importedPostingBatchSchema = z.object({
  idempotency_key: z.string().trim().min(1).max(200),
  records: z.array(importedPostingInput).min(1).max(MAX_IMPORTED_POSTINGS),
});

type ImportedPostingInput = z.output<typeof importedPostingInput>;
type ItemResult = Prisma.InputJsonObject & { index: number; status: "created" | "unchanged" | "needs_review" | "rejected"; posting_id: string | null; reason: string | null };

const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
const keyHash = (value: string) => createHash("sha256").update(value).digest("hex");
const itemResult = (index: number, status: ItemResult["status"], reason: string | null = null, postingId: string | null = null): ItemResult => ({
  index,
  status,
  posting_id: postingId,
  reason,
});

function parseRecord(value: ImportedPostingInput, index: number):
  | { ok: true; value: { title: string; company: string; place: string; remote: boolean | null; salary: string; postedAt: Date | null; url: string; description: string; complete: boolean; sourceKind: string; sourceUrl: string; reportedRetrievedAt: Date | null; reportedCheckedAt: Date | null; requisitionId: string | null; researchNotes: string } }
  | { ok: false; result: ItemResult } {
  const record = value;
  if (!record.title || !record.company || !record.source_kind) {
    return { ok: false, result: itemResult(index, "rejected", "Each posting needs a title, company, and reported source kind.") };
  }
  const url = record.posting_url ? safeLink(record.posting_url) : "";
  const sourceUrl = record.source_url ? safeLink(record.source_url) : "";
  if ((record.posting_url && !url) || (record.source_url && !sourceUrl)) {
    return { ok: false, result: itemResult(index, "rejected", "Posting and source links must use HTTP or HTTPS.") };
  }
  const description = record.posting_text?.trim() ?? "";
  const complete = record.complete ?? false;
  if (complete && !description) {
    return { ok: false, result: itemResult(index, "rejected", "A posting marked complete needs its full text.") };
  }
  return {
    ok: true,
    value: {
      title: record.title,
      company: record.company,
      place: record.place ?? "",
      remote: record.remote ?? null,
      salary: record.salary ?? "",
      postedAt: record.posted_at ? new Date(record.posted_at) : null,
      url,
      description,
      complete,
      sourceKind: record.source_kind,
      sourceUrl,
      reportedRetrievedAt: record.reported_retrieved_at ? new Date(record.reported_retrieved_at) : null,
      reportedCheckedAt: record.reported_checked_at ? new Date(record.reported_checked_at) : null,
      requisitionId: record.requisition_id ?? null,
      researchNotes: record.research_notes ?? "",
    },
  };
}

function matchesIdentity(
  existing: { company: string; title: string; url: string; requisitionId: string | null },
  incoming: { company: string; title: string; url: string; requisitionId: string | null },
): boolean {
  if (incoming.requisitionId && existing.requisitionId) {
    if (normalize(existing.company) === normalize(incoming.company) && normalize(existing.requisitionId) === normalize(incoming.requisitionId)) return true;
  }
  const incomingLink = linkKey(incoming.url);
  if (incomingLink) return linkKey(existing.url) === incomingLink;
  if (existing.url || incoming.requisitionId || existing.requisitionId) return false;
  return normalize(existing.company) === normalize(incoming.company) && normalize(existing.title) === normalize(incoming.title);
}

function equalImported(
  existing: {
    title: string;
    company: string;
    place: string;
    remote: boolean | null;
    salary: string;
    postedAt: Date | null;
    url: string;
    description: string;
    complete: boolean;
    sourceKind: string | null;
    sourceUrl: string | null;
    reportedRetrievedAt: Date | null;
    reportedCheckedAt: Date | null;
    requisitionId: string | null;
    researchNotes: string | null;
  },
  incoming: {
    title: string;
    company: string;
    place: string;
    remote: boolean | null;
    salary: string;
    postedAt: Date | null;
    url: string;
    description: string;
    complete: boolean;
    sourceKind: string;
    sourceUrl: string;
    reportedRetrievedAt: Date | null;
    reportedCheckedAt: Date | null;
    requisitionId: string | null;
    researchNotes: string;
  },
): boolean {
  const sameDate = (left: Date | null, right: Date | null) => left?.getTime() === right?.getTime();
  return (
    existing.title === incoming.title &&
    existing.company === incoming.company &&
    existing.place === incoming.place &&
    existing.remote === incoming.remote &&
    existing.salary === incoming.salary &&
    sameDate(existing.postedAt, incoming.postedAt) &&
    linkKey(existing.url) === linkKey(incoming.url) &&
    existing.description === incoming.description &&
    existing.complete === incoming.complete &&
    (existing.sourceKind ?? "") === incoming.sourceKind &&
    linkKey(existing.sourceUrl ?? "") === linkKey(incoming.sourceUrl) &&
    sameDate(existing.reportedRetrievedAt, incoming.reportedRetrievedAt) &&
    sameDate(existing.reportedCheckedAt, incoming.reportedCheckedAt) &&
    existing.requisitionId === incoming.requisitionId &&
    (existing.researchNotes ?? "") === incoming.researchNotes
  );
}

/** Saves validated external research as Saved postings without contacting any job source. */
export async function importPostings(clientId: string, input: z.output<typeof importedPostingBatchSchema>) {
  const { idempotency_key: idempotencyKey, records } = importedPostingBatchSchema.parse(input);
  return idempotentWrite({
    clientId,
    operation: "import_postings",
    idempotencyKey,
    payload: records,
    work: async (tx) => {
      const items: ItemResult[] = [];
      const imported = await tx.posting.findMany({
        where: { source: PostingSource.IMPORTED },
        select: {
          id: true,
          company: true,
          title: true,
          url: true,
          requisitionId: true,
          sourceKind: true,
          sourceUrl: true,
          place: true,
          remote: true,
          salary: true,
          postedAt: true,
          description: true,
          complete: true,
          reportedRetrievedAt: true,
          reportedCheckedAt: true,
          researchNotes: true,
        },
      });
      const providerRows = await tx.posting.findMany({
        where: { source: { not: PostingSource.IMPORTED }, url: { not: "" } },
        select: { id: true, url: true },
      });
      for (const [index, raw] of records.entries()) {
        const parsed = parseRecord(raw, index + 1);
        if (!parsed.ok) {
          items.push(parsed.result);
          continue;
        }
        const incoming = parsed.value;
        const matches = imported.filter((row) => matchesIdentity(row, incoming));
        if (matches.length > 1) {
          items.push(itemResult(index + 1, "needs_review", "More than one imported posting has a matching identity."));
          continue;
        }
        if (matches.length === 1) {
          const existing = matches[0];
          if (equalImported(existing, incoming)) {
            items.push(itemResult(index + 1, "unchanged", null, existing.id));
          } else {
            items.push(itemResult(index + 1, "needs_review", "This posting differs from the saved copy; Dossier left the saved version unchanged.", existing.id));
          }
          continue;
        }
        const canonicalLink = linkKey(incoming.url);
        const providerDuplicate = canonicalLink ? providerRows.find((row) => linkKey(row.url) === canonicalLink) : null;
        if (providerDuplicate) {
          items.push(itemResult(index + 1, "needs_review", "A job-search posting has the same link; Dossier left it unchanged.", providerDuplicate.id));
          continue;
        }
        const identity = incoming.requisitionId
          ? `req:${normalize(incoming.company)}:${normalize(incoming.requisitionId)}`
          : canonicalLink
            ? `url:${canonicalLink}`
            : `title:${normalize(incoming.company)}:${normalize(incoming.title)}`;
        const externalId = `import-${keyHash(identity)}`;
        const created = await tx.posting.create({
          data: {
            source: PostingSource.IMPORTED,
            externalId,
            title: incoming.title,
            company: incoming.company,
            place: incoming.place,
            remote: incoming.remote,
            salary: incoming.salary,
            postedAt: incoming.postedAt,
            url: incoming.url,
            description: incoming.description,
            complete: incoming.complete,
            requisitionId: incoming.requisitionId,
            sourceKind: incoming.sourceKind,
            sourceUrl: incoming.sourceUrl,
            reportedRetrievedAt: incoming.reportedRetrievedAt,
            reportedCheckedAt: incoming.reportedCheckedAt,
            researchNotes: incoming.researchNotes,
            savedAt: new Date(),
          },
          select: { id: true },
        });
        imported.push({ id: created.id, ...incoming });
        items.push(itemResult(index + 1, "created", null, created.id));
      }
      const tally = (status: ItemResult["status"]) => items.filter((item) => item.status === status).length;
      return {
        created: tally("created"),
        unchanged: tally("unchanged"),
        needs_review: tally("needs_review"),
        rejected: tally("rejected"),
        items,
      };
    },
  });
}
