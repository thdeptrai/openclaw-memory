/**
 * Clear all data + Seed dataset-100-conversations.json via API
 * 
 * PostgreSQL is cleared via docker exec (not exposed to host).
 * Qdrant is cleared via HTTP API (port 6333 exposed).
 * Exchanges are stored via the Memolo API (port 7437).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SERVER = process.env.MEMOLO_SERVER || 'http://localhost:7437';
const MASTER_KEY = process.env.MEMOLO_MASTER_KEY || 'mk-memolo-2026-secure-key';

async function api(method, urlPath, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (MASTER_KEY) headers['X-API-Key'] = MASTER_KEY;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${SERVER}${urlPath}`, opts);
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; }
    catch { return { status: res.status, data: { error: text.substring(0, 200) } }; }
}

async function clearAll() {
    console.log('=== STEP 1: Clear PostgreSQL (via docker exec) ===');
    try {
        const sql = "TRUNCATE exchanges, memories, summaries, conversations, agents, knowledge_base, memory_history, entities, relationships, memory_conversations CASCADE;";
        const cmd = `docker exec memolo-postgres psql -U openclaw -d openclaw_memory -c "${sql}"`;
        const out = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
        console.log('  ' + out.trim());
    } catch (e) {
        console.log('  Error: ' + (e.stderr || e.message).substring(0, 200));
    }

    console.log('\n=== STEP 2: Clear Qdrant collection ===');
    try {
        const r = await fetch('http://localhost:6333/collections/memory_embeddings', { method: 'DELETE' });
        const d = await r.json();
        console.log('  Delete: ' + JSON.stringify(d));
    } catch (e) {
        console.log('  ' + e.message);
    }

    console.log('  Waiting 5s for server to recreate collection...');
    await new Promise(r => setTimeout(r, 5000));
    const h = await api('GET', '/api/health');
    console.log('  Health: ' + (h.data?.status || 'unknown'));
}

async function seedDataset() {
    const dataPath = path.join(__dirname, '..', 'dataset-100-conversations.json');
    const conversations = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const uniqueAgents = [...new Set(conversations.map(c => c.agentId))];
    const totalExchangeCount = conversations.reduce((s, c) => s + c.exchanges.length, 0);

    console.log(`\n=== STEP 3: Seed ${conversations.length} conversations (${totalExchangeCount} exchanges) ===`);
    console.log('  Agents: ' + uniqueAgents.join(', '));

    // Register agents
    for (const agentId of uniqueAgents) {
        await api('POST', '/api/memory/agents/register', {
            id: agentId,
            name: agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        });
    }
    console.log('  Agents registered!\n');

    // Store exchanges
    let totalStored = 0;
    let errors = 0;
    const t0 = Date.now();

    for (let ci = 0; ci < conversations.length; ci++) {
        const conv = conversations[ci];
        let conversationId = null;
        const topic = conv.topics?.[0] || null;

        for (const ex of conv.exchanges) {
            const body = {
                agentId: conv.agentId,
                userMessage: ex.userMessage,
                agentResponse: ex.agentResponse,
            };
            if (conversationId) body.conversationId = conversationId;
            if (topic) body.topic = topic;

            const r = await api('POST', '/api/memory/store', body);

            if (r.data.data?.conversationId && !conversationId) {
                conversationId = r.data.data.conversationId;
            }

            if (r.status !== 200) errors++;
            totalStored++;
        }

        // Progress every 5 conversations
        if ((ci + 1) % 5 === 0 || ci === conversations.length - 1) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
            const rate = (totalStored / ((Date.now() - t0) / 1000)).toFixed(1);
            console.log(`  [${ci + 1}/${conversations.length}] ${totalStored} exchanges | ${rate} ex/s | ${elapsed}s${errors ? ' | ' + errors + ' errors' : ''}`);
        }
    }

    const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('\n=== DONE: ' + totalStored + ' exchanges in ' + totalTime + 's ===');

    // Stats
    const stats = await api('GET', '/api/intelligence/stats');
    if (stats.data.data) {
        const d = stats.data.data;
        console.log('  Agents:        ' + d.registeredAgents);
        console.log('  Exchanges:     ' + d.totalExchanges);
        console.log('  Conversations: ' + d.totalConversations);
        console.log('  Memories:      ' + d.activeMemories);
    }
}

async function main() {
    console.log('\n=== Memolo: Clear & Seed ===\n');
    await clearAll();
    await seedDataset();
    console.log('\nDone!\n');
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
