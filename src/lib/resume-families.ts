import { z } from "zod";

export const resumeFamilySchema = z.enum([
  "general",
  "design",
  "engineering",
  "product",
  "data",
  "marketing",
  "operations",
]);
export type ResumeFamily = z.infer<typeof resumeFamilySchema>;

export const RESUME_FAMILY_OPTIONS: { value: ResumeFamily; label: string; focus: string }[] = [
  { value: "general", label: "General", focus: "balance the most relevant evidence across the candidate's experience" },
  { value: "design", label: "Product and design", focus: "user needs, research, interaction and visual design, accessibility, design systems, and shipped outcomes" },
  { value: "engineering", label: "Software and engineering", focus: "technical decisions, implementation, architecture, reliability, and measurable delivery" },
  { value: "product", label: "Product management", focus: "product strategy, discovery, prioritization, cross-functional leadership, and customer or business outcomes" },
  { value: "data", label: "Data and analytics", focus: "analysis, metrics, experimentation, data quality, and decisions supported by evidence" },
  { value: "marketing", label: "Marketing and communications", focus: "audience insight, positioning, content, channels, and measurable campaign outcomes" },
  { value: "operations", label: "Operations and customer work", focus: "service quality, process improvement, customer outcomes, coordination, and operational reliability" },
];

export function resumeFamilyFocus(value: ResumeFamily): string {
  return RESUME_FAMILY_OPTIONS.find((option) => option.value === value)!.focus;
}

export function resumeFamilyLabel(value: ResumeFamily): string {
  return RESUME_FAMILY_OPTIONS.find((option) => option.value === value)!.label;
}
