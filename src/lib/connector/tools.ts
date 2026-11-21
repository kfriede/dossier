import "server-only";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { ApplicationStatus, DocumentKind, PostingSource } from "@/generated/prisma/enums";
import { approveCandidate } from "@/lib/agent/draft";
import { isAiUsable } from "@/lib/ai/config";
import { profileForPrompt } from "@/lib/ai/tasks/prompt-parts";
import { scoreFrom } from "@/lib/ai/tasks/score-posting";
import { unitsSchema } from "@/lib/application-data";
import { fitBand } from "@/lib/fit";
import { countryCodeFor, countryName } from "@/lib/job-search/countries";
import { fullText } from "@/lib/job-search/find";
import { DEFAULT_RADIUS_KM, foundPostingSchema, POSTED_WITHIN, postingText, RADII_KM, type FoundPosting, type PostedWithin, type SearchQuery, type ShownPosting } from "@/lib/job-search/search";
import { getJob, startJob } from "@/lib/jobs/runner";
import { withoutPrivateParts } from "@/lib/letter-frame";
import { fetchPosting } from "@/lib/posting-fetch";
import { saveScore } from "@/lib/posting-scores";
import { loadSearch, runSearch, showMoreFor } from "@/lib/posting-searches";
import { foundFromPosting, storePosting, storedPostingFromRow } from "@/lib/postings";
import { IdempotencyConflictError, idempotentWrite, readIdempotentResult } from "@/lib/connector/idempotency";
import { DocumentProposalConflictError, createDocumentProposal, documentProposalInputSchema } from "@/lib/connector/proposals";
import { documentRevision, postingRevision } from "@/lib/connector/revisions";
import { importPostings, importedPostingBatchSchema } from "@/lib/imported-postings";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { withoutSectionsOff } from "@/lib/resume-sections";
import { loadSettings } from "@/lib/settings-data";
import { statusInfo } from "@/lib/status";
import { applyStatusChange } from "@/lib/status-changes";
import { appVersion } from "@/lib/version";

import { connectorDraftJob } from "./draft";
import { readPastedPosting } from "./handoff";
import {
  InvalidProfileReferenceError,
  ProfileRevisionConflictError,
  profileRevision,
  saveWrittenApplication,
  WRITTEN_IN_CLAUDE,
  writtenDetailsSchema,
  writtenLetterSchema,
  writtenMatchSchema,
  writtenResumeSchema,
} from "./write";

// The Claude connector's tools (#221, src/app/api/mcp), adapted from Anirudh
// Sharma's fork of Dossier: search for jobs, read the profile and the
// applications, save applications and fit scores, and move applications
// along. Like the AI features, they never send anything, and no tool
// deletes or archives. Contact details, private notes and the letter's
// sender and signature stay out of what Claude is given.

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const POSTED = POSTED_WITHIN.map((option) => option.value) as [PostedWithin, ...PostedWithin[]];

/** A posting as Claude sees it in a list: numbered, without its whole text. */
function postingLine(posting: ShownPosting | FoundPosting, number: number) {
  const state = "state" in posting ? posting.state : null;
  return {
    number,
    title: posting.title,
    company: posting.company,
    place: posting.place,
    remote: posting.remote,
    salary: posting.salary || undefined,
    posted: posting.postedAt?.slice(0, 10),
    via: posting.via || undefined,
    url: posting.url || undefined,
    saved: state?.saved || undefined,
    applied: state?.applicationId ? true : undefined,
    fit: state?.score ?? undefined,
    snippet: posting.description.replace(/\s+/g, " ").slice(0, 280),
  };
}

/** The text of a tailored document's parts, in order. */
function documentText(units: unknown): string {
  const parsed = unitsSchema.safeParse(units);
  if (!parsed.success) return "";
  return withoutPrivateParts(parsed.data)
    .map((unit) => `## ${unit.label || unit.id}\n${unit.text}`)
    .join("\n\n");
}

/** Where a posting comes from, in a tool's input. */
const postingSource = {
  posting_id: z.string().max(100).optional().describe("A posting Dossier handed over, by its posting_id"),
  paste_id: z.string().max(100).optional().describe("A pasted posting Dossier handed over, by its paste_id"),
  search_id: z.string().max(100).optional().describe("A search from search_jobs"),
  number: z.number().int().min(1).optional().describe("The posting's number in that search"),
  posting_url: z.url({ protocol: /^https?$/ }).max(2000).optional().describe("The posting's web address"),
  posting_text: z.string().max(100_000).optional().describe("The posting's text, pasted"),
};

