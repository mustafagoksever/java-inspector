import { createHash } from 'crypto';
import * as path from 'path';
import * as os from 'os';
import fs from 'fs-extra';
import { projectCache, ClassIndexEntry } from '../cache/ProjectCache.js';
import { getJarIndexesDir } from '../utils/cachePaths.js';
import { projectDiscovery } from './ProjectDiscovery.js';
import { jarIndexer, JarClassEntry, JarLightIndex } from './JarIndexer.js';
import { jarScanCoordinator } from './JarScanCoordinator.js';
import { DependencyScanner } from './DependencyScanner.js';

export interface ArtifactSelector {
    workspacePath?: string;
    /**
     * How long a lookup may wait for a Maven classpath that is still being resolved
     * (cold start). 0 = do not wait, report complete=false instead.
     */
    classpathWaitMs?: number;
    onWait?: (message: string) => Promise<void>;
    jarPath?: string;
    jarDirectory?: string;
    jarNamePrefix?: string;
    coordinates?: string;
}

export interface JarCandidate {
    jarPath: string;
    jarName: string;
    origin: 'direct' | 'maven' | 'local' | 'nested';
    contextPath?: string;
    nestedEntry?: string;
}

export interface ClassCandidate extends ClassIndexEntry {
    entryPath?: string;
    score: number;
    origin: JarCandidate['origin'];
    contextPath: string;
}

export interface ClassSearchResult {
    query: string;
    results: ClassCandidate[];
    complete: boolean;
    scannedJarCount: number;
    remainingJarCount: number;
    errors: ArtifactScanError[];
}

export interface ArtifactScanError {
    jarPath?: string;
    contextPath?: string;
    message: string;
}

export interface ResourceSearchResult {
    results: Array<{ jarPath: string; resourcePath: string; size: number; contentMatch?: string }>;
    complete: boolean;
    errors: ArtifactScanError[];
}

export interface CodeSearchMatch {
    jarPath: string;
    className: string;
    kind: string;
    member?: string;
    owner?: string;
    descriptor?: string;
    value?: string;
}

export interface DuplicateClassGroup {
    contextPath: string;
    jars: Array<{ jarPath: string; groupId?: string; artifactId?: string; version?: string }>;
    /** same-artifact-multiple-versions: one groupId:artifactId on the classpath twice; different-artifacts: split package / shaded or relocated copy. */
    kind: 'same-artifact-multiple-versions' | 'different-artifacts';
    classCount: number;
    packages: string[];
    sampleClasses: string[];
}

export interface DuplicateClassesResult {
    groups: DuplicateClassGroup[];
    totalGroups: number;
    totalDuplicateClasses: number;
    complete: boolean;
    scannedJarCount: number;
    remainingJarCount: number;
    errors: ArtifactScanError[];
}

export class ArtifactService {
    constructor(private readonly scanner: DependencyScanner = DependencyScanner.getInstance()) {}

    async getContextPaths(workspacePath: string): Promise<string[]> {
        return projectDiscovery.findTopLevelPomDirectories(workspacePath);
    }

    async findJars(
        selector: ArtifactSelector,
        match: 'exact' | 'prefix' | 'contains' = 'prefix',
        limit: number = 20,
        timeBudgetMs: number = 5000,
    ): Promise<{ results: JarCandidate[]; complete: boolean; errors: ArtifactScanError[] }> {
        if (selector.jarPath) {
            const resolved = path.resolve(selector.jarPath);
            await jarIndexer.fingerprint(resolved);
            return { results: [{ jarPath: resolved, jarName: path.basename(resolved), origin: 'direct' }], complete: true, errors: [] };
        }

        const rawQuery = selector.jarNamePrefix || this.artifactIdFromCoordinates(selector.coordinates) || '';
        const query = rawQuery.toLowerCase();
        const matches = (name: string) => {
            const lower = name.toLowerCase();
            if (!query) return true;
            if (match === 'exact') return lower === query || lower === `${query}.jar`;
            if (match === 'contains') return lower.includes(query);
            return lower.startsWith(query);
        };

        const results: JarCandidate[] = [];
        const errors: ArtifactScanError[] = [];
        let mavenPending = false;
        const seen = new Set<string>();
        const add = (candidate: JarCandidate) => {
            const resolved = path.resolve(candidate.jarPath);
            if (seen.has(resolved) || !matches(candidate.jarName) || results.length >= limit) return;
            seen.add(resolved);
            results.push({ ...candidate, jarPath: resolved });
        };

        if (selector.coordinates) {
            for (const jarPath of await this.findCoordinateJars(selector.coordinates)) {
                add({ jarPath, jarName: path.basename(jarPath), origin: 'maven' });
            }
        }

        if (selector.workspacePath) {
            for (const contextPath of await this.getContextPaths(selector.workspacePath)) {
                const classpath = await this.getMavenClasspath(contextPath, selector);
                mavenPending ||= classpath.pending;
                if (classpath.error) errors.push(classpath.error);
                for (const jarPath of classpath.jarPaths) {
                    add({ jarPath, jarName: path.basename(jarPath), origin: 'maven', contextPath });
                }
            }
        }

        if (results.length >= limit) return { results, complete: false, errors };
        const searchRoot = selector.jarDirectory || selector.workspacePath;
        if (!searchRoot) return { results, complete: !mavenPending && errors.length === 0, errors };

        const root = path.resolve(searchRoot);
        const deadline = Date.now() + Math.max(100, timeBudgetMs);
        const conventional = selector.jarDirectory
            ? [root]
            : ['lib', 'libs', 'target', path.join('build', 'libs'), path.join('WEB-INF', 'lib')]
                .map(relative => path.join(root, relative));
        const queue: string[] = [];
        for (const candidate of conventional) {
            if (await fs.pathExists(candidate)) queue.push(candidate);
        }
        if (!selector.jarDirectory) queue.push(root);
        const visited = new Set<string>();
        let complete = !mavenPending && errors.length === 0;

        while (queue.length > 0 && results.length < limit) {
            if (Date.now() >= deadline) { complete = false; break; }
            const directory = queue.shift()!;
            const normalized = path.resolve(directory);
            if (visited.has(normalized)) continue;
            visited.add(normalized);
            let entries: Array<fs.Dirent>;
            try {
                entries = await fs.readdir(normalized, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (Date.now() >= deadline || results.length >= limit) { complete = false; break; }
                const fullPath = path.join(normalized, entry.name);
                if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) {
                    add({ jarPath: fullPath, jarName: entry.name, origin: 'local' });
                } else if (entry.isDirectory() && !entry.isSymbolicLink() && !['.git', 'node_modules', '.idea', '.gradle'].includes(entry.name)) {
                    queue.push(fullPath);
                }
            }
        }

        return { results, complete, errors };
    }

