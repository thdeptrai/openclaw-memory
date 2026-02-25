/**
 * ============================================================
 *  Category Service — Hierarchical memory categorization
 *
 *  Manages categories per agent with:
 *    - Seed categories (created on first use)
 *    - Auto-assignment of memories to categories via embedding similarity
 *    - Optional auto-summary generation (LLM-powered)
 * ============================================================
 */
const db = require('../models');
const embeddingService = require('./embeddingService');
const vectorStore = require('./vectorStore');
const runtimeConfig = require('../runtimeConfig');

// Default categories with descriptions
const DEFAULT_CATEGORIES = [
    { name: 'personal_info', description: 'Name, age, location, relationships, personal details' },
    { name: 'preferences', description: 'Likes, dislikes, preferred tools, languages, styles' },
    { name: 'work_professional', description: 'Job, company, work projects, professional skills' },
    { name: 'technical_stack', description: 'Programming languages, frameworks, databases, DevOps tools' },
    { name: 'goals_plans', description: 'Long-term goals, current projects, future plans' },
    { name: 'experiences_events', description: 'Past events, meetings, trips, milestones, incidents' },
    { name: 'knowledge_concepts', description: 'Learned concepts, domain knowledge, definitions' },
    { name: 'habits_routines', description: 'Daily routines, work habits, recurring patterns, workflows' },
    { name: 'opinions_feedback', description: 'Evaluations, critiques, assessments, comparisons' },
    { name: 'decisions_agreements', description: 'Architecture choices, tech decisions, accepted proposals' },
];

// Cache: agentId → { categories: [...], embeddings: Map<catId, embedding>, lastUpdated }
const categoryCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Seed default categories for an agent (idempotent)
 */
async function seedCategories(agentId) {
    const results = [];
    for (const cat of DEFAULT_CATEGORIES) {
        const created = await db.addCategory(agentId, cat.name, cat.description);
        if (created) results.push(created);
    }
    // Invalidate cache
    categoryCache.delete(agentId);
    return results;
}

/**
 * Get categories for an agent (with caching)
 */
async function getCategoriesWithCache(agentId) {
    const cached = categoryCache.get(agentId);
    if (cached && Date.now() - cached.lastUpdated < CACHE_TTL_MS) {
        return cached.categories;
    }

    let categories = await db.getCategories(agentId);

    // Auto-seed if no categories exist
    if (categories.length === 0) {
        await seedCategories(agentId);
        categories = await db.getCategories(agentId);
    }

    categoryCache.set(agentId, {
        categories,
        lastUpdated: Date.now(),
    });

    return categories;
}

/**
 * Assign a memory to 1-3 best-matching categories based on content similarity.
 * Uses a simple keyword/heuristic approach to avoid extra embedding calls.
 *
 * @param {string} memoryId - UUID of the stored memory
 * @param {string} agentId - Agent that owns the memory
 * @param {string} factText - The fact content
 * @param {string} memoryType - profile/event/knowledge/behavior
 */
