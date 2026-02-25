/**
 * ============================================================
 *  Prompt Evaluation Pipeline
 *  Tests extraction prompt quality against a gold-standard dataset.
 *
 *  Usage:
 *    node eval/run-eval.js                   # Run all test cases
 *    node eval/run-eval.js --case 3          # Run specific case
 *    node eval/run-eval.js --verbose         # Show detailed output
 *
 *  Scoring:
 *    - Precision: % of extracted facts that match expected (no junk)
 *    - Recall: % of expected facts that were extracted (no misses)
 *    - F1: harmonic mean of precision & recall
 *    - Type Accuracy: % of facts with correct memory_type
 *    - Forbidden Check: any forbidden content extracted? (penalty)
 * ============================================================
 */
const path = require('path');

const llmService = require(path.join(__dirname, '..', 'src', 'services', 'llmService'));
const runtimeConfig = require(path.join(__dirname, '..', 'src', 'runtimeConfig'));
const { COMBINED_SYSTEM_PROMPT } = require(path.join(__dirname, '..', 'src', 'services', 'promptDefaults'));

// ============ GOLD TEST DATASET ============

const TEST_CASES = [
    // ---- Case 1: Basic profile extraction ----
    {
        id: 1,
        name: 'Basic profile info',
        user_message: 'Tao tên Minh, 28 tuổi, đang làm fullstack dev ở Shopee. Tao dùng MacBook Pro M3.',
        agent_response: 'Chào Minh! Rất vui được biết bạn. Bạn cần hỗ trợ gì hôm nay?',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'Minh', memory_type: 'profile', min_importance: 0.9 },
                { text_contains: '28', memory_type: 'profile', min_importance: 0.8 },
                { text_contains: 'Shopee', memory_type: 'profile', min_importance: 0.8 },
                { text_contains: 'MacBook', memory_type: 'profile', min_importance: 0.6 },
            ],
            forbidden_patterns: ['Chào', 'hỗ trợ', 'hôm nay'],
            max_total_facts: 6,
        },
    },

    // ---- Case 2: Decision after agent suggestion ----
    {
        id: 2,
        name: 'User agreement = decision',
        user_message: 'OK dùng PostgreSQL đi, với lại tao muốn dùng Redis cho cache.',
        agent_response: 'Được, tao sẽ setup PostgreSQL làm primary DB và Redis cho caching layer.',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'PostgreSQL', memory_type: 'profile', min_importance: 0.6 },
                { text_contains: 'Redis', memory_type: 'profile', min_importance: 0.6 },
            ],
            forbidden_patterns: ['setup', 'primary DB', 'caching layer'],
            max_total_facts: 4,
        },
    },

    // ---- Case 3: Should extract NOTHING (greeting only) ----
    {
        id: 3,
        name: 'Empty extraction (greetings)',
        user_message: 'Hi, cảm ơn nhé. OK rồi.',
        agent_response: 'Không có gì! Cần gì cứ hỏi nhé.',
        existing_memories: [],
        expected: {
            user_facts: [],
            forbidden_patterns: ['Hi', 'cảm ơn', 'OK rồi'],
            max_total_facts: 0,
        },
    },

    // ---- Case 4: Should NOT extract debugging / temporary state ----
    {
        id: 4,
        name: 'Ignore debugging session',
        user_message: 'Lỗi rồi, port 3000 bị chiếm. Đang chạy npm install lại.',
        agent_response: 'Thử kill process cũ bằng lệnh: lsof -ti:3000 | xargs kill',
        existing_memories: [],
        expected: {
            user_facts: [],
            forbidden_patterns: ['port 3000', 'npm install', 'lsof', 'kill'],
            max_total_facts: 0,
        },
    },

    // ---- Case 5: Event with temporal context ----
    {
        id: 5,
        name: 'Event extraction with time',
        user_message: 'Tuần trước tao vừa phỏng vấn ở Google, kết quả khá tốt. Bạn tao tên Hùng giới thiệu.',
        agent_response: 'Chúc mừng! Hy vọng kết quả tốt.',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'Google', memory_type: 'event', min_importance: 0.5 },
                { text_contains: 'Hùng', memory_type: 'profile', min_importance: 0.6 },
            ],
            forbidden_patterns: ['Chúc mừng', 'Hy vọng'],
            max_total_facts: 4,
        },
    },

    // ---- Case 6: WHY capture + specificity ----
    {
        id: 6,
        name: 'Capture WHY and specificity',
        user_message: 'Tao chuyển từ VS Code sang Neovim vì keyboard-driven workflow nhanh hơn. Đang dùng LazyVim config.',
        agent_response: 'Neovim với LazyVim rất tốt. Bạn cần setup LSP không?',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'Neovim', memory_type: 'profile', min_importance: 0.7 },
                // Should include WHY (keyboard-driven) and specificity (LazyVim)
            ],
            must_contain_any: ['keyboard', 'LazyVim'],
            forbidden_patterns: ['LSP', 'setup'],
            max_total_facts: 3,
        },
    },

    // ---- Case 7: Dedup - should UPDATE not ADD ----
    {
        id: 7,
        name: 'Dedup UPDATE on contradiction',
        user_message: 'Tao mới chuyển sang dùng Arch Linux rồi, bỏ Ubuntu.',
        agent_response: 'Arch Linux tốt lắm, tùy biến nhiều hơn.',
        existing_memories: [
            { content: 'User dùng Ubuntu làm hệ điều hành chính' },
        ],
        expected: {
            user_facts: [
                { text_contains: 'Arch Linux', action: 'UPDATE', memory_type: 'profile' },
            ],
            forbidden_patterns: ['tốt lắm', 'tùy biến'],
            max_total_facts: 2,
        },
    },

    // ---- Case 8: Behavior pattern ----
    {
        id: 8,
        name: 'Behavior pattern extraction',
        user_message: 'Tao hay code vào buổi tối, khoảng 9-12h đêm. Sáng tao thường review PR của team.',
        agent_response: 'Hiểu rồi, schedule hợp lý đấy.',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'buổi tối', memory_type: 'behavior', min_importance: 0.5 },
                { text_contains: 'review PR', memory_type: 'behavior', min_importance: 0.5 },
            ],
            forbidden_patterns: ['schedule', 'hợp lý'],
            max_total_facts: 3,
        },
    },

    // ---- Case 9: Only assistant spoke (user did not confirm) ----
    {
        id: 9,
        name: 'Ignore unconfirmed assistant info',
        user_message: 'làm gì tiếp đây?',
        agent_response: 'Tao suggest dùng Docker Compose cho deployment. Nên thêm CI/CD pipeline nữa.',
        existing_memories: [],
        expected: {
            user_facts: [],
            forbidden_patterns: ['Docker Compose', 'CI/CD', 'deployment'],
            max_total_facts: 0,
        },
    },

    // ---- Case 10: Mixed - some valid, some forbidden ----
    {
        id: 10,
        name: 'Mixed valid + forbidden content',
        user_message: 'Tao là team lead, quản lý 5 người. Đang bị lỗi kết nối database, thử restart rồi mà chưa được.',
        agent_response: 'Thử check connection string và firewall rules.',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'team lead', memory_type: 'profile', min_importance: 0.7 },
                { text_contains: '5 người', memory_type: 'profile', min_importance: 0.6 },
            ],
            forbidden_patterns: ['lỗi', 'restart', 'connection string', 'firewall'],
            max_total_facts: 3,
        },
    },

    // ---- Case 11: Third-party info (about someone else, not user) ----
    {
        id: 11,
        name: 'Third-party vs user info',
        user_message: 'Anh Tuấn là CTO của công ty tao, anh ấy thích dùng Rust. Còn tao thì vẫn dùng TypeScript.',
        agent_response: 'Rust và TypeScript đều tốt, tùy use case.',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'Tuấn', memory_type: 'profile', min_importance: 0.6 },
                { text_contains: 'TypeScript', memory_type: 'profile', min_importance: 0.7 },
            ],
            forbidden_patterns: ['tùy use case'],
            max_total_facts: 4,
        },
    },

    // ---- Case 12: User opt-out ("đừng nhớ") ----
    {
        id: 12,
        name: 'User opt-out request',
        user_message: 'Tao vừa chia tay bạn gái, nhưng đừng nhớ chuyện này. À mà tao mới mua con xe Honda Wave.',
        agent_response: 'Hiểu rồi, tao sẽ không lưu chuyện đó. Chúc mừng xe mới!',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'Honda Wave', memory_type: 'profile', min_importance: 0.5 },
            ],
            forbidden_patterns: ['chia tay', 'bạn gái'],
            max_total_facts: 2,
        },
    },

    // ---- Case 13: Code-heavy conversation with 1 decision ----
    {
        id: 13,
        name: 'Code-heavy with decision',
        user_message: 'Chạy `docker compose up -d --build` xong rồi. À mà tao quyết định chuyển sang dùng pnpm thay npm vì nhanh hơn.',
        agent_response: 'pnpm tốt. Config file ở đây: `npmrc` set `shamefully-hoist=true`.',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'pnpm', memory_type: 'profile', min_importance: 0.7 },
            ],
            must_contain_any: ['nhanh', 'pnpm'],
            forbidden_patterns: ['docker compose', 'npmrc', 'shamefully'],
            max_total_facts: 2,
        },
    },

    // ---- Case 14: Long conversation with multiple topics ----
    {
        id: 14,
        name: 'Multi-topic extraction',
        user_message: 'Tao đang học Kubernetes, mục tiêu là lấy CKA certification trong Q2 năm nay. Team tao gồm 3 backend dev và 2 frontend dev. À tao cũng mới adopt con mèo tên Mochi.',
        agent_response: 'CKA là cert khó, nên luyện trên killer.sh. Team khá balance đấy.',
        existing_memories: [],
        expected: {
            user_facts: [
                { text_contains: 'Kubernetes', memory_type: 'profile', min_importance: 0.6 },
                { text_contains: 'CKA', memory_type: 'event', min_importance: 0.5 },
                { text_contains: 'Mochi', memory_type: 'profile', min_importance: 0.6 },
            ],
            must_contain_any: ['Q2', 'certification'],
            forbidden_patterns: ['killer.sh', 'balance'],
            max_total_facts: 6,
        },
    },

    // ---- Case 15: Dedup with multiple existing memories ----
    {
        id: 15,
        name: 'Complex dedup with multiple memories',
        user_message: 'Tao không còn ở Đà Nẵng nữa, mới chuyển vào Sài Gòn tuần trước. Vẫn làm ở FPT.',
        agent_response: 'Sài Gòn vui lắm! FPT có văn phòng ở quận 9.',
        existing_memories: [
            { content: 'User sống ở Đà Nẵng' },
            { content: 'User làm việc ở FPT' },
            { content: 'User thích ăn bún chả' },
        ],
        expected: {
            user_facts: [
                { text_contains: 'Sài Gòn', action: 'UPDATE', memory_type: 'event', min_importance: 0.5 },
            ],
            forbidden_patterns: ['vui lắm', 'quận 9', 'bún chả'],
            max_total_facts: 3,
        },
    },
];

