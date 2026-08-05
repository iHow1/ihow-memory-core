// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// ONE canonical calendar-day stamp. Full timestamps (the `at`/`created_at`/`promoted_at`
// instants) stay UTC ISO everywhere — they are points in time and UTC is the correct,
// unambiguous basis for ordering. But the human-facing calendar DAY used for day-grouped
// file names and headings (the journal `YYYY-MM-DD.md`, the event-log `YYYY-MM-DD.ndjson`,
// the journal front-matter `date:` and `--since` filter) must match the wall clock the user
// reads, and the dated daily-memory convention (`memory/YYYY-MM-DD.md`) other agents write.
//
// The old code derived the day via `new Date().toISOString().slice(0,10)`, which is UTC: every
// write after ~17:00 in a UTC-7 zone landed in TOMORROW's file. For a product whose rule is
// "prefer newer-dated memory for live state" that systematically promoted this-evening's work
// above tomorrow-morning's and surfaced a "future" journal as the freshest truth. Use localDay()
// for every day-grouping; never re-derive a day from toISOString().slice(0,10).
//
// Timezone resolution: the OS local zone by default; override with IHOW_MEMORY_TZ (an IANA name
// like "America/Los_Angeles") so headless/cron runtimes can pin a zone explicitly.

// Returns the local calendar day as YYYY-MM-DD.
export function localDay(date: Date = new Date()): string {
  const tz = process.env.IHOW_MEMORY_TZ;
  if (tz) {
    try {
      // en-CA renders as YYYY-MM-DD; timeZone pins the zone deterministically.
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
    } catch {
      // A bad IHOW_MEMORY_TZ value (typo, trailing space) or a minimal-ICU Node build throws RangeError.
      // localDay is on EVERY journal/event write path, so it must NEVER throw — fall back to the OS local
      // day below rather than break (and silently lose) writes.
    }
  }
  // Local components — no locale/ICU dependency, always YYYY-MM-DD.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