    async inspectJar(selector: ArtifactSelector): Promise<{ candidates?: JarCandidate[]; index?: JarLightIndex }> {
        const found = await this.findJars(selector, 'prefix', 21);
        if (found.results.length === 0 && found.errors.length > 0) {
            throw new Error(found.errors.map(error => error.message).join('; '));
        }
        if (found.results.length !== 1) return { candidates: found.results };
        const candidate = found.results[0];
        const context = selector.workspacePath || candidate.contextPath || path.dirname(candidate.jarPath);
        const index = await jarScanCoordinator.scanLight(candidate.jarPath, context, 'foreground');
        return { index };
    }

    async searchClasses(
        query: string,
        selector: ArtifactSelector,
        limit: number = 20,
        maxNewJars: number = 20,
    ): Promise<ClassSearchResult> {
        const dollar = query.indexOf('$');
        if (dollar > 0 && !/\s/.test(query.trim())) return this.searchNestedClasses(query.trim(), dollar, selector, limit, maxNewJars);
        const results = new Map<string, ClassCandidate>();
        const useWorkspaceClasspath = Boolean(selector.workspacePath && !selector.jarPath && !selector.jarDirectory && !selector.coordinates);
        const contexts = useWorkspaceClasspath ? await this.getContextPaths(selector.workspacePath!) : [];
        const errors: ArtifactScanError[] = [];
        const classpaths = new Map<string, string[]>();
        let mavenPending = false;
        for (const context of contexts) {
            const classpath = await this.getMavenClasspath(context, selector);
            classpaths.set(context, classpath.jarPaths);
            mavenPending ||= classpath.pending;
            if (classpath.error) errors.push(classpath.error);
        }
        const scoreAndAdd = (entry: ClassIndexEntry & { entryPath?: string }, origin: JarCandidate['origin'], contextPath: string) => {
            const score = this.classScore(entry, query);
            if (score <= 0) return;
            const key = `${entry.className}::${path.resolve(entry.jarPath)}`;
            results.set(key, { ...entry, score, origin, contextPath });
        };

        for (const context of contexts) {
            for (const entry of await projectCache.getAllEntriesWithDuplicates(context)) {
                scoreAndAdd(entry, 'maven', context);
            }
        }

        let jarCandidates: JarCandidate[] = [];
        const hasExplicitJarSelector = Boolean(selector.jarPath || selector.jarNamePrefix || selector.jarDirectory || selector.coordinates);
        if (hasExplicitJarSelector) {
            const found = await this.findJars(selector, selector.jarPath ? 'exact' : 'prefix', 50);
            jarCandidates = found.results;
            mavenPending ||= !found.complete;
            errors.push(...found.errors);
        } else {
            for (const context of contexts) {
                for (const jarPath of classpaths.get(context) ?? []) {
                    jarCandidates.push({ jarPath, jarName: path.basename(jarPath), origin: 'maven', contextPath: context });
                }
            }
            if (jarCandidates.length === 0 && selector.workspacePath) {
                const found = await this.findJars({ workspacePath: selector.workspacePath }, 'contains', maxNewJars, 5000);
                jarCandidates = found.results;
                mavenPending ||= !found.complete;
                errors.push(...found.errors);
            }
        }

        jarCandidates = [...new Map(jarCandidates.map(candidate => [path.resolve(candidate.jarPath), candidate])).values()];

        const processed = new Set<string>();
        for (const context of contexts) {
            const state = await projectCache.getScanState(context);
            for (const jar of state?.processedJars ?? []) processed.add(path.resolve(jar));
        }
        // Unprocessed JARs first; for a qualified class name, JARs whose Maven path/name matches the
        // package (org.apache.commons.lang3 -> org/apache/commons/commons-lang3) are opened first, so an
        // exact lookup usually needs one JAR read even while the background index is incomplete.
        const relevance = this.packageRelevance(query);
        jarCandidates.sort((a, b) =>
            Number(processed.has(path.resolve(a.jarPath))) - Number(processed.has(path.resolve(b.jarPath)))
            || relevance(b.jarPath) - relevance(a.jarPath));

        let scannedJarCount = 0;
        let nestedRemaining = 0;
        const attempted = new Set<string>();
        for (const candidate of jarCandidates) {
            if (scannedJarCount >= maxNewJars) break;
            if (!hasExplicitJarSelector && processed.has(path.resolve(candidate.jarPath))) continue;
            const context = selector.workspacePath || candidate.contextPath || path.dirname(candidate.jarPath);
            const resolvedJar = path.resolve(candidate.jarPath);
            attempted.add(resolvedJar);
            try {
                const index = await jarScanCoordinator.scanLight(candidate.jarPath, context, 'foreground');
                scannedJarCount++;
                for (const entry of index.classes.filter(item => !item.isInner)) {
                    scoreAndAdd({ ...entry, jarPath: index.jarPath }, candidate.origin, context);
                }
                let exactFound = this.isExactClassMatch(query, index.classes);
                if (!exactFound && index.nestedJars.length > 0) {
                    let nestedAttempted = 0;
                    for (const nestedEntry of index.nestedJars) {
                        if (scannedJarCount >= maxNewJars) break;
                        nestedAttempted++;
                        try {
                            const nestedPath = await this.extractNestedJar(candidate.jarPath, nestedEntry, context);
                            const nestedIndex = await jarScanCoordinator.scanLight(nestedPath, context, 'foreground');
                            scannedJarCount++;
                            for (const entry of nestedIndex.classes.filter(item => !item.isInner)) {
                                scoreAndAdd({ ...entry, jarPath: nestedPath }, 'nested', context);
                            }
                            exactFound = this.isExactClassMatch(query, nestedIndex.classes);
                            if (exactFound) break;
                        } catch (error) {
                            scannedJarCount++;
                            errors.push({ jarPath: candidate.jarPath, contextPath: context, message: `Nested JAR ${nestedEntry}: ${this.errorMessage(error)}` });
                        }
                    }
                    if (!exactFound) nestedRemaining += Math.max(0, index.nestedJars.length - nestedAttempted);
                }
                if (exactFound && !query.includes(' ')) break;
            } catch (error) {
                scannedJarCount++;
                const scanError = { jarPath: candidate.jarPath, contextPath: context, message: this.errorMessage(error) };
                if (selector.jarPath) throw new Error(`Unable to scan ${candidate.jarPath}: ${scanError.message}`);
                errors.push(scanError);
            }
        }

        const sorted = [...results.values()]
            .sort((a, b) => b.score - a.score || a.className.localeCompare(b.className) || a.jarPath.localeCompare(b.jarPath))
            .slice(0, Math.max(1, limit));
        const remainingJarCount = jarCandidates.filter(candidate => {
            const resolvedJar = path.resolve(candidate.jarPath);
            return !processed.has(resolvedJar) && !attempted.has(resolvedJar);
        }).length + nestedRemaining;
        return {
            query,
            results: sorted,
            complete: !mavenPending && remainingJarCount === 0 && errors.length === 0,
            scannedJarCount,
            remainingJarCount,
            errors,
        };
    }

