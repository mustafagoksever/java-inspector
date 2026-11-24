import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildToolOf, ProjectDiscovery } from './ProjectDiscovery.js';
import { projectCache } from '../cache/ProjectCache.js';

describe('ProjectDiscovery', () => {
    let workspace: string;
    const discovery = new ProjectDiscovery();

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'java-inspector-discovery-'));
    });

    afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

    it('uses a root pom without descending', async () => {
        fs.writeFileSync(path.join(workspace, 'pom.xml'), '<project/>');
        fs.mkdirSync(path.join(workspace, 'module'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'module', 'pom.xml'), '<project/>');
        await expect(discovery.findTopLevelPomDirectories(workspace)).resolves.toEqual([workspace]);
    });

    it('returns every pom at the first matching depth only', async () => {
        for (const name of ['b', 'a']) {
            fs.mkdirSync(path.join(workspace, name), { recursive: true });
            fs.writeFileSync(path.join(workspace, name, 'pom.xml'), '<project/>');
        }
        fs.mkdirSync(path.join(workspace, 'deep', 'module'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'deep', 'module', 'pom.xml'), '<project/>');

        await expect(discovery.findTopLevelPomDirectories(workspace)).resolves.toEqual([
            path.join(workspace, 'a'),
            path.join(workspace, 'b'),
        ]);
    });

    it('ignores build and dependency directories', async () => {
        for (const name of ['target', 'build', 'node_modules', '.git']) {
            fs.mkdirSync(path.join(workspace, name), { recursive: true });
            fs.writeFileSync(path.join(workspace, name, 'pom.xml'), '<project/>');
        }
        await expect(discovery.findTopLevelPomDirectories(workspace)).resolves.toEqual([]);
    });

    it('does not descend deeper than the depth limit', async () => {
        const deep = path.join(workspace, 'l1', 'l2', 'l3', 'l4', 'l5');
        fs.mkdirSync(deep, { recursive: true });
        fs.writeFileSync(path.join(deep, 'pom.xml'), '<project/>');
        await expect(new ProjectDiscovery().findTopLevelPomDirectories(workspace)).resolves.toEqual([]);
    });
});

describe('Gradle builds', () => {
    it('discovers Gradle roots, prefers Maven, and hashes the Gradle build files', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-gradle-'));
        try {
            fs.mkdirSync(path.join(root, 'svc', 'app'), { recursive: true });
            fs.writeFileSync(path.join(root, 'svc', 'settings.gradle.kts'), 'include("app")');
            fs.writeFileSync(path.join(root, 'svc', 'app', 'build.gradle.kts'), 'plugins { java }');
            expect(await new ProjectDiscovery().findTopLevelPomDirectories(root)).toEqual([path.join(root, 'svc')]);
            expect(await buildToolOf(path.join(root, 'svc'))).toBe('gradle');
            const before = await projectCache.getPomHash(path.join(root, 'svc'));
            fs.writeFileSync(path.join(root, 'svc', 'settings.gradle.kts'), 'include("app", "lib")');
            expect(await projectCache.getPomHash(path.join(root, 'svc'))).not.toBe(before);
            fs.writeFileSync(path.join(root, 'svc', 'pom.xml'), '<project/>');
            expect(await buildToolOf(path.join(root, 'svc'))).toBe('maven');
            expect(await buildToolOf(root)).toBeNull();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
