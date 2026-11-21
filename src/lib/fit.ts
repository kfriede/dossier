// How well a posting fits the profile (#208, E16-2): a score from
// score-posting, with why. Shared by Find jobs and the Agent screen.

import type { EvidenceMatch } from "@/lib/scoring/evidence";

export type PostingFit = { score: number; reasons: string[]; redFlags: string[]; evidence?: EvidenceMatch };

/** The score's band, as the prompt defines them: "Good fit". */
export function fitBand(score: number): string {
  if (score >= 85) return "Excellent fit";
  if (score >= 70) return "Good fit";
  if (score >= 50) return "Possible fit";
  return "Poor fit";
}
