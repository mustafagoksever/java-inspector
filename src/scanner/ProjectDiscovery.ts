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

const GRADLE_ROOT_FILES = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];

/** 'maven' when the directory has a pom.xml (preferred), 'gradle' for a Gradle build, otherwise null. */
export async function buildToolOf(directory: string): Promise<'maven' | 'gradle' | null> {
    if (await fs.pathExists(path.join(directory, 'pom.xml'))) return 'maven';
    for (const name of GRADLE_ROOT_FILES) if (await fs.pathExists(path.join(directory, name))) return 'gradle';
    return null;
}

export class ProjectDiscovery {
    private cache = new Map<string, { at: number; result: Promise<string[]> }>();

    /**
     * Find the top-level build roots: directories with a pom.xml or a Gradle settings/build file, at the first
     * depth (<= MAX_DEPTH) that has any. Results are cached briefly.
     */
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

        if (await buildToolOf(root)) return [root];

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
                    if (await buildToolOf(child)) matches.push(child);
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