    /**
     * Nested classes (Outer$Inner) are not part of the class index; resolve the outer class first,
     * then read the nested entry from the outer class's JAR. On a miss the outer class's nested
     * classes are returned as candidates so the caller can suggest them.
     */
    private async searchNestedClasses(query: string, dollar: number, selector: ArtifactSelector, limit: number, maxNewJars: number): Promise<ClassSearchResult> {
        const outerName = query.substring(0, dollar);
        const outer = await this.searchClasses(outerName, selector, 50, maxNewJars);
        const qualified = outerName.includes('.');
        const outerMatches = outer.results.filter(item => qualified ? item.className === outerName : item.simpleName === outerName);
        const lower = query.toLowerCase();
        const exact: ClassCandidate[] = [];
        const related: ClassCandidate[] = [];
        const errors = [...outer.errors];
        const seen = new Set<string>();
        for (const match of outerMatches) {
            const jarKey = path.resolve(match.jarPath);
            if (seen.has(jarKey)) continue;
            seen.add(jarKey);
            try {
                const index = await jarScanCoordinator.scanLight(match.jarPath, match.contextPath, 'foreground');
                const prefix = `${match.className}$`;
                for (const entry of index.classes) {
                    if (!entry.isInner || !entry.className.startsWith(prefix)) continue;
                    const full = entry.className.toLowerCase();
                    const simple = entry.simpleName.toLowerCase();
                    const candidate: ClassCandidate = { ...entry, jarPath: match.jarPath, origin: match.origin, contextPath: match.contextPath, score: 0 };
                    if (full === lower || simple === lower) exact.push({ ...candidate, score: full === lower ? 120 : 110 });
                    else related.push({ ...candidate, score: full.includes(lower) || simple.includes(lower) ? 70 : 30 });
                }
            } catch (error) {
                errors.push({ jarPath: match.jarPath, contextPath: match.contextPath, message: this.errorMessage(error) });
            }
        }
        const byName = (a: ClassCandidate, b: ClassCandidate) => b.score - a.score || a.className.localeCompare(b.className);
        const unique = (items: ClassCandidate[]) => [...new Map(items.map(item => [`${item.className}::${path.resolve(item.jarPath)}`, item])).values()];
        const results = (exact.length ? unique(exact) : unique(related)).sort(byName).slice(0, Math.max(1, limit));
        return { ...outer, query, results, errors, complete: outer.complete && errors.length === outer.errors.length };
    }

