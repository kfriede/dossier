import { z } from "zod";

import type { ProfileData } from "@/lib/profile";

const spanSchema = z.object({ text: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine((span) => span.end - span.start === span.text.length);
const evidenceSchema = z.object({
  kind: z.enum(["skill", "duty", "education", "certification", "language", "fact"]),
  id: z.string(),
  source: z.enum(["experience", "project"]).optional(),
  span: spanSchema,
});
const requirementSchema = z.object({
  kind: z.enum(["skill", "experience", "qualification", "eligibility"]),
  importance: z.enum(["required", "preferred"]),
  span: spanSchema,
  alternatives: z.array(spanSchema),
  evidence: z.array(evidenceSchema),
  relevantMonths: z.number().int().nonnegative().nullable(),
  status: z.enum(["supported", "unresolved"]),
});

export const evidenceMatchSchema = z.object({
  requirements: z.array(requirementSchema),
  questions: z.array(z.string()),
});
export type EvidenceMatch = z.infer<typeof evidenceMatchSchema>;
export type RequirementHint = { text: string; importance: "required" | "preferred" };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const contains = (text: string, value: string) => {
  if (!value.trim()) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(value.trim())}(?![\\p{L}\\p{N}])`, "iu").test(text);
};
const makeSpan = (text: string, start: number) => ({ text, start, end: start + text.length });
const dutySpan = (text: string, value: string) => {
  for (const match of text.matchAll(/[^\r\n]+/g)) {
    if (contains(match[0], value)) return makeSpan(match[0], match.index!);
  }
  return null;
};

/** Counts only complete, explicitly dated months from linked paid roles, once each. */
function relevantMonths(roles: ProfileData["experience"], today: Date): number {
  const now = today.getFullYear() * 12 + today.getMonth();
  const months = new Set<number>();
  for (const role of roles) {
    if (role.volunteering || role.startYear === null || role.startMonth === null) continue;
    if (!role.current && (role.endYear === null || role.endMonth === null)) continue;
    const start = role.startYear * 12 + role.startMonth - 1;
    const end = role.current ? now : role.endYear! * 12 + role.endMonth! - 1;
    for (let month = start; month <= Math.min(end, now); month++) months.add(month);
  }
  return months.size;
}

/**
 * Conservative, source-grounded matching. Absence of evidence is not a
 * negative assertion; ambiguous or compound claims require confirmation.
 */
export function matchEvidence(posting: string, profile: ProfileData, today = new Date(), hints: readonly RequirementHint[] = []): EvidenceMatch {
  type Requirement = z.infer<typeof requirementSchema>;
  const requirements: Requirement[] = [];
  let section: "required" | "preferred" | "other" = "other";
  const lines = /[^\r\n]+/g;
  for (const match of posting.matchAll(lines)) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^(?:requirements|qualifications|what you(?:'ll| will) need|required skills|your profile)\s*:?\s*$/i.test(trimmed)) { section = "required"; continue; }
    if (/^(?:preferred|nice to have|bonus|desired)(?: qualifications| skills)?\s*:?\s*$/i.test(trimmed)) { section = "preferred"; continue; }
    if (/^[\p{L} ]+:\s*$/u.test(trimmed)) { section = "other"; continue; }
    const text = trimmed.replace(/^(?:[-*•·▪◦●‣–—]|\d{1,2}[.)])\s+/u, "");
    const start = match.index! + raw.indexOf(text);
    if (text.length < 4 || text.length > 2000) continue;
    const hint = hints.find((item) => item.text.length >= 8 && text.includes(item.text));
    const preferred = /\b(?:preferred|nice to have|a plus|bonus|ideally|desirable)\b/i.test(text) || hint?.importance === "preferred" || section === "preferred";
    const explicit = /\b(?:required|must|need(?:ed)?|require[sd]?|at least|minimum|years? of|experience (?:with|in|of)|proficien(?:t|cy)|degree|certification|authori[sz](?:ed|ation)|work permit|visa|clearance)\b/i.test(text);
    if (!explicit && section === "other" && !preferred && !hint) continue;
    const kind: Requirement["kind"] = /\b(?:work permit|work authori[sz]ation|authori[sz]ed to work|visa|security clearance|right to work|eligible to work|citizenship|based in|located in|relocat(?:e|ion)|on[- ]site)\b/i.test(text)
      ? "eligibility" : /\b(?:years? of|years?['’] experience|years? experience|experience (?:with|in|of))\b/i.test(text)
        ? "experience" : /\b(?:degree|diploma|certification|certificate|bachelor|master|phd|bsc|msc|mba)\b/i.test(text) ? "qualification" : "skill";
    const span = makeSpan(text, start);
    const alternatives: z.infer<typeof spanSchema>[] = [];
    if (/\s+or\s+/i.test(text)) {
      for (const part of text.split(/\s+or\s+/i)) {
        const value = part.trim();
        const offset = text.indexOf(value, alternatives.length ? alternatives[alternatives.length - 1].end - start : 0);
        if (value && offset >= 0) alternatives.push(makeSpan(value, start + offset));
      }
    }
    const evidence: Requirement["evidence"] = [];
    const mentionedSkills = profile.skills.filter((skill) => contains(text, skill.name));
    const roles = profile.experience.filter((role) => mentionedSkills.some((skill) =>
      role.skillIds.includes(skill.id) && contains(role.bullets, skill.name)));
    for (const role of roles) {
      for (const skill of mentionedSkills.filter((item) => role.skillIds.includes(item.id))) {
        const duty = dutySpan(role.bullets, skill.name);
        if (duty) evidence.push({ kind: "duty", id: role.id, source: "experience", span: duty });
      }
    }
    for (const project of profile.projects) {
      for (const skill of mentionedSkills.filter((item) => project.skillIds.includes(item.id))) {
        const duty = dutySpan(project.bullets, skill.name);
        if (duty) evidence.push({ kind: "duty", id: project.id, source: "project", span: duty });
      }
    }
    for (const skill of mentionedSkills) evidence.push({ kind: "skill", id: skill.id, span: makeSpan(skill.name, 0) });
    for (const entry of profile.education) {
      if (contains(text, entry.degree)) evidence.push({ kind: "education", id: entry.id, span: makeSpan(entry.degree, 0) });
    }
    for (const entry of profile.certifications) {
      if (contains(text, entry.name)) evidence.push({ kind: "certification", id: entry.id, span: makeSpan(entry.name, 0) });
    }
    for (const entry of profile.languages) {
      if (contains(text, entry.name)) evidence.push({ kind: "language", id: entry.id, span: makeSpan(entry.name, 0) });
    }
    for (const entry of profile.facts) {
      if (contains(text, entry.text)) evidence.push({ kind: "fact", id: entry.id, span: makeSpan(entry.text, 0) });
    }
    const months = kind === "experience" ? relevantMonths(roles, today) : null;
    const years = /(?:at least\s+|minimum(?: of)?\s+)?(\d+)\s*\+?\s*years?/i.exec(text);
    // A named skill by itself does not establish a compound requirement,
    // proficiency level, degree equivalence or eligibility.
    const compound = /\b(?:and|nor|without|not|fluent|advanced|expert|proficien\w*|level|degree|diploma|bachelor|master|phd)\b/i.test(text);
    const qualificationSupported = evidence.some((item) => item.kind === "education" || item.kind === "certification") &&
      !/\b(?:and|nor|without|not)\b/i.test(text);
    const skillOnly = (value: string) => {
      const bare = value.trim()
        .replace(/^(?:(?:required|preferred)\s*:\s*|(?:you\s+)?(?:must\s+)?(?:know|use|have|knowledge of)\s+)/i, "")
        .replace(/\s*(?:is\s+)?(?:required|preferred|a plus|nice to have)[.!]?\s*$/i, "")
        .replace(/[.!]\s*$/, "").trim();
      return mentionedSkills.some((skill) => bare.localeCompare(skill.name, undefined, { sensitivity: "accent" }) === 0);
    };
    const experienceSpecific = mentionedSkills.some((skill) => new RegExp(
      `^(?:at least\\s+|minimum(?: of)?\\s+)?\\d+\\s*\\+?\\s*years?\\s+(?:of\\s+)?(?:experience\\s+(?:with|in|of)\\s+)?${escape(skill.name)}[.!]?$`, "i",
    ).test(text));
    const supported = kind === "experience"
      ? years !== null && months! >= Number(years[1]) * 12 && roles.length > 0 && !compound && experienceSpecific && alternatives.length === 0
      : kind === "qualification" ? qualificationSupported
      : kind === "skill" && !compound && (alternatives.length ? alternatives.some((item) => skillOnly(item.text)) : skillOnly(text));
    requirements.push({ kind, importance: preferred ? "preferred" : "required", span, alternatives, evidence, relevantMonths: months, status: supported ? "supported" : "unresolved" });
    if (requirements.length === 40) break;
  }
  const questions = requirements.filter((item) => item.status === "unresolved").map((item) =>
    item.kind === "eligibility"
      ? `Can you confirm this eligibility condition: ${item.span.text}?`
      : `Can you provide evidence for: ${item.span.text}?`);
  return evidenceMatchSchema.parse({ requirements, questions });
}

/** The same coverage calculation is used regardless of scoring provider. */
export function evidenceFit(match: EvidenceMatch) {
  const coverage = match.requirements.filter((item) => item.kind !== "eligibility" && item.importance === "required");
  const supported = coverage.filter((item) => item.status === "supported");
  const score = coverage.length ? Math.round(100 * supported.length / coverage.length) : 0;
  return {
    score,
    reasons: supported.length ? supported.slice(0, 4).map((item) => `Evidence found: ${item.span.text}`) : ["No requirements could be confirmed from the available evidence."],
    redFlags: [],
    evidence: match,
  };
}
