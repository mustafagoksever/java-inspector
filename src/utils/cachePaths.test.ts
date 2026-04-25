import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import {
    getProjectCacheDir,
    getDecompileCacheDir,
    getClassTempDir,
    getClassIndexPath,
    getPartialIndexPath,
    getClasspathPath,
    getClassIndexJsonlPath,
    getScanStatePath,
    getServerLogPath,
} from './cachePaths.js';

describe('cachePaths', () => {
    const testProject = '/some/project/path';
    const resolvedPath = path.resolve(testProject);
    const hash = createHash('sha256').update(resolvedPath).digest('hex').substring(0, 12);
    const baseName = path.basename(resolvedPath);
    const expectedDirName = `${baseName}_${hash}`;
    const expectedBase = path.join(os.homedir(), '.cache', 'java-inspector', expectedDirName);

    it('getProjectCacheDir should return a path under ~/.cache/java-inspector', () => {
        const dir = getProjectCacheDir(testProject);
        expect(dir.startsWith(path.join(os.homedir(), '.cache', 'java-inspector'))).toBe(true);
        expect(path.basename(dir)).toBe(expectedDirName);
    });

    it('getProjectCacheDir should be consistent for the same path', () => {
        const dir1 = getProjectCacheDir(testProject);
        const dir2 = getProjectCacheDir(testProject);
        expect(dir1).toBe(dir2);
    });

    it('getProjectCacheDir should differ for different paths', () => {
        const dir1 = getProjectCacheDir('/project/a');
        const dir2 = getProjectCacheDir('/project/b');
        expect(dir1).not.toBe(dir2);
    });

    it('getDecompileCacheDir should be inside project cache dir', () => {
        const dir = getDecompileCacheDir(testProject);
        expect(dir).toBe(path.join(expectedBase, 'decompile-cache-vineflower'));
    });

    it('getClassTempDir should be inside project cache dir', () => {
        const dir = getClassTempDir(testProject);
        expect(dir).toBe(path.join(expectedBase, 'class-temp'));
    });

    it('getClassIndexPath should return class-index.json', () => {
        const p = getClassIndexPath(testProject);
        expect(p).toBe(path.join(expectedBase, 'class-index.json'));
    });

    it('getPartialIndexPath should return class-index.partial.json', () => {
        const p = getPartialIndexPath(testProject);
        expect(p).toBe(path.join(expectedBase, 'class-index.partial.json'));
    });

    it('getClasspathPath should return classpath.json', () => {
        const p = getClasspathPath(testProject);
        expect(p).toBe(path.join(expectedBase, 'classpath.json'));
    });

    it('getClassIndexJsonlPath should return class-index.jsonl', () => {
        const p = getClassIndexJsonlPath(testProject);
        expect(p).toBe(path.join(expectedBase, 'class-index.jsonl'));
    });

    it('getScanStatePath should return scan-state.json', () => {
        const p = getScanStatePath(testProject);
        expect(p).toBe(path.join(expectedBase, 'scan-state.json'));
    });

    it('getServerLogPath should return server-<pid>.log', () => {
        const pid = 12345;
        const p = getServerLogPath(testProject, pid);
        expect(p).toBe(path.join(expectedBase, `server-${pid}.log`));
    });

    it('getServerLogPath should default to current process pid', () => {
        const p = getServerLogPath(testProject);
        expect(path.basename(p)).toBe(`server-${process.pid}.log`);
    });

    it('should handle relative paths by resolving them', () => {
        const relative = './my-project';
        const dir = getProjectCacheDir(relative);
        const expectedResolved = path.resolve(relative);
        const expectedHash = createHash('sha256').update(expectedResolved).digest('hex').substring(0, 12);
        const expectedBaseName = path.basename(expectedResolved);
        expect(path.basename(dir)).toBe(`${expectedBaseName}_${expectedHash}`);
    });
});