// ============ USER PROMPT TEMPLATE (same as factExtractor.js) ============

const USER_TEMPLATE = `CONVERSATION:
User: {{USER_MESSAGE}}
Assistant: {{AGENT_RESPONSE}}

EXISTING MEMORIES:
{{EXISTING_MEMORIES}}

Extract facts AND decide dedup actions. Return JSON:
{
  "user_facts": [
    { "text": "fact about the user", "action": "ADD|UPDATE|NONE|DELETE", "old_memory_id": null, "importance": 0.8, "memory_type": "profile|event|knowledge|behavior" }
  ],
  "agent_facts": [
    { "text": "fact about the assistant", "action": "ADD|UPDATE|NONE|DELETE", "old_memory_id": null, "importance": 0.7, "memory_type": "knowledge" }
  ],
  "entities": ["tech/tool/person mentioned"],
  "topic": "main topic"
}

For UPDATE/DELETE, set old_memory_id to the [N] index of the existing memory being changed.
Return ONLY the JSON object.`;

// ============ SCORING ENGINE ============

function scoreCase(testCase, result) {
    const scores = { precision: 0, recall: 0, f1: 0, typeAccuracy: 0, forbiddenPenalty: 0, details: [] };
    const expected = testCase.expected;
    const actualFacts = (result.user_facts || []).concat(result.agent_facts || []);

    // 1. Handle empty-expected cases
    if (expected.user_facts.length === 0) {
        if (actualFacts.length === 0) {
            scores.precision = 1.0;
            scores.recall = 1.0;
            scores.f1 = 1.0;
            scores.typeAccuracy = 1.0;
            scores.details.push('✅ Correctly extracted nothing');
        } else {
            scores.precision = 0;
            scores.recall = 1.0; // no expected to miss
            scores.f1 = 0;
            scores.forbiddenPenalty = actualFacts.length;
            scores.details.push(`❌ Extracted ${actualFacts.length} facts when 0 expected`);
            actualFacts.forEach(f => scores.details.push(`  - JUNK: "${f.text}"`));
        }
    } else {
        // 2. Recall: for each expected, check if any actual matches
        let matched = 0;
        let typeMatched = 0;
        for (const exp of expected.user_facts) {
            const match = actualFacts.find(f =>
                f.text && f.text.toLowerCase().includes(exp.text_contains.toLowerCase())
            );
            if (match) {
                matched++;
                if (match.memory_type === exp.memory_type) {
                    typeMatched++;
                    scores.details.push(`✅ Found "${exp.text_contains}" → type=${match.memory_type} ✓`);
                } else {
                    scores.details.push(`⚠️ Found "${exp.text_contains}" but type=${match.memory_type}, expected=${exp.memory_type}`);
                }
                // Check action for dedup tests
                if (exp.action && match.action !== exp.action) {
                    scores.details.push(`  ⚠️ Action=${match.action}, expected=${exp.action}`);
                }
            } else {
                scores.details.push(`❌ MISSED: "${exp.text_contains}"`);
            }
        }
        scores.recall = matched / expected.user_facts.length;
        scores.typeAccuracy = matched > 0 ? typeMatched / matched : 0;

        // 3. Precision: how many actual facts are valid (not junk)?
        const validActual = actualFacts.filter(f =>
            expected.user_facts.some(exp =>
                f.text && f.text.toLowerCase().includes(exp.text_contains.toLowerCase())
            )
        );
        scores.precision = actualFacts.length > 0 ? validActual.length / actualFacts.length : 1.0;

        // 4. F1
        if (scores.precision + scores.recall > 0) {
            scores.f1 = 2 * (scores.precision * scores.recall) / (scores.precision + scores.recall);
        }
    }

    // 5. Forbidden check
    const forbidden = expected.forbidden_patterns || [];
    for (const pattern of forbidden) {
        const violations = actualFacts.filter(f =>
            f.text && f.text.toLowerCase().includes(pattern.toLowerCase())
        );
        if (violations.length > 0) {
            scores.forbiddenPenalty++;
            scores.details.push(`🚫 FORBIDDEN content found: "${pattern}" in "${violations[0].text}"`);
        }
    }

    // 6. must_contain_any check
    if (expected.must_contain_any) {
        const allTexts = actualFacts.map(f => (f.text || '').toLowerCase()).join(' ');
        const found = expected.must_contain_any.some(kw => allTexts.includes(kw.toLowerCase()));
        if (found) {
            scores.details.push(`✅ Contains expected keyword from [${expected.must_contain_any.join(', ')}]`);
        } else {
            scores.details.push(`❌ Missing expected keywords: [${expected.must_contain_any.join(', ')}]`);
        }
    }

    // 7. Max facts check
    if (expected.max_total_facts !== undefined && actualFacts.length > expected.max_total_facts) {
        scores.details.push(`⚠️ Too many facts: ${actualFacts.length} > max ${expected.max_total_facts}`);
    }

    return scores;
}

