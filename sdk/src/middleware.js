const MemoryClient = require('./client');

/**
 * Express Middleware for automatic memory recall + store
 *
 * Usage:
 *   const { createMemoryMiddleware } = require('memolo');
 *
 *   app.use('/chat', createMemoryMiddleware({
 *     agentId: 'my-agent',
 *     agentName: 'My Agent',
 *     serverUrl: 'http://localhost:3100',
 *   }));
 *
 * The middleware expects:
 *   - req.body.message (user's message)
 *   - req.body.conversationId (optional)
 *
 * It injects:
 *   - req.memories (recalled memories)
 *   - req.memoryContext (formatted context string for LLM)
 *   - req.memoryClient (MemoryClient instance)
 *   - req.storeMemory(agentResponse) (helper to store after response)
 */
function createMemoryMiddleware(options = {}) {
    const client = new MemoryClient(options);

    return async function memoryMiddleware(req, res, next) {
        try {
            const userMessage = req.body?.message || req.body?.userMessage;
            const conversationId = req.body?.conversationId || null;

            // Attach client to request
            req.memoryClient = client;

            // Recall memories if there's a user message
            if (userMessage) {
                const memories = await client.recall(userMessage, {
                    conversationId,
                    limit: options.recallLimit || 10,
                    includeOtherAgents: options.includeOtherAgents !== false,
                    format: 'context',
                });

                req.memories = memories;
                req.memoryContext = memories.context || client.buildContext(memories, userMessage);
            } else {
                req.memories = null;
                req.memoryContext = '';
            }

            // Helper function to store exchange after agent responds
            req.storeMemory = async function (agentResponse, extraTags = []) {
                if (!userMessage || !agentResponse) return null;

                return client.store({
                    conversationId: conversationId || req.body?.conversationId,
                    userMessage,
                    agentResponse,
                    tags: extraTags,
                    metadata: { path: req.path, method: req.method },
                });
            };

            next();
        } catch (error) {
            console.error('[memolo] Middleware error:', error.message);
            // Don't block the request if memory system fails
            req.memories = null;
            req.memoryContext = '';
            req.storeMemory = async () => null;
            req.memoryClient = client;
            next();
        }
    };
}

module.exports = { createMemoryMiddleware };
