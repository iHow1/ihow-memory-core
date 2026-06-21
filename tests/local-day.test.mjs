// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// localDay() — the canonical calendar-day stamp. Regression for the UTC forward-dating bug: the old
// code derived the day via `new Date().toISOString().slice(0,10)` (UTC), so every write after ~17:00
// in a UTC-7 zone landed in TOMORROW's journal/event file. localDay() must return the LOCAL day that
// matches the wall clock the user reads, with an IHOW_MEMORY_TZ override for headless runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localDay } from '../src/time.ts';

test('localDay uses the IHOW_MEMORY_TZ zone, not UTC — the evening forward-date is fixed', () => {
  const prev = process.env.IHOW_MEMORY_TZ;
  try {
    // 2026-06-21T01:30:00Z == 2026-06-20 18:30 in America/Los_Angeles (UTC-7).
    const eveningInstant = new Date('2026-06-21T01:30:00Z');
    // The OLD (buggy) basis:
    assert.equal(eveningInstant.toISOString().slice(0, 10), '2026-06-21', 'UTC prefix is the bug');
    // The FIX:
    process.env.IHOW_MEMORY_TZ = 'America/Los_Angeles';
    assert.equal(localDay(eveningInstant), '2026-06-20', 'local day matches the wall clock');
    // Morning of the next local day still reads correctly.
    assert.equal(localDay(new Date('2026-06-21T12:00:00Z')), '2026-06-21');
    // A zone ahead of UTC rolls the other way.
    process.env.IHOW_MEMORY_TZ = 'Asia/Shanghai'; // UTC+8
    assert.equal(localDay(new Date('2026-06-20T20:00:00Z')), '2026-06-21');
  } finally {
    if (prev === undefined) delete process.env.IHOW_MEMORY_TZ;
    else process.env.IHOW_MEMORY_TZ = prev;
  }
});

test('localDay never throws on a bad IHOW_MEMORY_TZ — falls back to the OS local day', () => {
  const prev = process.env.IHOW_MEMORY_TZ;
  try {
    const instant = new Date('2026-03-09T15:00:00Z');
    const expected = `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, '0')}-${String(instant.getDate()).padStart(2, '0')}`;
    for (const bad of ['Not/AZone', 'America/Los_Angeles ', '', 'garbage']) {
      process.env.IHOW_MEMORY_TZ = bad;
      let out;
      assert.doesNotThrow(() => { out = localDay(instant); }, `bad TZ ${JSON.stringify(bad)} must not throw`);
      assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
      // a non-empty bad value falls back to OS local (empty string just means "unset" → also OS local)
      assert.equal(out, expected);
    }
  } finally {
    if (prev === undefined) delete process.env.IHOW_MEMORY_TZ;
    else process.env.IHOW_MEMORY_TZ = prev;
  }
});

test('localDay returns YYYY-MM-DD in the OS local zone by default', () => {
  const prev = process.env.IHOW_MEMORY_TZ;
  delete process.env.IHOW_MEMORY_TZ;
  try {
    const day = localDay(new Date('2026-03-09T15:00:00Z'));
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
    // Whatever the runner's zone, it must agree with the local Date components (no locale dependency).
    const d = new Date('2026-03-09T15:00:00Z');
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(day, expected);
  } finally {
    if (prev !== undefined) process.env.IHOW_MEMORY_TZ = prev;
  }
});
