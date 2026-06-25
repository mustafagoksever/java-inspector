import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './Logger.js';
import { getServerLogPath } from './cachePaths.js';

const TEST_PROJECT = path.join(os.tmpdir(), `java-inspector-logger-test-${process.pid}`);

describe('Logger', () => {
    beforeEach(() => {
        // Reset singleton state
        (Logger as any).instances = new Map();
        (Logger as any).normalizedPaths = new Map();
    });

    afterEach(() => {
        try {
            const logFile = getServerLogPath(TEST_PROJECT, process.pid);
            if (fs.existsSync(logFile)) {
                fs.unlinkSync(logFile);
            }
            const cacheDir = path.dirname(logFile);
            if (fs.existsSync(cacheDir)) {
                fs.rmdirSync(cacheDir, { recursive: true });
            }
        } catch {
            // ignore cleanup errors
        }
        (Logger as any).instances = new Map();
        (Logger as any).normalizedPaths = new Map();
    });

    it('should be a singleton per projectPath', () => {
        const logger1 = Logger.get(TEST_PROJECT);
        const logger2 = Logger.get(TEST_PROJECT);
        expect(logger1).toBe(logger2);
    });

    it('should create different instances for different projects', () => {
        const logger1 = Logger.get(TEST_PROJECT);
        const logger2 = Logger.get(TEST_PROJECT + '-other');
        expect(logger1).not.toBe(logger2);
    });

    it('should write logs to file with correct format', () => {
        const logger = Logger.get(TEST_PROJECT);
        logger.info('Test message');

        const logFile = getServerLogPath(TEST_PROJECT, process.pid);
        expect(fs.existsSync(logFile)).toBe(true);

        const content = fs.readFileSync(logFile, 'utf-8');
        expect(content).toContain('[INFO ]');
        expect(content).toContain('Test message');
        expect(content).toContain(`[PID:${process.pid}]`);
        // Should contain ISO timestamp
        expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should include context tags in formatted line', () => {
        const logger = Logger.get(TEST_PROJECT);
        logger.info('[SERVER] Startup complete');

        const logFile = getServerLogPath(TEST_PROJECT, process.pid);
        const content = fs.readFileSync(logFile, 'utf-8');
        expect(content).toContain('[SERVER]');
        expect(content).toContain('Startup complete');
    });

    it('should append multiple log levels', () => {
        const logger = Logger.get(TEST_PROJECT);
        logger.debug('debug msg');
        logger.info('info msg');
        logger.warn('warn msg');
        logger.error('error msg');

        const logFile = getServerLogPath(TEST_PROJECT, process.pid);
        const content = fs.readFileSync(logFile, 'utf-8');
        expect(content).toContain('[DEBUG]');
        expect(content).toContain('debug msg');
        expect(content).toContain('[INFO ]');
        expect(content).toContain('info msg');
        expect(content).toContain('[WARN ]');
        expect(content).toContain('warn msg');
        expect(content).toContain('[ERROR]');
        expect(content).toContain('error msg');
    });

    it('should append logs to existing file', () => {
        const logger = Logger.get(TEST_PROJECT);
        logger.info('first');
        logger.info('second');

        const logFile = getServerLogPath(TEST_PROJECT, process.pid);
        const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
        expect(lines.length).toBe(2);
        expect(lines[0]).toContain('first');
        expect(lines[1]).toContain('second');
    });

    it('clearLog should remove log file and delete instance', () => {
        const logger = Logger.get(TEST_PROJECT);
        logger.info('before clear');

        const logFile = getServerLogPath(TEST_PROJECT, process.pid);
        expect(fs.existsSync(logFile)).toBe(true);

        Logger.clearLog(TEST_PROJECT);
        expect(fs.existsSync(logFile)).toBe(false);

        // After clearing, get should create a new instance
        const newLogger = Logger.get(TEST_PROJECT);
        expect(newLogger).not.toBe(logger);
    });

    it('should handle messages without context tags', () => {
        const logger = Logger.get(TEST_PROJECT);
        logger.info('Plain message without brackets');

        const logFile = getServerLogPath(TEST_PROJECT, process.pid);
        const content = fs.readFileSync(logFile, 'utf-8');
        expect(content).toContain('Plain message without brackets');
    });

    it('should handle nested context tags', () => {
        const logger = Logger.get(TEST_PROJECT);
        logger.info('[TOOL:scan_dependencies] Request received');

        const logFile = getServerLogPath(TEST_PROJECT, process.pid);
        const content = fs.readFileSync(logFile, 'utf-8');
        expect(content).toContain('[TOOL:scan_dependencies]');
        expect(content).toContain('Request received');
    });
});
