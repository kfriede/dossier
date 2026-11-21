"use client";

import { useState, type FormEvent } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { searchPreferencesSchema, type SearchPreferences } from "@/lib/job-search/preferences";

import { saveSearchPreferences } from "./actions";

export function SearchPreferencesSection({ initial }: { initial: SearchPreferences }) {
  const [values, setValues] = useState(initial);
  const [salary, setSalary] = useState(initial.minimumSalary?.toString() ?? "");
  const [travel, setTravel] = useState(initial.maxTravelMinutes?.toString() ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const track = useTrackSave();
  const set = (patch: Partial<SearchPreferences>) => setValues((current) => ({ ...current, ...patch }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = searchPreferencesSchema.safeParse({
      ...values, currency: values.currency.trim().toUpperCase(),
      minimumSalary: salary.trim() === "" ? null : Number(salary),
      maxTravelMinutes: travel.trim() === "" ? null : Number(travel),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your preferences.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const result = toastResult(await track(saveSearchPreferences(parsed.data)));
      if (result.ok) setValues(result.data);
    } finally {
      setSaving(false);
    }
  };
  const options = <>
    <option value="off">Not considered</option>
    <option value="firm">Firm constraint</option>
    <option value="prefer">Preference</option>
    <option value="question">Unanswered question</option>
  </>;

  return (
    <Card>
      <form onSubmit={save} className="flex flex-col gap-5">
        <div>
          <h3 className="font-serif text-section">Search preferences</h3>
          <p className="mt-1 text-sm text-muted">Triage is advice only. It won&apos;t filter postings, reorder your work, or change agent behavior. Unknowns stay open for you to check.</p>
        </div>
        <Select label="Remote work" value={values.remote} onChange={(event) => set({ remote: event.target.value as SearchPreferences["remote"] })}>{options}</Select>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Compensation" value={values.compensation} onChange={(event) => set({ compensation: event.target.value as SearchPreferences["compensation"] })}>{options}</Select>
          <Input label="Minimum annual salary" type="number" min="1" max="100000000" step="1" value={salary} onChange={(event) => setSalary(event.target.value)} />
          <Input label="Currency code" hint="Three-letter code, such as USD or EUR." maxLength={3} value={values.currency} onChange={(event) => set({ currency: event.target.value })} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Commute or work travel time" value={values.travel} onChange={(event) => set({ travel: event.target.value as SearchPreferences["travel"] })}>{options}</Select>
          <Input label="Maximum travel time in minutes" type="number" min="1" max="1440" step="1" value={travel} onChange={(event) => setTravel(event.target.value)} />
        </div>
        <Textarea label="Other unanswered questions" hint="These are reminders to investigate, not automatic checks." maxLength={2000} value={values.questions} onChange={(event) => set({ questions: event.target.value })} />
        {error && <p role="alert" className="text-sm text-error">{error}</p>}
        <Button type="submit" className="self-start" disabled={saving}>{saving ? "Saving…" : "Save preferences"}</Button>
      </form>
    </Card>
  );
}
