import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentKind } from "@/generated/prisma/enums";

import { DocumentProposalReview, type DocumentProposalView } from "./document-proposal-review";

const actions = vi.hoisted(() => ({
  approve: vi.fn(async () => ({ ok: true, data: { result: "approved" }, toast: "Proposal approved." })),
  reject: vi.fn(async () => ({ ok: true, data: null, toast: "Proposal rejected." })),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("./actions", () => ({
  approveDocumentProposal: actions.approve,
  rejectDocumentProposal: actions.reject,
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const proposals: DocumentProposalView[] = [{
  id: "proposal-1",
  kind: DocumentKind.RESUME,
  currentUnits: [{ id: "summary", label: "Summary", text: "Current summary." }],
  proposedUnits: [{ id: "summary", label: "Summary", text: "Proposed summary." }],
  sourceContext: { source: "connector", url: "https://jobs.example/role", posting_revision: "sha256:posting" },
  warnings: ["Check the proposed claim."],
  createdAt: "2026-11-11T12:00:00.000Z",
}];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DocumentProposalReview", () => {
  it("shows the current and proposed text, source, and warnings before approval", async () => {
    const user = userEvent.setup();
    render(<DocumentProposalReview applicationId="app-1" proposals={proposals} />);

    expect(screen.getByText("Current summary.")).toBeInTheDocument();
    expect(screen.getByText("Proposed summary.")).toBeInTheDocument();
    expect(screen.getByText(/connector-supplied source details are unverified/i)).toBeInTheDocument();
    expect(screen.getByText("Check the proposed claim.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve changes" }));

    await waitFor(() => {
      expect(actions.approve).toHaveBeenCalledWith({ id: "app-1", proposalId: "proposal-1" });
      expect(router.refresh).toHaveBeenCalledOnce();
    });
  });

  it("rejects a proposal and refreshes the application", async () => {
    const user = userEvent.setup();
    render(<DocumentProposalReview applicationId="app-1" proposals={proposals} />);

    await user.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(actions.reject).toHaveBeenCalledWith({ id: "app-1", proposalId: "proposal-1" });
      expect(router.refresh).toHaveBeenCalledOnce();
    });
  });

  it("supports approving a proposal from the keyboard", async () => {
    const user = userEvent.setup();
    render(<DocumentProposalReview applicationId="app-1" proposals={proposals} />);

    await user.tab();
    expect(screen.getByRole("button", { name: "Approve changes" })).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(actions.approve).toHaveBeenCalledWith({ id: "app-1", proposalId: "proposal-1" });
      expect(router.refresh).toHaveBeenCalledOnce();
    });
  });
});
