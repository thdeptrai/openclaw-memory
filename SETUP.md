# Hướng dẫn Setup & Vận hành — Memolo Memory System

## Mục lục
1. [Quick Setup (Docker)](#1-quick-setup-docker)
2. [Cài đặt thủ công (dev)](#2-cài-đặt-thủ-công-dev)
3. [Cấu hình](#3-cấu-hình)
4. [Authentication & Agent Keys](#4-authentication--agent-keys)
5. [LAN Access](#5-lan-access)
6. [Tích hợp Agent](#6-tích-hợp-agent)
7. [Dashboard](#7-dashboard)
8. [Runtime Config](#8-runtime-config)
9. [Vận hành & Bảo trì](#9-vận-hành--bảo-trì)
10. [Xử lý lỗi](#10-xử-lý-lỗi)

---

## 1. Quick Setup (Docker)

### Prerequisites
- Docker Desktop ≥ 4.0
- Ollama ([ollama.com](https://ollama.com)) chạy trên host machine

```bash
# 1. Pull Ollama models (chạy trên host, KHÔNG phải trong Docker)
ollama pull qwen3-embedding:8b
ollama pull qwen2.5:7b

# 2. Configure
cd openclaw-memory
cp .env.example .env
# Edit .env → QUAN TRỌNG: đổi MEMOLO_MASTER_KEY thành chuỗi random
# Generate key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Start (PG + Qdrant + Server)
docker compose up -d

# 4. Verify
curl http://localhost:7437/api/health
# → { "status": "healthy", "checks": { "server": "ok", "postgres": "ok", "qdrant": "ok", "ollama": "ok" } }
```

**Xong!** Server chạy trên port 7437, dashboard mở cùng URL.

---

## 2. Cài đặt thủ công (dev)

Nếu muốn dev trực tiếp (không qua Docker):

```bash
# Start infrastructure
docker compose up -d postgres qdrant   # Chỉ PG + Qdrant

# Server chạy trực tiếp
cd server
cp ../.env.example .env
# Sửa .env: PG_HOST=localhost, QDRANT_HOST=localhost, OLLAMA_BASE_URL=http://localhost:11434
npm install
npm run migrate
npm run dev    # Auto-reload (node --watch)
```

---

## 3. Cấu hình

File `.env` ở project root:

```env
# === BẮT BUỘC ===
MEMOLO_MASTER_KEY=your-random-secret-key    # Master API key

# === SERVER ===
PORT=7437                                    # Server port

# === LLM PROVIDER ===
LLM_PROVIDER=ollama                          # 'ollama' (default) hoặc 'minimax'

# === OLLAMA (TÙY CHỌN, có defaults) ===
OLLAMA_BASE_URL=http://host.docker.internal:11434  # Ollama URL (Docker)
OLLAMA_EMBED_MODEL=qwen3-embedding:8b
OLLAMA_CHAT_MODEL=qwen2.5:7b
OLLAMA_TIMEOUT=180000                        # Request timeout (ms)

# === MINIMAX M2.5 (TÙY CHỌN, nếu LLM_PROVIDER=minimax) ===
MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_MODEL=MiniMax-M2.5
MINIMAX_BASE_URL=https://api.minimax.io/anthropic/v1/messages

# === MEMORY SETTINGS ===
SUMMARIZE_AFTER_EXCHANGES=5                  # Summarize mỗi N exchanges
EMBEDDING_DIMENSIONS=4096                    # Vector dimensions

# === FEATURE FLAGS (mặc định: true) ===
ENABLE_FACT_EXTRACTION=true                  # Extract atomic facts từ mỗi exchange
ENABLE_RERANKING=true                        # LLM rerank search results
ENABLE_GRAPH=true                            # Build knowledge graph

# === TIMEOUTS ===
FACT_EXTRACT_TIMEOUT=60000                   # Fact extraction (ms)
DEDUP_TIMEOUT=60000                          # Deduplication (ms)
RERANK_TIMEOUT=30000                         # Reranking (ms)

# === DATABASE (không cần đổi nếu dùng Docker) ===
PG_HOST=postgres        # Docker service name
PG_PORT=5432
PG_USER=openclaw
PG_PASSWORD=openclaw_secret
PG_DATABASE=openclaw_memory
QDRANT_HOST=qdrant      # Docker service name
QDRANT_PORT=6333
```

> ⚠️ **Env var names**: `PG_HOST` (không phải `POSTGRES_HOST`), `OLLAMA_BASE_URL` (không phải `OLLAMA_URL`)

---

## 4. Authentication & Agent Keys

### 2-tier auth system

```
Master Key (env: MEMOLO_MASTER_KEY)
  ├── Full access: tất cả endpoints
  ├── Dùng để: register agents, run intelligence, admin
  └── Set 1 lần trong .env

Per-Agent Key (DB: agents.api_key)
  ├── Full access: tất cả endpoints
  ├── Auto-generated khi register
  └── Mỗi agent 1 key riêng
```

### Tạo agent + lấy key

```bash
curl -X POST http://localhost:7437/api/memory/agents/register \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_MASTER_KEY" \
  -d '{"id":"coding-agent","name":"Coding Assistant"}'
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "coding-agent",
    "name": "Coding Assistant",
    "apiKey": "a1b2c3d4e5f6...64-char-hex-string",
    "created_at": "2026-02-19T..."
  }
}
```

**Lưu `apiKey` vào config của agent** — dùng cho tất cả API calls.

### Rotate key (nếu bị lộ)

```bash
curl -X POST http://localhost:7437/api/memory/agents/coding-agent/regenerate-key \
  -H "X-API-Key: YOUR_MASTER_KEY"
# → New key, old key invalidated
```

### Gửi key trong request

```
X-API-Key: agent-api-key-here
```

### Exceptions
- `GET /api/health` — không cần auth
- Nếu `MEMOLO_MASTER_KEY` không set → auth tắt hoàn toàn (dev mode)

---

## 5. LAN Access

Server bind `0.0.0.0:7437` → truy cập được từ mọi thiết bị trong mạng LAN.

### Tìm IP của máy chạy server

Server log khi startup:
```
📡 Access URLs:
   Local:     http://localhost:7437
   LAN (Wi-Fi): http://192.168.1.100:7437
   LAN (Ethernet): http://192.168.1.101:7437
```

### Agent ở thiết bị khác

```javascript
// Agent trên laptop khác
const memory = new MemoryClient({
  agentId: 'remote-agent',
  apiKey: 'agent-specific-key',
  serverUrl: 'http://192.168.1.100:7437',  // IP máy chạy server
});
```

### Windows Firewall
Nếu agents ở máy khác không kết nối được, mở port:
```powershell
# PowerShell (Admin)
New-NetFirewallRule -DisplayName "Memolo" -Direction Inbound -Port 7437 -Protocol TCP -Action Allow
```

### Bảo mật LAN
- ✅ API key auth trên mọi request
- ✅ Per-agent key isolation
- ✅ PG + Qdrant không expose ra ngoài Docker
- ⚠️ Chỉ an toàn cho mạng LAN private — KHÔNG expose ra internet

---

## 6. Tích hợp Agent

### SDK (Node.js)

```javascript
const { MemoryClient } = require('openclaw-memory');

const memory = new MemoryClient({
  agentId: 'my-agent',
  apiKey: 'key-from-register',
  serverUrl: 'http://192.168.1.100:7437',
});

// Recall → inject context vào LLM prompt
const ctx = await memory.recall('user question', { format: 'context' });

// Store sau khi trả lời
const result = await memory.store({
  userMessage: 'câu hỏi',
  agentResponse: 'câu trả lời',
});
// result.conversationId ← reuse cho exchanges tiếp
```

### OpenClaw Plugin

```json
{
  "memolo": {
    "agentId": "my-agent",
    "apiKey": "${MEMOLO_API_KEY}",
    "serverUrl": "http://192.168.1.100:7437"
  }
}
```

### Direct API

```bash
# Store
curl -X POST http://192.168.1.100:7437/api/memory/store \
  -H "Content-Type: application/json" \
  -H "X-API-Key: AGENT_KEY" \
  -d '{"agentId":"my-agent","userMessage":"hello","agentResponse":"hi"}'

# Recall
curl -X POST http://192.168.1.100:7437/api/memory/recall \
  -H "Content-Type: application/json" \
  -H "X-API-Key: AGENT_KEY" \
  -d '{"query":"hello","agentId":"my-agent"}'
```

---

## 7. Dashboard

Mở `http://localhost:7437` (hoặc LAN IP) trong browser.

Features:
- **Stats bar**: Active memories, total exchanges, agents, conversations, SSE clients
- **Memory Explorer**: List, filter by topic/scope/type/agent, confirm/reject/supersede
- **Conversations**: Browse conversations with exchange count and last activity
- **Agents**: Registered agents, API key management
- **Knowledge Graph**: Entity visualization and exploration
- **Knowledge Base**: Curated knowledge entries
- **Live Logs**: Real-time log stream via SSE (HTTP requests, memory operations, errors)
- **Runtime Settings**: Live configuration tuning (LLM provider, feature toggles, timeouts)
- **Intelligence Stats**: Memory counts, duplicates, average importance

---

## 8. Runtime Config

Server hỗ trợ thay đổi cấu hình **live** qua API (không cần restart, in-memory, reset khi restart):

```bash
# Xem tất cả settings
curl http://localhost:7437/api/config -H "X-API-Key: MASTER_KEY"

# Đổi LLM provider sang MiniMax
curl -X PUT http://localhost:7437/api/config \
  -H "Content-Type: application/json" \
  -H "X-API-Key: MASTER_KEY" \
  -d '{"settings": {"llm.provider": "minimax"}}'

# Tắt reranking
curl -X PUT http://localhost:7437/api/config \
  -H "Content-Type: application/json" \
  -H "X-API-Key: MASTER_KEY" \
  -d '{"settings": {"reranking.enabled": false}}'

# Reset tất cả về default
curl -X POST http://localhost:7437/api/config/reset \
  -H "Content-Type: application/json" \
  -H "X-API-Key: MASTER_KEY" \
  -d '{"all": true}'
```

### Available Settings

| Group | Setting | Type | Default |
|-------|---------|------|---------|
| LLM Models | `llm.provider` | select | `ollama` |
| LLM Models | `ollama.chatModel` | string | `qwen2.5:7b` |
| LLM Models | `ollama.embedModel` | string | `qwen3-embedding:8b` |
| LLM Models | `minimax.apiKey` | string | — |
| LLM Models | `minimax.model` | string | `MiniMax-M2.5` |
| Feature Toggles | `factExtraction.enabled` | boolean | `true` |
| Feature Toggles | `factExtraction.extractAgentFacts` | boolean | `true` |
| Feature Toggles | `reranking.enabled` | boolean | `true` |
| Feature Toggles | `graph.enabled` | boolean | `true` |
| Timeouts | `factExtraction.timeout` | number | `60000` |
| Timeouts | `factExtraction.dedupTimeout` | number | `60000` |
| Timeouts | `reranking.timeout` | number | `30000` |
| Timeouts | `summarizer.timeout` | number | `180000` |
| Memory | `memory.summarizeAfterExchanges` | number | `5` |
| Memory | `memory.vectorScoreThreshold` | number | `0.3` |
| Memory | `memory.agentFactMinResponseLength` | number | `100` |
| Scheduler | `scheduler.summarizationSweep` | number | `120000` |
| Scheduler | `scheduler.memoryDecay` | number | `21600000` |
| Scheduler | `scheduler.duplicateDetection` | number | `7200000` |
| Scheduler | `scheduler.knowledgeConsolidation` | number | `43200000` |

---

## 9. Vận hành & Bảo trì

### Update version

```bash
cd openclaw-memory
git pull                    # Hoặc copy files mới
docker compose build        # Rebuild server image
docker compose up -d        # Restart (data giữ nguyên)
```

### Backup & Restore

```bash
# Backup
docker exec memolo-postgres pg_dump -U openclaw openclaw_memory > backup.sql

# Restore
docker exec -i memolo-postgres psql -U openclaw openclaw_memory < backup.sql
```

### Dừng / Khởi động lại

```bash
docker compose down          # Dừng (giữ data)
docker compose down -v       # Dừng + XÓA data
docker compose up -d         # Start lại
```

### Scheduler tự động

| Task | Default Interval | Mô tả |
|------|------------------|--------|
| Summarization Sweep | 2 phút | Catch missed/failed summarizations |
| Memory Decay | 6 giờ | Giảm importance |
| Duplicate Detection | 2 giờ | Merge duplicate memories |
| Knowledge Consolidation | 12 giờ | Tổng hợp knowledge base |

> Tất cả intervals có thể thay đổi runtime qua Settings API (`scheduler.*`).

---

## 10. Xử lý lỗi

| Lỗi | Fix |
|-----|-----|
| `ECONNREFUSED :7437` | `docker compose up -d` |
| `Embedding failed` | `ollama serve` + `ollama pull qwen3-embedding:8b` |
| `401 API key required` | Thêm header `X-API-Key` |
| `401 Invalid API key` | Kiểm tra key đúng chưa, hoặc regenerate |
| Store chậm lần đầu | Ollama cold start, bình thường |
| Agents máy khác không connect | Mở firewall port 7437 |
| Ollama timeout | Tăng `OLLAMA_TIMEOUT` trong .env hoặc `summarizer.timeout` qua Settings API |
| `Qdrant collection missing` | Restart: `docker compose restart memolo` |
| MiniMax API error | Kiểm tra `MINIMAX_API_KEY` đúng chưa, API quota |
| LLM returned empty content | Kiểm tra model có load chưa: `ollama list` |

### Reset toàn bộ

```bash
docker compose down -v
docker compose up -d
# Tất cả data bị xóa, schema auto-recreate
```