type PostingSourceInput = { posting_id?: string; paste_id?: string; search_id?: string; number?: number; posting_url?: string; posting_text?: string };
type ResolvedPosting = {
  text: string;
  url: string;
  postingId: string | null;
  revision: string;
  complete: boolean;
  source: string;
  sourceContext?: { kind: string; url: string; retrievedAt: string | null; checkedAt: string | null; verified: false };
  recordUpdatedAt?: Date;
  title?: string;
  company?: string;
  place?: string;
};
type SaveApplicationResult = Prisma.InputJsonObject & {
  application_id: string;
  check_these: (Prisma.InputJsonObject & { part: string; items: string[] })[];
  warnings: string[];
};

class PostingRevisionConflictError extends Error {
  constructor() {
    super("The posting changed after it was read. Read it again before saving this application.");
    this.name = "PostingRevisionConflictError";
  }
}

/** The whole text of a posting from a search, one handed over, a link or pasted text, or what's wrong. */
async function resolvePosting(source: PostingSourceInput): Promise<ResolvedPosting | { error: string }> {
  if (source.posting_id) {
    const row = await prisma.posting.findUnique({ where: { id: source.posting_id } });
    if (!row) return { error: "That posting is no longer in Dossier. Open it again from Find jobs." };
    if (row.source === PostingSource.IMPORTED) {
      const description = row.description;
      const text = postingText({ title: row.title, company: row.company, place: row.place, remote: row.remote, salary: row.salary, description });
      return {
        text,
        url: row.url,
        postingId: row.id,
        revision: postingRevision({
          text,
          url: row.url,
          source: "imported",
          complete: row.complete,
          title: row.title,
          company: row.company,
          place: row.place,
          sourceContext: { kind: row.sourceKind ?? "Unspecified", url: row.sourceUrl ?? "", retrievedAt: row.reportedRetrievedAt?.toISOString() ?? null, checkedAt: row.reportedCheckedAt?.toISOString() ?? null, verified: false },
        }),
        complete: row.complete,
        source: "imported",
        recordUpdatedAt: row.updatedAt,
        sourceContext: { kind: row.sourceKind ?? "Unspecified", url: row.sourceUrl ?? "", retrievedAt: row.reportedRetrievedAt?.toISOString() ?? null, checkedAt: row.reportedCheckedAt?.toISOString() ?? null, verified: false },
        title: row.title,
        company: row.company,
        place: row.place,
      };
    }
    const found = foundFromPosting(row);
    const description = found.complete ? found.description : ((await fullText(found)) ?? found.description);
    if (!description.trim()) return { error: "That posting has no text to write from. Give its link as posting_url instead." };
    const text = postingText({ ...found, description });
    return {
      text,
      url: found.url,
      postingId: row.id,
      revision: postingRevision({ text, url: found.url, source: row.source, title: found.title, company: found.company, place: found.place, complete: found.complete }),
      complete: found.complete,
      source: row.source,
      recordUpdatedAt: row.updatedAt,
      title: found.title,
      company: found.company,
      place: found.place,
    };
  }
  if (source.paste_id) {
    const pasted = await readPastedPosting(source.paste_id);
    if (!pasted) return { error: "That pasted posting is no longer kept. Paste it into New application again, or here as posting_text." };
    return { text: pasted.text, url: pasted.url, postingId: null, revision: postingRevision({ text: pasted.text, url: pasted.url, source: "pasted", complete: true }), complete: true, source: "pasted" };
  }
  if (source.search_id) {
    const search = await prisma.postingSearch.findUnique({ where: { id: source.search_id }, select: { postings: true } });
    const kept = foundPostingSchema.array().catch([]).parse(search?.postings ?? []);
    const found = source.number ? kept[source.number - 1] : undefined;
    if (!found) return { error: "There's no such posting in that search. Use a number from search_jobs." };
    const description = (await fullText(found)) ?? found.description;
    if (!description.trim()) return { error: "That posting has no text to write from. Give its link as posting_url instead." };
    const stored = await storePosting(found);
    const text = postingText({ ...found, description });
    return {
      text,
      url: found.url,
      postingId: stored.id,
      revision: postingRevision({ text, url: found.url, source: found.source, title: found.title, company: found.company, place: found.place, complete: found.complete }),
      complete: found.complete,
      source: found.source,
      recordUpdatedAt: stored.updatedAt,
      title: found.title,
      company: found.company,
      place: found.place,
    };
  }
  // Pasted text is used as it is, with its link kept: a page Dossier can't read, such as one behind a sign-in, mustn't fail it.
  if (source.posting_text?.trim()) {
    const value = source.posting_text.trim();
    return { text: value, url: source.posting_url ?? "", postingId: null, revision: postingRevision({ text: value, url: source.posting_url ?? "", source: "pasted", complete: true }), complete: true, source: "pasted" };
  }
  if (source.posting_url) {
    const fetched = await fetchPosting(source.posting_url);
    if (!fetched.ok) return { error: `${fetched.error} Paste the posting's text as posting_text instead.` };
    return { text: fetched.text, url: fetched.url, postingId: null, revision: postingRevision({ text: fetched.text, url: fetched.url, source: "external", complete: true }), complete: true, source: "external" };
  }
  return { error: "Give posting_id, paste_id, search_id and number, posting_url, or posting_text." };
}

