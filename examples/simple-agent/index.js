/**
 * Simple Agent Example — Demonstrates Memolo SDK integration
 *
 * This agent:
 * 1. Recalls relevant memories BEFORE processing each message
 * 2. Uses memory context to enrich its responses
 * 3. Stores each exchange AFTER responding
 *
 * Start Memory Server first: cd ../../server && npm start
 * Then run this: npm start
 */
const express = require('express');
const { MemoryClient, createMemoryMiddleware } = require('memolo');

const app = express();
app.use(express.json());

// ============================================================
// METHOD 1: Using Middleware (automatic recall + store)
// ============================================================

const memoryMiddleware = createMemoryMiddleware({
    agentId: 'simple-agent-01',
    agentName: 'Simple Demo Agent',
    serverUrl: 'http://localhost:3100',
    recallLimit: 10,
    includeOtherAgents: true,
});

app.post('/chat', memoryMiddleware, async (req, res) => {
    const userMessage = req.body.message;

    if (!userMessage) {
        return res.status(400).json({ error: 'Missing message field' });
    }

    // req.memoryContext contains formatted memories for LLM prompt
    console.log('\n📥 User:', userMessage);
    console.log('🧠 Memory context:', req.memoryContext || '(no memories yet)');

    // Simulate agent thinking (in real app, call your LLM here)
    const agentResponse = generateResponse(userMessage, req.memoryContext);

    // Store this exchange in memory
    const storeResult = await req.storeMemory(agentResponse);

    console.log('📤 Agent:', agentResponse);
    console.log('💾 Stored:', storeResult?.conversationId || 'failed');

    res.json({
        response: agentResponse,
        conversationId: storeResult?.conversationId,
        memoriesUsed: req.memories ? true : false,
    });
});

// ============================================================
// METHOD 2: Manual (more control)
// ============================================================

const memory = new MemoryClient({
    agentId: 'simple-agent-02',
    agentName: 'Manual Demo Agent',
    serverUrl: 'http://localhost:3100',
});

app.post('/chat-manual', async (req, res) => {
    const { message, conversationId } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Missing message field' });
    }

    // Step 1: Recall memories
    const memories = await memory.recall(message, {
        conversationId,
        limit: 10,
        includeOtherAgents: true,
        format: 'context',
    });

    const context = memories.context || '';

    console.log('\n📥 User:', message);
    console.log('🧠 Context:', context || '(no memories)');

    // Step 2: Generate response (with memory context)
    const agentResponse = generateResponse(message, context);

    // Step 3: Store exchange
    const storeResult = await memory.store({
        conversationId,
        userMessage: message,
        agentResponse,
        tags: ['demo'],
    });

    console.log('📤 Agent:', agentResponse);

    res.json({
        response: agentResponse,
        conversationId: storeResult.conversationId,
    });
});

// ============================================================
// Simple response generator (replace with your LLM call)
// ============================================================

function generateResponse(userMessage, memoryContext) {
    if (memoryContext && memoryContext.length > 0) {
        return `[With memory] I recall some context about your query. You asked: "${userMessage}". Based on my memories, I have relevant context to help you.`;
    }
    return `[No memory] You said: "${userMessage}". This is a new conversation, I don't have prior context yet.`;
}

// ============================================================

const PORT = 4000;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║        🤖 Simple Agent Example                  ║
║        Running on port ${PORT}                      ║
╠══════════════════════════════════════════════════╣
║  POST /chat         — Middleware mode            ║
║  POST /chat-manual  — Manual mode                ║
╚══════════════════════════════════════════════════╝

Try:
  curl -X POST http://localhost:${PORT}/chat \\
    -H "Content-Type: application/json" \\
    -d '{"message": "Hello, remember my name is Tao"}'
  `);
});
