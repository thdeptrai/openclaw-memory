/**
 * ═══════════════════════════════════════════════════════════════
 *  Memolo — Unified Test Runner
 * 
 *  Imports conversations from dataset-100-conversations.json
 *  and exercises every major API surface.
 * 
 *  Usage:
 *    node test-runner.js                          # default: 10 conversations, 30s wait
 *    node test-runner.js --conversations 5        # fewer conversations, faster
 *    node test-runner.js --conversations 30 --wait 60  # stress test
 *    node test-runner.js --server http://192.168.1.5:7437
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');

// ─── CLI Args ───────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const SERVER = arg('server', process.env.MEMOLO_SERVER || 'http://localhost:7437');
const MASTER_KEY = arg('key', process.env.MEMOLO_MASTER_KEY || 'mk-memolo-2026-secure-key');
const NUM_CONVS = parseInt(arg('conversations', '10'), 10);
const WAIT_SECONDS = parseInt(arg('wait', '30'), 10);

// ─── Load Dataset ───────────────────────────────────────────

const DATASET_PATH = path.join(__dirname, 'dataset-100-conversations.json');
if (!fs.existsSync(DATASET_PATH)) {
    console.error('❌ dataset-100-conversations.json not found! Run: node scripts/generate-conversations.js');
    process.exit(1);
}
const ALL_CONVERSATIONS = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));

// Pick a subset of conversations to seed
const conversations = ALL_CONVERSATIONS.slice(0, NUM_CONVS);

// ─── Test Framework ─────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function assert(name, condition, detail = '') {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}`);
        if (detail) console.log(`     → ${detail}`);
        failed++;
        failures.push({ name, detail });
    }
}

function section(title) {
    console.log(`\n${'═'.repeat(56)}`);
    console.log(`  ${title}`);
    console.log('═'.repeat(56));
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── API Helper ─────────────────────────────────────────────

async function api(method, path, body = null, apiKey = MASTER_KEY) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;
    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const res = await fetch(`${SERVER}${path}`, opts);
    const text = await res.text();
    try {
        return { status: res.status, data: JSON.parse(text) };
    } catch {
        return { status: res.status, data: { success: false, error: text.substring(0, 200) } };
    }
}

// ─── Phase 1: Health Check ──────────────────────────────────

async function phaseHealth() {
    section('Phase 1: Health Check');

    const { status, data } = await api('GET', '/api/health', null, null);
    assert('Server responds', status === 200 || status === 503);
    assert('PostgreSQL connected', data.checks?.postgres === 'ok');
    assert('Qdrant connected', data.checks?.qdrant === 'ok');
    console.log(`  Ollama: ${data.checks?.ollama || 'skipped'}`);
}

// ─── Phase 2: Authentication ────────────────────────────────

async function phaseAuth() {
    section('Phase 2: Authentication');

    // No key → 401
    const r1 = await api('POST', '/api/memory/store', { agentId: 'x' }, null);
    assert('POST without API key → 401', r1.status === 401);

    // Wrong key → 401
    const r2 = await api('POST', '/api/memory/store', { agentId: 'x' }, 'wrong-key-123');
    assert('POST with wrong key → 401', r2.status === 401);

    // Master key → works
    const r3 = await api('GET', '/api/memory/agents');
    assert('GET agents (no auth on reads) → 200', r3.status === 200);
}

// ─── Phase 3: Seed Conversations from Dataset ───────────────

const seededConvIds = [];  // { agentId, conversationId, topics, exchangeCount }
const agentKeys = {};      // agentId → apiKey

async function phaseSeed() {
    section(`Phase 3: Seed ${conversations.length} Conversations`);

    // Collect unique agents from selected conversations
    const uniqueAgents = [...new Set(conversations.map(c => c.agentId))];
    console.log(`  Agents: ${uniqueAgents.join(', ')}`);

    // Register agents
    for (const agentId of uniqueAgents) {
        const r = await api('POST', '/api/memory/agents/register', {
            id: agentId,
            name: agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            description: `Test agent ${agentId}`
        });
        assert(`Register ${agentId}`, r.data.data?.success !== false);
        agentKeys[agentId] = r.data.data?.apiKey || r.data.data?.api_key || MASTER_KEY;
    }

    // Store exchanges for each conversation
    let totalExchanges = 0;
    for (let ci = 0; ci < conversations.length; ci++) {
        const conv = conversations[ci];
        let conversationId = null;
        const topic = (conv.topics && conv.topics[0]) || null;

        for (let ei = 0; ei < conv.exchanges.length; ei++) {
            const ex = conv.exchanges[ei];
            const body = {
                agentId: conv.agentId,
                userMessage: ex.userMessage,
                agentResponse: ex.agentResponse,
            };
            if (conversationId) body.conversationId = conversationId;
            if (topic) body.topic = topic;

            const r = await api('POST', '/api/memory/store', body);

            if (!conversationId && r.data.data?.conversationId) {
                conversationId = r.data.data.conversationId;
            }

            totalExchanges++;
        }

        seededConvIds.push({
            agentId: conv.agentId,
            conversationId,
            topics: conv.topics || [],
            exchangeCount: conv.exchanges.length,
            // Grab a few keywords from the exchanges for later recall testing
            sampleWords: extractKeywords(conv.exchanges),
        });

        const bar = '█'.repeat(Math.floor((ci + 1) / conversations.length * 20)).padEnd(20, '░');
        process.stdout.write(`\r  Seeding: [${bar}] ${ci + 1}/${conversations.length} (${totalExchanges} exchanges)`);
    }
    console.log('');

    assert(`Stored ${totalExchanges} exchanges`, totalExchanges > 0);
    assert(`Created ${seededConvIds.length} conversations`, seededConvIds.filter(c => c.conversationId).length === conversations.length);
}

// Extract a few meaningful words from exchanges for recall testing
function extractKeywords(exchanges) {
    const techWords = new Set();
    const techPattern = /\b(React|Vue|Next\.js|Svelte|Angular|Node\.js|NestJS|Go|Python|Express|Docker|Kubernetes|AWS|Terraform|PostgreSQL|MongoDB|Redis|MySQL|Flutter|Swift|Kotlin|Expo|JWT|OAuth|TypeScript|Tailwind|CSS|Nginx|GraphQL|REST|WebSocket|Firebase|Stripe|Prisma)\b/gi;

    for (const ex of exchanges) {
        const text = `${ex.userMessage} ${ex.agentResponse}`;
        const matches = text.match(techPattern) || [];
        matches.forEach(m => techWords.add(m));
    }
    return [...techWords].slice(0, 5);
}

// ─── Phase 4: Wait for Processing ───────────────────────────

async function phaseWait() {
    section(`Phase 4: Wait ${WAIT_SECONDS}s for Fact Extraction + Summarization`);

    for (let s = WAIT_SECONDS; s > 0; s -= 5) {
        process.stdout.write(`\r  ⏳ ${s}s remaining...   `);
        await sleep(Math.min(5000, s * 1000));
    }
    console.log('\r  ⏳ Done!                  ');
}

// ─── Phase 5: Recall Tests ──────────────────────────────────

async function phaseRecall() {
    section('Phase 5: Recall Tests');

    // Test 1: Recall with a keyword from each seeded conversation
    let recallHits = 0;
    const testCount = Math.min(seededConvIds.length, 10); // test up to 10

    for (let i = 0; i < testCount; i++) {
        const conv = seededConvIds[i];
        const keyword = conv.sampleWords[0] || conv.topics[0] || 'technology';
        const query = `${keyword} setup and configuration`;

        const r = await api('POST', '/api/memory/recall', {
            agentId: conv.agentId,
            query,
            limit: 5,
        });

        const memCount = (r.data.data?.semanticMemories?.length || 0)
            + (r.data.data?.recentExchanges?.length || 0);

        if (memCount > 0) recallHits++;
    }

    assert(`Recall returned results for ${recallHits}/${testCount} queries`, recallHits >= testCount * 0.5,
        recallHits < testCount * 0.5 ? `Only ${recallHits} hits (expected ≥${Math.ceil(testCount * 0.5)})` : '');

    // Test 2: Recall with format=context
    if (seededConvIds.length > 0) {
        const conv = seededConvIds[0];
        const r = await api('POST', '/api/memory/recall', {
            agentId: conv.agentId,
            query: 'project overview',
            format: 'context',
        });
        assert('Recall with format=context returns context string', typeof r.data.context === 'string' && r.data.context.length > 0);
    }
}

// ─── Phase 6: Cross-Agent Recall ────────────────────────────

async function phaseCrossAgent() {
    section('Phase 6: Cross-Agent Recall');

    const agents = [...new Set(seededConvIds.map(c => c.agentId))];
    if (agents.length < 2) {
        console.log('  ⚠️ Skipped (need ≥2 agents for cross-agent tests)');
        return;
    }

    // Grant team permissions
    const permR = await api('POST', '/api/intelligence/permissions/team', {
        agentIds: agents.slice(0, 4),
    });
    assert('Team permissions granted', permR.data.data?.success !== false);

    // Agent A queries for Agent B's content
    const agentA = agents[0];
    const agentB = agents[1];
    const agentBConv = seededConvIds.find(c => c.agentId === agentB);
    const keyword = agentBConv?.sampleWords[0] || 'technology';

    const r = await api('POST', '/api/memory/recall', {
        agentId: agentA,
        query: keyword,
        includeOtherAgents: true,
        limit: 10,
    });

    const crossResults = r.data.data?.crossAgentMemories?.length || 0;
    const totalResults = (r.data.data?.semanticMemories?.length || 0) + crossResults;
    assert(`Cross-agent recall found results (${totalResults} total, ${crossResults} cross-agent)`, totalResults > 0);
}

// ─── Phase 7: Search Tests ──────────────────────────────────

async function phaseSearch() {
    section('Phase 7: Search');

    // Pick a random keyword from the dataset
    const allKeywords = seededConvIds.flatMap(c => c.sampleWords);
    const keyword = allKeywords.length > 0 ? allKeywords[Math.floor(Math.random() * allKeywords.length)] : 'database';

    const r = await api('POST', '/api/memory/search', { query: keyword, limit: 20 });
    assert(`Search for "${keyword}" returns results`, (r.data.data?.length || 0) > 0,
        `Got ${r.data.data?.length || 0} results`);

    // Empty search returns recent
    const r2 = await api('POST', '/api/memory/search', { query: '', limit: 5 });
    assert('Empty search returns recent memories', r2.status === 200);
}

// ─── Phase 8: Intelligence Layer ────────────────────────────

async function phaseIntelligence() {
    section('Phase 8: Intelligence Layer');

    // Trigger intelligence tasks
    const r = await api('POST', '/api/intelligence/run', {
        tasks: ['decay', 'dedup', 'consolidate'],
    });
    assert('Intelligence run succeeded', r.data.data?.success !== false || r.status === 200);

    // Stats
    const stats = await api('GET', '/api/intelligence/stats');
    assert('Stats endpoint returns data', stats.status === 200 && stats.data.data);
    if (stats.data.data) {
        const d = stats.data.data;
        console.log(`  📊 Memories: ${d.activeMemories || 0} | Exchanges: ${d.totalExchanges || 0} | Agents: ${d.registeredAgents || 0}`);
    }

    // Knowledge base
    const kb = await api('GET', '/api/intelligence/knowledge');
    assert('Knowledge base endpoint responds', kb.status === 200);
    console.log(`  📚 Knowledge entries: ${kb.data.data?.length || 0}`);
}

// ─── Phase 9: Dashboard / List APIs ─────────────────────────

async function phaseDashboard() {
    section('Phase 9: Dashboard & List APIs');

    const agents = await api('GET', '/api/memory/agents');
    assert('GET /agents returns list', agents.status === 200 && Array.isArray(agents.data.data));

    const convs = await api('GET', '/api/memory/conversations?limit=100');
    assert('GET /conversations returns list', convs.status === 200 && Array.isArray(convs.data.data));
    assert(`Conversations count ≥ ${conversations.length}`, (convs.data.data?.length || 0) >= conversations.length);

    const exchanges = await api('GET', '/api/memory/exchanges?limit=10');
    assert('GET /exchanges returns list', exchanges.status === 200 && Array.isArray(exchanges.data.data));

    const memories = await api('GET', '/api/memory/memories?limit=10');
    assert('GET /memories returns list', memories.status === 200);

    const topics = await api('GET', '/api/memory/topics');
    assert('GET /topics returns list', topics.status === 200);

    const history = await api('GET', '/api/memory/history?limit=5');
    assert('GET /history returns list', history.status === 200);

    // Conversation detail
    if (seededConvIds[0]?.conversationId) {
        const detail = await api('GET', `/api/memory/conversations/${seededConvIds[0].conversationId}`);
        assert('GET /conversations/:id returns detail', detail.status === 200 && detail.data.data);
    }

    // API info
    const info = await api('GET', '/api');
    assert('GET /api returns endpoint list', info.status === 200);
}

// ─── Phase 10: Config API ───────────────────────────────────

async function phaseConfig() {
    section('Phase 10: Config API');

    // GET config
    const config = await api('GET', '/api/config');
    assert('GET /config returns settings', config.status === 200 && config.data.data);

    if (config.data.data) {
        const keys = Object.keys(config.data.data);
        assert(`Config has ${keys.length} settings`, keys.length > 0);
    }

    // PUT config (change and revert)
    const origThreshold = config.data.data?.['memory.vectorScoreThreshold']?.value;
    const putR = await api('PUT', '/api/config', {
        settings: { 'memory.vectorScoreThreshold': 0.25 }
    });
    assert('PUT /config updates setting', putR.status === 200);

    // Reset
    const resetR = await api('POST', '/api/config/reset', {
        key: 'memory.vectorScoreThreshold'
    });
    assert('POST /config/reset resets setting', resetR.status === 200);
}

// ─── Phase 11: Graph API ────────────────────────────────────

async function phaseGraph() {
    section('Phase 11: Knowledge Graph');

    if (seededConvIds.length === 0) {
        console.log('  ⚠️ Skipped (no seeded data)');
        return;
    }

    const agentId = seededConvIds[0].agentId;

    const entities = await api('GET', `/api/graph/entities/${agentId}`);
    assert('GET /graph/entities/:agentId responds', entities.status === 200);
    const entityCount = entities.data.data?.length || 0;
    console.log(`  📍 Entities for ${agentId}: ${entityCount}`);

    const graph = await api('GET', `/api/graph/${agentId}?limit=50`);
    assert('GET /graph/:agentId responds', graph.status === 200);

    const search = await api('GET', '/api/graph/entities/search?query=React');
    assert('GET /graph/entities/search responds', search.status === 200);
}

// ─── Phase 12: Key Regeneration ─────────────────────────────

async function phaseKeyRegen() {
    section('Phase 12: API Key Rotation');

    if (seededConvIds.length === 0) return;

    const agentId = seededConvIds[0].agentId;
    const oldKey = agentKeys[agentId];

    const r = await api('POST', `/api/memory/agents/${agentId}/regenerate-key`, null);
    assert('Key regenerated', r.status === 200 && r.data.success);

    const newKey = r.data.data?.apiKey || r.data.data?.api_key || '';
    assert('New key differs from old', newKey.length > 0 && newKey !== oldKey);

    if (newKey && oldKey && oldKey !== MASTER_KEY) {
        // Old key should fail
        const oldTest = await api('POST', '/api/memory/recall', { query: 'test', agentId }, oldKey);
        assert('Old key rejected after regen', oldTest.status === 401);
    }

    // New key should work (or master key)
    const newTest = await api('POST', '/api/memory/recall', { query: 'test', agentId }, newKey || MASTER_KEY);
    assert('New key works', newTest.status === 200);
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
    console.log('\n🧠 Memolo — Unified Test Runner');
    console.log('═'.repeat(56));
    console.log(`  Server:        ${SERVER}`);
    console.log(`  Dataset:       ${ALL_CONVERSATIONS.length} conversations available`);
    console.log(`  Seeding:       ${conversations.length} conversations`);
    console.log(`  Total exch:    ${conversations.reduce((s, c) => s + c.exchanges.length, 0)}`);
    console.log(`  Wait time:     ${WAIT_SECONDS}s`);
    console.log(`  Time:          ${new Date().toISOString()}`);
    console.log('═'.repeat(56));

    const t0 = Date.now();

    try {
        await phaseHealth();
        await phaseAuth();
        await phaseSeed();
        await phaseWait();
        await phaseRecall();
        await phaseCrossAgent();
        await phaseSearch();
        await phaseIntelligence();
        await phaseDashboard();
        await phaseConfig();
        await phaseGraph();
        await phaseKeyRegen();
    } catch (err) {
        console.error(`\n💥 Unexpected crash: ${err.message}`);
        console.error(err.stack);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    section('RESULTS');
    console.log(`\n  ✅ Passed: ${passed}`);
    console.log(`  ❌ Failed: ${failed}`);
    console.log(`  ⏱  Time:   ${elapsed}s`);
    console.log(`  📊 Rate:   ${(passed / (passed + failed) * 100).toFixed(0)}%`);

    if (failed > 0) {
        console.log(`\n  Failed tests:`);
        failures.forEach(f => {
            console.log(`    ❌ ${f.name}`);
            if (f.detail) console.log(`       ${f.detail}`);
        });
    } else {
        console.log('\n  🎉 ALL TESTS PASSED!');
    }

    process.exit(failed > 0 ? 1 : 0);
}

main();
