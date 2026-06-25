import * as fs from 'fs';
import * as path from 'path';
import { getServerLogPath } from './cachePaths.js';

export class Logger {
    private static instances = new Map<string, Logger>();
    private static normalizedPaths = new Map<string, string>();
    private logFile: string;
    private pid: number;

    static get(projectPath: string): Logger {
        const normalized = path.resolve(projectPath);
        const existingKey = Logger.normalizedPaths.get(normalized);
        const key = existingKey ?? projectPath;

        if (!this.instances.has(key)) {
            Logger.normalizedPaths.set(normalized, key);
            this.instances.set(key, new Logger(key));
        }
        return this.instances.get(key)!;
    }

    private constructor(private projectPath: string) {
        this.pid = process.pid;
        this.logFile = getServerLogPath(projectPath, this.pid);
        try {
            fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        } catch {
            // ignore
        }
    }

    private write(level: string, msg: string): void {
        const timestamp = new Date().toISOString();
        const levelPadded = level.padEnd(5);
        const contextMatch = msg.match(/^(\[[A-Z][A-Z0-9_:-]*\])\s*(.*)$/);
        let line: string;
        if (contextMatch) {
            const [, context, rest] = contextMatch;
            line = `[${timestamp}] [${levelPadded}] [PID:${this.pid}] ${context} ${rest}\n`;
        } else {
            line = `[${timestamp}] [${levelPadded}] [PID:${this.pid}] ${msg}\n`;
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

    dispose(): void {
        Logger.instances.delete(this.projectPath);
        const normalized = path.resolve(this.projectPath);
        Logger.normalizedPaths.delete(normalized);
    }

    static clearLog(projectPath: string): void {
        const normalized = path.resolve(projectPath);
        const key = Logger.normalizedPaths.get(normalized) ?? projectPath;
        const instance = Logger.instances.get(key);
        if (instance) {
            instance.dispose();
        }
        try {
            const logFile = getServerLogPath(key, process.pid);
            if (fs.existsSync(logFile)) {
                fs.unlinkSync(logFile);
            }
        } catch {
            // ignore
        }
    }

    static disposeAll(): void {
        for (const [, instance] of Logger.instances) {
            instance.dispose();
        }
        Logger.instances.clear();
        Logger.normalizedPaths.clear();
    }
}
