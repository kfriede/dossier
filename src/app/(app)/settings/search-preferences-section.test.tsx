import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SEARCH_PREFERENCES } from "@/lib/job-search/preferences";
import { SearchPreferencesSection } from "./search-preferences-section";
import { saveSearchPreferences } from "./actions";

vi.mock("./actions", () => ({ saveSearchPreferences: vi.fn(async (value) => ({ ok: true, data: value })) }));
vi.mock("@/components/toast", () => ({ toastResult: (result: unknown) => result }));

describe("search preferences settings", () => {
  it("validates and saves the choices together", async () => {
    render(<SearchPreferencesSection initial={DEFAULT_SEARCH_PREFERENCES} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Compensation"), "firm");
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a minimum annual salary.");
    expect(saveSearchPreferences).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Minimum annual salary"), "100000");
    await user.selectOptions(screen.getByLabelText("Remote work"), "prefer");
    await user.type(screen.getByLabelText("Other unanswered questions"), "Travel frequency?");
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(saveSearchPreferences).toHaveBeenCalledWith({
      ...DEFAULT_SEARCH_PREFERENCES, compensation: "firm", minimumSalary: 100000, remote: "prefer", questions: "Travel frequency?",
    }));
  });
});
