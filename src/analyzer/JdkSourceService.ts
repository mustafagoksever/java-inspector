import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import fs from 'fs-extra';
import * as yauzl from 'yauzl';

const execFileAsync = promisify(execFile);

export class JdkSourceService {
    private javaHomePromise?: Promise<string | null>;
    private sourceClassesPromise?: Promise<Array<{ className: string; module?: string }>>;

    isLikelyJdkClass(className: string): boolean {
        return /^(java|javax|jdk|sun|com\.sun)\./.test(className);
    }

    async getSource(className: string): Promise<string | null> {
        const javaHome = await this.getJavaHome();
        if (!javaHome) return null;
        const candidates = [
            path.join(javaHome, 'lib', 'src.zip'),
            path.join(javaHome, 'src.zip'),
            path.resolve(javaHome, '..', 'lib', 'src.zip'),
        ];
        const srcZip = candidates.find(candidate => fs.existsSync(candidate));
        if (!srcZip) return null;
        const outerClass = className.split('$')[0];
        const suffix = `${outerClass.replace(/\./g, '/')}.java`;
        return this.readEntryEndingWith(srcZip, suffix);
    }

    async searchClasses(query: string, limit: number = 20): Promise<Array<{ className: string; module?: string; score: number }>> {
        const classes = await this.getSourceClasses();
        const lower = query.toLowerCase().trim();
        return classes
            .map(entry => {
                const simpleName = entry.className.substring(entry.className.lastIndexOf('.') + 1).toLowerCase();
                const fullName = entry.className.toLowerCase();
                const score = fullName === lower ? 120 : simpleName === lower ? 110 : simpleName.includes(lower) ? 60 : fullName.includes(lower) ? 50 : 0;
                return { ...entry, score };
            })
            .filter(entry => entry.score > 0)
            .sort((a, b) => b.score - a.score || a.className.localeCompare(b.className))
            .slice(0, limit);
    }

    async getJavaHome(): Promise<string | null> {
        if (this.javaHomePromise) return this.javaHomePromise;
        this.javaHomePromise = this.resolveJavaHome();
        return this.javaHomePromise;
    }

    private async resolveJavaHome(): Promise<string | null> {
        if (process.env.JAVA_HOME && await fs.pathExists(process.env.JAVA_HOME)) {
            return path.resolve(process.env.JAVA_HOME);
        }
        try {
            const { stderr, stdout } = await execFileAsync('java', ['-XshowSettings:properties', '-version'], { timeout: 10000 });
            const match = `${stdout}\n${stderr}`.match(/^\s*java\.home\s*=\s*(.+)$/m);
            return match ? path.resolve(match[1].trim()) : null;
        } catch {
            return null;
        }
    }

    private async getSourceClasses(): Promise<Array<{ className: string; module?: string }>> {
        if (this.sourceClassesPromise) return this.sourceClassesPromise;
        this.sourceClassesPromise = (async () => {
            const javaHome = await this.getJavaHome();
            if (!javaHome) return [];
            const candidates = [path.join(javaHome, 'lib', 'src.zip'), path.join(javaHome, 'src.zip'), path.resolve(javaHome, '..', 'lib', 'src.zip')];
            const srcZip = candidates.find(candidate => fs.existsSync(candidate));
            if (!srcZip) return [];
            return new Promise<Array<{ className: string; module?: string }>>((resolve, reject) => {
                yauzl.open(srcZip, { lazyEntries: true }, (error: Error | null, zipfile: yauzl.ZipFile) => {
                    if (error || !zipfile) { reject(error ?? new Error(`Unable to open ${srcZip}`)); return; }
                    const results: Array<{ className: string; module?: string }> = [];
                    zipfile.on('entry', (entry: yauzl.Entry) => {
                        if (entry.fileName.endsWith('.java') && !entry.fileName.endsWith('module-info.java') && !entry.fileName.endsWith('package-info.java')) {
                            const parts = entry.fileName.split('/');
                            const module = parts.length > 2 && parts[0].includes('.') ? parts.shift() : undefined;
                            results.push({ className: parts.join('.').replace(/\.java$/, ''), module });
                        }
                        zipfile.readEntry();
                    });
                    zipfile.on('error', reject);
                    zipfile.on('end', () => resolve(results));
                    zipfile.readEntry();
                });
            });
        })();
        return this.sourceClassesPromise;
    }

    private readEntryEndingWith(zipPath: string, suffix: string): Promise<string | null> {
        return new Promise((resolve, reject) => {
            yauzl.open(zipPath, { lazyEntries: true }, (openError: Error | null, zipfile: yauzl.ZipFile) => {
                if (openError || !zipfile) {
                    reject(openError ?? new Error(`Unable to open ${zipPath}`));
                    return;
                }
                let settled = false;
                const finish = (value: string | null) => {
                    if (settled) return;
                    settled = true;
                    try { zipfile.close(); } catch { /* ignore */ }
                    resolve(value);
                };
                zipfile.on('error', reject);
                zipfile.on('entry', (entry: yauzl.Entry) => {
                    if (!entry.fileName.endsWith(suffix)) {
                        zipfile.readEntry();
                        return;
                    }
                    zipfile.openReadStream(entry, (streamError: Error | null, stream: NodeJS.ReadableStream) => {
                        if (streamError || !stream) {
                            reject(streamError ?? new Error(`Unable to read ${entry.fileName}`));
                            return;
                        }
                        const chunks: Buffer[] = [];
                        stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
                        stream.on('error', reject);
                        stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
                    });
                });
                zipfile.on('end', () => finish(null));
                zipfile.readEntry();
            });
        });
    }
}

export const jdkSourceService = new JdkSourceService();
