import { describe, expect, it } from "vitest";

import { RESUME_FAMILY_OPTIONS, resumeFamilyFocus, resumeFamilyLabel } from "./resume-families";

describe("resume family presets", () => {
  it("offers a general option and role-family emphasis without changing profile facts", () => {
    expect(RESUME_FAMILY_OPTIONS[0]).toMatchObject({ value: "general", label: "General" });
    expect(resumeFamilyFocus("design")).toContain("design systems");
    expect(resumeFamilyFocus("engineering")).toContain("architecture");
    expect(resumeFamilyLabel("data")).toBe("Data and analytics");
  });
});
