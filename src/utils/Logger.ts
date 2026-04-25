import * as fs from 'fs';
import * as path from 'path';
import { getProjectCacheDir } from './cachePaths.js';

export class Logger {
    private static instances = new Map<string, Logger>();
    private logFile: string;

    static get(projectPath: string): Logger {
        if (!this.instances.has(projectPath)) {
            this.instances.set(projectPath, new Logger(projectPath));
        }
        return this.instances.get(projectPath)!;
    }

    private constructor(private projectPath: string) {
        const cacheDir = getProjectCacheDir(projectPath);
        this.logFile = path.join(cacheDir, 'server.log');
        try {
            fs.mkdirSync(cacheDir, { recursive: true });
        } catch {
            // ignore
        }
    }

    private write(level: string, msg: string): void {
        const timestamp = new Date().toISOString();
        const levelPadded = level.padEnd(5);
        // Extract context tag like [SERVER], [MAVEN], [TOOL:x] from message start
        const contextMatch = msg.match(/^(\[[A-Z][A-Z0-9_:-]*\])\s*(.*)$/);
        let line: string;
        if (contextMatch) {
            const [, context, rest] = contextMatch;
            line = `[${timestamp}] [${levelPadded}] ${context} ${rest}\n`;
        } else {
            line = `[${timestamp}] [${levelPadded}] ${msg}\n`;
        }
        console.error(line.trimEnd());
        try {
            fs.appendFileSync(this.logFile, line);
        } catch {
            // ignore
        }
    }

    debug(msg: string): void { this.write('DEBUG', msg); }
    info(msg: string): void { this.write('INFO', msg); }
    warn(msg: string): void { this.write('WARN', msg); }
    error(msg: string): void { this.write('ERROR', msg); }

    static clearLog(projectPath: string): void {
        try {
            const logFile = path.join(getProjectCacheDir(projectPath), 'server.log');
            if (fs.existsSync(logFile)) {
                fs.unlinkSync(logFile);
            }
        } catch {
            // ignore
        }
        this.instances.delete(projectPath);
    }
}