/** Dossier as an MCP server, for one request; `origin` is the address links in answers point to. */
export function createDossierServer(origin: string, clientId: string): McpServer {
  const linkTo = (path: string) => `${origin}${path}`;
  const server = new McpServer(
    { name: "dossier", title: "Dossier", version: appVersion },
    {
      instructions:
        "Dossier is the user's own job search app: one profile, tailored resumes and cover letters, and every application tracked. " +
        "Search jobs with search_jobs (in the profile's city and country unless the user says otherwise), " +
        "or import external research with import_postings when the user shares researched postings. Treat imported source labels and check dates as unverified, " +
        "and when the user wants to know which fit best, score them against the profile and save the scores with save_job_scores. " +
        "To draft an application, you write it yourself: call get_profile and get_posting, write the requested resume, cover letter or both " +
        "from facts in the profile only (never invent experience, employers, numbers or degrees; say what's missing instead), " +
        "show the user a short summary, then save it with save_application. Read or update applications with the other tools. " +
        "Nothing is ever sent for the user: drafts wait in Dossier for them to review and download as PDFs.",
    },
  );

  server.registerTool(
    "get_profile",
    {
      title: "Read the profile",
      description:
        "The user's profile in Dossier: headline, summary, facts about them, skills, languages, experience, projects, education, certifications, publications and sections they made, with the ids save_application uses. Contact details and links are left out.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
      return text({
        ...JSON.parse(profileForPrompt(withoutSectionsOff(profile, settings.resumeSections))),
        profile_revision: profileRevision(profile, settings.resumeSections),
        link: linkTo("/profile"),
      });
    },
  );

  server.registerTool(
    "search_jobs",
    {
      title: "Search for jobs",
      description:
        "Searches the job source set up in Dossier's settings and keeps the search in Find jobs → Past searches. Each search uses one search from the user's plan with that source. " +
        "Returns a search_id and numbered postings; pass both to get_posting, save_job_scores or save_application, or the search_id to more_jobs.",
      inputSchema: z.object({
        keywords: z.string().trim().min(1).max(200).describe("Job title, skill or company, e.g. 'product designer'"),
        place: z.string().max(200).optional().describe("City or region. Defaults to the profile's city. Use '' for the whole country."),
        country: z.string().max(60).optional().describe("Country name or ISO code, e.g. 'Germany' or 'de'. Defaults to the profile's country."),
        remote_only: z.boolean().optional().describe("Only remote postings."),
        radius_km: z.literal(RADII_KM).optional(),
        posted_within: z.enum(POSTED).optional().describe("any, day, 3days, week or month. Defaults to month."),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) => {
      const { basics } = await loadProfile();
      const country = countryCodeFor(input.country ?? basics.country) || (input.country?.trim().length === 2 ? input.country.trim().toLowerCase() : "");
      if (!country) return failure("Say which country to search in, e.g. country: 'Germany'.");
      const remoteOnly = input.remote_only ?? false;
      const query: SearchQuery = {
        keywords: input.keywords,
        place: remoteOnly ? "" : (input.place ?? basics.city).trim(),
        country,
        radiusKm: input.radius_km ?? DEFAULT_RADIUS_KM,
        remoteOnly,
        postedWithin: input.posted_within ?? "month",
      };
      const ran = await runSearch(query);
      if (!ran.ok) return failure(ran.message);
      const search = await loadSearch(ran.id);
      if (!search) return failure("The search ran, but couldn't be read back. Try again.");
      return text({
        search_id: search.id,
        searched: `${query.keywords} in ${query.place || countryName(country)}${query.remoteOnly ? " (remote only)" : ""}`,
        found: search.postings.length,
        more_available: search.next !== null,
        postings: search.postings.map((posting, index) => postingLine(posting, index + 1)),
        link: linkTo(`/jobs?search=${search.id}`),
      });
    },
  );

  server.registerTool(
    "import_postings",
    {
      title: "Import researched postings",
      description:
        "Saves up to 25 postings the user has already researched into Find jobs → Saved. " +
        "Supply an idempotency_key and each posting's title, company, source_kind, posting_text, and completeness. " +
        "Optional source links, requisition IDs, retrieval/check timestamps and notes are stored as reported context, not verified facts. " +
        "Dossier does not fetch these links or contact job sources. Reuse the same key only for an exact retry; receipts are kept for 30 days. " +
        "If a posting differs from an existing copy, Dossier leaves the saved version unchanged and returns needs_review.",
      inputSchema: importedPostingBatchSchema,
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true },
    },
    async (input) => {
      if (!clientId) return failure("This write requires an authenticated Dossier connector.");
      let outcome: Awaited<ReturnType<typeof importPostings>>;
      try {
        outcome = await importPostings(clientId, input);
      } catch (error) {
        if (error instanceof IdempotencyConflictError) return failure(error.message);
        throw error;
      }
      const { result, replayed } = outcome;
      const response = { ...result, replayed, provenance_warning: "Source labels and source-check timestamps were reported by the importing client and have not been verified." };
      return text(response);
    },
  );

  server.registerTool(
    "more_jobs",
    {
      title: "Show more jobs",
      description: "The next page of a search from search_jobs. Uses one more search from the user's plan.",
      inputSchema: z.object({ search_id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ search_id }) => {
      const before = await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { found: true } });
      if (!before) return failure("That search is no longer kept. Search again.");
      const more = await showMoreFor(search_id);
      if (!more.ok) return failure(more.message);
      return text({
        search_id,
        added: more.postings.length,
        more_available: more.next !== null,
        postings: more.postings.map((posting, index) => postingLine(posting, before.found + index + 1)),
      });
    },
  );

  server.registerTool(
    "save_job_scores",
    {
      title: "Save fit scores for postings",
      description:
        "Saves how well postings fit the user (from a search_jobs search by number, or handed over by posting_id), so Find jobs shows each score with its reasons. " +
        "Read the profile first, and the whole posting with get_posting when the snippet is too short to judge. " +
        "Score each from 0 to 100 against the profile from get_profile: 85-100 excellent (clearly meets the core requirements), 70-84 good (most core requirements, a gap or two), 50-69 possible (meaningful gaps or a stretch), 0-49 poor. " +
        "Judge skills and experience, seniority and scope, location, remote work and language, and salary when both say something. " +
        "Give one to four short reasons, each tying a requirement to a specific role, project, skill or degree, and up to three real red flags. " +
        "Never invent experience, and never use age, gender, nationality or any other protected characteristic.",
      inputSchema: z.object({
        search_id: z.string().max(100).optional().describe("The search the numbered postings are from"),
        scores: z
          .array(
            z.object({
              number: z.number().int().min(1).optional().describe("The posting's number in the search"),
              posting_id: z.string().max(100).optional().describe("Instead of a number: a posting Dossier handed over"),
              score: z.number().int().min(0).max(100),
              reasons: z.array(z.string().max(300)).min(1).max(4),
              red_flags: z.array(z.string().max(300)).max(3).default([]),
            }),
          )
          .min(1)
          .max(50),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ search_id, scores }) => {
      const search = search_id ? await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { postings: true } }) : null;
      if (search_id && !search) return failure("That search is no longer kept. Search again.");
      const kept = foundPostingSchema.array().catch([]).parse(search?.postings ?? []);
      const saved: { number?: number; posting_id?: string; title: string; score: number; band: string }[] = [];
      const missing: (number | string)[] = [];
      for (const entry of scores) {
        const row = entry.posting_id ? await prisma.posting.findUnique({ where: { id: entry.posting_id } }) : null;
        const posting = row ? storedPostingFromRow(row) : entry.number ? kept[entry.number - 1] : undefined;
        if (!posting) {
          missing.push(entry.posting_id ?? entry.number ?? "?");
          continue;
        }
        const fit = scoreFrom({ score: entry.score, reasons: entry.reasons, redFlags: entry.red_flags });
        await saveScore(posting, fit, WRITTEN_IN_CLAUDE);
        saved.push({ number: entry.number, posting_id: entry.posting_id, title: posting.title, score: fit.score, band: fitBand(fit.score) });
      }
      return text({ saved, not_found: missing.length > 0 ? missing : undefined, link: linkTo(search_id ? `/jobs?search=${search_id}` : "/jobs?view=saved") });
    },
  );

  server.registerTool(
    "list_applications",
    {
      title: "List applications",
      description: "The user's applications in Dossier, newest activity first, with their status. Optionally only one status.",
      inputSchema: z.object({
        status: z.enum(ApplicationStatus).optional().describe("DRAFT, SENT, SCREENING, INTERVIEW, OFFER, ACCEPTED, REJECTED or DECLINED"),
        include_archived: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ status, include_archived, limit }) => {
      const rows = await prisma.application.findMany({
        where: { awaitingReview: false, ...(status ? { status } : {}), ...(include_archived ? {} : { archivedAt: null }) },
        orderBy: { updatedAt: "desc" },
        take: limit ?? 30,
        select: { id: true, title: true, company: true, role: true, location: true, status: true, updatedAt: true, postingUrl: true },
      });
      return text(
        rows.map((row) => ({
          id: row.id,
          title: row.title,
          company: row.company,
          role: row.role,
          location: row.location,
          status: statusInfo(row.status).label,
          updated: row.updatedAt.toISOString().slice(0, 10),
          posting: row.postingUrl || undefined,
          link: linkTo(`/applications/${row.id}`),
        })),
      );
    },
  );

  server.registerTool(
    "get_application",
    {
      title: "Read an application",
      description: "One application with its posting, how the profile matches it, and the tailored resume and cover letter as text. Private notes and contact details are left out.",
      inputSchema: z.object({ id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const application = await prisma.application.findUnique({
        where: { id, awaitingReview: false },
        select: {
          id: true,
          title: true,
          company: true,
          role: true,
          location: true,
          mode: true,
          salary: true,
          status: true,
          postingUrl: true,
          postingText: true,
          match: true,
          documents: { select: { id: true, kind: true, units: true, updatedAt: true } },
        },
      });
      if (!application) return failure("That application no longer exists.");
      const doc = (kind: DocumentKind) => documentText(application.documents.find((document) => document.kind === kind)?.units);
      return text({
        id: application.id,
        title: application.title,
        company: application.company,
        role: application.role,
        location: application.location,
        mode: application.mode,
        salary: application.salary,
        status: statusInfo(application.status).label,
        posting_url: application.postingUrl || undefined,
        posting: application.postingText.slice(0, 20_000),
        match: application.match,
        resume: doc(DocumentKind.RESUME),
        cover_letter: doc(DocumentKind.COVER_LETTER),
        document_revisions: application.documents.map((document) => ({
          kind: document.kind,
          document_revision: documentRevision(document),
        })),
        link: linkTo(`/applications/${application.id}`),
      });
    },
  );

  server.registerTool(
    "propose_document_revision",
    {
      title: "Propose a document revision",
      description:
        "Stores a resume or cover-letter revision for the user to review in Dossier. " +
        "Pass the document_revision from get_application and profile_revision from get_profile. " +
        "This creates a pending proposal only; it does not change the document, application status, or sent copy. " +
        "The user must approve or reject it in Dossier.",
      inputSchema: z.object({
        ...documentProposalInputSchema.shape,
        idempotency_key: z.string().trim().min(1).max(200).describe("Unique key for retrying this exact proposal"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ idempotency_key, ...input }) => {
      if (!clientId) return failure("This write requires an authenticated Dossier connector.");
      try {
        const saved = await idempotentWrite({
          clientId,
          operation: "propose_document_revision",
          idempotencyKey: idempotency_key,
          payload: input,
          work: async (tx) => {
            const result = await createDocumentProposal(tx, input);
            return { proposal_id: result.proposalId, warnings: result.warnings };
          },
        });
        return text({
          ...saved.result,
          status: "pending",
          replayed: saved.replayed,
          link: linkTo(`/applications/${input.application_id}`),
        });
      } catch (error) {
        if (error instanceof IdempotencyConflictError || error instanceof DocumentProposalConflictError) return failure(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "get_posting",
    {
      title: "Read a posting",
      description:
        "Reads a posting from a search (search_id and number), one Dossier handed over (posting_id or paste_id), a link (posting_url) or pasted text (posting_text). Long text is returned in 16,000-character chunks; pass next_offset as offset to read more. The posting_revision token identifies the exact context returned.",
      inputSchema: z.object({
        posting_id: postingSource.posting_id,
        paste_id: postingSource.paste_id,
        search_id: postingSource.search_id,
        number: postingSource.number,
        posting_url: postingSource.posting_url,
        posting_text: postingSource.posting_text,
        offset: z.number().int().min(0).max(100_000).default(0).describe("Character offset for the next chunk from a previous get_posting result"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ offset, ...input }) => {
      const posting = await resolvePosting(input);
      if ("error" in posting) return failure(posting.error);
      if (offset > posting.text.length) return failure("That offset is past the end of this posting. Read it again from offset 0.");
      const end = Math.min(offset + 16_000, posting.text.length);
      return text({
        url: posting.url || undefined,
        title: posting.title,
        company: posting.company,
        place: posting.place,
        source: posting.source,
        complete: posting.complete,
        source_context: posting.sourceContext,
        posting_revision: posting.revision,
        offset,
        total_characters: posting.text.length,
        next_offset: end < posting.text.length ? end : undefined,
        text: posting.text.slice(offset, end),
      });
    },
  );

  server.registerTool(
    "save_application",
    {
      title: "Save an application you wrote",
      description:
        "Saves the resume, cover letter, or both that you wrote as a Draft application in Dossier, where the user can review, edit and download them as PDFs. " +
        "Give the profile_revision from get_profile and posting_revision from get_posting. Resume role, project, and education ids must still exist in the current profile. " +
        "Supply an idempotency_key for safe retries. Only use facts from the profile. Nothing is sent.",
      inputSchema: z.object({
        ...postingSource,
        idempotency_key: z.string().trim().min(1).max(200).describe("Unique key for retrying this exact save"),
        profile_revision: z.string().min(1).max(200).describe("The profile_revision returned by get_profile"),
        posting_revision: z.string().min(1).max(200).describe("The posting_revision returned by get_posting"),
        details: writtenDetailsSchema,
        resume: writtenResumeSchema.optional(),
        cover_letter: writtenLetterSchema.optional(),
        match: writtenMatchSchema.describe("What the posting asks for and whether the profile covers it, partly covers it, or has a gap; Dossier shows it as the application's match"),
        note: z.string().max(2000).optional().describe("What the user asked to stress, kept with the application"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ details, resume, cover_letter, match, note, idempotency_key, profile_revision, posting_revision, ...source }) => {
      if (!clientId) return failure("This write requires an authenticated Dossier connector.");
      if (!resume && !cover_letter) return failure("Provide a resume, a cover letter, or both.");
      const payload = { source, details, resume, cover_letter, match, note: note ?? "", profile_revision, posting_revision };
      try {
        const replay = await readIdempotentResult<SaveApplicationResult>({
          clientId,
          operation: "save_application",
          idempotencyKey: idempotency_key,
          payload,
        });
        if (replay) {
          return text({
            ...replay.result,
            status: "Draft",
            replayed: true,
            link: linkTo(`/applications/${replay.result.application_id}`),
            next: replay.result.check_these.length > 0 ? "Dossier marked names or numbers it couldn't find in the profile or posting; tell the user to check them." : undefined,
          });
        }

        const posting = await resolvePosting(source);
        if ("error" in posting) return failure(posting.error);
        if (posting.revision !== posting_revision) return failure("The posting changed after it was read. Read it again before saving this application.");

        const saved = await idempotentWrite<SaveApplicationResult>({
          clientId,
          operation: "save_application",
          idempotencyKey: idempotency_key,
          payload,
          work: async (tx) => {
            if (posting.postingId && posting.recordUpdatedAt) {
              const pinned = await tx.posting.updateMany({
                where: { id: posting.postingId, updatedAt: posting.recordUpdatedAt },
                data: { updatedAt: posting.recordUpdatedAt },
              });
              if (pinned.count !== 1) throw new PostingRevisionConflictError();
            }
            const result = await saveWrittenApplication({
              posting: posting.text.slice(0, 100_000),
              postingUrl: posting.url.slice(0, 2000),
              postingId: posting.postingId,
              details,
              resume,
              letter: cover_letter,
              match,
              note: note ?? "",
            }, profile_revision, tx);
            return {
              application_id: result.applicationId,
              check_these: result.unverified,
              warnings: [
                ...(!posting.complete ? ["The posting text is marked incomplete; verify fit and claims before using the documents."] : []),
                ...(posting.sourceContext ? ["The imported source details were reported by the connector and have not been verified."] : []),
              ],
            };
          },
        });
        const result = saved.result;
        return text({
          ...result,
          status: "Draft",
          replayed: saved.replayed,
          link: linkTo(`/applications/${result.application_id}`),
          next: result.check_these.length > 0 ? "Dossier marked names or numbers it couldn't find in the profile or posting; tell the user to check them." : undefined,
        });
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof ProfileRevisionConflictError ||
          error instanceof InvalidProfileReferenceError ||
          error instanceof PostingRevisionConflictError
        ) {
          return failure(error.message);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "draft_application",
    {
      title: "Have Dossier draft an application",
      description:
        "Has Dossier's own AI model draft the application, only when an AI provider is set up in Dossier's settings. " +
        "Without one, write it yourself with get_profile, get_posting and save_application. Takes one to three minutes: follow it with check_draft.",
      inputSchema: z.object({ ...postingSource, note: z.string().max(2000).optional().describe("Anything the documents should stress, in the user's words") }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ note, ...source }) => {
      if (!(await isAiUsable())) {
        return failure("Dossier has no AI model of its own set up. Write the application yourself: get_profile, get_posting, then save_application.");
      }
      const posting = await resolvePosting(source);
      if ("error" in posting) return failure(posting.error);
      const jobId = await startJob(connectorDraftJob, { posting: posting.text.slice(0, 100_000), postingUrl: posting.url.slice(0, 2000), note: note ?? "", postingId: posting.postingId });
      return text({ draft_id: jobId, status: "started", next: "Call check_draft with this draft_id in a minute or so." });
    },
  );

  server.registerTool(
    "check_draft",
    {
      title: "Check a draft",
      description: "How a draft from draft_application is coming along; once done, the new application's id and link.",
      inputSchema: z.object({ draft_id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: true },
    },
    async ({ draft_id }) => {
      const job = await getJob(draft_id);
      if (!job || job.type !== connectorDraftJob.type) return failure("There's no such draft.");
      if (job.status === "FAILED") return failure(job.error ?? "The draft couldn't be written.");
      if (job.status !== "DONE") return text({ draft_id, status: "working", step: job.step ?? "Starting", next: "Check again in a little while." });
      const result = connectorDraftJob.result.safeParse(job.result);
      if (!result.success) return failure("The draft finished, but its application couldn't be found.");
      return text({ draft_id, status: "done", application_id: result.data.applicationId, link: linkTo(`/applications/${result.data.applicationId}`) });
    },
  );

  server.registerTool(
    "set_application_status",
    {
      title: "Move an application",
      description: "Changes an application's status, e.g. to SENT once the user has applied, or INTERVIEW. It only records the change; nothing is sent.",
      inputSchema: z.object({ id: z.string().min(1).max(100), status: z.enum(ApplicationStatus) }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id, status }) => {
      // A job agent draft waiting for review is approved first, as moving it on the Agent screen does.
      if (status !== ApplicationStatus.DRAFT) {
        const pending = await prisma.agentCandidate.findFirst({ where: { applicationId: id, application: { awaitingReview: true } }, select: { id: true } });
        if (pending) await approveCandidate(pending.id);
      }
      const result = await applyStatusChange(prisma, id, status);
      if (result.outcome === "not-found") return failure("That application no longer exists.");
      return text({ id, status: statusInfo(status).label, changed: result.outcome !== "unchanged" });
    },
  );

  return server;
}
