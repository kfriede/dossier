"use server";

import { z } from "zod";

import { PostingSource } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { isAiUsable } from "@/lib/ai/config";
import { handOffFoundPosting, handsOffToClaude } from "@/lib/connector/handoff";
import { loadJobSearchConfig } from "@/lib/job-search/config";
import { fullText } from "@/lib/job-search/find";
import { foundPostingSchema, searchQuerySchema, storedPostingSchema } from "@/lib/job-search/search";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { scoreJobKey, scorePostingJob } from "@/lib/jobs/score-posting";
import { removeSearch, runSearch, showMoreFor } from "@/lib/posting-searches";
import { dismissPosting, markImportedPosting, savePosting, storePosting, storedPostingFromRow, unmarkPosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { scoringProblem } from "@/lib/scoring";
import { loadScoringConfig } from "@/lib/scoring/config";
import { saveSettings } from "@/lib/settings-data";

// Find jobs (E14-6). Each search is kept with what it found (E14-10).
// Postings come back from the screen as the search gave them, checked
// against the posting shape.

const postingRef = z.object({ source: z.enum(PostingSource), externalId: z.string().min(1).max(500) });
const postingInputSchema = z.union([
  foundPostingSchema,
  z.object({ source: z.literal(PostingSource.IMPORTED), externalId: z.string().min(1).max(500) }),
]);
const searchId = z.string().min(1).max(100);

/** "I understand" under the Bundesagentur für Arbeit's note (#223), for a BA choice made before it, or by DOSSIER_JOBS_SOURCE. */
export const acceptArbeitsagenturNote = action(z.object({}), async () => {
  const { arbeitsagentur } = await loadJobSearchConfig();
  if (!arbeitsagentur.offered) throw new ActionError("The Bundesagentur für Arbeit isn't offered on this server.");
  await saveSettings({ arbeitsagenturAcceptedAt: new Date().toISOString() });
  return null;
});

/** "Search": asks the chosen source and keeps the search with what it found; gives its id, or what went wrong. */
export const runJobSearch = action(z.object({ query: searchQuerySchema }), ({ query }) => runSearch(query));

/** "Show more": the next page, added to the kept search. */
export const showMorePostings = action(z.object({ searchId }), ({ searchId }) => showMoreFor(searchId));

/** Removes a kept search and what it found; saved postings stay. */
export const removeJobSearch = action(z.object({ id: searchId }), async ({ id }, { toast }) => {
  await removeSearch(id);
  toast("Search removed. Saved postings from it stay in Saved.");
  return null;
});

/** The whole text of a posting the search only gave the start of; null when it can't be had. */
export const loadFullText = action(z.object({ posting: foundPostingSchema }), async ({ posting }) => ({ text: await fullText(posting) }));

export const savePostingForLater = action(z.object({ posting: postingInputSchema }), async ({ posting }, { toast }) => {
  const saved = posting.source === PostingSource.IMPORTED
    ? await markImportedPosting(posting, "saved")
    : await savePosting(posting);
  if (!saved) throw new ActionError("That imported posting is no longer in Saved.");
  toast("Saved for later.");
  return { postingId: saved.id };
});

export const unsavePosting = action(postingRef, async (ref, { toast }) => {
  await unmarkPosting(ref, "saved");
  toast("Removed from Saved.");
  return null;
});

/** Dismiss: out of this and later searches. Says whether it was saved, so Undo can put it back. */
export const dismissFoundPosting = action(z.object({ posting: postingInputSchema }), async ({ posting }) => {
  if (posting.source !== PostingSource.IMPORTED) return dismissPosting(posting);
  const dismissed = await markImportedPosting(posting, "dismissed");
  if (!dismissed) throw new ActionError("That imported posting is no longer in Dismissed.");
  return { wasSaved: dismissed.wasSaved };
});

/**
 * "Start application" (E14-8): keeps the posting with its whole text when it
 * can be had, for New application to open from its id.
 */
export const startApplicationFrom = action(z.object({ posting: postingInputSchema }), async ({ posting }) => {
  if (posting.source === PostingSource.IMPORTED) {
    const stored = await prisma.posting.findUnique({
      where: { source_externalId: { source: PostingSource.IMPORTED, externalId: posting.externalId } },
      select: { id: true },
    });
    if (!stored) throw new ActionError("That imported posting is no longer in Dossier.");
    return { postingId: stored.id };
  }
  const text = await fullText(posting);
  const stored = await storePosting(text ? { ...posting, description: text, complete: true } : posting);
  return { postingId: stored.id };
});

/** Brings a dismissed posting back, into Saved again when it was there (Undo). */
export const restorePosting = action(postingRef.extend({ saved: z.boolean() }), async ({ saved, ...ref }) => {
  await unmarkPosting(ref, "dismissed", { saved });
  return null;
});

/**
 * "Score" (#208): how well a posting fits the profile, in the background; a
 * scoring under way is followed, not started again. With the Claude connector
 * on and no AI model of Dossier's own, a Claude chat scores it instead (#221),
 * unless Settings → Scoring chose Jev (#274).
 */
export const startScoringPosting = action(z.object({ posting: storedPostingSchema }), async ({ posting }): Promise<{ jobId: string } | { handoff: string }> => {
  const scoreable = posting.source === PostingSource.IMPORTED
    ? await prisma.posting.findUnique({ where: { source_externalId: { source: PostingSource.IMPORTED, externalId: posting.externalId } } }).then((row) => {
        if (!row) throw new ActionError("That imported posting is no longer in Dossier.");
        return storedPostingFromRow(row);
      })
    : posting;
  const scoring = await loadScoringConfig();
  if (scoring.scorer === "AI" && (await handsOffToClaude(await isAiUsable()))) return { handoff: await handOffFoundPosting(scoreable, "score") };
  const problem = await scoringProblem(scoring);
  if (problem) throw new ActionError(problem);
  const key = scoreJobKey(scoreable);
  const [unfinished] = await findUnfinishedJobs(key);
  return { jobId: unfinished?.id ?? (await startJob(scorePostingJob, { posting: scoreable }, { key })) };
});