    async resolveClass(className: string, selector: ArtifactSelector): Promise<ClassSearchResult> {
        // A fully qualified lookup is cheap with package-relevance ordering, so allow more JARs.
        return this.searchClasses(className, selector, 50, className.includes('.') ? 60 : 20);
    }

    async searchCode(
        query: string,
        kind: 'method' | 'field' | 'annotation' | 'reference' | 'string',
        selector: ArtifactSelector,
        limit: number = 20,
        maxNewJars: number = 5,
    ): Promise<{ matches: CodeSearchMatch[]; complete: boolean; scannedJarCount: number; remainingJarCount: number; errors: ArtifactScanError[] }> {
        const candidates = await this.candidateJarsForDeepSearch(selector, 10_000);
        const jars = candidates.jars;
        const errors = [...candidates.errors];
        const matches: CodeSearchMatch[] = [];
        let newlyScanned = 0;
        let remainingUnindexed = 0;
        let skippedAfterLimit = 0;
        const lower = query.toLowerCase();
        const ordered = await this.orderForDeepSearch(jars, selector, kind === 'reference' ? query.split('#')[0] : query);

        for (const { candidate, context, cached } of ordered) {
            if (!cached && newlyScanned >= maxNewJars) {
                remainingUnindexed++;
                continue;
            }
            if (matches.length >= limit) {
                skippedAfterLimit++;
                continue;
            }
            try {
                const deep = await jarScanCoordinator.scanDeep(candidate.jarPath, context, 'foreground');
                if (!cached) newlyScanned++;
                for (const clazz of deep.classes) {
                    if (kind === 'method') {
                        for (const method of clazz.methods.filter(item => item.name.toLowerCase().includes(lower))) {
                            matches.push({ jarPath: candidate.jarPath, className: clazz.className, kind, member: method.name, descriptor: method.descriptor });
                        }
                    } else if (kind === 'field') {
                        for (const field of clazz.fields.filter(item => item.name.toLowerCase().includes(lower))) {
                            matches.push({ jarPath: candidate.jarPath, className: clazz.className, kind, member: field.name, descriptor: field.descriptor });
                        }
                    } else if (kind === 'annotation') {
                        for (const annotation of clazz.annotationCandidates.filter(item => item.toLowerCase().includes(lower))) {
                            matches.push({ jarPath: candidate.jarPath, className: clazz.className, kind, value: annotation });
                        }
                    } else if (kind === 'string') {
                        for (const value of clazz.stringConstants.filter(item => item.toLowerCase().includes(lower))) {
                            matches.push({ jarPath: candidate.jarPath, className: clazz.className, kind, value });
                        }
                    } else {
                        for (const reference of clazz.references.filter(item => `${item.owner}#${item.name} ${item.owner}.${item.name} ${item.name}`.toLowerCase().includes(lower))) {
                            matches.push({
                                jarPath: candidate.jarPath,
                                className: clazz.className,
                                kind,
                                member: reference.name,
                                owner: reference.owner,
                                descriptor: reference.descriptor,
                            });
                        }
                    }
                    if (matches.length >= limit) break;
                }
            } catch (error) {
                if (!cached) newlyScanned++;
                const scanError = { jarPath: candidate.jarPath, contextPath: context, message: this.errorMessage(error) };
                if (selector.jarPath) throw new Error(`Unable to deep-scan ${candidate.jarPath}: ${scanError.message}`);
                errors.push(scanError);
            }
        }
        return { matches: matches.slice(0, limit), complete: !candidates.pending && remainingUnindexed === 0 && skippedAfterLimit === 0 && errors.length === 0, scannedJarCount: newlyScanned, remainingJarCount: remainingUnindexed + skippedAfterLimit, errors };
    }

