import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiError } from "@/lib/ai/errors";
import { MockProvider } from "@/lib/ai/providers/mock";
import { demoProfile } from "@/lib/demo-profile";
import type { ProfileData } from "@/lib/profile";

import type { ScoringConfig } from "./config";
import { loadPostingScorer, scoringProblem } from "./index";

const state = vi.hoisted(() => ({
  config: { scorer: "AI", saved: false, key: null, keyState: "none" } as ScoringConfig,
  aiReady: true,
  provider: null as unknown,
}));

vi.mock("./config", async (importOriginal) => ({ ...(await importOriginal<typeof import("./config")>()), loadScoringConfig: async () => state.config }));
vi.mock("@/lib/ai/config", () => ({ isAiConfigured: async () => state.aiReady }));
vi.mock("@/lib/ai", () => ({ getAiProvider: async () => state.provider }));
vi.mock("@/lib/ai/task-options", () => ({ loadTaskOptions: async () => ({ creativity: "BALANCED", strict: true, language: null }) }));
vi.mock("@/lib/usage-data", () => ({ recordUsage: vi.fn() }));
vi.mock("./jev", () => ({
  scoreWithJev: vi.fn(async (posting: { description: string }, profile: ProfileData) => {
    const { evidenceFit, matchEvidence } = await import("./evidence");
    return { data: evidenceFit(matchEvidence(posting.description, profile)), scoredWith: "score-posting-jev@1 (jev-1.14.0)" };
  }),
}));

const { scoreWithJev } = await import("./jev");
const { recordUsage } = await import("@/lib/usage-data");

const profile = demoProfile();
const posting = { title: "Designer", company: "Ledgerly", place: "Amsterdam", remote: false, salary: "", description: "Requirements:\n- Figma" };
const signal = new AbortController().signal;

beforeEach(() => {
  state.config = { scorer: "AI", saved: false, key: null, keyState: "none" };
  state.aiReady = true;
  vi.mocked(scoreWithJev).mockClear();
});

describe("scoringProblem (#274)", () => {
  it("asks for an AI provider, or for Jev's key, whichever scores", async () => {
    expect(await scoringProblem()).toBeNull();
    state.aiReady = false;
    expect(await scoringProblem()).toBe("Choose an AI provider in Settings → AI provider first.");

    state.config = { scorer: "JEV", saved: true, key: null, keyState: "none" };
    expect(await scoringProblem()).toBe("Enter your TypeSafe key in Settings → Scoring first.");
    expect(await scoringProblem({ ...state.config, key: "ts", keyState: "set" })).toBeNull();
  });
});

describe("loadPostingScorer", () => {
  it("scores with Jev and its key once chosen, without the AI provider", async () => {
    state.config = { scorer: "JEV", saved: true, key: "ts", keyState: "set" };
    state.aiReady = false;
    const score = await loadPostingScorer();
    expect(await score(posting, profile, signal)).toMatchObject({ data: { score: 100, evidence: { requirements: [{ status: "supported" }] } }, scoredWith: "score-posting-jev@1 (jev-1.14.0)" });
    // Jev's tokens go to the Usage screen (#290).
    expect(scoreWithJev).toHaveBeenCalledWith(posting, profile, { key: "ts", signal, onUsage: recordUsage });
  });

  it("scores with the AI model's score-posting otherwise, keeping its prompt version", async () => {
    const provider = new MockProvider({ reply: () => ({ score: 72, reasons: ["Knows Figma."], redFlags: [] }) });
    state.provider = provider;
    const score = await loadPostingScorer();
    expect(await score(posting, profile, signal)).toMatchObject({ data: { score: 100, evidence: { requirements: [{ status: "supported" }] } }, scoredWith: "score-posting@3" });
    expect(provider.calls[0].messages[0].content).toContain("Ledgerly: Designer");
    expect(scoreWithJev).not.toHaveBeenCalled();
  });

  it("uses the same evidence and eligibility rules for either provider", async () => {
    const description = "Requirements:\n- Figma\n- Must have work authorization\n- Bachelor degree or equivalent experience";
    state.provider = new MockProvider({ reply: () => ({ score: 99, reasons: ["Unverified."], redFlags: [] }) });
    const ai = await (await loadPostingScorer())({ ...posting, description }, profile, signal);
    state.config = { scorer: "JEV", saved: true, key: "ts", keyState: "set" };
    const jev = await (await loadPostingScorer())({ ...posting, description }, profile, signal);
    expect(ai.data).toEqual(jev.data);
    expect(ai.data.evidence?.requirements.map((item) => item.kind)).toEqual(["skill", "eligibility", "qualification"]);
    expect(ai.data.evidence?.questions).toHaveLength(2);
  });

  it("fails with what's missing", async () => {
    state.aiReady = false;
    await expect(loadPostingScorer()).rejects.toThrow(new AiError("config", "Choose an AI provider in Settings → AI provider first."));
    state.config = { scorer: "JEV", saved: true, key: null, keyState: "unreadable" };
    await expect(loadPostingScorer()).rejects.toThrow("Your saved TypeSafe key can't be read. Enter it again in Settings → Scoring.");
  });
});
