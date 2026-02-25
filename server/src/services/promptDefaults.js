/**
 * ============================================================
 *  Prompt Defaults — Default prompt templates for fact extraction
 *
 *  Separated from factExtractor to avoid circular dependency
 *  with runtimeConfig (which needs defaults at init time).
 * ============================================================
 */

// COMBINED extract + dedup system prompt (primary path for all providers)
const COMBINED_SYSTEM_PROMPT = `Bạn là Memory Manager. Trích xuất các sự kiện quan trọng từ hội thoại, sau đó so trùng với ký ức hiện có.
Hãy RẤT CHỌN LỌC — đa số hội thoại chỉ cho 0-2 sự kiện. Chất lượng hơn số lượng.

## Quy trình
1. Đọc hội thoại → xác định thông tin được user TRỰC TIẾP NÓI hoặc XÁC NHẬN.
2. Trích xuất facts, phân loại từng cái theo type + importance. Gộp các mục tương tự.
3. So trùng với existing memories (ADD/UPDATE/NONE/DELETE).
4. Kiểm tra lần cuối: mỗi mục phải tuân thủ TẤT CẢ quy tắc bên dưới.

## Phân loại

### user_facts vs agent_facts (fact NÓI VỀ AI, không phải AI nói)
- user_facts = về NGƯỜI DÙNG (tên, sở thích, quyết định, mục tiêu, môi trường làm việc)
- agent_facts = về chính CON BOT (quyết định kiến trúc bot tự đưa ra)

Nếu bot đề xuất X và user đồng ý ("ok", "ừ", "được") → user_facts:
  Bot: "Dùng Redis nhé?" User: "OK" → "User đồng ý dùng Redis"

### memory_type
- "profile": danh tính, sở thích, thuộc tính lâu dài, mối quan hệ. Mỗi mục < 30 từ. CẤM event.
- "event": sự kiện có mốc thời gian ("hôm nay", "tuần trước"). Mỗi mục < 50 từ. Ghi ngày/nơi/người tham gia.
- "knowledge": kiến thức khách quan, tech, quyết định kiến trúc. Mỗi mục < 50 từ. CẤM ý kiến cá nhân.
- "behavior": thói quen lặp lại, quy trình, cách làm việc. Mỗi mục < 50 từ. CẤM sự kiện một lần.

### importance (0.0 → 1.0)
- 0.9-1.0: Danh tính, sở thích cốt lõi, mối quan hệ
- 0.7-0.8: Quyết định kỹ thuật, kiến trúc dự án
- 0.5-0.6: Chi tiết dự án, sở thích tạm thời
- 0.3-0.4: Sự kiện tạm, kế hoạch ngắn hạn

## Quy tắc trích xuất
- Dùng "User" ở ngôi thứ 3: "User thích..." chứ không phải "Tao thích..."
- Mỗi mục = MỘT câu khai báo hoàn chỉnh, tự đủ nghĩa, viết bằng NGÔN NGỮ GỐC của hội thoại.
- Giữ tính cụ thể: "User dùng Next.js 14 App Router" tốt hơn "User dùng React"
- Ghi lý do khi có: "User thích Go vì goroutines xử lý concurrent tốt"
- Ghi mốc thời gian cho event: "Tháng 2/2026, user đang làm project Memolo"
- Ghi mối quan hệ: tên và vai trò người mà user nhắc đến
- Xác định CHỦ THỂ là user hay người xung quanh (gia đình, đồng nghiệp, bạn bè)
- CHỈ trích xuất thông tin user trực tiếp nói hoặc xác nhận. Không đoán.
- Nếu user yêu cầu KHÔNG nhớ điều gì đó → không trích xuất.
- Nếu chỉ có bot nói mà user không phản hồi → KHÔNG trích xuất.

## CẤM — Không bao giờ trích xuất
- Câu hỏi ("Bạn muốn dùng gì?" KHÔNG phải fact)
- Chào hỏi/lấp chỗ trống ("hi", "cảm ơn", "ok rồi")
- Phiên debug không có insight lâu dài (lỗi, stack trace, port xung đột)
- Trạng thái tạm: "đang build", "server down"
- Bước thủ tục: "chạy npm install", "đã push code"
- Giả định: "nếu...", "có thể..."
- Đoạn code, lệnh, đường dẫn file
- Lặp lại lời bên kia
- Lời hứa/cam kết của bot (chỉ trích xuất quyết định của USER)
- Nhạy cảm: mật khẩu, API key, tài khoản tài chính, địa chỉ cụ thể
- Thay đổi nhỏ không có giá trị

## Quy tắc so trùng (Dedup)
- ADD: thông tin thực sự mới
- UPDATE: ký ức cũ BỊ MÂU THUẪN bởi thông tin mới (ghi old_memory_id)
- NONE: đã có — ƯU TIÊN chọn NONE
- DELETE: user nói rõ điều gì đó không còn đúng

## Ví dụ

Tốt:
  Input: "Tao tên Tyson, 25 tuổi, đang làm backend dev ở FPT. Tao thích Go hơn Java vì goroutines."
  → "User tên Tyson" (profile, 0.95)
  → "User 25 tuổi" (profile, 0.9)
  → "User làm backend developer ở FPT" (profile, 0.85)
  → "User thích Go hơn Java vì goroutines xử lý concurrent tốt" (profile, 0.8)

Xấu:
  - "User hỏi về cách cài Docker" ← CÂU HỎI, không phải fact
  - "Bot giải thích cách dùng Redis" ← về BOT, không phải user
  - "Đang build project" ← trạng thái tạm

Trường hợp đặc biệt:
  Input: "OK dùng PostgreSQL đi" (sau khi bot đề xuất)
  → "User đồng ý dùng PostgreSQL" (profile, 0.7)

## Output
- Mỗi fact PHẢI có trường "memory_type".
- Nếu không chắc, ĐỪNG trích xuất. Mảng rỗng hoàn toàn OK.
- Trả về JSON hợp lệ DUY NHẤT.`;

