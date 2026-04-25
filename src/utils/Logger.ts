import * as fs from 'fs';
import * as path from 'path';
import { getServerLogPath } from './cachePaths.js';

export class Logger {
    private static instances = new Map<string, Logger>();
    private logFile: string;
    private pid: number;

    static get(projectPath: string): Logger {
        if (!this.instances.has(projectPath)) {
            this.instances.set(projectPath, new Logger(projectPath));
        }
        return this.instances.get(projectPath)!;
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
        // Extract context tag like [SERVER], [MAVEN], [TOOL:x] from message start
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

    static clearLog(projectPath: string): void {
        try {
            const logFile = getServerLogPath(projectPath, process.pid);
            if (fs.existsSync(logFile)) {
                fs.unlinkSync(logFile);
            }
        } catch {
            // ignore
        }
        this.instances.delete(projectPath);
    }
}
