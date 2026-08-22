import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectDiscovery } from './ProjectDiscovery.js';

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
});
