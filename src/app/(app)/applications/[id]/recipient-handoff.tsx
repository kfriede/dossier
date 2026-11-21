"use client";

import { useState, useTransition } from "react";

import { toast } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { useJob } from "@/hooks/use-job";

import { startRecipientHandoff } from "../actions";

type HandoffResult = { file: string; fileName: string; documents: number };

export function RecipientHandoff({ applicationIds }: { applicationIds: string[] }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, startTransition] = useTransition();
  const job = useJob<HandoffResult>(jobId, 0, (update) => {
    if (update.status === "FAILED") toast(update.error ?? "The handoff couldn't be prepared. Try again.");
  });
  const busy = starting || (jobId !== null && job?.status !== "DONE" && job?.status !== "FAILED");

  const prepare = () =>
    startTransition(async () => {
      const result = await startRecipientHandoff({ ids: applicationIds });
      if (!result.ok) return toast(result.error);
      setJobId(result.data);
    });

  if (job?.status === "DONE" && job.result) {
    return (
      <a href={`/api/downloads/${job.id}`} download className={buttonClassName("secondary", "sm")}>
        Download handoff
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="sm" disabled={busy || applicationIds.length === 0} onClick={prepare}>
        {busy ? "Preparing…" : "Prepare handoff"}
      </Button>
      {busy && job?.step && <span role="status" className="text-meta text-muted">{job.step}…</span>}
    </div>
  );
}
