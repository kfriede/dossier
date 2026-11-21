import { describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_PREFERENCES, searchPreferencesSchema, triagePosting } from "./preferences";

const posting = { remote: true, salary: "USD 100,000–120,000 a year" };
const salary = { ...DEFAULT_SEARCH_PREFERENCES, compensation: "firm" as const, minimumSalary: 110_000 };

describe("search preferences", () => {
  it("validates thresholds and rejects unexpected values", () => {
    expect(searchPreferencesSchema.safeParse({ ...salary, minimumSalary: null }).success).toBe(false);
    expect(searchPreferencesSchema.safeParse({ ...salary, maxTravelMinutes: -1 }).success).toBe(false);
    expect(searchPreferencesSchema.safeParse({ ...salary, currency: "US" }).success).toBe(false);
    expect(searchPreferencesSchema.safeParse({ ...salary, extra: true }).success).toBe(false);
    expect(searchPreferencesSchema.safeParse(salary).success).toBe(true);
  });

  it("uses only a reported annual range, and clarifies overlap or missing evidence", () => {
    expect(triagePosting(posting, salary).decision).toBe("clarify");
    expect(triagePosting({ ...posting, salary: "USD 80,000–100,000 a year" }, salary).decision).toBe("skip");
    expect(triagePosting({ ...posting, salary: "USD 110,000–130,000 a year" }, salary).decision).toBe("apply");
    for (const value of ["", "USD 100,000 a year", "EUR 80,000–100,000 a year", "USD 80,000–100,000 a year (estimated)", "USD 80,000–100,000", "USD 80,000–100,000 an hour"]) {
      expect(triagePosting({ ...posting, salary: value }, salary).decision).toBe("clarify");
    }
  });

  it("distinguishes a firm remote constraint from a preference and an unanswered question", () => {
    const remote = { ...DEFAULT_SEARCH_PREFERENCES, remote: "firm" as const };
    expect(triagePosting({ ...posting, remote: false }, remote).decision).toBe("skip");
    expect(triagePosting({ ...posting, remote: null }, remote).decision).toBe("clarify");
    expect(triagePosting(posting, remote).decision).toBe("apply");
    expect(triagePosting({ ...posting, remote: false }, { ...remote, remote: "prefer" }).decision).toBe("clarify");
    expect(triagePosting(posting, { ...remote, remote: "question" }).decision).toBe("clarify");
  });

  it("never infers travel time and retains unknowns even when a constraint fails", () => {
    const preferences = { ...salary, travel: "firm" as const, maxTravelMinutes: 45 };
    const result = triagePosting({ remote: false, salary: "USD 50,000–70,000 a year" }, preferences);
    expect(result.decision).toBe("skip");
    expect(result.reasons.join(" ")).toContain("travel time: unknown");
    expect(triagePosting(posting, { ...preferences, compensation: "off" }).decision).toBe("clarify");
    expect(triagePosting(posting, { ...DEFAULT_SEARCH_PREFERENCES, questions: "How much travel?" }).decision).toBe("clarify");
  });
});
