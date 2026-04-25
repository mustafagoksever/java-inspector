import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import fs from 'fs-extra';
import { getProjectCacheDir } from './cachePaths.js';

export interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number;
}

const DEFAULT_OPTIONS: Required<LockOptions> = {
    stale: 60000,    // 60 seconds — lock becomes stale if owner dies
    update: 30000,   // Update mtime every 30 seconds while alive
    retries: 0,      // Do not retry; fail fast
};

export class CrossProcessLock {
    /**
     * Acquire a cross-process lock for the given project.
     * @param projectPath Absolute path to the project root.
     * @param lockName Base name of the lock file (e.g. 'scan', 'write').
     * @param options Optional overrides for stale/update/retries.
     * @returns A release function that must be called to free the lock.
     */
    static async acquire(
        projectPath: string,
        lockName: string,
        options: LockOptions = {}
    ): Promise<() => Promise<void>> {
        const cacheDir = getProjectCacheDir(projectPath);
        await fs.ensureDir(cacheDir);
        const lockFile = path.join(cacheDir, `${lockName}.lock`);
        const opts = { ...DEFAULT_OPTIONS, ...options };

        return lockfile.lock(lockFile, {
            stale: opts.stale,
            update: opts.update,
            retries: opts.retries,
            realpath: false,
            onCompromised: (err: Error) => {
                // Log but don't throw — the lock may have been stolen legitimately
                // by a forceRefresh or another process recovering from stale lock.
                console.error(`[LOCK] Lock compromised for ${lockName}: ${err.message}`);
            },
        });
    }

    /**
     * Check whether a lock is currently held (and not stale).
     * @param projectPath Absolute path to the project root.
     * @param lockName Base name of the lock file.
     * @returns true if locked and active, false otherwise.
     */
    static async check(projectPath: string, lockName: string): Promise<boolean> {
        const cacheDir = getProjectCacheDir(projectPath);
        const lockFile = path.join(cacheDir, `${lockName}.lock`);
        try {
            return await lockfile.check(lockFile, { realpath: false, stale: DEFAULT_OPTIONS.stale });
        } catch {
            return false;
        }
    }

    /**
     * Forcibly release a lock (useful during forceRefresh / invalidate).
     * Safe to call even if the lock is not held by this process.
     */
    static async release(projectPath: string, lockName: string): Promise<void> {
        const cacheDir = getProjectCacheDir(projectPath);
        const lockFile = path.join(cacheDir, `${lockName}.lock`);
        try {
            await lockfile.unlock(lockFile, { realpath: false });
        } catch {
            // Ignore errors — lock may not exist or not be held by us
        }
    }
}
