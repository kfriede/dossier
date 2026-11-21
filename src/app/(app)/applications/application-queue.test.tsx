import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ApplicationRow } from "@/lib/applications-data";

import { startRecipientHandoff } from "./actions";
import { ApplicationQueue } from "./application-queue";

vi.mock("@/hooks/use-job", () => ({ useJob: () => null }));
vi.mock("./actions", () => ({
  startRecipientHandoff: vi.fn(async () => ({ ok: true, data: "job-1" })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn() }));

const row = (id: string, extra: Partial<ApplicationRow> = {}): ApplicationRow => ({
  id,
  score: null,
  company: "Acme",
  role: id,
  location: "",
  mode: "",
  status: "DRAFT",
  archived: false,
  deadline: null,
  match: null,
  sent: null,
  updated: "Today",
  updatedAt: 1,
  boardSort: null,
  queueSort: null,
  hasRecipientDocuments: true,
  ...extra,
});

describe("application priority queue", () => {
  it("reorders by the accessible move controls without changing status", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    render(<ApplicationQueue rows={[row("First"), row("Second", { status: "SENT" })]} onReorder={onReorder} />);

    await user.click(screen.getByRole("button", { name: "Move Second, Acme up in queue" }));

    expect(onReorder).toHaveBeenCalledWith([expect.objectContaining({ id: "Second", status: "SENT" }), expect.objectContaining({ id: "First", status: "DRAFT" })]);
  });

  it("selects only applications with recipient documents and caps a handoff at ten", async () => {
    const user = userEvent.setup();
    render(
      <ApplicationQueue
        rows={[
          row("Available"),
          row("Second"),
          row("Missing", { hasRecipientDocuments: false }),
        ]}
        onReorder={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Include Missing, Acme in recipient handoff" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Include Second, Acme in recipient handoff" }));
    await user.click(screen.getByRole("checkbox", { name: "Include Available, Acme in recipient handoff" }));
    expect(screen.getByText("Only resumes and cover letters are included; notes and job research stay private.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare handoff" }));
    await waitFor(() => expect(startRecipientHandoff).toHaveBeenCalledWith({ ids: ["Available", "Second"] }));
  });
});
