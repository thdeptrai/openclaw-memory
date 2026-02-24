/**
 * Build a context string from recalled memories for LLM prompt injection.
 * Groups memories by scope + topic for clear contextual understanding.
 */
function buildContextFromMemories(memories, maxLength = 3000) {
    const parts = [];

    // --- Group semantic memories by scope + topic ---
    if (memories.semanticMemories && memories.semanticMemories.length > 0) {
        const groups = groupByContext(memories.semanticMemories);

        // Universal knowledge first
        if (groups.universal.length > 0) {
            parts.push('=== 🌐 Universal Knowledge ===');
            for (const m of groups.universal) {
                parts.push(formatMemory(m));
            }
            parts.push('');
        }

        // Current topic (highest relevance)
        const profile = memories.conversationProfile || {};
        const currentTopic = profile.topic || null;

        if (currentTopic && groups.byTopic[currentTopic]) {
            parts.push(`=== 📁 Project: "${currentTopic}" ===`);
            for (const m of groups.byTopic[currentTopic]) {
                parts.push(formatMemory(m));
            }
            parts.push('');
            delete groups.byTopic[currentTopic]; // don't repeat
        }

        // Other topics (lower priority)
        const otherTopics = Object.keys(groups.byTopic);
        if (otherTopics.length > 0) {
            parts.push('=== 📎 From Other Contexts ===');
            for (const topic of otherTopics) {
                for (const m of groups.byTopic[topic]) {
                    const topicLabel = topic !== 'general' ? `[${topic}]` : '';
                    parts.push(formatMemory(m, topicLabel));
                }
            }
            parts.push('');
        }

        // Ungrouped (no topic/scope info)
        if (groups.other.length > 0 && parts.length <= 2) {
            // Only show ungrouped if we don't have good grouped data
            parts.push('=== Relevant Memories ===');
            for (const m of groups.other) {
                parts.push(formatMemory(m));
            }
            parts.push('');
        }
    }

    // Knowledge base entries (consolidated facts — high priority)
    if (memories.knowledgeBase && memories.knowledgeBase.length > 0) {
        parts.push('=== 📚 What I Know About You ===');
        for (const k of memories.knowledgeBase) {
            parts.push(`- **${k.topic}**: ${k.content}`);
        }
        parts.push('');
    }

    // Summaries (conversation history insight)
    if (memories.summaries && memories.summaries.length > 0) {
        parts.push('=== Conversation History ===');
        for (const s of memories.summaries) {
            parts.push(`- ${s.summary}`);
            if (s.facts && s.facts.length > 0) {
                parts.push(`  Key facts: ${s.facts.slice(0, 3).join('; ')}`);
            }
        }
        parts.push('');
    }

    // Cross-agent memories
    if (memories.crossAgentMemories && memories.crossAgentMemories.length > 0) {
        parts.push('=== Knowledge from Other Agents ===');
        for (const m of memories.crossAgentMemories) {
            parts.push(`- [${m.agentName || m.agentId}] (${m.type}) ${m.content}`);
        }
        parts.push('');
    }

    // Note: Raw exchanges are no longer included in recall (Mem0 style)
    // Context is built from: semantic facts + KB + summaries + cross-agent

    let context = parts.join('\n');

    // Truncate if too long
    if (context.length > maxLength) {
        context = context.substring(0, maxLength) + '\n... (truncated)';
    }

    return context;
}

/**
 * Group memories by scope and topic
 */
function groupByContext(memories) {
    const groups = {
        universal: [],   // scope=universal
        byTopic: {},     // grouped by topic
        other: [],       // no scope/topic info
    };

    for (const m of memories) {
        const scope = m.scope || 'unknown';
        const topic = m.topic || 'general';

        if (scope === 'universal') {
            groups.universal.push(m);
        } else if (topic && topic !== 'general') {
            if (!groups.byTopic[topic]) groups.byTopic[topic] = [];
            groups.byTopic[topic].push(m);
        } else if (scope !== 'unknown') {
            // Has scope but no specific topic
            if (!groups.byTopic['general']) groups.byTopic['general'] = [];
            groups.byTopic['general'].push(m);
        } else {
            groups.other.push(m);
        }
    }

    return groups;
}

/**
 * Format a single memory entry
 */
function formatMemory(m, prefix = '') {
    const agentLabel = m.agentId ? `[${m.agentId}]` : '';
    const score = m.score ? ` (${(m.score * 100).toFixed(0)}%)` : '';
    const typeLabel = m.type ? `(${m.type})` : '';
    return `- ${prefix}${agentLabel} ${typeLabel}${score} ${m.content}`.trim();
}

module.exports = { buildContextFromMemories };