    async findImplementations(
        targetClass: string,
        selector: ArtifactSelector,
        transitive: boolean = true,
        limit: number = 50,
        maxNewJars: number = 5,
    ): Promise<{ implementations: CodeSearchMatch[]; complete: boolean; scannedJarCount: number; remainingJarCount: number; errors: ArtifactScanError[] }> {
        const candidates = await this.candidateJarsForDeepSearch(selector, 10_000);
        const jars = candidates.jars;
        const errors = [...candidates.errors];
        const allClasses = new Map<string, { jarPath: string; superClass?: string; interfaces: string[]; accessFlags: number }>();
        let newlyScanned = 0;
        let remainingUnindexed = 0;
        for (const { candidate, context, cached } of await this.orderForDeepSearch(jars, selector, targetClass)) {
            if (!cached && newlyScanned >= maxNewJars) {
                remainingUnindexed++;
                continue;
            }
            try {
                const deep = await jarScanCoordinator.scanDeep(candidate.jarPath, context, 'foreground');
                if (!cached) newlyScanned++;
                for (const clazz of deep.classes) {
                    allClasses.set(clazz.className, { jarPath: candidate.jarPath, superClass: clazz.superClass, interfaces: clazz.interfaces, accessFlags: clazz.accessFlags });
                }
            } catch (error) {
                if (!cached) newlyScanned++;
                const scanError = { jarPath: candidate.jarPath, contextPath: context, message: this.errorMessage(error) };
                if (selector.jarPath) throw new Error(`Unable to deep-scan ${candidate.jarPath}: ${scanError.message}`);
                errors.push(scanError);
            }
        }

        const isSubtype = (name: string, seen = new Set<string>()): boolean => {
            const metadata = allClasses.get(name);
            if (!metadata || seen.has(name)) return false;
            seen.add(name);
            const parents = [metadata.superClass, ...metadata.interfaces].filter(Boolean) as string[];
            if (parents.includes(targetClass)) return true;
            return transitive && parents.some(parent => isSubtype(parent, seen));
        };
        const implementations: CodeSearchMatch[] = [];
        for (const [className, metadata] of allClasses) {
            if (className !== targetClass && isSubtype(className)) {
                implementations.push({ jarPath: metadata.jarPath, className, kind: 'implementation' });
            }
        }
        implementations.sort((a, b) => a.className.localeCompare(b.className));
        return {
            implementations: implementations.slice(0, limit),
            complete: !candidates.pending && remainingUnindexed === 0 && errors.length === 0,
            scannedJarCount: newlyScanned,
            remainingJarCount: remainingUnindexed,
            errors,
        };
    }

    async searchResources(
        selector: ArtifactSelector,
        pathQuery: string = '',
        contentQuery?: string,
        limit: number = 20,
    ): Promise<ResourceSearchResult> {
        // Previously capped at the first 20 classpath JARs, so a workspace-wide search could never see the rest.
        const candidates = await this.candidateJarsForDeepSearch(selector, 10_000);
        const jars = candidates.jars;
        const errors = [...candidates.errors];
        const results: Array<{ jarPath: string; resourcePath: string; size: number; contentMatch?: string }> = [];
        const deadline = Date.now() + 20_000;
        const lowerPath = pathQuery.toLowerCase();
        const lowerContent = contentQuery?.toLowerCase();
        for (const candidate of jars) {
            if (Date.now() > deadline) return { results, complete: false, errors };
            const context = selector.workspacePath || candidate.contextPath || path.dirname(candidate.jarPath);
            let index: JarLightIndex;
            try {
                index = await jarScanCoordinator.scanLight(candidate.jarPath, context, 'foreground');
            } catch (error) {
                const scanError = { jarPath: candidate.jarPath, contextPath: context, message: this.errorMessage(error) };
                if (selector.jarPath) throw new Error(`Unable to scan resources in ${candidate.jarPath}: ${scanError.message}`);
                errors.push(scanError);
                continue;
            }
            for (const resource of index.resources) {
                if (lowerPath && !resource.path.toLowerCase().includes(lowerPath)) continue;
                if (lowerContent) {
                    if (!resource.isText || resource.size > 1024 * 1024) continue;
                    const text = (await jarIndexer.readEntry(candidate.jarPath, resource.path, 1024 * 1024)).toString('utf8');
                    const position = text.toLowerCase().indexOf(lowerContent);
                    if (position < 0) continue;
                    results.push({
                        jarPath: candidate.jarPath,
                        resourcePath: resource.path,
                        size: resource.size,
                        contentMatch: text.substring(Math.max(0, position - 80), Math.min(text.length, position + lowerContent.length + 80)),
                    });
                } else {
                    results.push({ jarPath: candidate.jarPath, resourcePath: resource.path, size: resource.size });
                }
                if (results.length >= limit) return { results, complete: false, errors };
            }
        }
        return { results, complete: !candidates.pending && errors.length === 0, errors };
    }

    async readResource(
        selector: ArtifactSelector,
        resourcePath: string,
        offset: number = 1,
        limit: number = 200,
    ): Promise<{ jarPath: string; resourcePath: string; text: string; totalLines: number; startLine: number; endLine: number }> {
        const inspection = await this.inspectJar(selector);
        if (!inspection.index) throw new Error(`JAR selector is ambiguous. Candidates: ${(inspection.candidates ?? []).map(item => item.jarPath).join(', ')}`);
        const resource = inspection.index.resources.find(item => item.path === resourcePath);
        if (!resource) throw new Error(`Resource not found: ${resourcePath}`);
        if (!resource.isText) throw new Error(`Binary resource content is not supported: ${resourcePath}`);
        const bytes = await jarIndexer.readEntry(inspection.index.jarPath, resourcePath, 2 * 1024 * 1024);
        const lines = bytes.toString('utf8').split(/\r?\n/);
        const start = Math.max(1, offset);
        const pageSize = Math.min(1000, Math.max(1, limit));
        const end = Math.min(lines.length, start - 1 + pageSize);
        return {
            jarPath: inspection.index.jarPath,
            resourcePath,
            text: lines.slice(start - 1, end).join('\n'),
            totalLines: lines.length,
            startLine: start,
            endLine: end,
        };
    }

