import { createHash } from 'crypto';
import * as path from 'path';
import fs from 'fs-extra';
import * as yauzl from 'yauzl';
import { getGlobalJarIndexesDir } from '../utils/cachePaths.js';
import { ClassFileMetadata, ClassFileMetadataReader } from './ClassFileMetadataReader.js';

export interface JarClassEntry {
    className: string;
    packageName: string;
    simpleName: string;
    entryPath: string;
    release: number;
    isInner: boolean;
    isSource: boolean;
}

export interface JarResourceEntry {
    path: string;
    size: number;
    compressedSize: number;
    crc32: number;
    isText: boolean;
}

export interface MavenCoordinates {
    groupId?: string;
    artifactId?: string;
    version?: string;
}

export interface JarFingerprint {
    path: string;
    size: number;
    mtimeMs: number;
    key: string;
}

export interface JarLightIndex {
    schemaVersion: 3;
    fingerprint: JarFingerprint;
    jarPath: string;
    jarName: string;
    classes: JarClassEntry[];
    resources: JarResourceEntry[];
    nestedJars: string[];
    packages: string[];
    manifest: Record<string, string>;
    mavenCoordinates: MavenCoordinates[];
    isMultiRelease: boolean;
    isSourceJar: boolean;
    layout: 'jar' | 'spring-boot' | 'war' | 'jmod';
    indexedAt: string;
}

export interface DeepClassEntry extends ClassFileMetadata {
    entryPath: string;
}

export interface JarDeepIndex {
    schemaVersion: 3;
    fingerprint: JarFingerprint;
    classes: DeepClassEntry[];
    parseErrors: number;
    indexedAt: string;
}

const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.mf', '.properties', '.xml', '.json', '.yaml', '.yml', '.conf',
    '.cfg', '.ini', '.list', '.factories', '.imports', '.handlers', '.schemas', '.sql',
    '.html', '.css', '.js', '.ts', '.java', '.kt', '.groovy', '.kts', '.csv', '.graphql',
]);

export class JarIndexer {
    private lightPromises = new Map<string, Promise<JarLightIndex>>();
    private deepPromises = new Map<string, Promise<JarDeepIndex>>();

