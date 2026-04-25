import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { CrossProcessLock } from './CrossProcessLock.js';
import { getProjectCacheDir } from './cachePaths.js';

const TEST_PROJECT = path.join(os.tmpdir(), `java-inspector-test-${process.pid}`);

function ensureTestDir(): void {
    const cacheDir = getProjectCacheDir(TEST_PROJECT);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
}

describe('CrossProcessLock', () => {
    beforeAll(() => {
        ensureTestDir();
    });

    afterAll(() => {
        try {
            fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
    });

    afterEach(async () => {
        // Clean up any leftover locks
        await CrossProcessLock.release(TEST_PROJECT, 'test');
        await CrossProcessLock.release(TEST_PROJECT, 'test2');
    });

    it('should acquire, check, and release a lock', async () => {
        // Initially not locked
        expect(await CrossProcessLock.check(TEST_PROJECT, 'test')).toBe(false);

        // Acquire
        const release = await CrossProcessLock.acquire(TEST_PROJECT, 'test');
        expect(await CrossProcessLock.check(TEST_PROJECT, 'test')).toBe(true);

        // Release
        await release();
        expect(await CrossProcessLock.check(TEST_PROJECT, 'test')).toBe(false);
    });

    it('should block concurrent acquisition of the same lock', async () => {
        const release1 = await CrossProcessLock.acquire(TEST_PROJECT, 'test');
        expect(await CrossProcessLock.check(TEST_PROJECT, 'test')).toBe(true);

        // Second acquire should fail immediately (retries: 0)
        await expect(
            CrossProcessLock.acquire(TEST_PROJECT, 'test', { retries: 0 })
        ).rejects.toThrow();

        await release1();
    });

    it('should allow different lock names concurrently', async () => {
        const release1 = await CrossProcessLock.acquire(TEST_PROJECT, 'test');
        const release2 = await CrossProcessLock.acquire(TEST_PROJECT, 'test2');

        expect(await CrossProcessLock.check(TEST_PROJECT, 'test')).toBe(true);
        expect(await CrossProcessLock.check(TEST_PROJECT, 'test2')).toBe(true);

        await release1();
        await release2();

        expect(await CrossProcessLock.check(TEST_PROJECT, 'test')).toBe(false);
        expect(await CrossProcessLock.check(TEST_PROJECT, 'test2')).toBe(false);
    });

    it('should forcibly release a lock via release()', async () => {
        const release = await CrossProcessLock.acquire(TEST_PROJECT, 'test');
        expect(await CrossProcessLock.check(TEST_PROJECT, 'test')).toBe(true);

        // Force release (even if held by us)
        await CrossProcessLock.release(TEST_PROJECT, 'test');
        expect(await CrossProcessLock.check(TEST_PROJECT, 'test')).toBe(false);

        // Original release should now be a no-op or throw — safe to call
        try { await release(); } catch { /* ignore */ }
    });
});