    async extractNestedJar(parentJar: string, nestedEntry: string, contextPath: string): Promise<string> {
        const parentFingerprint = await jarIndexer.fingerprint(parentJar);
        const entryKey = createHash('sha256').update(nestedEntry).digest('hex').substring(0, 12);
        const target = path.join(getJarIndexesDir(contextPath), 'nested', parentFingerprint.key, `${entryKey}-${path.basename(nestedEntry)}`);
        if (!(await fs.pathExists(target))) {
            const bytes = await jarIndexer.readEntry(parentJar, nestedEntry, 250 * 1024 * 1024);
            await fs.outputFile(target, bytes);
        }
        return target;
    }

    private async candidateJarsForDeepSearch(
        selector: ArtifactSelector,
        limit: number,
    ): Promise<{ jars: JarCandidate[]; pending: boolean; errors: ArtifactScanError[] }> {
        const hasSelector = Boolean(selector.jarPath || selector.jarNamePrefix || selector.jarDirectory || selector.coordinates);
        if (hasSelector) {
            const found = await this.findJars(selector, selector.jarPath ? 'exact' : 'prefix', limit);
            return { jars: found.results, pending: !found.complete, errors: found.errors };
        }
        const results: JarCandidate[] = [];
        const errors: ArtifactScanError[] = [];
        let pending = false;
        if (selector.workspacePath) {
            for (const contextPath of await this.getContextPaths(selector.workspacePath)) {
                const classpath = await this.getMavenClasspath(contextPath, selector);
                pending ||= classpath.pending;
                if (classpath.error) errors.push(classpath.error);
                for (const jarPath of classpath.jarPaths) {
                    results.push({ jarPath, jarName: path.basename(jarPath), origin: 'maven', contextPath });
                    if (results.length >= limit) return { jars: results, pending: true, errors };
                }
            }
            if (results.length === 0) {
                const found = await this.findJars({ workspacePath: selector.workspacePath }, 'contains', limit);
                return { jars: found.results, pending: pending || !found.complete, errors: [...errors, ...found.errors] };
            }
        }
        const jars = [...new Map(results.map(candidate => [path.resolve(candidate.jarPath), candidate])).values()];
        return { jars, pending, errors };
    }