async function assignCategories(memoryId, agentId, factText, memoryType = 'knowledge') {
    try {
        const categories = await getCategoriesWithCache(agentId);
        if (categories.length === 0) return;

        const text = factText.toLowerCase();

        // Type-based primary assignment
        const typeToCategory = {
            'profile': ['personal_info', 'preferences'],
            'event': ['experiences_events'],
            'knowledge': ['knowledge_concepts', 'technical_stack'],
            'behavior': ['habits_routines'],
        };
        const primaryCats = typeToCategory[memoryType] || ['knowledge_concepts'];

        // Keyword-based secondary assignment
        const keywordMap = {
            'personal_info': /\b(tên|name|tuổi|age|sống|live|ở|sinh|born|gia đình|family)\b/i,
            'preferences': /\b(thích|prefer|muốn|want|chọn|choose|dùng|use|style|kiểu)\b/i,
            'work_professional': /\b(làm|work|job|công ty|company|project|dự án|team)\b/i,
            'technical_stack': /\b(react|vue|node|python|docker|postgresql|redis|typescript|api|database|framework|git)\b/i,
            'goals_plans': /\b(goal|mục tiêu|plan|kế hoạch|build|xây dựng|tương lai|future)\b/i,
            'experiences_events': /\b(hôm nay|today|yesterday|hôm qua|meeting|event|gặp|happened|last week)\b/i,
            'knowledge_concepts': /\b(là gì|what is|concept|khái niệm|definition|nghĩa là|means)\b/i,
            'habits_routines': /\b(thường|usually|always|luôn|routine|habit|mỗi ngày|daily|workflow)\b/i,
            'opinions_feedback': /\b(đẹp|ugly|tốt|good|bad|xấu|chậm|slow|fast|nhanh|đánh giá|review)\b/i,
            'decisions_agreements': /\b(quyết định|decide|đồng ý|agree|chốt|confirm|ok dùng|architecture)\b/i,
        };

        // Score each category
        const scored = categories.map(cat => {
            let score = 0;
            // Primary type match
            if (primaryCats.includes(cat.name)) score += 3;
            // Keyword match
            if (keywordMap[cat.name] && keywordMap[cat.name].test(text)) score += 2;
            return { cat, score };
        });

        // Sort and take top 1-2 matches (must have score > 0)
        scored.sort((a, b) => b.score - a.score);
        const assigned = scored.filter(s => s.score > 0).slice(0, 2);

        // Link memory to categories
        for (const { cat } of assigned) {
            await db.linkMemoryToCategory(memoryId, cat.id);
        }
    } catch (err) {
        console.warn('⚠️ Category assignment failed:', err.message);
    }
}

/**
 * Generate an LLM-powered summary for a category based on its memories.
 * This is an expensive operation (1 LLM call per category) — use sparingly.
 *
 * @param {string} categoryId - UUID of the category
 * @param {string} categoryName - Human-readable category name
 * @returns {Promise<string|null>} Generated summary or null on failure
 */
async function generateCategorySummary(categoryId, categoryName) {
    const llmService = require('./llmService');
    try {
        const memories = await db.getCategoryMemories(categoryId, 30);
        if (memories.length === 0) return null;

        const memoryTexts = memories.map((m, i) => `[${i}] ${m.content}`).join('\n');

        const result = await llmService.chatJSON(
            `You are a memory summarizer. Given a list of memories in the "${categoryName}" category, produce a concise summary (2-4 sentences) capturing the key patterns and important facts. Return JSON: {"summary": "..."}`,
            `MEMORIES:\n${memoryTexts.substring(0, 3000)}\n\nSummarize these ${memories.length} memories concisely.`,
            { maxTokens: 300, timeout: 15000, purpose: 'category_summary' }
        );

        if (result.summary && result.summary.length > 10) {
            await db.updateCategorySummary(categoryId, result.summary);
            // Invalidate cache
            for (const [agentId, cache] of categoryCache.entries()) {
                const cat = cache.categories?.find(c => c.id === categoryId);
                if (cat) {
                    categoryCache.delete(agentId);
                    break;
                }
            }
            return result.summary;
        }
    } catch (err) {
        console.warn(`⚠️ Category summary generation failed for ${categoryName}:`, err.message);
    }
    return null;
}

/**
 * Regenerate summaries for all categories of an agent.
 * Expensive: 1 LLM call per category with memories.
 */
async function regenerateAllSummaries(agentId) {
    const categories = await getCategoriesWithCache(agentId);
    const results = [];

    for (const cat of categories) {
        if (cat.memory_count > 0) {
            const summary = await generateCategorySummary(cat.id, cat.name);
            results.push({ name: cat.name, summary });
        }
    }

    console.log(`📝 Regenerated ${results.filter(r => r.summary).length}/${results.length} category summaries for agent ${agentId}`);
    return results;
}

module.exports = {
    seedCategories,
    getCategoriesWithCache,
    assignCategories,
    generateCategorySummary,
    regenerateAllSummaries,
    DEFAULT_CATEGORIES,
};
