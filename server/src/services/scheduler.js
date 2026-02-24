const intelligenceService = require('./intelligenceService');

// Lazy-load to avoid circular dependency
let memoryService;
function getMemoryService() {
    if (!memoryService) memoryService = require('./memoryService');
    return memoryService;
}

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

        // 1. Summarization sweep — every 2 minutes (catches missed/failed summarizations)
        this.schedule('Summarization Sweep', 2 * 60 * 1000, async () => {
            await getMemoryService().sweepUnsummarized();
        });

        // 2. Apply memory decay — every 6 hours
        this.schedule('Memory Decay', 6 * 60 * 60 * 1000, async () => {
            await intelligenceService.applyDecay();
        });

        // 3. Duplicate detection — every 2 hours
        this.schedule('Duplicate Detection', 2 * 60 * 60 * 1000, async () => {
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
