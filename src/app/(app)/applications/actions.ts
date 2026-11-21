"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApplicationStatus, DocumentKind } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { FILTERS, SORT_KEYS, VIEWS } from "@/lib/applications-list";
import { boardOrder, queueOrder, withShownOrder } from "@/lib/board-order";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { zipPdfsJob } from "@/lib/jobs/zip-pdfs";
import { prisma } from "@/lib/prisma";
import { saveSettings } from "@/lib/settings-data";

/** Remembers how the Applications screen was left (LST-7), for the next visit. */
export const rememberListView = action(
  z.object({
    view: z.enum(VIEWS),
    filter: z.enum(FILTERS.map((filter) => filter.value)),
    sort: z.object({ key: z.enum(SORT_KEYS), reversed: z.boolean() }),
  }),
  async ({ view, filter, sort }) => {
    await saveSettings({
      applicationsView: view,
      applicationsFilter: filter,
      applicationsSort: `${sort.reversed ? "-" : ""}${sort.key}`,
    });
    return null;
  },
);

/**
 * Writes a board column's new order (public issue 60). `ids` are the cards on
 * screen; the whole column gets a place, so what a search or the archive
 * hides stays where it is. Reordering isn't news, so "Updated" stays as it was.
 */
export const reorderBoard = action(
  z.object({
    status: z.enum(ApplicationStatus),
    ids: z.array(z.string().min(1)).min(1),
  }),
  async ({ status, ids }) => {
    const column = await prisma.application.findMany({
      where: { status, awaitingReview: false },
      select: { id: true, boardSort: true, updatedAt: true },
    });
    await prisma.$transaction(
      withShownOrder(column.sort(boardOrder), ids).map(({ id, updatedAt }, boardSort) =>
        prisma.application.updateMany({ where: { id, status }, data: { boardSort, updatedAt } }),
      ),
    );
    revalidatePath("/applications");
    return null;
  },
);

/** Reorders the application queue without changing application statuses or the board order. */
export const reorderQueue = action(z.object({ ids: z.array(z.string().min(1)).min(1) }), async ({ ids }) => {
  if (new Set(ids).size !== ids.length) throw new ActionError("The queue order contains a duplicate application.");
  const all = await prisma.application.findMany({
    where: { awaitingReview: false },
    select: { id: true, queueSort: true, updatedAt: true },
  });
  const knownIds = new Set(all.map(({ id }) => id));
  if (ids.some((id) => !knownIds.has(id))) throw new ActionError("One or more applications are no longer in the queue. Reload and try again.");
  const ordered = withShownOrder([...all].sort(queueOrder), ids);
  await prisma.$transaction(
    ordered.map(({ id, updatedAt }, queueSort) =>
      prisma.application.updateMany({ where: { id, awaitingReview: false }, data: { queueSort, updatedAt } }),
    ),
  );
  revalidatePath("/applications");
  return null;
});

/** Exports only selected applications' resume and cover letter PDFs, never private application research. */
export const startRecipientHandoff = action(
  z.object({ ids: z.array(z.string().min(1)).min(1).max(10) }),
  async ({ ids }) => {
    if (new Set(ids).size !== ids.length) throw new ActionError("Select each application only once.");
    const applications = await prisma.application.findMany({
      where: { id: { in: ids }, awaitingReview: false },
      select: {
        id: true,
        documents: { where: { kind: { in: [DocumentKind.RESUME, DocumentKind.COVER_LETTER] } }, select: { id: true } },
      },
    });
    if (applications.length !== ids.length) throw new ActionError("One or more selected applications are no longer available. Reload the queue.");
    if (applications.some((application) => application.documents.length === 0)) {
      throw new ActionError("Each selected application needs a resume or cover letter before preparing the handoff.");
    }
    const key = `recipient-handoff:${ids.join(",")}`;
    const [running] = await findUnfinishedJobs(key);
    return running?.id ?? startJob(zipPdfsJob, { applicationIds: ids }, { key, ...(ids.length === 1 ? { applicationId: ids[0] } : {}) });
  },
);
