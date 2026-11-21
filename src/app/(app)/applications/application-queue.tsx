"use client";

import Link from "next/link";
import { useState } from "react";

import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusDot } from "@/components/ui/status-dot";
import type { ApplicationRow } from "@/lib/applications-data";
import { statusLabel } from "@/lib/applications-list";

import { RecipientHandoff } from "./[id]/recipient-handoff";

const MAX_HANDOFF_APPLICATIONS = 10;

export function ApplicationQueue({ rows, onReorder }: { rows: ApplicationRow[]; onReorder: (rows: ApplicationRow[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const handoffIds = rows.filter((row) => selected.includes(row.id)).map((row) => row.id);
  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      if (!checked) return current.filter((entry) => entry !== id);
      if (current.length >= MAX_HANDOFF_APPLICATIONS) {
        toast(`Choose up to ${MAX_HANDOFF_APPLICATIONS} applications for one handoff.`);
        return current;
      }
      return [...current, id];
    });
  };
  const move = (index: number, direction: -1 | 1) => {
    const next = [...rows];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next);
  };

  return (
    <section className="mx-10 mb-16 overflow-hidden rounded-panel border border-line-card bg-card" aria-label="Application queue">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-field font-medium">Priority order</h2>
          <p className="mt-1 text-meta text-muted">Move applications to set the order you want to work through. Statuses do not change.</p>
        </div>
        {selected.length > 0 && (
          <div className="flex flex-col items-start gap-1">
            <RecipientHandoff applicationIds={handoffIds} />
            <span className="text-meta text-muted">Only resumes and cover letters are included; notes and job research stay private.</span>
          </div>
        )}
      </div>
      <ol className="divide-y divide-line">
        {rows.map((row, index) => {
          const label = [row.role, row.company].filter(Boolean).join(", ");
          return (
            <li key={row.id} className="flex items-center gap-3 px-4 py-3.5">
              <Checkbox
                label={`Include ${label} in recipient handoff`}
                checked={selected.includes(row.id)}
                disabled={!row.hasRecipientDocuments}
                onChange={(event) => toggle(row.id, event.target.checked)}
                hint={!row.hasRecipientDocuments ? "Write a resume or cover letter first." : undefined}
                className="min-w-0 flex-1"
              />
              <Link href={`/applications/${row.id}`} className="min-w-0 flex-[2]">
                <span className="block truncate text-sm font-medium text-ink">{row.role}</span>
                <span className="block truncate text-meta text-muted">{row.company || "Company not given"}</span>
              </Link>
              <span className="flex w-28 shrink-0 items-center gap-2 text-meta text-muted">
                <StatusDot status={row.status} />
                {statusLabel(row.status)}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="text"
                  size="sm"
                  aria-label={`Move ${label} up in queue`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  variant="text"
                  size="sm"
                  aria-label={`Move ${label} down in queue`}
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
