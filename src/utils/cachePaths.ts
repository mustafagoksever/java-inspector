import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';

/**
 * Get the project-specific cache directory under the user's home cache.
 * Uses a hash of the resolved project path to avoid collisions between
 * different repositories with the same folder name.
 */
export function getProjectCacheDir(projectPath: string): string {
    const normalizedPath = path.resolve(projectPath);
    const hash = createHash('sha256').update(normalizedPath).digest('hex').substring(0, 12);
    const baseName = path.basename(normalizedPath);
    const dirName = `${baseName}_${hash}`;
    return path.join(os.homedir(), '.cache', 'java-inspector', dirName);
}

export function getDecompileCacheDir(projectPath: string): string {
    return path.join(getProjectCacheDir(projectPath), 'decompile-cache-vineflower');
}

export function getClassTempDir(projectPath: string): string {
    return path.join(getProjectCacheDir(projectPath), 'class-temp');
}

export function getClassIndexPath(projectPath: string): string {
    return path.join(getProjectCacheDir(projectPath), 'class-index.json');
}

export function getPartialIndexPath(projectPath: string): string {
    return path.join(getProjectCacheDir(projectPath), 'class-index.partial.json');
}

export function getClasspathPath(projectPath: string): string {
    return path.join(getProjectCacheDir(projectPath), 'classpath.json');
}

export function getClassIndexJsonlPath(projectPath: string): string {
    return path.join(getProjectCacheDir(projectPath), 'class-index.jsonl');
}

export function getScanStatePath(projectPath: string): string {
    return path.join(getProjectCacheDir(projectPath), 'scan-state.json');
}
