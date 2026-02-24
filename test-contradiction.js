/**
 * Targeted Contradiction Test — verifies supersession fix
 * Tests that UPDATE actions properly remove old Qdrant vectors
 */
const BASE_URL = 'http://localhost:7437';
const AGENT_ID = 'contradiction-test-agent';

async function apiCall(method, path, body = null) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Agent-Id': AGENT_ID },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { success: false, error: text.substring(0, 100) }; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
    console.log('=== CONTRADICTION TEST ===\n');

    // 1. Register fresh agent
    await apiCall('POST', '/api/memory/agents/register', { id: AGENT_ID, name: 'Contradiction Test Agent' });

    // 2. Send exchange 1: User uses Windows
    console.log('Step 1: Storing "user uses Windows" ...');
    const r1 = await apiCall('POST', '/api/memory/store', {
        agentId: AGENT_ID,
        userMessage: 'Tao dang dung Windows laptop. Tao thich Windows vi gaming tot.',
        agentResponse: 'Windows cho gaming tot. GPU selection da dang hon Mac nhieu.',
    });
    console.log(`  Store: ${r1.success ? 'OK' : 'FAIL'}`);

    // Wait for fact extraction + dedup
    console.log('  Waiting 20s for pipeline...');
    await sleep(20000);

    // 3. Recall to verify Windows is stored
    console.log('\nStep 2: Recall "user dung laptop gi?" (expect: Windows)');
    const recall1 = await apiCall('POST', '/api/memory/recall', {
        agentId: AGENT_ID,
        query: 'User dung laptop gi?',
        limit: 5,
    });
    const mems1 = recall1.data?.semanticMemories || [];
    const content1 = mems1.map(m => m.content || '').join(' ');
    console.log(`  Results: ${mems1.length} memories`);
    console.log(`  Contains "Windows": ${content1.toLowerCase().includes('windows') ? 'YES' : 'NO'}`);
    if (mems1[0]) console.log(`  Top: "${mems1[0].content?.substring(0, 80)}"`);

    // 4. Send exchange 2: User switches BACK to Mac (contradiction!)
    console.log('\nStep 3: Storing CONTRADICTION "user quit Windows, now uses MacBook M4 Max" ...');
    const r2 = await apiCall('POST', '/api/memory/store', {
        agentId: AGENT_ID,
        userMessage: 'Tao nghi lai roi, tao khong dung Windows nua. Tao moi mua MacBook Pro M4 Max, 36GB RAM. Windows qua nhieu bloatware.',
        agentResponse: 'MacBook Pro M4 Max 36GB RAM rat manh! M4 chip vuot troi. macOS cho dev work on dinh hon.',
    });
    console.log(`  Store: ${r2.success ? 'OK' : 'FAIL'}`);

    // Wait for fact extraction + dedup (including UPDATE/supersession)
    console.log('  Waiting 25s for pipeline + dedup + supersession...');
    await sleep(25000);

    // 5. Recall AFTER contradiction — should return MacBook, NOT Windows
    console.log('\nStep 4: Recall "user dung laptop gi?" (expect: MacBook M4, NOT Windows)');
    const recall2 = await apiCall('POST', '/api/memory/recall', {
        agentId: AGENT_ID,
        query: 'User dung laptop gi?',
        limit: 5,
    });
    const mems2 = recall2.data?.semanticMemories || [];
    const content2 = mems2.map(m => m.content || '').join(' ').toLowerCase();
    console.log(`  Results: ${mems2.length} memories`);

    const hasMacBook = content2.includes('macbook') || content2.includes('m4');
    const hasWindows = content2.includes('windows');

    console.log(`  Contains "MacBook/M4": ${hasMacBook ? 'YES ✓' : 'NO ✗'}`);
    console.log(`  Contains "Windows": ${hasWindows ? 'YES (old still present!)' : 'NO ✓ (superseded!)'}`);

    mems2.forEach((m, i) => {
        console.log(`  [${i + 1}] score=${m.score?.toFixed(3)} "${m.content?.substring(0, 100)}"`);
    });

    // 6. Also test "why no Windows?"
    console.log('\nStep 5: Recall "Tai sao user khong dung Windows?" (expect: bloatware)');
    const recall3 = await apiCall('POST', '/api/memory/recall', {
        agentId: AGENT_ID,
        query: 'Tai sao user khong dung Windows?',
        limit: 5,
    });
    const mems3 = recall3.data?.semanticMemories || [];
    const content3 = mems3.map(m => m.content || '').join(' ').toLowerCase();
    const hasBloatware = content3.includes('bloatware');
    console.log(`  Contains "bloatware": ${hasBloatware ? 'YES ✓' : 'NO ✗'}`);
    if (mems3[0]) console.log(`  Top: "${mems3[0]?.content?.substring(0, 100)}"`);

    // Summary
    console.log('\n=== VERDICT ===');
    const allPass = hasMacBook && !hasWindows;
    console.log(`  Contradiction resolution: ${allPass ? 'PASS ✓✓✓' : 'PARTIAL — see details above'}`);
    console.log(`  MacBook recalled: ${hasMacBook ? '✓' : '✗'}`);
    console.log(`  Windows superseded: ${!hasWindows ? '✓' : '✗'}`);
    console.log(`  Bloatware recalled: ${hasBloatware ? '✓' : '✗'}`);
}

run().catch(err => console.error('Test failed:', err));
