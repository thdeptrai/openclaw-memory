const intelligenceService = require('./intelligenceService');
const runtimeConfig = require('../runtimeConfig');

/**
 * Scheduler — Runs periodic intelligence tasks
 *
 * Uses simple setInterval-based scheduling (no external cron dependency)
 */
class Scheduler {
    constructor() {
        this.intervals = [];
        this.running = false;
    }

    /**
     * Start all scheduled tasks
     */
    start() {
        if (this.running) return;
        this.running = true;

        console.log('⏰ Scheduler started');

        // 1. Apply memory decay
        const decayMs = runtimeConfig.get('scheduler.memoryDecay');
        this.schedule('Memory Decay', decayMs, async () => {
            await intelligenceService.applyDecay();
        });

        // 2. Duplicate detection
        const dedupMs = runtimeConfig.get('scheduler.duplicateDetection');
        this.schedule('Duplicate Detection', dedupMs, async () => {
            await intelligenceService.detectAndMergeDuplicates();
        });
    }

    /**
     * Schedule a recurring task
     */
    schedule(name, intervalMs, fn) {
        console.log(`  📅 ${name}: every ${(intervalMs / 3600000).toFixed(1)}h`);

        const wrappedFn = async () => {
            try {
                console.log(`\n🔄 Running: ${name}`);
                await fn();
                console.log(`✅ Done: ${name}`);
            } catch (err) {
                console.error(`❌ ${name} failed:`, err.message);
            }
        };

        const interval = setInterval(wrappedFn, intervalMs);
        this.intervals.push(interval);
    }

    /**
     * Run all tasks once (useful for testing)
     */
    async runAll() {
        console.log('🔄 Running all intelligence tasks...');
        await intelligenceService.applyDecay();
        await intelligenceService.detectAndMergeDuplicates();
        console.log('✅ All intelligence tasks complete');
    }

    /**
     * Stop all scheduled tasks
     */
    stop() {
        for (const interval of this.intervals) {
            clearInterval(interval);
        }
        this.intervals = [];
        this.running = false;
        console.log('⏰ Scheduler stopped');
    }
}

module.exports = new Scheduler();
