import { z } from "zod";

const priority = z.enum(["off", "firm", "prefer", "question"]);

export const searchPreferencesSchema = z.strictObject({
  remote: priority,
  compensation: priority,
  minimumSalary: z.number().int().min(1).max(100_000_000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  travel: priority,
  maxTravelMinutes: z.number().int().min(1).max(1440).nullable(),
  questions: z.string().trim().max(2000),
}).superRefine((value, ctx) => {
  if ((value.compensation === "firm" || value.compensation === "prefer") && value.minimumSalary === null)
    ctx.addIssue({ code: "custom", path: ["minimumSalary"], message: "Enter a minimum annual salary." });
  if ((value.travel === "firm" || value.travel === "prefer") && value.maxTravelMinutes === null)
    ctx.addIssue({ code: "custom", path: ["maxTravelMinutes"], message: "Enter a maximum travel time." });
});
export type SearchPreferences = z.infer<typeof searchPreferencesSchema>;

export const DEFAULT_SEARCH_PREFERENCES: SearchPreferences = {
  remote: "off", compensation: "off", minimumSalary: null, currency: "USD",
  travel: "off", maxTravelMinutes: null, questions: "",
};

export type Triage = { decision: "apply" | "clarify" | "skip"; reasons: string[] };

/** Advisory only: never filters or sorts a posting. */
export function triagePosting(posting: { remote: boolean | null; salary: string }, preferences: SearchPreferences): Triage {
  const reasons: string[] = [];
  let skip = false;
  let clarify = false;
  let checked = false;
  const assess = (priority: SearchPreferences["remote"], outcome: "met" | "missed" | "unknown", message: string) => {
    if (priority === "off") return;
    checked = true;
    const label = priority === "firm" ? "Firm constraint" : priority === "prefer" ? "Preference" : "Unanswered question";
    reasons.push(`${label}: ${message}`);
    if (priority === "question" || outcome === "unknown" || (priority === "prefer" && outcome === "missed")) clarify = true;
    if (priority === "firm" && outcome === "missed") skip = true;
  };
  assess(preferences.remote, posting.remote === null ? "unknown" : posting.remote ? "met" : "missed",
    posting.remote === null ? "Remote work: unknown." : posting.remote ? "Remote work is reported." : "The source reports this is not remote.");

  if (preferences.compensation !== "off") {
    // Only an explicit annual range is comparable. A single amount may be a
    // minimum or maximum, and estimated ranges are not firm evidence.
    const match = /^([A-Z]{3}) ((?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*))–((?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)) a year$/.exec(posting.salary.trim());
    const low = match ? Number(match[2].replaceAll(",", "")) : NaN;
    const high = match ? Number(match[3].replaceAll(",", "")) : NaN;
    const comparable = match && match[1] === preferences.currency && Number.isSafeInteger(low) && Number.isSafeInteger(high) && low > 0 && high >= low && preferences.minimumSalary !== null;
    const outcome = !comparable ? "unknown" : high < preferences.minimumSalary! ? "missed" : low >= preferences.minimumSalary! ? "met" : "unknown";
    assess(preferences.compensation, outcome, !posting.salary.trim() ? "Compensation: unknown; no salary was supplied."
      : outcome === "unknown" ? `Compensation needs clarification: ${posting.salary}.`
      : outcome === "met" ? `The reported annual range meets your minimum: ${posting.salary}.`
      : `The reported annual range is below your minimum: ${posting.salary}.`);
  } else {
    reasons.push(posting.salary.trim() ? `Reported compensation: ${posting.salary}.` : "Compensation: unknown; no salary was supplied.");
  }
  if (preferences.travel !== "off") assess(preferences.travel, "unknown", "Commute and work travel time: unknown; a location does not establish travel time.");
  else reasons.push("Commute and work travel time: unknown.");
  if (preferences.questions) {
    checked = true;
    clarify = true;
    reasons.push(`Your unanswered questions: ${preferences.questions}`);
  }
  if (!checked) return { decision: "clarify", reasons: ["No search preferences set. Review this posting and set preferences if useful.", ...reasons] };
  return { decision: skip ? "skip" : clarify ? "clarify" : "apply", reasons };
}
