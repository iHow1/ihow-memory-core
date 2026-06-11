// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '../types.ts';

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withWorkspaceLock<T>(workspace: Workspace, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(workspace.lockPath), { recursive: true });
  const started = Date.now();
  let handle: fs.FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(workspace.lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('workspace_lock_timeout');
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close();
    await fs.rm(workspace.lockPath, { force: true });
  }
}
