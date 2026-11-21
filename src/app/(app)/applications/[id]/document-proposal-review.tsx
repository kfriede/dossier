"use client";

import { useRouter } from "next/navigation";
import { useId, useTransition } from "react";

import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { DocumentKind } from "@/generated/prisma/enums";
import type { Unit } from "@/lib/application-data";
import type { ProposalSourceContext } from "@/lib/connector/proposals";

import { approveDocumentProposal, rejectDocumentProposal } from "./actions";

export type DocumentProposalView = {
  id: string;
  kind: DocumentKind;
  currentUnits: Unit[];
  proposedUnits: Unit[];
  sourceContext: ProposalSourceContext;
  warnings: string[];
  createdAt: string;
};

function changesFor(current: Unit[], proposed: Unit[]) {
  const before = new Map(current.map((unit) => [unit.id, unit]));
  const after = new Map(proposed.map((unit) => [unit.id, unit]));
  const ids = [...new Set([...current.map((unit) => unit.id), ...proposed.map((unit) => unit.id)])];
  return ids.flatMap((id) => {
    const oldUnit = before.get(id);
    const newUnit = after.get(id);
    if (oldUnit?.text === newUnit?.text && oldUnit?.label === newUnit?.label) return [];
    return [{ id, label: newUnit?.label ?? oldUnit?.label ?? id, oldText: oldUnit?.text, newText: newUnit?.text }];
  });
}

export function DocumentProposalReview({
  applicationId,
  proposals,
}: {
  applicationId: string;
  proposals: DocumentProposalView[];
}) {
  const router = useRouter();
  const titleId = useId();
  const [pending, startTransition] = useTransition();

  if (proposals.length === 0) return null;

  const review = (proposalId: string, decision: "approve" | "reject") => {
    startTransition(async () => {
      const result =
        decision === "approve"
          ? await approveDocumentProposal({ id: applicationId, proposalId })
          : await rejectDocumentProposal({ id: applicationId, proposalId });
      if (toastResult(result).ok) router.refresh();
    });
  };

  return (
    <section aria-labelledby={titleId} aria-busy={pending || undefined} className="flex w-full max-w-[640px] flex-col gap-4 rounded-panel border border-warning-line bg-warning-surface px-5 py-5">
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-[15px] font-medium">
          Proposed document update
        </h2>
        <p className="text-sm text-muted">
          Review the changes before applying them. Your current document stays as-is until you approve a proposal.
        </p>
      </div>
      {proposals.map((proposal) => {
        const changes = changesFor(proposal.currentUnits, proposal.proposedUnits);
        const documentName = proposal.kind === DocumentKind.RESUME ? "Resume" : "Cover letter";
        return (
          <article key={proposal.id} className="flex flex-col gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="text-sm font-medium">{documentName}</h3>
              <time className="text-meta text-muted" dateTime={proposal.createdAt}>
                Proposed {proposal.createdAt.slice(0, 10)}
              </time>
            </div>
            <p className="text-sm text-muted">
              Source: {proposal.sourceContext.source || "external"}. Connector-supplied source details are unverified.
              {proposal.sourceContext.url ? ` ${proposal.sourceContext.url}` : ""}
            </p>
            {proposal.warnings.length > 0 && (
              <div className="flex flex-col gap-1 rounded-card border border-warning-line px-3 py-2 text-sm text-warning">
                <h4 className="font-medium">Review these claims</h4>
                <ul className="list-disc space-y-1 pl-5">
                  {proposal.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
                </ul>
              </div>
            )}
            {changes.length > 0 ? (
              <ul aria-label={`${documentName} changes`} className="flex flex-col gap-2">
                {changes.map((change) => (
                  <li key={change.id} className="flex flex-col gap-1 rounded-card border border-line-card bg-card px-3 py-2.5 text-sm">
                    <h4 className="font-medium">{change.label}</h4>
                    {change.oldText !== undefined && (
                      <p className="whitespace-pre-wrap text-muted">
                        <span className="font-medium text-ink">Current: </span>
                        {change.oldText || "(empty)"}
                      </p>
                    )}
                    {change.newText !== undefined && (
                      <p className="whitespace-pre-wrap text-ink">
                        <span className="font-medium">Proposed: </span>
                        {change.newText || "(empty)"}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">The proposal has no text changes.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={() => review(proposal.id, "approve")}>
                Approve changes
              </Button>
              <Button variant="secondary" size="sm" disabled={pending} onClick={() => review(proposal.id, "reject")}>
                Reject
              </Button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
