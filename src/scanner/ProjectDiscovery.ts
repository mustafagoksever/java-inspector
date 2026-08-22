import * as path from 'path';
import fs from 'fs-extra';

const EXCLUDED_DIRECTORIES = new Set([
    '.git', '.idea', '.gradle', 'node_modules', 'target', 'build', 'out', 'dist',
]);

export class ProjectDiscovery {
    /** Find every pom.xml at the first depth containing a POM. */
    async findTopLevelPomDirectories(workspacePath: string): Promise<string[]> {
        const root = path.resolve(workspacePath);
        const stat = await fs.stat(root).catch(() => null);
        if (!stat?.isDirectory()) throw new Error(`workspacePath is not a directory: ${root}`);

        if (await fs.pathExists(path.join(root, 'pom.xml'))) return [root];

        let level = [root];
        const visited = new Set<string>([root]);
        while (level.length > 0) {
            const next: string[] = [];
            const matches: string[] = [];
            for (const directory of level.sort((a, b) => a.localeCompare(b))) {
                let entries: fs.Dirent[];
                try {
                    entries = await fs.readdir(directory, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                    if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
                    const child = path.join(directory, entry.name);
                    if (visited.has(child)) continue;
                    visited.add(child);
                    if (await fs.pathExists(path.join(child, 'pom.xml'))) matches.push(child);
                    else next.push(child);
                }
            }
            if (matches.length > 0) return matches.sort((a, b) => a.localeCompare(b));
            level = next;
        }
        return [];
    }
}

export const projectDiscovery = new ProjectDiscovery();