    /**
     * Already deep-indexed JARs first (free), then JARs whose Maven path matches the query's package
     * (e.g. org.springframework.context.ApplicationListener -> spring-context), so the per-call budget
     * of new deep scans is spent where matches are most likely.
     */
    private async orderForDeepSearch(
        jars: JarCandidate[],
        selector: ArtifactSelector,
        relevanceQuery: string,
    ): Promise<Array<{ candidate: JarCandidate; context: string; cached: boolean; relevance: number }>> {
        const relevance = this.packageRelevance(relevanceQuery.replace(/[#(].*$/, '').replace(/\$/g, '.'));
        const ordered = [];
        for (const candidate of jars) {
            const context = selector.workspacePath || candidate.contextPath || path.dirname(candidate.jarPath);
            ordered.push({ candidate, context, cached: await jarIndexer.hasDeepIndex(candidate.jarPath, context), relevance: relevance(candidate.jarPath) });
        }
        return ordered
            .map((item, position) => ({ ...item, position }))
            .sort((a, b) => Number(b.cached) - Number(a.cached) || b.relevance - a.relevance || a.position - b.position);
    }

    /**
     * Classes present in more than one classpath JAR (split packages, relocated/shaded copies,
     * two versions of one artifact). Uses the background class index plus on-demand light scans of
     * JARs the background scan has not reached yet.
     */
    async findDuplicateClasses(
        selector: ArtifactSelector,
        options: { query?: string; limit?: number; classLimit?: number; maxNewJars?: number; deadlineMs?: number } = {},
    ): Promise<DuplicateClassesResult> {
        const limit = options.limit ?? 50;
        const classLimit = options.classLimit ?? 10;
        const maxNewJars = options.maxNewJars ?? 200;
        const deadline = Date.now() + (options.deadlineMs ?? 20_000);
        const query = (options.query ?? '').trim().toLowerCase();
        const errors: ArtifactScanError[] = [];
        const hasSelector = Boolean(selector.jarPath || selector.jarNamePrefix || selector.jarDirectory || selector.coordinates);
        const scopes: Array<{ contextPath: string; jars: string[]; indexed: Map<string, Set<string>>; processed: Set<string> }> = [];
        let pending = false;

        if (hasSelector) {
            const found = await this.findJars(selector, selector.jarPath ? 'exact' : 'prefix', 10_000);
            pending ||= !found.complete;
            errors.push(...found.errors);
            const contextPath = selector.workspacePath || selector.jarDirectory || (found.results[0] ? path.dirname(found.results[0].jarPath) : process.cwd());
            scopes.push({ contextPath, jars: found.results.map(item => item.jarPath), indexed: new Map(), processed: new Set() });
        } else if (selector.workspacePath) {
            for (const contextPath of await this.getContextPaths(selector.workspacePath)) {
                const classpath = await this.getMavenClasspath(contextPath, selector);
                pending ||= classpath.pending;
                if (classpath.error) errors.push(classpath.error);
                const indexed = new Map<string, Set<string>>();
                for (const entry of await projectCache.getAllEntriesWithDuplicates(contextPath)) {
                    if (!indexed.has(entry.className)) indexed.set(entry.className, new Set());
                    indexed.get(entry.className)!.add(path.resolve(entry.jarPath));
                }
                const state = await projectCache.getScanState(contextPath);
                scopes.push({ contextPath, jars: classpath.jarPaths, indexed, processed: new Set((state?.processedJars ?? []).map(jar => path.resolve(jar))) });
            }
        }

        let scannedJarCount = 0;
        let remainingJarCount = 0;
        const groups = new Map<string, DuplicateClassGroup>();
        for (const scope of scopes) {
            const owners = scope.indexed;
            for (const jarPath of scope.jars) {
                const resolved = path.resolve(jarPath);
                if (scope.processed.has(resolved)) continue;
                if (scannedJarCount >= maxNewJars || Date.now() > deadline) { remainingJarCount++; continue; }
                try {
                    const index = await jarScanCoordinator.scanLight(jarPath, scope.contextPath, 'foreground');
                    scannedJarCount++;
                    for (const entry of index.classes) {
                        if (entry.isInner || entry.isSource) continue;
                        if (!owners.has(entry.className)) owners.set(entry.className, new Set());
                        owners.get(entry.className)!.add(resolved);
                    }
                } catch (error) {
                    scannedJarCount++;
                    errors.push({ jarPath, contextPath: scope.contextPath, message: this.errorMessage(error) });
                }
            }
            const onClasspath = new Set(scope.jars.map(jar => path.resolve(jar)));
            for (const [className, jarSet] of owners) {
                const jarsForClass = [...jarSet].filter(jar => onClasspath.size === 0 || onClasspath.has(jar)).sort();
                if (jarsForClass.length < 2) continue;
                if (query && !className.toLowerCase().includes(query)) continue;
                const key = `${scope.contextPath}\n${jarsForClass.join('\n')}`;
                let group = groups.get(key);
                if (!group) {
                    const artifacts = jarsForClass.map(jar => ({ jarPath: jar, ...this.coordinatesFromJarPath(jar) }));
                    const artifactIds = new Set(artifacts.map(item => item.groupId && item.artifactId ? `${item.groupId}:${item.artifactId}` : path.basename(item.jarPath)));
                    group = {
                        contextPath: scope.contextPath,
                        jars: artifacts,
                        kind: artifactIds.size === 1 ? 'same-artifact-multiple-versions' : 'different-artifacts',
                        classCount: 0,
                        packages: [],
                        sampleClasses: [],
                    };
                    groups.set(key, group);
                }
                group.classCount++;
                const pkg = className.includes('.') ? className.substring(0, className.lastIndexOf('.')) : '';
                if (!group.packages.includes(pkg) && group.packages.length < 20) group.packages.push(pkg);
                if (group.sampleClasses.length < classLimit) group.sampleClasses.push(className);
            }
        }

        const sorted = [...groups.values()]
            .map(group => ({ ...group, packages: group.packages.sort(), sampleClasses: group.sampleClasses.sort() }))
            .sort((a, b) => Number(b.kind === 'same-artifact-multiple-versions') - Number(a.kind === 'same-artifact-multiple-versions') || b.classCount - a.classCount);
        return {
            groups: sorted.slice(0, Math.max(1, limit)),
            totalGroups: sorted.length,
            totalDuplicateClasses: sorted.reduce((sum, group) => sum + group.classCount, 0),
            complete: !pending && remainingJarCount === 0 && errors.length === 0,
            scannedJarCount,
            remainingJarCount,
            errors,
        };

    }

    /** groupId/artifactId/version from a Maven repository layout path (.../g/r/o/u/p/artifact/version/artifact-version.jar). */
    coordinatesFromJarPath(jarPath: string): { groupId?: string; artifactId?: string; version?: string } {
        const parts = path.resolve(jarPath).split(/[\\/]/);
        // Gradle cache: .../files-2.1/<group>/<artifact>/<version>/<sha1>/<file>.jar
        const gradleIndex = parts.lastIndexOf('files-2.1');
        if (gradleIndex >= 0 && parts.length - gradleIndex === 6) {
            return { groupId: parts[gradleIndex + 1], artifactId: parts[gradleIndex + 2], version: parts[gradleIndex + 3] };
        }
        const file = parts[parts.length - 1];
        const version = parts[parts.length - 2];
        const artifactId = parts[parts.length - 3];
        if (!file || !version || !artifactId || !file.startsWith(`${artifactId}-${version}`)) return {};
        const repoIndex = parts.lastIndexOf('repository');
        const groupParts = repoIndex >= 0 ? parts.slice(repoIndex + 1, parts.length - 3) : [];
        return { groupId: groupParts.length ? groupParts.join('.') : undefined, artifactId, version };
    }

    private async getMavenClasspath(
        contextPath: string,
        options: Pick<ArtifactSelector, 'classpathWaitMs' | 'onWait'> = {},
    ): Promise<{ jarPaths: string[]; pending: boolean; error?: ArtifactScanError }> {
        const cached = await projectCache.getClasspath(contextPath).catch(() => null);
        if (cached !== null) return { jarPaths: cached, pending: false };

        if (!this.scanner.isResolvingClasspath(contextPath)) {
            try {
                const result = await this.scanner.scanProject(contextPath, false);
                if (result.message?.startsWith('Previous scan failed:')) {
                    return { jarPaths: [], pending: false, error: { contextPath, message: result.message } };
                }
            } catch (error) {
                return { jarPaths: [], pending: false, error: { contextPath, message: this.errorMessage(error) } };
            }
        }

        let refreshed = await projectCache.getClasspath(contextPath).catch(() => null);
        if (refreshed === null && options.classpathWaitMs) {
            await options.onWait?.('Waiting for Maven classpath resolution (first run for this project)...');
            refreshed = await this.scanner.waitForClasspath(contextPath, options.classpathWaitMs, async elapsed => {
                await options.onWait?.(`Still resolving Maven classpath (${Math.round(elapsed / 1000)}s)...`);
            });
        }
        return { jarPaths: refreshed ?? [], pending: refreshed === null };
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private classScore(entry: ClassIndexEntry, query: string): number {
        const normalized = query.toLowerCase().trim();
        if (!normalized) return 0;
        const full = entry.className.toLowerCase();
        const simple = entry.simpleName.toLowerCase();
        if (full === normalized) return 120;
        if (simple === normalized) return 110;
        if (simple.endsWith(normalized)) return 80;
        if (simple.includes(normalized)) return 60;
        if (full.includes(normalized)) return 50;
        const parts = normalized.split(/[\s.]+/).filter(Boolean);
        if (parts.length > 1 && parts.every(part => full.includes(part))) return 40 + parts.length * 5;
        return 0;
    }

    private packageRelevance(query: string): (jarPath: string) => number {
        const trimmed = query.trim();
        if (!/^[\w$]+(\.[\w$]+)+$/.test(trimmed)) return () => 0;
        const generic = new Set(['org', 'com', 'io', 'net', 'java', 'javax', 'jakarta', 'internal', 'impl', 'api', 'util', 'core']);
        const segments = trimmed.toLowerCase().split('.').slice(0, -1);
        return (jarPath: string) => {
            const parts = new Set(jarPath.toLowerCase().split(/[\\/._-]+/));
            let score = 0;
            segments.forEach((segment, index) => {
                if (!parts.has(segment)) return;
                // Leading package segments match the Maven groupId directories; distinctive ones weigh more.
                score += (generic.has(segment) ? 1 : 3) + (index < 4 ? 1 : 0);
            });
            return score;
        };
    }

    private isExactClassMatch(query: string, classes: JarClassEntry[]): boolean {
        const lower = query.toLowerCase();
        return classes.some(entry => !entry.isInner && (entry.className.toLowerCase() === lower || entry.simpleName.toLowerCase() === lower));
    }

    private artifactIdFromCoordinates(coordinates?: string): string {
        if (!coordinates) return '';
        return coordinates.split(':')[1] || coordinates;
    }

    /** The -sources.jar of a binary JAR: next to it (Maven repository) or in a sibling hash directory (Gradle cache). */
    async findSourcesJar(jarPath: string): Promise<string | null> {
        const sibling = jarPath.replace(/\.jar$/i, '-sources.jar');
        if (sibling !== jarPath && await fs.pathExists(sibling)) return sibling;
        const parts = path.resolve(jarPath).split(/[\\/]/);
        const gradleIndex = parts.lastIndexOf('files-2.1');
        if (gradleIndex < 0 || parts.length - gradleIndex !== 6) return null;
        const versionDir = path.dirname(path.dirname(path.resolve(jarPath)));
        const fileName = path.basename(sibling);
        for (const hash of await fs.readdir(versionDir).catch(() => [] as string[])) {
            const candidate = path.join(versionDir, hash, fileName);
            if (await fs.pathExists(candidate)) return candidate;
        }
        return null;
    }

    async findCoordinateJars(coordinates: string): Promise<string[]> {
        const [groupId, artifactId, version, classifier] = coordinates.split(':');
        if (!groupId || !artifactId) return [];
        const repository = path.resolve(process.env.MAVEN_REPO || path.join(os.homedir(), '.m2', 'repository'));
        const artifactRoot = path.join(repository, ...groupId.split('.'), artifactId);
        if (!(await fs.pathExists(artifactRoot))) return [];
        const versions = version
            ? [version]
            : (await fs.readdir(artifactRoot, { withFileTypes: true }))
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name)
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        const results: string[] = [];
        for (const selectedVersion of versions) {
            const suffix = classifier ? `-${classifier}` : '';
            const jarPath = path.join(artifactRoot, selectedVersion, `${artifactId}-${selectedVersion}${suffix}.jar`);
            if (await fs.pathExists(jarPath)) results.push(jarPath);
        }
        return results;
    }
}

export const artifactService = new ArtifactService();
