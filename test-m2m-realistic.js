/**
 * Comprehensive M2M Memory-Conversation Test v2
 * ================================================
 * 15 scenarios covering real-world edge cases:
 *
 *  GROUP A: Basic Operations
 *   1. Fresh facts (2 atomic facts)
 *   2. Exact duplicate (same wording → hash-skip path)
 *   3. Semantic duplicate (different words, same meaning → NONE path)
 *
 *  GROUP B: Updates & Contradictions
 *   4. Soft update (adds detail to existing fact)
 *   5. Hard contradiction (location change)
 *   6. Preference reversal (liked X → now dislikes X)
 *
 *  GROUP C: Multi-Agent Isolation
 *   7. Agent B stores same facts as Agent A (should be separate)
 *   8. Agent C stores related but different facts
 *
 *  GROUP D: Complex Overlaps
 *   9. Mix of 1 old + 1 new fact (partial overlap)
 *  10. 3+ facts in a single exchange (stress test extraction)
 *  11. Revisit Conv 1 with same agent (additional exchange to existing conv)
 *
 *  GROUP E: Edge Cases
 *  12. Empty/greeting message (no facts to extract)
 *  13. Very long detailed fact (precision retention)
 *  14. Multi-language mix (Vietnamese + English in same message)
 *  15. Chained updates (A→B→C, test supersede chain)
 */

const crypto = require('crypto');
const API = 'http://localhost:7437/api/memory';

// ── Helpers ───────────────────────────────────────────────────────

async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);
    return { status: res.status, data: await res.json() };
}

async function store(agentId, conversationId, userMessage, agentResponse) {
    const t0 = Date.now();
    const res = await api('POST', '/store', { agentId, conversationId, userMessage, agentResponse });
    const elapsed = Date.now() - t0;
    return { ...res, elapsed };
}

async function getConvMemories(convId) {
    const res = await api('GET', `/conversations/${convId}`);
    return res.data?.data?.memories || [];
}

