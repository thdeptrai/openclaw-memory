# Memolo SDK

Lightweight client SDK for integrating any AI agent with the Memolo Memory System.

## Quick Start

```javascript
const { MemoryClient } = require('memolo');

const memory = new MemoryClient({
  agentId: 'my-agent-01',
  agentName: 'My Agent',
  apiKey: 'your-agent-api-key',
  serverUrl: 'http://192.168.1.100:7437'
});

// Recall before responding
const memories = await memory.recall(userMessage, {
  conversationId: 'conv-123',
  format: 'context'
});

// Use memories.context in your LLM prompt
const prompt = `${memories.context}\n\nUser: ${userMessage}`;

// Store after responding
await memory.store({
  conversationId: 'conv-123',
  userMessage,
  agentResponse
});
```

## Express Middleware (Auto Mode)

```javascript
const { createMemoryMiddleware } = require('memolo');

app.use('/chat', createMemoryMiddleware({
  agentId: 'my-agent',
  apiKey: 'your-agent-api-key',
  serverUrl: 'http://localhost:7437'
}));

app.post('/chat', (req, res) => {
  // req.memoryContext — formatted context string
  // req.memories — raw memories object
  // req.storeMemory(agentResponse) — store helper

  const response = await generateLLMResponse(req.memoryContext, req.body.message);
  await req.storeMemory(response);
  res.json({ response });
});
```

## API Reference

### `MemoryClient`

| Method | Description |
|--------|-------------|
| `register()` | Register this agent with the Memory Server (auto-called on first recall/store) |
| `recall(query, options)` | Semantic search + knowledge graph + LLM reranking |
| `store(exchange)` | Save user message + agent response → triggers async fact extraction |
| `buildContext(memories, query)` | Format memories for LLM prompt |
| `searchAcrossAgents(query, limit)` | Search all agents' memories |
| `getConversation(id)` | Get conversation details with exchanges |
| `endConversation(id)` | End & trigger final summarization |
| `getRecentMemories(limit)` | Recent memories for this agent |
| `summarize(conversationId)` | Manual summarization trigger |
| `health()` | Check Memory Server health |

### `recall(query, options)` Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `conversationId` | `string` | `null` | Current conversation ID |
| `limit` | `number` | `10` | Max memories to return |
| `includeOtherAgents` | `boolean` | `true` | Include cross-agent memories |
| `format` | `string` | `'context'` | `'raw'` or `'context'` |

### `store(exchange)` Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `conversationId` | `string` | No | Conversation ID (auto-created if null) |
| `userMessage` | `string` | **Yes** | User's message |
| `agentResponse` | `string` | **Yes** | Agent's response |
| `tags` | `string[]` | No | Optional tags |
| `metadata` | `object` | No | Optional metadata |

### Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentId` | `string` | — | **Required.** Unique agent identifier |
| `agentName` | `string` | same as agentId | Human-readable name |
| `apiKey` | `string` | `''` | API key from agent registration |
| `serverUrl` | `string` | `http://localhost:7437` | Memory server URL |
