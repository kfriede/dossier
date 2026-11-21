import Link from "next/link";

import type { Triage } from "@/lib/job-search/preferences";

export function PostingTriage({ triage }: { triage: Triage }) {
  return (
    <section aria-label="Search preference triage" className="rounded-card bg-track px-4 py-3 text-meta">
      <p className="font-medium">Suggested: {triage.decision === "apply" ? "Apply" : triage.decision === "skip" ? "Skip" : "Clarify"}</p>
      <ul className="mt-1 list-disc pl-5">
        {triage.reasons.map((reason, index) => <li key={index} className="whitespace-pre-line break-words">{reason}</li>)}
      </ul>
      <p className="mt-2 text-muted">Your decision. <Link href="/settings?section=jobs" className="underline underline-offset-2">Edit search preferences</Link></p>
    </section>
  );
}
