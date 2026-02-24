# 🧠 Memolo

**Long-term shared memory for [OpenClaw](https://github.com/openclaw/openclaw) agents.**

Your agents forget everything between sessions. Memolo fixes that. It watches conversations, extracts what matters, and brings it back when relevant — automatically.

Backed by a self-hosted memory server with **PostgreSQL**, **Qdrant** vector search, and **Ollama** embeddings.

## How it works

```
┌──────────────┐          ┌──────────────┐          ┌──────────────────────┐
│  OpenClaw    │──auto────│    Memolo     │──HTTP────│  Memory Server :7437 │
│  Agent       │  recall  │    Plugin     │          │  ┌─ PostgreSQL       │
│              │◀─inject──│              │          │  ├─ Qdrant           │
│              │──auto────│              │          │  └─ Ollama           │
│              │  capture │              │          │                      │
└──────────────┘          └──────────────┘          └──────────────────────┘
```

**Auto-Recall** — Before the agent responds, Memolo searches for memories matching the current message and injects them into context. Uses semantic search + knowledge graph + LLM reranking.

**Auto-Capture** — After the agent responds, Memolo stores the exchange. For each exchange, it extracts atomic facts via LLM, deduplicates against existing memories (ADD/UPDATE/DELETE/NONE), and updates the knowledge graph. When enough exchanges accumulate, it triggers batch summarization.

**Cross-Agent Memory** — Agents can access each other's memories when granted permissions.

## Setup

```bash
openclaw plugins install @memolo/openclaw-plugin
```

Then configure in your OpenClaw settings:

```json
{
  "memolo": {
    "agentId": "my-agent",
    "agentName": "My Agent",
    "apiKey": "${MEMOLO_API_KEY}",
    "serverUrl": "http://192.168.1.100:7437"
  }
}
```

### Prerequisites

Start the memory server (requires Docker):

```bash
cd openclaw-memory
cp .env.example .env       # Set MEMOLO_MASTER_KEY
ollama pull qwen3-embedding:8b && ollama pull qwen2.5:7b
docker compose up -d       # PostgreSQL + Qdrant + Server
```

## Agent Tools

The agent gets 5 tools it can use during conversations:

| Tool | Description |
|------|-------------|
| `memolo_search` | Search memories by natural language |
| `memolo_store` | Explicitly save an exchange |
| `memolo_list` | List recent exchanges for this agent |
| `memolo_get` | Retrieve a conversation by ID |
| `memolo_forget` | Delete by ID or by search query |

## CLI

```bash
# Search memories
openclaw memolo search "what languages does the user prefer"

# Show system stats
openclaw memolo stats

# List registered agents
openclaw memolo agents
```

## Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `serverUrl` | `string` | `http://localhost:7437` | Memory server URL (supports `${MEMOLO_SERVER_URL}`) |
| `agentId` | `string` | — | **Required.** Unique agent identifier |
| `agentName` | `string` | same as agentId | Human-readable agent name |
| `apiKey` | `string` | `${MEMOLO_API_KEY}` | API key from agent registration (supports env vars) |
| `autoRecall` | `boolean` | `true` | Inject memories before each turn |
| `autoCapture` | `boolean` | `true` | Store exchanges after each turn |
| `topK` | `number` | `10` | Max memories per recall |
| `includeOtherAgents` | `boolean` | `true` | Include cross-agent memories |
| `tags` | `string` | — | Comma-separated default tags |

## Architecture

The Memolo memory system consists of:

- **Plugin** (this package) — OpenClaw integration layer
- **Memory Server** — Express.js API with intelligence layer (14 services)
- **PostgreSQL** — 10 tables: conversations, exchanges, memories, summaries, entities, relationships, knowledge_base, memory_history, agents, memory_conversations
- **Qdrant** — 4096-dim vector embeddings for semantic search
- **Ollama** — Local LLM (default: `qwen2.5:7b` for fact extraction/dedup/rerank/summarization, `qwen3-embedding:8b` for embeddings). MiniMax M2.5 also supported as alternative LLM provider.
- **Dashboard** — Web UI at `http://localhost:7437` with live logs, memory explorer, knowledge graph, and runtime settings

## License

MIT
