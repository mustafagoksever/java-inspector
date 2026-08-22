import * as path from 'path';
import { jarIndexer, JarDeepIndex, JarLightIndex } from './JarIndexer.js';

export type ScanPriority = 'foreground' | 'background';

interface QueueItem<T> {
    priority: ScanPriority;
    run: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

/**
 * Coordinates every JAR read in the process. Background work is capped below
 * total capacity so interactive tool calls always retain two I/O slots.
 */
export class JarScanCoordinator {
    private active = 0;
    private activeBackground = 0;
    private foregroundQueue: QueueItem<any>[] = [];
    private backgroundQueue: QueueItem<any>[] = [];
    private inFlight = new Map<string, Promise<any>>();
    private queuedByKey = new Map<string, QueueItem<any>>();

    constructor(
        private readonly maxConcurrent: number = 8,
        private readonly maxBackground: number = 6,
        private readonly lightTimeoutMs: number = 30_000,
        private readonly deepTimeoutMs: number = 60_000,
    ) {}

    scanLight(jarPath: string, contextPath: string, priority: ScanPriority): Promise<JarLightIndex> {
        return this.schedule(
            `light::${path.resolve(jarPath)}`,
            priority,
            () => this.withTimeout(
                jarIndexer.getLightIndex(jarPath, contextPath),
                this.lightTimeoutMs,
                `Timed out after ${this.lightTimeoutMs}ms indexing JAR: ${path.resolve(jarPath)}`,
            ),
        );
    }

    scanDeep(jarPath: string, contextPath: string, priority: ScanPriority): Promise<JarDeepIndex> {
        return this.schedule(
            `deep::${path.resolve(jarPath)}`,
            priority,
            () => this.withTimeout(
                jarIndexer.getDeepIndex(jarPath, contextPath),
                this.deepTimeoutMs,
                `Timed out after ${this.deepTimeoutMs}ms deep-indexing JAR: ${path.resolve(jarPath)}`,
            ),
        );
    }

    getStats(): { active: number; activeBackground: number; foregroundQueued: number; backgroundQueued: number } {
        return {
            active: this.active,
            activeBackground: this.activeBackground,
            foregroundQueued: this.foregroundQueue.length,
            backgroundQueued: this.backgroundQueue.length,
        };
    }

    private schedule<T>(key: string, priority: ScanPriority, run: () => Promise<T>): Promise<T> {
        const existing = this.inFlight.get(key);
        if (existing) {
            const queued = this.queuedByKey.get(key);
            if (priority === 'foreground' && queued?.priority === 'background') {
                const index = this.backgroundQueue.indexOf(queued);
                if (index >= 0) this.backgroundQueue.splice(index, 1);
                queued.priority = 'foreground';
                this.foregroundQueue.push(queued);
                this.pump();
            }
            return existing as Promise<T>;
        }

        let resolvePromise!: (value: T) => void;
        let rejectPromise!: (reason: unknown) => void;
        const promise = new Promise<T>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        this.inFlight.set(key, promise);

        const item: QueueItem<T> = {
            priority,
            run,
            resolve: resolvePromise,
            reject: rejectPromise,
        };
        if (priority === 'foreground') this.foregroundQueue.push(item);
        else this.backgroundQueue.push(item);
        this.queuedByKey.set(key, item);
        promise.finally(() => {
            this.inFlight.delete(key);
            this.queuedByKey.delete(key);
        }).catch(() => {});
        this.pump();
        return promise;
    }

    private pump(): void {
        while (this.active < this.maxConcurrent) {
            let item: QueueItem<any> | undefined;
            if (this.foregroundQueue.length > 0) {
                item = this.foregroundQueue.shift();
            } else if (this.backgroundQueue.length > 0 && this.activeBackground < this.maxBackground) {
                item = this.backgroundQueue.shift();
            }
            if (!item) break;

            for (const [key, queued] of this.queuedByKey) {
                if (queued === item) {
                    this.queuedByKey.delete(key);
                    break;
                }
            }
            this.active++;
            if (item.priority === 'background') this.activeBackground++;
            item.run()
                .then(item.resolve, item.reject)
                .finally(() => {
                    this.active--;
                    if (item!.priority === 'background') this.activeBackground--;
                    this.pump();
                });
        }
    }

    private async withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                operation,
                new Promise<T>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

export const jarScanCoordinator = new JarScanCoordinator();
