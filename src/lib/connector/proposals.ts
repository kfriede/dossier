import "server-only";

import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { DocumentKind } from "@/generated/prisma/enums";
import { guardSources, guardUnits } from "@/lib/ai/fact-guard";
import { profileUnits } from "@/lib/ai/tasks/tailor-resume";
import { extractedSchema, unitsSchema, type Unit } from "@/lib/application-data";
import { documentLabels } from "@/lib/document-labels";
import { documentRevision } from "@/lib/connector/revisions";
import { profileRevision } from "@/lib/connector/write";
import { loadProfile } from "@/lib/profile-data";
import { withoutSectionsOff } from "@/lib/resume-sections";
import { loadSettings } from "@/lib/settings-data";

export const proposalSourceContextSchema = z.object({
  source: z.string().trim().max(100).default("external"),
  url: z.string().max(2000).default(""),
  posting_revision: z.string().max(200).default(""),
}).strict();
export type ProposalSourceContext = z.output<typeof proposalSourceContextSchema>;

export const documentProposalInputSchema = z.object({
  application_id: z.string().min(1).max(100),
  document_kind: z.enum([DocumentKind.RESUME, DocumentKind.COVER_LETTER]),
  document_revision: z.string().min(1).max(200),
  profile_revision: z.string().min(1).max(200),
  proposed_units: unitsSchema,
  source_context: proposalSourceContextSchema,
  warnings: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
}).strict();

export type DocumentProposalInput = z.output<typeof documentProposalInputSchema>;

export class DocumentProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentProposalConflictError";
  }
}

function withTrustedLetterFrame(proposed: Unit[], current: Unit[]): Unit[] {
  const protectedIds = new Set(["date", "sender", "signature"]);
  const original = new Map(current.filter((unit) => protectedIds.has(unit.id)).map((unit) => [unit.id, unit]));
  const result = proposed.map((unit) => original.get(unit.id) ?? unit);
  for (const [id, unit] of original) {
    if (result.some((entry) => entry.id === id)) continue;
    const oldIndex = current.findIndex((entry) => entry.id === id);
    const preceding = current.slice(0, oldIndex).reverse().find((entry) => result.some((candidate) => candidate.id === entry.id));
    const insertion = preceding ? result.findIndex((entry) => entry.id === preceding.id) + 1 : Math.min(oldIndex, result.length);
    result.splice(insertion, 0, unit);
  }
  return unitsSchema.parse(result);
}

/** Creates an external revision proposal without changing the active document. */
export async function createDocumentProposal(tx: Prisma.TransactionClient, input: DocumentProposalInput): Promise<{ proposalId: string; warnings: string[] }> {
  const application = await tx.application.findUnique({
    where: { id: input.application_id },
    select: { id: true, postingText: true, extracted: true, facts: { select: { text: true } } },
  });
  if (!application) throw new DocumentProposalConflictError("That application no longer exists.");
  const document = await tx.document.findUnique({
    where: { applicationId_kind: { applicationId: application.id, kind: input.document_kind } },
    select: { id: true, kind: true, units: true, updatedAt: true },
  });
  if (!document) throw new DocumentProposalConflictError("That document no longer exists.");
  const currentUnits = unitsSchema.parse(document.units);
  if (documentRevision(document) !== input.document_revision) {
    throw new DocumentProposalConflictError("The document changed after it was read. Read it again before proposing a revision.");
  }
  const [profile, settings] = await Promise.all([loadProfile(tx), loadSettings(tx)]);
  if (profileRevision(profile, settings.resumeSections) !== input.profile_revision) {
    throw new DocumentProposalConflictError("The profile changed after it was read. Read it again before proposing a revision.");
  }

  const proposed = unitsSchema.parse(input.proposed_units).map((unit) => {
    const clean = { ...unit };
    delete clean.unverified;
    return clean;
  });
  if (document.kind === DocumentKind.RESUME) {
    const visibleProfile = withoutSectionsOff(profile, settings.resumeSections);
    const validIds = new Set(profileUnits(visibleProfile, documentLabels("English")).map((unit) => unit.id));
    if (proposed.some((unit) => !validIds.has(unit.id))) {
      throw new DocumentProposalConflictError("The resume proposal includes a section that is no longer in the profile.");
    }
  } else {
    const allowed = new Set(["recipient", "greeting", "date", "sender", "signature", "sign-off", ...currentUnits.map((unit) => unit.id)]);
    if (proposed.some((unit) => !allowed.has(unit.id) && !/^paragraph:\d+$/.test(unit.id))) {
      throw new DocumentProposalConflictError("The cover letter proposal includes an unsupported part.");
    }
  }
  const proposedUnits = document.kind === DocumentKind.COVER_LETTER ? withTrustedLetterFrame(proposed, currentUnits) : proposed;
  const extracted = extractedSchema.safeParse(application.extracted);
  if (settings.strict && !extracted.success) throw new DocumentProposalConflictError("The application's posting details are unavailable. Read the application again before proposing a revision.");
  const guarded =
    settings.strict && extracted.success
      ? guardUnits(proposedUnits, guardSources(profile, extracted.data, application.postingText, application.facts.map(({ text }) => text)))
      : proposedUnits;
  const warnings = [...input.warnings, ...guarded.flatMap((unit) => unit.unverified?.map((claim) => `${unit.label}: ${claim}`) ?? [])];
  const proposal = await tx.documentProposal.create({
    data: {
      applicationId: application.id,
      documentId: document.id,
      expectedDocumentRevision: input.document_revision,
      expectedProfileRevision: input.profile_revision,
      proposedUnits: guarded,
      sourceContext: input.source_context,
      warnings,
    },
    select: { id: true },
  });
  return { proposalId: proposal.id, warnings };
}
