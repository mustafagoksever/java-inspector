import { jest } from '@jest/globals';
import { JarScanCoordinator } from './JarScanCoordinator.js';
import { jarIndexer, JarLightIndex } from './JarIndexer.js';

function fakeIndex(jarPath: string): JarLightIndex {
    return {
        schemaVersion: 3,
        fingerprint: { path: jarPath, size: 1, mtimeMs: 1, key: jarPath },
        jarPath,
        jarName: jarPath,
        classes: [],
        resources: [],
        nestedJars: [],
        packages: [],
        manifest: {},
        mavenCoordinates: [],
        isMultiRelease: false,
        isSourceJar: false,
        layout: 'jar',
        indexedAt: new Date().toISOString(),
    };
}

describe('JarScanCoordinator', () => {
    it('reserves foreground capacity and promotes an already queued background JAR', async () => {
        const coordinator = new JarScanCoordinator();
        const started: string[] = [];
        const releases = new Map<string, () => void>();
        const spy = jest.spyOn(jarIndexer, 'getLightIndex').mockImplementation(async (jarPath: string) => {
            started.push(jarPath);
            if (jarPath.endsWith('target.jar')) return fakeIndex(jarPath);
            await new Promise<void>(resolve => releases.set(jarPath, resolve));
            return fakeIndex(jarPath);
        });

        const background = Array.from({ length: 6 }, (_, index) => coordinator.scanLight(`background-${index}.jar`, '/context', 'background'));
        const queuedTarget = coordinator.scanLight('target.jar', '/context', 'background');
        await Promise.resolve();
        expect(started).toHaveLength(6);
        expect(started).not.toContain('target.jar');

        const foregroundTarget = coordinator.scanLight('target.jar', '/context', 'foreground');
        await expect(foregroundTarget).resolves.toMatchObject({ jarPath: 'target.jar' });
        expect(foregroundTarget).toBe(queuedTarget);
        expect(started).toContain('target.jar');

        for (const release of releases.values()) release();
        await Promise.all(background);
        spy.mockRestore();
    });

    it('releases a coordinator slot when a JAR scan times out', async () => {
        const coordinator = new JarScanCoordinator(8, 6, 20, 20);
        const spy = jest.spyOn(jarIndexer, 'getLightIndex').mockImplementation(() => new Promise<JarLightIndex>(() => {}));
        try {
            await expect(coordinator.scanLight('stuck.jar', '/context', 'background'))
                .rejects.toThrow('Timed out after 20ms indexing JAR');
            await Promise.resolve();
            expect(coordinator.getStats().active).toBe(0);
            expect(coordinator.getStats().activeBackground).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });
});