// ============ RUNNER ============

async function runEval(options = {}) {
    const { caseId, verbose } = options;

    const systemPrompt = runtimeConfig.get('prompt.combinedSystem') || COMBINED_SYSTEM_PROMPT;
    const cases = caseId ? TEST_CASES.filter(c => c.id === caseId) : TEST_CASES;

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║        🧪 Memolo Prompt Evaluation Pipeline     ║');
    console.log(`║        ${cases.length} test cases | ${new Date().toISOString().slice(0, 16)}   ║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const results = [];

    for (const tc of cases) {
        process.stdout.write(`[${tc.id}/${TEST_CASES.length}] ${tc.name}...`);

        const existingForPrompt = tc.existing_memories.length > 0
            ? tc.existing_memories.map((m, i) => `[${i}] ${m.content}`).join('\n')
            : '(none — all facts are new)';

        const userPrompt = USER_TEMPLATE
            .replace('{{USER_MESSAGE}}', tc.user_message)
            .replace('{{AGENT_RESPONSE}}', tc.agent_response)
            .replace('{{EXISTING_MEMORIES}}', existingForPrompt);

        try {
            const result = await llmService.chatJSON(systemPrompt, userPrompt, {
                maxTokens: 2000,
                timeout: 30000,
                purpose: 'eval',
            });

            const scores = scoreCase(tc, result);
            results.push({ id: tc.id, name: tc.name, scores, result });

            const icon = scores.f1 >= 0.8 ? '✅' : scores.f1 >= 0.5 ? '⚠️' : '❌';
            console.log(` ${icon} P=${(scores.precision * 100).toFixed(0)}% R=${(scores.recall * 100).toFixed(0)}% F1=${(scores.f1 * 100).toFixed(0)}% Type=${(scores.typeAccuracy * 100).toFixed(0)}% Forbidden=${scores.forbiddenPenalty}`);

            if (verbose) {
                scores.details.forEach(d => console.log(`    ${d}`));
                console.log(`    Raw: ${JSON.stringify(result.user_facts?.map(f => f.text) || [])}`);
                console.log('');
            }
        } catch (err) {
            console.log(` 💥 ERROR: ${err.message}`);
            results.push({ id: tc.id, name: tc.name, scores: { f1: 0, precision: 0, recall: 0, typeAccuracy: 0, forbiddenPenalty: 0 }, error: err.message });
        }
    }

    // ============ SUMMARY ============
    console.log('\n' + '═'.repeat(60));
    console.log('                    📊 SUMMARY');
    console.log('═'.repeat(60));

    const validResults = results.filter(r => !r.error);
    const avgPrecision = validResults.reduce((s, r) => s + r.scores.precision, 0) / validResults.length;
    const avgRecall = validResults.reduce((s, r) => s + r.scores.recall, 0) / validResults.length;
    const avgF1 = validResults.reduce((s, r) => s + r.scores.f1, 0) / validResults.length;
    const avgType = validResults.reduce((s, r) => s + r.scores.typeAccuracy, 0) / validResults.length;
    const totalForbidden = validResults.reduce((s, r) => s + r.scores.forbiddenPenalty, 0);

    console.log(`  Precision (no junk):   ${(avgPrecision * 100).toFixed(1)}%`);
    console.log(`  Recall (no misses):    ${(avgRecall * 100).toFixed(1)}%`);
    console.log(`  F1 Score:              ${(avgF1 * 100).toFixed(1)}%`);
    console.log(`  Type Accuracy:         ${(avgType * 100).toFixed(1)}%`);
    console.log(`  Forbidden Violations:  ${totalForbidden}`);
    console.log(`  Errors:                ${results.length - validResults.length}`);
    console.log('═'.repeat(60));

    // Grade
    const grade = avgF1 >= 0.9 ? 'A' : avgF1 >= 0.8 ? 'B' : avgF1 >= 0.7 ? 'C' : avgF1 >= 0.5 ? 'D' : 'F';
    console.log(`\n  Overall Grade: ${grade} (${(avgF1 * 100).toFixed(1)}%)\n`);

    return { avgPrecision, avgRecall, avgF1, avgType, totalForbidden, grade, results };
}

// ============ MAIN ============
const args = process.argv.slice(2);
const caseId = args.includes('--case') ? parseInt(args[args.indexOf('--case') + 1]) : null;
const verbose = args.includes('--verbose') || args.includes('-v');

runEval({ caseId, verbose }).then(() => process.exit(0)).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
