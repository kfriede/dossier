import { describe, expect, it } from "vitest";

import { demoProfile } from "@/lib/demo-profile";
import type { ProfileData } from "@/lib/profile";

import { evidenceFit, evidenceMatchSchema, matchEvidence } from "./evidence";

const today = new Date("2026-10-15T12:00:00Z");
const profile = (): ProfileData => {
  const base = demoProfile();
  return {
    ...base,
    skills: [{ id: "python", name: "Python", group: "" }, { id: "go", name: "Go", group: "" }],
    experience: [
      { ...base.experience[0], id: "relevant", startYear: 2020, startMonth: 1, endYear: 2022, endMonth: 12, current: false, volunteering: false, bullets: "Built Python services", skillIds: ["python"] },
      { ...base.experience[0], id: "overlap", startYear: 2022, startMonth: 1, endYear: 2023, endMonth: 12, current: false, volunteering: false, bullets: "Maintained Python services", skillIds: ["python"] },
      { ...base.experience[0], id: "unrelated", startYear: 2000, startMonth: 1, endYear: 2019, endMonth: 12, current: false, volunteering: false, bullets: "Unrelated work", skillIds: [] },
    ],
    projects: [],
  };
};

describe("evidence-aware matching", () => {
  it("counts only linked duties, merges overlaps, and retains exact source spans", () => {
    const posting = "Requirements:\n- 4+ years of Python\n- Python or Go\n- Must have work authorization";
    const result = matchEvidence(posting, profile(), today);
    const [experience, alternative, eligibility] = result.requirements;
    expect(experience).toMatchObject({ kind: "experience", relevantMonths: 48, status: "supported" });
    expect(experience.evidence.filter((entry) => entry.kind === "duty").map((entry) => entry.id)).toEqual(["relevant", "overlap"]);
    for (const item of result.requirements) expect(posting.slice(item.span.start, item.span.end)).toBe(item.span.text);
    expect(alternative.alternatives.map((item) => posting.slice(item.start, item.end))).toEqual(["Python", "Go"]);
    expect(alternative.status).toBe("supported");
    expect(eligibility).toMatchObject({ kind: "eligibility", status: "unresolved" });
    expect(result.questions).toContain("Can you confirm this eligibility condition: Must have work authorization?");
    expect(evidenceFit(result).score).toBe(100);
    expect(evidenceMatchSchema.safeParse(result).success).toBe(true);
  });

  it("does not count a skill link without a matching duty, volunteering, or imprecise dates", () => {
    const candidate = profile();
    candidate.experience[0].bullets = "Other work";
    candidate.experience[1].volunteering = true;
    candidate.experience[2].skillIds = ["python"];
    candidate.experience[2].bullets = "Python work";
    candidate.experience[2].startMonth = null;
    const result = matchEvidence("Requirements:\n- 1 year of Python", candidate, today);
    expect(result.requirements[0]).toMatchObject({ relevantMonths: 0, status: "unresolved" });
    expect(result.questions).toHaveLength(1);
    expect(evidenceFit(result).score).toBe(0);
  });

  it("keeps qualification alternatives unresolved instead of requiring both or inventing a credential", () => {
    const result = matchEvidence("Qualifications:\n- Bachelor degree or equivalent experience", profile(), today);
    expect(result.requirements[0]).toMatchObject({ kind: "qualification", status: "unresolved" });
    expect(result.requirements[0].alternatives.map((part) => part.text)).toEqual(["Bachelor degree", "equivalent experience"]);
    expect(result.questions).toHaveLength(1);
  });

  it("accepts a specifically evidenced qualification without requiring its alternative", () => {
    const result = matchEvidence("Qualifications:\n- MSc Design for Interaction or equivalent experience", profile(), today);
    expect(result.requirements[0]).toMatchObject({ kind: "qualification", status: "supported", evidence: [{ kind: "education", id: "d1" }] });
    expect(result.questions).toEqual([]);
  });

  it("does not score eligibility as skill coverage", () => {
    const result = matchEvidence("Requirements:\n- Must have work authorization", profile(), today);
    expect(result.requirements[0].kind).toBe("eligibility");
    expect(evidenceFit(result).score).toBe(0);
    expect(result.questions).toHaveLength(1);
  });
});
