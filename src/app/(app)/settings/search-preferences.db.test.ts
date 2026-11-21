import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SEARCH_PREFERENCES } from "@/lib/job-search/preferences";
import { loadSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";
import { saveSearchPreferences } from "./actions";

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

beforeEach(async () => resetDatabase(db.client!));
afterAll(async () => db.client?.$disconnect());

describe("saveSearchPreferences", () => {
  it("persists validated preferences and rejects invalid changes", async () => {
    const preferences = { ...DEFAULT_SEARCH_PREFERENCES, remote: "firm" as const, compensation: "prefer" as const, minimumSalary: 100000 };
    expect(await saveSearchPreferences(preferences)).toMatchObject({ ok: true });
    expect((await loadSettings()).searchPreferences).toEqual(preferences);
    expect(await saveSearchPreferences({ ...preferences, minimumSalary: -1 })).toMatchObject({ ok: false });
    expect((await loadSettings()).searchPreferences).toEqual(preferences);
  });
});