    async fingerprint(jarPath: string): Promise<JarFingerprint> {
        const resolved = path.resolve(jarPath);
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) throw new Error(`JAR path is not a file: ${resolved}`);
        if (!resolved.toLowerCase().endsWith('.jar') && !resolved.toLowerCase().endsWith('.jmod')) {
            throw new Error(`Artifact must be a .jar or .jmod file: ${resolved}`);
        }
        const identity = `${resolved}\n${stat.size}\n${stat.mtimeMs}`;
        return {
            path: resolved,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            key: createHash('sha256').update(identity).digest('hex').substring(0, 20),
        };
    }

    async getLightIndex(jarPath: string, contextPath: string): Promise<JarLightIndex> {
        const fingerprint = await this.fingerprint(jarPath);
        const promiseKey = fingerprint.key;
        const existing = this.lightPromises.get(promiseKey);
        if (existing) return existing;

        const promise = this.loadOrBuildLight(fingerprint, contextPath);
        this.lightPromises.set(promiseKey, promise);
        try {
            return await promise;
        } finally {
            this.lightPromises.delete(promiseKey);
        }
    }

    async getDeepIndex(jarPath: string, contextPath: string): Promise<JarDeepIndex> {
        const fingerprint = await this.fingerprint(jarPath);
        const promiseKey = fingerprint.key;
        const existing = this.deepPromises.get(promiseKey);
        if (existing) return existing;

        const promise = this.loadOrBuildDeep(fingerprint, contextPath);
        this.deepPromises.set(promiseKey, promise);
        try {
            return await promise;
        } finally {
            this.deepPromises.delete(promiseKey);
        }
    }

    async hasDeepIndex(jarPath: string, contextPath: string): Promise<boolean> {
        try {
            const fingerprint = await this.fingerprint(jarPath);
            return Boolean(await this.readCache<JarDeepIndex>(this.cachePath(contextPath, fingerprint.path, 'deep'), fingerprint));
        } catch {
            return false;
        }
    }

    async readEntry(jarPath: string, entryPath: string, maxBytes: number = 5 * 1024 * 1024): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            yauzl.open(jarPath, { lazyEntries: true }, (openError: Error | null, zipfile: yauzl.ZipFile) => {
                if (openError || !zipfile) {
                    reject(new Error(`Unable to open JAR ${jarPath}: ${openError?.message ?? 'unknown error'}`));
                    return;
                }
                let settled = false;
                let timer: NodeJS.Timeout | undefined;
                const fail = (error: Error) => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    try { zipfile.close(); } catch { /* ignore */ }
                    reject(error);
                };
                timer = setTimeout(() => fail(new Error(`Timed out reading JAR entry: ${entryPath}`)), 30_000);
                zipfile.on('error', fail);
                zipfile.on('entry', (entry: yauzl.Entry) => {
                    if (entry.fileName !== entryPath) {
                        zipfile.readEntry();
                        return;
                    }
                    if (entry.uncompressedSize > maxBytes) {
                        fail(new Error(`JAR entry exceeds ${maxBytes} byte limit: ${entryPath}`));
                        return;
                    }
                    zipfile.openReadStream(entry, (streamError: Error | null, stream: NodeJS.ReadableStream) => {
                        if (streamError || !stream) {
                            fail(new Error(`Unable to read JAR entry ${entryPath}: ${streamError?.message ?? 'unknown error'}`));
                            return;
                        }
                        const chunks: Buffer[] = [];
                        let size = 0;
                        stream.on('data', (chunk: Buffer) => {
                            size += chunk.length;
                            if (size > maxBytes) {
                                (stream as any).destroy();
                                fail(new Error(`JAR entry exceeds ${maxBytes} byte limit: ${entryPath}`));
                            } else {
                                chunks.push(Buffer.from(chunk));
                            }
                        });
                        stream.on('error', fail);
                        stream.on('end', () => {
                            if (settled) return;
                            settled = true;
                            if (timer) clearTimeout(timer);
                            try { zipfile.close(); } catch { /* ignore */ }
                            resolve(Buffer.concat(chunks));
                        });
                    });
                });
                zipfile.on('end', () => fail(new Error(`JAR entry not found: ${entryPath}`)));
                zipfile.readEntry();
            });
        });
    }

    private async loadOrBuildLight(fingerprint: JarFingerprint, contextPath: string): Promise<JarLightIndex> {
        const cachePath = this.cachePath(contextPath, fingerprint.path, 'light');
        const cached = await this.readCache<JarLightIndex>(cachePath, fingerprint);
        if (cached) return cached;
        const index = await this.buildLightIndex(fingerprint);
        await fs.outputJson(cachePath, index, { spaces: 0 });
        return index;
    }

    private async loadOrBuildDeep(fingerprint: JarFingerprint, contextPath: string): Promise<JarDeepIndex> {
        const cachePath = this.cachePath(contextPath, fingerprint.path, 'deep');
        const cached = await this.readCache<JarDeepIndex>(cachePath, fingerprint);
        if (cached) return cached;

        const light = await this.getLightIndex(fingerprint.path, contextPath);
        const index = await this.buildDeepIndex(fingerprint, light);
        await fs.outputJson(cachePath, index, { spaces: 0 });
        return index;
    }

    private buildDeepIndex(fingerprint: JarFingerprint, light: JarLightIndex): Promise<JarDeepIndex> {
        return new Promise((resolve, reject) => {
            const targets = new Set(light.classes.filter(entry => !entry.isSource).map(entry => entry.entryPath));
            const classes: DeepClassEntry[] = [];
            let parseErrors = 0;
            let failed = false;
            yauzl.open(fingerprint.path, { lazyEntries: true }, (openError: Error | null, zipfile: yauzl.ZipFile) => {
                if (openError || !zipfile) {
                    reject(new Error(`Unable to open JAR ${fingerprint.path}: ${openError?.message ?? 'unknown error'}`));
                    return;
                }
                let timer: NodeJS.Timeout | undefined;
                const fail = (error: Error) => {
                    if (failed) return;
                    failed = true;
                    if (timer) clearTimeout(timer);
                    try { zipfile.close(); } catch { /* ignore */ }
                    reject(error);
                };
                timer = setTimeout(() => fail(new Error(`Timed out deep-indexing JAR: ${fingerprint.path}`)), 60_000);
                zipfile.on('error', fail);
                zipfile.on('entry', (entry: yauzl.Entry) => {
                    if (!targets.has(entry.fileName) || entry.uncompressedSize > 20 * 1024 * 1024) {
                        zipfile.readEntry();
                        return;
                    }
                    zipfile.openReadStream(entry, (streamError: Error | null, stream: NodeJS.ReadableStream) => {
                        if (streamError || !stream) {
                            parseErrors++;
                            zipfile.readEntry();
                            return;
                        }
                        const chunks: Buffer[] = [];
                        let streamSettled = false;
                        stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
                        stream.on('error', () => {
                            if (streamSettled) return;
                            streamSettled = true;
                            parseErrors++;
                            zipfile.readEntry();
                        });
                        stream.on('end', () => {
                            if (streamSettled) return;
                            streamSettled = true;
                            try {
                                classes.push({ ...ClassFileMetadataReader.read(Buffer.concat(chunks)), entryPath: entry.fileName });
                            } catch {
                                parseErrors++;
                            }
                            zipfile.readEntry();
                        });
                    });
                });
                zipfile.on('end', () => {
                    if (failed) return;
                    if (timer) clearTimeout(timer);
                    try { zipfile.close(); } catch { /* ignore */ }
                    resolve({
                        schemaVersion: 3,
                        fingerprint,
                        classes,
                        parseErrors,
                        indexedAt: new Date().toISOString(),
                    });
                });
                zipfile.readEntry();
            });
        });
    }

    private buildLightIndex(fingerprint: JarFingerprint): Promise<JarLightIndex> {
        return new Promise((resolve, reject) => {
            yauzl.open(fingerprint.path, { lazyEntries: true }, (openError: Error | null, zipfile: yauzl.ZipFile) => {
                if (openError || !zipfile) {
                    reject(new Error(`Unable to open JAR ${fingerprint.path}: ${openError?.message ?? 'unknown error'}`));
                    return;
                }

                const classMap = new Map<string, JarClassEntry>();
                const resources: JarResourceEntry[] = [];
                const nestedJars: string[] = [];
                const manifest: Record<string, string> = {};
                const coordinates: MavenCoordinates[] = [];
                let layout: JarLightIndex['layout'] = fingerprint.path.toLowerCase().endsWith('.jmod') ? 'jmod' : 'jar';
                let failed = false;
                let timer: NodeJS.Timeout | undefined;

                const fail = (error: Error) => {
                    if (failed) return;
                    failed = true;
                    if (timer) clearTimeout(timer);
                    try { zipfile.close(); } catch { /* ignore */ }
                    reject(error);
                };
                timer = setTimeout(() => fail(new Error(`Timed out indexing JAR: ${fingerprint.path}`)), 30_000);

                const continueReading = () => { if (!failed) zipfile.readEntry(); };
                zipfile.on('error', fail);
                zipfile.on('entry', (entry: yauzl.Entry) => {
                    const entryPath = entry.fileName.replace(/\\/g, '/');
                    if (entryPath.endsWith('/')) {
                        continueReading();
                        return;
                    }

                    if (entryPath.startsWith('BOOT-INF/')) layout = 'spring-boot';
                    if (entryPath.startsWith('WEB-INF/')) layout = 'war';

                    const classEntry = this.toClassEntry(entryPath);
                    if (classEntry) {
                        const classKey = `${classEntry.className}::${classEntry.isSource ? 'source' : 'binary'}`;
                        const existing = classMap.get(classKey);
                        if (!existing || classEntry.release >= existing.release) {
                            classMap.set(classKey, classEntry);
                        }
                        continueReading();
                        return;
                    }

                    if (/^(BOOT-INF\/lib|WEB-INF\/lib|lib)\/.+\.jar$/i.test(entryPath)) {
                        nestedJars.push(entryPath);
                    }

                    const lower = entryPath.toLowerCase();
                    const isManifest = lower === 'meta-inf/manifest.mf';
                    const isPomProperties = /^meta-inf\/maven\/[^/]+\/[^/]+\/pom\.properties$/i.test(entryPath);
                    if (isManifest || isPomProperties) {
                        resources.push({
                            path: entryPath,
                            size: entry.uncompressedSize,
                            compressedSize: entry.compressedSize,
                            crc32: entry.crc32,
                            isText: true,
                        });
                        if (entry.uncompressedSize > 1024 * 1024) {
                            continueReading();
                            return;
                        }
                        zipfile.openReadStream(entry, (streamError: Error | null, stream: NodeJS.ReadableStream) => {
                            if (streamError || !stream) {
                                fail(streamError ?? new Error(`Unable to read ${entryPath}`));
                                return;
                            }
                            const chunks: Buffer[] = [];
                            let streamSettled = false;
                            stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
                            stream.on('error', error => {
                                if (streamSettled) return;
                                streamSettled = true;
                                fail(error);
                            });
                            stream.on('end', () => {
                                if (streamSettled || failed) return;
                                streamSettled = true;
                                const text = Buffer.concat(chunks).toString('utf8');
                                if (isManifest) Object.assign(manifest, this.parseKeyValues(text, true));
                                if (isPomProperties) coordinates.push(this.parseKeyValues(text, false));
                                continueReading();
                            });
                        });
                        return;
                    }

                    const extension = path.posix.extname(lower);
                    resources.push({
                        path: entryPath,
                        size: entry.uncompressedSize,
                        compressedSize: entry.compressedSize,
                        crc32: entry.crc32,
                        isText: TEXT_EXTENSIONS.has(extension) || lower.startsWith('meta-inf/services/'),
                    });
                    continueReading();
                });

                zipfile.on('end', () => {
                    if (failed) return;
                    if (timer) clearTimeout(timer);
                    try { zipfile.close(); } catch { /* ignore */ }
                    const classes = [...classMap.values()].sort((a, b) => a.className.localeCompare(b.className));
                    resolve({
                        schemaVersion: 3,
                        fingerprint,
                        jarPath: fingerprint.path,
                        jarName: path.basename(fingerprint.path),
                        classes,
                        resources: resources.sort((a, b) => a.path.localeCompare(b.path)),
                        nestedJars: nestedJars.sort(),
                        packages: [...new Set(classes.filter(c => !c.isInner).map(c => c.packageName))].filter(Boolean).sort(),
                        manifest,
                        mavenCoordinates: coordinates,
                        isMultiRelease: manifest['Multi-Release']?.toLowerCase() === 'true' || classes.some(c => c.release > 0),
                        isSourceJar: fingerprint.path.toLowerCase().endsWith('-sources.jar') || classes.some(c => c.isSource),
                        layout,
                        indexedAt: new Date().toISOString(),
                    });
                });
                zipfile.readEntry();
            });
        });
    }

    private toClassEntry(entryPath: string): JarClassEntry | null {
        let logical = entryPath;
        let release = 0;
        const versionMatch = logical.match(/^META-INF\/versions\/(\d+)\/(.+)$/i);
        if (versionMatch) {
            release = Number(versionMatch[1]);
            logical = versionMatch[2];
        }
        logical = logical.replace(/^(BOOT-INF|WEB-INF)\/classes\//, '');
        logical = logical.replace(/^classes\//, ''); // JMOD layout

        const isClass = logical.endsWith('.class');
        const isSource = logical.endsWith('.java');
        if (!isClass && !isSource) return null;
        if (logical.startsWith('META-INF/')) return null;

        const className = logical.replace(/\.(class|java)$/i, '').replace(/\//g, '.');
        const simpleName = className.substring(className.lastIndexOf('.') + 1);
        if (simpleName === 'module-info' || simpleName === 'package-info') return null;
        const packageName = className.includes('.') ? className.substring(0, className.lastIndexOf('.')) : '';
        return {
            className,
            packageName,
            simpleName,
            entryPath,
            release,
            isInner: simpleName.includes('$'),
            isSource,
        };
    }

    private parseKeyValues(text: string, manifestStyle: boolean): Record<string, string> {
        const result: Record<string, string> = {};
        let previousKey: string | undefined;
        for (const rawLine of text.split(/\r?\n/)) {
            if (manifestStyle && rawLine.startsWith(' ') && previousKey) {
                result[previousKey] += rawLine.substring(1);
                continue;
            }
            const separator = manifestStyle ? rawLine.indexOf(':') : rawLine.indexOf('=');
            if (separator <= 0) continue;
            const key = rawLine.substring(0, separator).trim();
            const value = rawLine.substring(separator + 1).trim();
            result[key] = value;
            previousKey = key;
        }
        return result;
    }

    private cachePath(contextPath: string, jarPath: string, kind: 'light' | 'deep'): string {
        const pathKey = createHash('sha256').update(path.resolve(jarPath)).digest('hex').substring(0, 20);
        void contextPath;
        return path.join(getGlobalJarIndexesDir(), `${pathKey}.${kind}.json`);
    }

    private async readCache<T extends { schemaVersion: number; fingerprint: JarFingerprint }>(
        cachePath: string,
        fingerprint: JarFingerprint,
    ): Promise<T | null> {
        try {
            const value = await fs.readJson(cachePath) as T;
            if (value.schemaVersion !== 3 || value.fingerprint.key !== fingerprint.key) return null;
            return value;
        } catch {
            return null;
        }
    }
}

export const jarIndexer = new JarIndexer();