// DEDUP system prompt — used by memoryDeduplicator for ADD/UPDATE/DELETE/NONE decisions
const DEDUP_SYSTEM_PROMPT = `You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) ADD into memory, (2) UPDATE memory, (3) DELETE from memory, (4) NONE (no change).

Compare newly retrieved facts with existing memories. For each new fact, decide:
- ADD: The fact is genuinely new information not in any existing memory. Generate a new integer ID.
- UPDATE: An existing memory CONTRADICTS or is CORRECTED by the new fact. Merge both into an improved version. Keep the SAME ID.
- DELETE: The new fact explicitly says something is no longer true, making an existing memory obsolete. Keep the SAME ID.
- NONE: The fact is already fully covered by an existing memory (same meaning, possibly different wording). No action needed.

RULES:
1. STRONGLY prefer NONE over UPDATE when the meaning is the same. Only use UPDATE when the new fact adds genuinely new detail or CONTRADICTS the existing memory.
2. NEVER use UPDATE just because the wording is slightly different. If the core information is the same, use NONE.
3. When UPDATEing, combine old memory + new fact into ONE improved sentence.
4. Keep the ORIGINAL LANGUAGE (Vietnamese → Vietnamese).
5. Return ONLY valid JSON — no markdown, no explanations.
6. Use ONLY the integer IDs from the existing memories list. Do NOT invent new IDs for UPDATE/DELETE.
7. For CONTRADICTIONS (e.g., "used to live in A, now lives in B"), use UPDATE to replace the old fact with the new one.
8. Each new fact should produce EXACTLY ONE action entry. Do not skip any facts.`;

// RERANK system prompt — used by reranker for LLM-based relevance scoring
const RERANK_SYSTEM_PROMPT = `You are a RELEVANCE SCORER. Given a QUERY and candidate MEMORIES, rate each memory's relevance from 0.0 to 1.0.

RULES:
1. Score 0.8-1.0 = directly answers the query
2. Score 0.5-0.7 = somewhat related, provides useful context
3. Score 0.2-0.4 = tangentially related
4. Score 0.0-0.1 = irrelevant
5. Return ONLY valid JSON
6. Consider semantic meaning, not just keyword overlap`;

// QUERY REWRITER prompt — used by memoryService.recall() to resolve pronouns/references
const QUERY_REWRITER_PROMPT = `# Task Objective
Rewrite a user query to make it self-contained and explicit by resolving references and ambiguities using the conversation history.

# Workflow
1. Review the conversation history to identify relevant entities, topics, and context.
2. Analyze the current query for:
   - Pronouns (e.g., "they", "it", "nó", "cái đó")
   - Referential expressions (e.g., "that", "those", "the same", "cái vừa nãy")
   - Implicit context (e.g., "what about…", "and also…", "còn…")
   - Incomplete info that can be inferred from conversation history
3. If rewriting is needed: replace pronouns with specific entities, add necessary background, make implicit references explicit.
4. If the query is already clear and self-contained, keep it unchanged.

# Rules
- Preserve the original intent of the user query.
- Only use information explicitly available in the conversation history.
- Do not introduce new assumptions or external knowledge.
- Keep the rewritten query concise but fully explicit.
- Return JSON: {"rewritten_query": "..."}`;

// CATEGORY SUMMARY prompt — used by categoryService to generate LLM summaries per category
const CATEGORY_SUMMARY_PROMPT = `You are a memory summarizer. Given a list of memories in a specific category, produce a concise summary (2-4 sentences) capturing the key patterns and important facts.

# Rules
- Focus on the most important and recurring themes.
- Use the same language as the memories.
- Be concise but comprehensive — cover the breadth of the category.
- Do not list individual items — synthesize into a narrative summary.
- Return JSON: {"summary": "..."}`;

module.exports = {
  COMBINED_SYSTEM_PROMPT,
  DEDUP_SYSTEM_PROMPT,
  RERANK_SYSTEM_PROMPT,
  QUERY_REWRITER_PROMPT,
  CATEGORY_SUMMARY_PROMPT,
};
