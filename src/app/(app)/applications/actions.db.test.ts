import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

const jobs = vi.hoisted(() => ({
  findUnfinishedJobs: vi.fn(async () => []),
  startJob: vi.fn(async () => "handoff-job"),
}));
vi.mock("@/lib/jobs/runner", () => ({
  ...jobs,
  defineJob: <T,>(definition: T) => definition,
}));

import { rememberListView, reorderBoard, reorderQueue, startRecipientHandoff } from "./actions";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ persistent: false, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const prisma = () => db.client!;

beforeEach(async () => {
  await resetDatabase(prisma());
  jobs.findUnfinishedJobs.mockClear();
  jobs.startJob.mockClear();
});
afterAll(() => prisma().$disconnect());

describe("rememberListView (E9-4)", () => {
  it("starts from the board, all applications, latest update first", async () => {
    expect(await loadSettings()).toMatchObject({ applicationsView: "board", applicationsFilter: "all", applicationsSort: "updated" });
  });

  it("saves the view, filter and sort in Settings", async () => {
    expect(await rememberListView({ view: "table", filter: "closed", sort: { key: "match", reversed: true } })).toEqual({ ok: true, data: null });
    expect(await loadSettings()).toMatchObject({ applicationsView: "table", applicationsFilter: "closed", applicationsSort: "-match" });
  });

  it("refuses what the list doesn't know", async () => {
    expect(await rememberListView({ view: "grid" as "board", filter: "all", sort: { key: "updated", reversed: false } })).toMatchObject({ ok: false });
  });
});

describe("reorderBoard (public issue 60)", () => {
  const places = async () => {
    const rows = await prisma().application.findMany({ orderBy: { id: "asc" }, select: { id: true, boardSort: true } });
    return Object.fromEntries(rows.map((row) => [row.id, row.boardSort]));
  };

  // Newest first: a, b, c.
  beforeEach(() =>
    prisma().application.createMany({
      data: ["a", "b", "c"].map((id, index) => ({ id, status: "SENT" as const, updatedAt: new Date(Date.UTC(2026, 8, 27, 12, 30 - index)) })),
    }),
  );

  it("gives the column its new places and leaves other columns alone", async () => {
    await prisma().application.create({ data: { id: "draft", status: "DRAFT" } });
    expect(await reorderBoard({ status: "SENT", ids: ["c", "a", "b"] })).toEqual({ ok: true, data: null });
    expect(await places()).toEqual({ c: 0, a: 1, b: 2, draft: null });
  });

  describe("reorderQueue", () => {
    beforeEach(async () => {
      await prisma().application.deleteMany({ where: { id: { in: ["a", "b", "c"] } } });
      await prisma().application.createMany({
        data: [
          { id: "a", status: "DRAFT", updatedAt: new Date("2026-09-27T12:30:00Z") },
          { id: "b", status: "SENT", updatedAt: new Date("2026-09-27T12:29:00Z") },
          { id: "c", status: "OFFER", updatedAt: new Date("2026-09-27T12:28:00Z") },
          { id: "archived", status: "DRAFT", archivedAt: new Date("2026-09-27T12:00:00Z"), updatedAt: new Date("2026-09-27T12:00:00Z") },
          { id: "agent-review", status: "DRAFT", awaitingReview: true, updatedAt: new Date("2026-09-27T12:31:00Z") },
        ],
      });
    });

    it("persists one priority across statuses, preserving hidden and archived applications", async () => {
      const updatedBefore = await prisma().application.findMany({ select: { id: true, updatedAt: true } });
      expect(await reorderQueue({ ids: ["c", "a"] })).toEqual({ ok: true, data: null });
      const rows = await prisma().application.findMany({ orderBy: { queueSort: "asc" }, select: { id: true, status: true, queueSort: true, updatedAt: true } });
      expect(rows.filter((row) => row.id !== "agent-review").map(({ id, queueSort }) => [id, queueSort])).toEqual([
        ["c", 0],
        ["b", 1],
        ["a", 2],
        ["archived", 3],
      ]);
      expect(rows.find(({ id }) => id === "agent-review")?.queueSort).toBeNull();
      expect(rows.filter(({ id }) => ["a", "b", "c"].includes(id)).map(({ id, status }) => [id, status])).toEqual([
        ["c", "OFFER"],
        ["b", "SENT"],
        ["a", "DRAFT"],
      ]);
      const updatedAfter = await prisma().application.findMany({ select: { id: true, updatedAt: true } });
      expect(Object.fromEntries(updatedAfter.map(({ id, updatedAt }) => [id, updatedAt.toISOString()]))).toEqual(
        Object.fromEntries(updatedBefore.map(({ id, updatedAt }) => [id, updatedAt.toISOString()])),
      );
    });

    describe("startRecipientHandoff", () => {
      it("exports only a selected application's recipient documents", async () => {
        await prisma().application.create({
          data: { id: "handoff", documents: { create: [{ kind: "RESUME", units: [] }, { kind: "EMAIL", units: [] }] } },
        });

        expect(await startRecipientHandoff({ ids: ["handoff"] })).toEqual({ ok: true, data: "handoff-job" });
        expect(jobs.startJob).toHaveBeenCalledWith(
          expect.objectContaining({ type: "zip-pdfs" }),
          { applicationIds: ["handoff"] },
          { key: "recipient-handoff:handoff", applicationId: "handoff" },
        );
      });

      it("rejects selections without recipient documents", async () => {
        await prisma().application.create({ data: { id: "no-documents" } });
        expect(await startRecipientHandoff({ ids: ["no-documents"] })).toMatchObject({
          ok: false,
          error: "Each selected application needs a resume or cover letter before preparing the handoff.",
        });
      });
    });

    it("rejects duplicate or unknown application ids", async () => {
      expect(await reorderQueue({ ids: ["a", "a"] })).toMatchObject({ ok: false });
      expect(await reorderQueue({ ids: ["missing"] })).toMatchObject({ ok: false });
    });
  });

  it("keeps each card's Updated, since reordering isn't news", async () => {
    const updated = () => prisma().application.findMany({ orderBy: { id: "asc" }, select: { id: true, updatedAt: true } });
    const before = await updated();
    await reorderBoard({ status: "SENT", ids: ["c", "b", "a"] });
    expect(await updated()).toEqual(before);
  });

  it("leaves a card that a search hides in its place", async () => {
    await reorderBoard({ status: "SENT", ids: ["c", "a"] });
    expect(await places()).toEqual({ c: 0, b: 1, a: 2 });
  });

  it("leaves alone a card that has moved to another column since", async () => {
    await prisma().application.update({ where: { id: "c" }, data: { status: "SCREENING" } });
    await reorderBoard({ status: "SENT", ids: ["c", "b", "a"] });
    expect(await places()).toEqual({ b: 0, a: 1, c: null });
  });

  it("refuses an empty order", async () => {
    expect(await reorderBoard({ status: "SENT", ids: [] })).toMatchObject({ ok: false });
  });
});