function uuid() { return crypto.randomUUID(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Agents ────────────────────────────────────────────────────

const AGENT_A = 'test-agent-alpha';
const AGENT_B = 'test-agent-beta';
const AGENT_C = 'test-agent-gamma';

// ── Scenarios ─────────────────────────────────────────────────

const SCENARIOS = [
    // === GROUP A: Basic Operations ===
    {
        name: '1. Fresh facts (TypeScript + Hanoi)',
        group: 'A',
        agent: AGENT_A,
        convId: null, // will be assigned
        user: 'Tao thich dung TypeScript vi no co type safety. Tao dang song o Ha Noi.',
        assistant: 'TypeScript rat tot cho du an lon. Ha Noi la thu do.',
        waitMs: 14000,
        tests: [
            { desc: 'Should have ≥2 memories', check: (mems) => mems.length >= 2 },
        ],
    },
    {
        name: '2. Exact duplicate (same wording)',
        group: 'A',
        agent: AGENT_A,
        convId: null,
        user: 'Tao thich dung TypeScript vi no co type safety. Tao dang song o Ha Noi.',
        assistant: 'Biet roi, may noi roi.',
        waitMs: 14000,
        tests: [
            { desc: 'Should have ≥1 memory via junction (hash-skip link)', check: (mems) => mems.length >= 1 },
            {
                desc: 'Should share memory IDs with Conv 1', check: (mems, ctx) => {
                    const conv1Ids = new Set((ctx.results[0]?.memories || []).map(m => m.id));
                    return mems.some(m => conv1Ids.has(m.id));
                }
            },
        ],
    },
    {
        name: '3. Semantic duplicate (different words, same meaning)',
        group: 'A',
        agent: AGENT_A,
        convId: null,
        user: 'TypeScript la ngon ngu lap trinh yeu thich cua tao. Noi tao o la Ha Noi.',
        assistant: 'OK, tao biet roi.',
        waitMs: 14000,
        tests: [
            { desc: 'Should have ≥1 memory via junction (NONE link)', check: (mems) => mems.length >= 1 },
            {
                desc: 'Should share memory IDs with Conv 1', check: (mems, ctx) => {
                    const conv1Ids = new Set((ctx.results[0]?.memories || []).map(m => m.id));
                    return mems.some(m => conv1Ids.has(m.id));
                }
            },
        ],
    },

    // === GROUP B: Updates & Contradictions ===
    {
        name: '4. Soft update (add detail to existing)',
        group: 'B',
        agent: AGENT_A,
        convId: null,
        user: 'Tao dung TypeScript phien ban 5.4, chu yeu voi React va Next.js.',
        assistant: 'TypeScript 5.4 voi Next.js la combo tuyet voi!',
        waitMs: 14000,
        tests: [
            { desc: 'Should have ≥1 memory (updated or new)', check: (mems) => mems.length >= 1 },
        ],
    },
    {
        name: '5. Hard contradiction (location: Hanoi → Saigon)',
        group: 'B',
        agent: AGENT_A,
        convId: null,
        user: 'Tao vua chuyen vao Sai Gon roi, khong o Ha Noi nua.',
        assistant: 'Sai Gon nang nong nhung vui lam!',
        waitMs: 14000,
        tests: [
            {
                desc: 'Should have fact mentioning Sai Gon', check: (mems) =>
                    mems.some(m => m.content.toLowerCase().includes('sài gòn') || m.content.toLowerCase().includes('sai gon') || m.content.toLowerCase().includes('saigon') || m.content.toLowerCase().includes('hcm'))
            },
        ],
    },
    {
        name: '6. Preference reversal (likes → dislikes)',
        group: 'B',
        agent: AGENT_A,
        convId: null,
        user: 'Thuc ra tao khong con thich TypeScript nua, tao chuyen sang Rust roi.',
        assistant: 'Rust la ngon ngu tot cho system programming!',
        waitMs: 14000,
        tests: [
            {
                desc: 'Should have fact mentioning Rust', check: (mems) =>
                    mems.some(m => m.content.toLowerCase().includes('rust'))
            },
        ],
    },

    // === GROUP C: Multi-Agent Isolation ===
    {
        name: '7. Agent B — same facts as Agent A Conv 1',
        group: 'C',
        agent: AGENT_B,
        convId: null,
        user: 'Toi thich TypeScript va toi song o Ha Noi.',
        assistant: 'TypeScript rat pho bien va Ha Noi rat dep.',
        waitMs: 14000,
        tests: [
            { desc: 'Agent B should have own memories (≥1)', check: (mems) => mems.length >= 1 },
            {
                desc: 'Agent B memories should NOT share IDs with Agent A', check: (mems, ctx) => {
                    const agentAIds = new Set();
                    for (let i = 0; i < 6; i++) {
                        (ctx.results[i]?.memories || []).forEach(m => agentAIds.add(m.id));
                    }
                    return mems.every(m => !agentAIds.has(m.id));
                }
            },
        ],
    },
    {
        name: '8. Agent C — related but different facts',
        group: 'C',
        agent: AGENT_C,
        convId: null,
        user: 'Toi la lap trinh vien Python, chuyen ve data science. Toi song o Da Nang.',
        assistant: 'Python va data science la linh vuc rat hot. Da Nang la thanh pho dep.',
        waitMs: 14000,
        tests: [
            { desc: 'Agent C should have ≥2 memories', check: (mems) => mems.length >= 2 },
            {
                desc: 'Agent C memories should include Python', check: (mems) =>
                    mems.some(m => m.content.toLowerCase().includes('python'))
            },
        ],
    },

    // === GROUP D: Complex Overlaps ===
    {
        name: '9. Mixed — 1 old fact + 1 new fact',
        group: 'D',
        agent: AGENT_A,
        convId: null,
        user: 'Tao van o Sai Gon va tao moi bat dau hoc Kubernetes.',
        assistant: 'Kubernetes rat manh cho container orchestration!',
        waitMs: 14000,
        tests: [
            { desc: 'Should have ≥1 memory (at least Kubernetes)', check: (mems) => mems.length >= 1 },
            {
                desc: 'Should include Kubernetes fact', check: (mems) =>
                    mems.some(m => m.content.toLowerCase().includes('kubernetes'))
            },
        ],
    },
    {
        name: '10. Multi-fact exchange (3+ facts in one message)',
        group: 'D',
        agent: AGENT_A,
        convId: null,
        user: 'Tao dang lam project moi bang Rust, deploy tren AWS, su dung Docker va PostgreSQL. Team tao co 5 nguoi.',
        assistant: 'Stack Rust + AWS + Docker + PostgreSQL la rat solid! Team 5 nguoi cung hop ly.',
        waitMs: 14000,
        tests: [
            { desc: 'Should have ≥3 memories (multi-fact extraction)', check: (mems) => mems.length >= 3 },
        ],
    },
    {
        name: '11. Additional exchange to Conv 1 (same conversationId)',
        group: 'D',
        agent: AGENT_A,
        convId: 'REUSE_CONV_1', // marker — will be replaced with Conv 1's ID
        user: 'Ngoai ra tao cung dung VS Code lam IDE chinh.',
        assistant: 'VS Code la IDE pho bien nhat!',
        waitMs: 14000,
        tests: [
            { desc: 'Conv 1 should now have ≥3 memories (original 2 + VS Code)', check: (mems) => mems.length >= 3 },
            {
                desc: 'Should include VS Code fact', check: (mems) =>
                    mems.some(m => m.content.toLowerCase().includes('vs code') || m.content.toLowerCase().includes('vscode'))
            },
        ],
    },

    // === GROUP E: Edge Cases ===
    {
        name: '12. Empty/greeting (no facts expected)',
        group: 'E',
        agent: AGENT_A,
        convId: null,
        user: 'Xin chao! Hom nay troi dep qua nhi?',
        assistant: 'Chao ban! Dung roi, hom nay troi rat dep!',
        waitMs: 14000,
        tests: [
            { desc: 'Should have 0 memories (greeting only)', check: (mems) => mems.length === 0 },
        ],
    },
    {
        name: '13. Long detailed fact (precision)',
        group: 'E',
        agent: AGENT_A,
        convId: null,
        user: 'MacBook Pro M4 Max cua tao co 128GB RAM, 2TB SSD, mua ngay 15/01/2026 voi gia 89,990,000 VND tai FPT Shop Nguyen Trai.',
        assistant: 'Cau hinh khung that day! M4 Max voi 128GB RAM rat it nguoi dung.',
        waitMs: 14000,
        tests: [
            { desc: 'Should have ≥1 memory', check: (mems) => mems.length >= 1 },
            {
                desc: 'Should preserve specifics (128GB or M4 Max)', check: (mems) =>
                    mems.some(m => m.content.includes('128') || m.content.includes('M4'))
            },
        ],
    },
    {
        name: '14. Multi-language mix (Vietnamese + English)',
        group: 'E',
        agent: AGENT_A,
        convId: null,
        user: 'Tao prefer clean architecture pattern va tao luon follow SOLID principles trong code.',
        assistant: 'Clean architecture va SOLID principles la best practices rat tot!',
        waitMs: 14000,
        tests: [
            { desc: 'Should have ≥1 memory', check: (mems) => mems.length >= 1 },
            {
                desc: 'Should preserve English terms (clean architecture or SOLID)', check: (mems) =>
                    mems.some(m => m.content.toLowerCase().includes('clean architecture') || m.content.toLowerCase().includes('solid'))
            },
        ],
    },
    {
        name: '15. Chained update (Rust was from Scenario 6, now Go)',
        group: 'E',
        agent: AGENT_A,
        convId: null,
        user: 'Tao da bo Rust roi, bay gio tao dung Go vi no don gian hon va build nhanh hon.',
        assistant: 'Go la lua chon thuc te! Build nhanh va deploy de.',
        waitMs: 14000,
        tests: [
            {
                desc: 'Should have fact mentioning Go', check: (mems) =>
                    mems.some(m => m.content.toLowerCase().includes(' go ') || m.content.toLowerCase().includes(' go.') || m.content.toLowerCase().includes('golang'))
            },
        ],
    },
];

// ── Main ──────────────────────────────────────────────────────

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  COMPREHENSIVE M2M TEST v2 — 15 Scenarios                           ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

    // Register agents
    await api('POST', '/agents/register', { id: AGENT_A, name: 'Test Agent Alpha' });
    await api('POST', '/agents/register', { id: AGENT_B, name: 'Test Agent Beta' });
    await api('POST', '/agents/register', { id: AGENT_C, name: 'Test Agent Gamma' });

    const convIds = [];
    const timings = [];
    const storeResults = [];

    // ── Store all exchanges sequentially ──
    for (let i = 0; i < SCENARIOS.length; i++) {
        const s = SCENARIOS[i];

        // Assign conv IDs
        if (s.convId === 'REUSE_CONV_1') {
            s.convId = convIds[0]; // reuse Conv 1
        } else {
            s.convId = uuid();
        }
        convIds.push(s.convId);

        console.log(`\n── ${s.name}`);
        console.log(`   Agent: ${s.agent} | Conv: ${s.convId.substring(0, 8)}...`);

        const result = await store(s.agent, s.convId, s.user, s.assistant);
        timings.push({ scenario: i + 1, name: s.name, elapsed: result.elapsed, status: result.status });
        storeResults.push(result);
        console.log(`   Store: ${result.status === 200 ? '✅' : '❌'} (${result.elapsed}ms)`);

        console.log(`   Waiting ${s.waitMs / 1000}s for extraction...`);
        await sleep(s.waitMs);
    }

    // ── Collect results ──
    console.log('\n\n╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  COLLECTING RESULTS                                                  ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

    const ctx = { results: [] };
    for (let i = 0; i < SCENARIOS.length; i++) {
        // For Scenario 11 (REUSE_CONV_1), we need Conv 1's memories
        const convToCheck = SCENARIOS[i].convId;
        const mems = await getConvMemories(convToCheck);
        ctx.results.push({
            convId: convToCheck,
            agent: SCENARIOS[i].agent,
            memories: mems,
        });
        console.log(`  ${SCENARIOS[i].name}: ${mems.length} memories`);
    }

    // ── Run tests ──
    console.log('\n\n╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  TEST RESULTS                                                        ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

    let totalTests = 0;
    let passedTests = 0;
    const failures = [];
    let currentGroup = '';

    for (let i = 0; i < SCENARIOS.length; i++) {
        const s = SCENARIOS[i];
        const mems = ctx.results[i].memories;

        if (s.group !== currentGroup) {
            currentGroup = s.group;
            const groupNames = { A: 'Basic Operations', B: 'Updates & Contradictions', C: 'Multi-Agent Isolation', D: 'Complex Overlaps', E: 'Edge Cases' };
            console.log(`\n  ━━━ GROUP ${s.group}: ${groupNames[s.group]} ━━━`);
        }

        for (const test of s.tests) {
            totalTests++;
            const passed = test.check(mems, ctx);
            if (passed) {
                passedTests++;
                console.log(`  ✅ ${s.name} — ${test.desc}`);
            } else {
                failures.push({ scenario: s.name, test: test.desc, memCount: mems.length });
                console.log(`  ❌ ${s.name} — ${test.desc} (got ${mems.length} mems)`);
            }
        }
    }

    // ── Timing analysis ──
    console.log('\n\n╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  PERFORMANCE                                                         ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

    timings.forEach(t => {
        const bar = '█'.repeat(Math.min(Math.round(t.elapsed / 30), 40));
        console.log(`  ${String(t.scenario).padStart(2)}. ${t.name.padEnd(55)} ${String(t.elapsed).padStart(5)}ms ${bar}`);
    });
    const avgTime = timings.reduce((s, t) => s + t.elapsed, 0) / timings.length;
    const maxTime = Math.max(...timings.map(t => t.elapsed));
    const minTime = Math.min(...timings.map(t => t.elapsed));
    console.log(`\n  Average: ${avgTime.toFixed(0)}ms | Min: ${minTime}ms | Max: ${maxTime}ms`);

    // ── Memory stats ──
    console.log('\n\n╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  MEMORY STATS                                                        ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

    // Unique convs with memories
    let totalLinks = 0;
    let convsWithMems = 0;
    const uniqueMemIds = new Set();
    for (const r of ctx.results) {
        if (r.memories.length > 0) convsWithMems++;
        totalLinks += r.memories.length;
        r.memories.forEach(m => uniqueMemIds.add(m.id));
    }

    console.log(`  Conversations with memories: ${convsWithMems}/${SCENARIOS.length}`);
    console.log(`  Total junction links: ${totalLinks}`);
    console.log(`  Unique memories: ${uniqueMemIds.size}`);
    console.log(`  Link:Memory ratio: ${(totalLinks / Math.max(uniqueMemIds.size, 1)).toFixed(2)}`);

    // ── Per-conversation dump ──
    console.log('\n\n╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  PER-CONVERSATION DETAIL                                             ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

    for (let i = 0; i < SCENARIOS.length; i++) {
        const s = SCENARIOS[i];
        const mems = ctx.results[i].memories;
        console.log(`  📝 ${s.name} (${s.convId.substring(0, 8)}) [${s.agent}]`);
        if (mems.length === 0) {
            console.log('     (no memories)');
        } else {
            mems.forEach(m => {
                const shared = ctx.results.filter((_, j) => j !== i && ctx.results[j].memories.some(om => om.id === m.id));
                const shareTag = shared.length > 0 ? ` [shared with ${shared.length} other conv(s)]` : '';
                console.log(`     • ${m.id.substring(0, 8)} | ${m.content.substring(0, 80)}${shareTag}`);
            });
        }
        console.log('');
    }

    // ── Summary ──
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  FINAL SUMMARY                                                      ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

    const pct = ((passedTests / totalTests) * 100).toFixed(0);
    console.log(`  Accuracy:        ${passedTests}/${totalTests} (${pct}%)`);
    console.log(`  Avg Store:       ${avgTime.toFixed(0)}ms`);
    console.log(`  Unique Memories: ${uniqueMemIds.size}`);
    console.log(`  Junction Links:  ${totalLinks}`);
    console.log(`  Link:Mem Ratio:  ${(totalLinks / Math.max(uniqueMemIds.size, 1)).toFixed(2)}`);

    if (failures.length > 0) {
        console.log(`\n  ❌ Failures (${failures.length}):`);
        failures.forEach(f => console.log(`     - ${f.scenario}: ${f.test} (${f.memCount} mems)`));
    }

    console.log('\n  GROUP RESULTS:');
    const groups = { A: { pass: 0, total: 0 }, B: { pass: 0, total: 0 }, C: { pass: 0, total: 0 }, D: { pass: 0, total: 0 }, E: { pass: 0, total: 0 } };
    let testIdx = 0;
    for (const s of SCENARIOS) {
        for (const t of s.tests) {
            groups[s.group].total++;
            if (!failures.some(f => f.scenario === s.name && f.test === t.desc)) {
                groups[s.group].pass++;
            }
            testIdx++;
        }
    }
    const groupNames = { A: 'Basic Operations', B: 'Updates & Contradictions', C: 'Multi-Agent', D: 'Complex Overlaps', E: 'Edge Cases' };
    for (const [g, r] of Object.entries(groups)) {
        const gpct = ((r.pass / r.total) * 100).toFixed(0);
        const icon = r.pass === r.total ? '✅' : '⚠️';
        console.log(`     ${icon} Group ${g} (${groupNames[g]}): ${r.pass}/${r.total} (${gpct}%)`);
    }

    console.log('');
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
