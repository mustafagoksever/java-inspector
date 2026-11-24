import * as path from 'path';
import fs from 'fs-extra';

const EXCLUDED_DIRECTORIES = new Set([
    '.git', '.idea', '.gradle', 'node_modules', 'target', 'build', 'out', 'dist',
]);

/**
 * Bounds for the breadth-first search. Without them a server started from "/" or the
 * home directory (Claude Desktop, some IDEs) would walk the whole disk on every tool call.
 */
const MAX_DEPTH = 4;
const MAX_DIRECTORIES = 5_000;
const CACHE_TTL_MS = 30_000;

export class ProjectDiscovery {
    private cache = new Map<string, { at: number; result: Promise<string[]> }>();

    /** Find every pom.xml at the first depth (<= MAX_DEPTH) containing a POM. Results are cached briefly. */
    async findTopLevelPomDirectories(workspacePath: string): Promise<string[]> {
        const key = path.resolve(workspacePath);
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
        const result = this.discover(key);
        this.cache.set(key, { at: Date.now(), result });
        result.catch(() => this.cache.delete(key));
        return result;
    }

    private async discover(workspacePath: string): Promise<string[]> {
        const root = path.resolve(workspacePath);
        const stat = await fs.stat(root).catch(() => null);
        if (!stat?.isDirectory()) throw new Error(`workspacePath is not a directory: ${root}`);

        if (await fs.pathExists(path.join(root, 'pom.xml'))) return [root];

        let level = [root];
        const visited = new Set<string>([root]);
        let depth = 0;
        while (level.length > 0 && depth < MAX_DEPTH && visited.size < MAX_DIRECTORIES) {
            depth++;
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
                    if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    if (visited.size >= MAX_DIRECTORIES) break;
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
