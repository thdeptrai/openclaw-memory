/* ============================================================
   Memolo Memory Dashboard v2.0 â€” Application Logic
   Real-time SSE updates, Conversations, Activity Feed, Toasts
   ============================================================ */

// ============ THEME ============

// Apply theme immediately to prevent FOUC
(function initTheme() {
    const saved = localStorage.getItem('memolo-theme') || 'night';
    document.documentElement.setAttribute('data-theme', saved);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => updateThemeUI(saved));
    } else {
        updateThemeUI(saved);
    }
})();

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'night';
    const isDark = ['night', 'dark', 'dracula', 'business'].includes(current);
    const next = isDark ? 'corporate' : 'night';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('memolo-theme', next);
    updateThemeUI(next);
}

function updateThemeUI(theme) {
    const icon = document.getElementById('theme-icon');
    const label = document.getElementById('theme-label');
    const isDark = ['night', 'dark', 'dracula', 'business'].includes(theme);
    if (icon) icon.textContent = isDark ? 'ðŸŒ™' : 'â˜€ï¸';
    if (label) label.textContent = isDark ? 'Dark mode' : 'Light mode';
}

const API = '';  // Same origin

// ============ STATE ============

let currentLogFilter = 'all';
let currentMemoryFilter = 'all';
let currentActorFilter = 'all'; // 'all' | 'user' | 'assistant'
let currentStatusFilter = 'all'; // 'all' | 'active' | 'superseded'
let allLogs = [];
let allMemories = [];
let allConversations = [];
let selectedConvId = null;
let logAutoScroll = true;
let evtSource = null;
let reconnectAttempts = 0;
let sseReady = false; // suppress toasts during SSE catch-up replay

// ============ PAGE NAVIGATION ============

function showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.sidebar-link').forEach(n => n.classList.remove('active'));

    document.getElementById(`page-${page}`).classList.add('active');
    const navLink = document.querySelector(`.sidebar-link[data-page="${page}"]`);
    if (navLink) navLink.classList.add('active');

    // Close drawer sidebar on mobile after navigation
    const toggle = document.getElementById('sidebar-toggle');
    if (toggle && window.innerWidth < 1024) {
        toggle.checked = false;
    }

    // Load page-specific data
    if (page === 'conversations') loadConversations();
    if (page === 'agents') loadAgentsFull();
    if (page === 'memories') loadMemoriesFull();
    if (page === 'settings') loadSettings();
}

// ============ API HELPERS ============

async function api(method, path, body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);
    return res.json();
}

// ============ SSE CONNECTION ============

function initSSE() {
    connectSSE();
    loadInitialLogs();
    updateSSEStatus('connecting');

    // Track user scroll in log containers
    ['dash-logs-list', 'logs-full-list'].forEach(id => {
        const container = document.getElementById(id);
        if (container) {
            container.addEventListener('scroll', () => {
                const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
                logAutoScroll = atBottom;
            });
        }
    });
}

function connectSSE() {
    if (evtSource) evtSource.close();

    evtSource = new EventSource('/api/logs/stream');

    evtSource.onopen = () => {
        reconnectAttempts = 0;
        updateSSEStatus('connected');
        // Delay sseReady so catch-up events don't trigger toasts
        sseReady = false;
        setTimeout(() => { sseReady = true; }, 2000);
    };

    evtSource.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'connected') return;
            handleSSEEvent(msg);
        } catch { /* ignore */ }
    };

    evtSource.onerror = () => {
        evtSource.close();
        reconnectAttempts++;
        updateSSEStatus('disconnected');
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        setTimeout(connectSSE, delay);
    };
}

function updateSSEStatus(status) {
    const el = document.getElementById('sse-status');
    if (!el) return;
    const dot = el.querySelector('.sse-dot');
    const text = el.querySelector('span:last-child');
    dot.className = 'sse-dot ' + (status === 'connected' ? '' : status === 'connecting' ? 'connecting' : 'disconnected');
    text.textContent = `SSE: ${status}`;
}

// ============ SSE EVENT HANDLER ============

function handleSSEEvent(msg) {
    switch (msg.type) {
        case 'log':
            addLogEntry(msg.data);
            break;
        case 'exchange:new':
            addActivityItem('ðŸ’¾', 'Exchange Stored', `${msg.data.agentId} â€” "${truncate(msg.data.userMessage, 60)}"`, 'memory', msg.data.timestamp);
            if (sseReady) showToast('ðŸ’¾', 'New Exchange', `${msg.data.agentId}: ${truncate(msg.data.userMessage, 80)}`);
            loadDashMemories(); // refresh
            break;
        case 'memory:new': {
            const actorIcon = msg.data.actorId === 'assistant' ? 'ðŸ¤–' : 'ðŸ‘¤';
            const actorLabel = msg.data.actorId === 'assistant' ? 'Agent' : 'User';
            const typeIcon = msg.data.type === 'fact' ? 'âœ…' : 'ðŸ”®';
            addActivityItem(typeIcon, `${actorLabel} ${capitalize(msg.data.type)} Extracted`, truncate(msg.data.content, 80), 'summarizer', msg.data.timestamp);
            break;
        }
        case 'summarize:done':
            addActivityItem('ðŸ§ ', 'Summarization Complete', `${msg.data.factsCount} facts, ${msg.data.decisionsCount} decisions`, 'summarizer', msg.data.timestamp);
            if (sseReady) showToast('ðŸ§ ', 'Summarization Done', `${msg.data.factsCount} facts extracted`);
            break;
        case 'agent:new':
            addActivityItem('ðŸ¤–', 'New Agent', `${msg.data.name} (${msg.data.agentId})`, 'memory', msg.data.timestamp);
            if (sseReady) showToast('ðŸ¤–', 'Agent Registered', msg.data.name);
            loadStats(); // refresh
            break;
        case 'stats:update':
            updateStatsFromSSE(msg.data);
            break;
    }
}

// ============ STATS ============

async function loadStats() {
    try {
        const [health, agents] = await Promise.all([
            api('GET', '/api/health'),
            api('GET', '/api/memory/agents'),
        ]);

        // Health
        const isHealthy = health.status === 'healthy';
        document.getElementById('stat-health').textContent = isHealthy ? 'âœ“' : 'âœ—';
        document.getElementById('stat-health-detail').textContent =
            Object.entries(health.checks).map(([k, v]) => `${k}: ${v}`).join(' Â· ');
        document.getElementById('health-dot').className = `health-dot ${isHealthy ? '' : 'unhealthy'}`;
        document.getElementById('health-text').textContent = isHealthy ? 'All systems healthy' : 'Issues detected';

        // Agent count badge
        if (agents.success) {
            document.getElementById('nav-agent-count').textContent = agents.data.length;
            document.getElementById('stat-agents').textContent = agents.data.length;
            document.getElementById('stat-agents-detail').textContent = `${agents.data.length} registered`;
            renderAgentsList(agents.data, 'agents-list');
        }
    } catch (err) {
        console.error('Failed to load stats:', err);
    }
}

function updateStatsFromSSE(data) {
    if (!data || !data.totalExchanges) return;

    const setWithFlash = (id, value) => {
        const el = document.getElementById(id);
        if (el && el.textContent !== String(value)) {
            el.textContent = value;
            const card = el.closest('.stat');
            if (card) {
                card.classList.remove('flash');
                void card.offsetWidth;
                card.classList.add('flash');
            }
        }
    };

    setWithFlash('stat-exchanges', data.totalExchanges);
    document.getElementById('stat-exchanges-detail').textContent =
        `${data.totalConversations || 0} conversations`;

    setWithFlash('stat-memories', data.activeMemories);
    const superseded = data.supersededMemories || 0;
    document.getElementById('stat-memories-detail').textContent =
        `${data.activeMemories} active Â· ${superseded} superseded`;

    setWithFlash('stat-agents', data.registeredAgents);
    document.getElementById('stat-agents-detail').textContent =
        `${data.sseClients || 0} SSE clients connected`;

    document.getElementById('nav-memory-count').textContent = data.activeMemories || 0;
    document.getElementById('nav-agent-count').textContent = data.registeredAgents || 0;
    document.getElementById('nav-conv-count').textContent = data.totalConversations || 0;
}

// ============ ACTIVITY FEED ============

function addActivityItem(icon, title, desc, source = '', eventTime = null) {
    const feed = document.getElementById('activity-feed');
    if (!feed) return;

    const empty = feed.querySelector('.text-center');
    if (empty) empty.remove();

    const ts = eventTime ? new Date(eventTime) : new Date();
    const timeStr = ts.toLocaleTimeString('en-GB', { hour12: false });

    const div = document.createElement('div');
    div.className = 'flex items-start gap-3 py-2 border-b border-base-300/50 text-sm animate-[fadeSlideIn_0.3s_ease-out]';
    div.innerHTML = `
    <span class="text-lg flex-shrink-0">${icon}</span>
    <div class="flex-1 min-w-0">
      <div class="font-semibold">${escHtml(title)}</div>
      <div class="text-xs text-base-content/60">${escHtml(desc)}</div>
    </div>
    ${source ? `<span class="badge badge-ghost badge-xs">${source}</span>` : ''}
    <span class="text-xs text-base-content/40 whitespace-nowrap">${timeStr}</span>
  `;

    feed.insertBefore(div, feed.firstChild);

    while (feed.children.length > 100) {
        feed.removeChild(feed.lastChild);
    }
}

function clearActivityFeed() {
    document.getElementById('activity-feed').innerHTML =
        '<div class="text-center text-base-content/40 py-8">âš¡</span> Feed cleared</div>';
}

// ============ TOAST NOTIFICATIONS ============

function showToast(icon, title, desc) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'alert alert-info shadow-lg text-sm max-w-sm';
    toast.innerHTML = `
    <span>${icon}</span>
    <div>
      <div class="font-bold">${escHtml(title)}</div>
      <div class="text-xs opacity-70">${escHtml(desc)}</div>
    </div>
  `;

    container.appendChild(toast);

    // Auto dismiss after 5s
    setTimeout(() => {
        toast.style.transition = 'opacity 0.3s';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 5000);

    // Limit toasts
    while (container.children.length > 5) {
        container.removeChild(container.firstChild);
    }
}

// ============ AGENTS ============

const AGENT_COLORS = [
    '#58a6ff', '#bc8cff', '#3fb950', '#d29922', '#f85149',
    '#39d2c0', '#f778ba', '#79c0ff', '#d2a8ff', '#56d364',
];

function getAgentColor(id) {
    let hash = 0;
    for (const c of id) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
    return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

function getInitials(name) {
    return name.split(/[-_\s]/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

let agentKeyVisibility = {};

function renderAgentsList(agents, containerId) {
    const container = document.getElementById(containerId);
    if (!agents.length) {
        container.innerHTML = '<div class="text-center text-base-content/40 py-8">ðŸ¤– No agents registered yet.</div>';
        return;
    }

    container.innerHTML = agents.map(a => {
        const convCount = a.conversation_count || a.conversations || 0;
        const exCount = a.exchange_count || a.exchanges || 0;
        const lastActive = a.last_active_at || a.updated_at || a.created_at;
        const apiKey = a.api_key || '';
        const isVisible = agentKeyVisibility[a.id] || false;

        const maskedKey = apiKey.length > 12
            ? apiKey.slice(0, 8) + 'â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢' + apiKey.slice(-4)
            : 'â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢';

        const showFull = containerId === 'agents-full-list';
        const keySection = showFull ? `
      <div class="mt-2">
        <div class="flex items-center gap-2 flex-wrap p-2 bg-base-300/50 rounded-lg">
          <span class="text-xs font-semibold text-base-content/60">ðŸ”‘ API Key</span>
          <code class="text-xs font-mono text-primary flex-1 min-w-0 truncate" id="agent-key-${a.id}">${isVisible ? escHtml(apiKey) : maskedKey}</code>
          <div class="flex gap-1">
            <button class="btn btn-ghost btn-xs btn-circle" onclick="toggleAgentKeyVisibility('${a.id}')" title="${isVisible ? 'Hide' : 'Show'}">
              ${isVisible ? 'ðŸ™ˆ' : 'ðŸ‘ï¸'}
            </button>
            <button class="btn btn-ghost btn-xs btn-circle" onclick="copyAgentKey('${a.id}', '${escHtml(apiKey)}')" title="Copy to clipboard">
              ðŸ“‹
            </button>
            <button class="btn btn-ghost btn-xs btn-circle text-error" onclick="regenerateAgentKey('${a.id}', '${escHtml(a.name || a.id)}')" title="Regenerate key">
              ðŸ”„
            </button>
          </div>
        </div>
      </div>
    ` : '';

        return `
    <div class="flex gap-3 py-3 border-b border-base-300/30 last:border-b-0 items-start">
      <div class="avatar placeholder">
        <div class="w-10 rounded-xl text-white" style="background: ${getAgentColor(a.id)}">
          <span class="text-sm font-bold">${getInitials(a.name || a.id)}</span>
        </div>
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-bold text-sm">${escHtml(a.name || a.id)}</div>
        <div class="text-xs text-base-content/50">ID: ${escHtml(a.id)}</div>
        <div class="flex gap-3 flex-wrap text-xs text-base-content/60 mt-1">
          <span>ðŸ’¬ ${convCount} conversations</span>
          <span>ðŸ“ ${exCount} exchanges</span>
          <span>ðŸ• ${timeAgo(lastActive)}</span>
        </div>
        ${keySection}
      </div>
    </div>
  `;
    }).join('');
}

function toggleAgentKeyVisibility(agentId) {
    agentKeyVisibility[agentId] = !agentKeyVisibility[agentId];
    loadAgentsFull();
}

function copyAgentKey(agentId, key) {
    navigator.clipboard.writeText(key).then(() => {
        showToast(`ðŸ“‹ API key for ${agentId} copied`, 'success');
    }).catch(() => {
        showToast('âŒ Failed to copy', 'error');
    });
}

async function regenerateAgentKey(agentId, agentName) {
    if (!confirm(`âš ï¸ Regenerate API key for "${agentName}"?\n\nThe old key will be invalidated immediately. Any agent using the old key will lose access.`)) return;

    try {
        const res = await fetch(`/api/memory/agents/${agentId}/regenerate-key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        const json = await res.json();

        if (json.success) {
            showToast(`ðŸ”‘ New key generated for ${agentName}`, 'success');
            agentKeyVisibility[agentId] = true; // Show the new key
            await loadAgentsFull();
        } else {
            showToast(`âŒ Failed: ${json.error}`, 'error');
        }
    } catch (err) {
        showToast(`âŒ Error: ${err.message}`, 'error');
    }
}

async function loadAgentsFull() {
    const res = await api('GET', '/api/memory/agents');
    if (res.success) {
        renderAgentsList(res.data, 'agents-full-list');
    }
}

// ============ CONVERSATIONS ============

async function loadConversations() {
    try {
        const res = await api('GET', '/api/memory/conversations?limit=100');
        if (res.success && res.data) {
            allConversations = res.data;
            renderConversationList(allConversations);
        }
    } catch {
        document.getElementById('conv-list').innerHTML =
            '<div class="text-center text-base-content/40 py-8">ðŸ’¬</span> Failed to load</div>';
    }
}

function renderConversationList(conversations) {
    const container = document.getElementById('conv-list');
    if (!conversations.length) {
        container.innerHTML = '<div class="text-center text-base-content/40 py-8">ðŸ’¬ No conversations yet.</div>';
        return;
    }

    container.innerHTML = conversations.map(c => {
        const agentName = c.agent_name || c.agent_id || 'unknown';
        const isActive = c.status === 'active';
        const isSelected = c.id === selectedConvId;
        const title = c.topic || c.title || `Conv ${c.id.slice(0, 8)}`;
        return `
      <div class="flex items-center gap-3 px-3 py-2.5 cursor-pointer border-b border-base-300/30 border-l-3 transition-colors hover:bg-base-300/30 ${isSelected ? 'bg-primary/8 border-l-primary' : 'border-l-transparent'}" onclick="loadConversationThread('${c.id}', '${escAttr(agentName)}')">
        <div class="avatar placeholder">
          <div class="w-9 rounded-lg text-white text-xs" style="background: ${getAgentColor(c.agent_id || 'x')}">
            <span class="font-bold">${getInitials(agentName)}</span>
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-sm truncate">${escHtml(title)}</div>
          <div class="flex items-center gap-1.5 text-xs text-base-content/50 flex-wrap">
            <span class="inline-block w-1.5 h-1.5 rounded-full ${isActive ? 'bg-success' : 'bg-base-content/30'}"></span>
            ${escHtml(agentName)}
            ${c.exchange_count ? `<span class="badge badge-info badge-xs">${c.exchange_count} exchanges</span>` : ''}
            ${c.topic ? `<span class="badge badge-ghost badge-xs">${escHtml(c.topic)}</span>` : ''}
          </div>
        </div>
        <span class="text-xs text-base-content/40 whitespace-nowrap">${timeAgo(c.updated_at || c.created_at)}</span>
      </div>
    `;
    }).join('');
}

function filterConversations(query) {
    if (!query.trim()) {
        renderConversationList(allConversations);
        return;
    }
    const q = query.toLowerCase();
    const filtered = allConversations.filter(c =>
        (c.title || '').toLowerCase().includes(q) ||
        (c.agent_name || '').toLowerCase().includes(q) ||
        (c.agent_id || '').toLowerCase().includes(q)
    );
    renderConversationList(filtered);
}

async function loadConversationThread(convId, agentName) {
    selectedConvId = convId;

    // Re-render conversation list to update selection
    renderConversationList(allConversations);

    document.getElementById('conv-thread-title').textContent = `ðŸ’¬ ${agentName || 'Conversation'}`;
    document.getElementById('conv-thread-actions').style.display = 'flex';
    document.getElementById('conv-thread-meta').textContent = `ID: ${convId.slice(0, 12)}...`;

    const threadEl = document.getElementById('conv-thread');
    threadEl.innerHTML = '<div class="text-center text-base-content/40 py-8"><span class="loading loading-spinner loading-md"></span><p class="mt-2">Loading...</p></div>';

    try {
        const res = await api('GET', `/api/memory/conversations/${convId}`);
        if (!res.success) {
            threadEl.innerHTML = '<div class="text-center text-error py-8">âŒ Failed to load</div>';
            return;
        }

        const conv = res.data;
        const exchanges = conv.exchanges || [];

        if (!exchanges.length) {
            threadEl.innerHTML = '<div class="text-center text-base-content/40 py-8">ðŸ’¬ No exchanges yet</div>';
            return;
        }

        threadEl.innerHTML = exchanges.map((ex, i) => `
        <div class="chat chat-start mb-1">
          <div class="chat-image avatar placeholder">
            <div class="w-8 rounded-full bg-info/20 text-info">
              <span>ðŸ‘¤</span>
            </div>
          </div>
          <div class="chat-header text-xs opacity-60">
            User <time class="text-xs opacity-40">#${ex.sequence_num || i + 1} Â· ${timeAgo(ex.created_at)}</time>
          </div>
          <div class="chat-bubble chat-bubble-info text-sm whitespace-pre-wrap">${escHtml(ex.user_message)}</div>
        </div>
        <div class="chat chat-end mb-3">
          <div class="chat-image avatar placeholder">
            <div class="w-8 rounded-full bg-success/20 text-success">
              <span>ðŸ¤–</span>
            </div>
          </div>
          <div class="chat-header text-xs opacity-60">${escHtml(agentName)}</div>
          <div class="chat-bubble chat-bubble-success text-sm whitespace-pre-wrap">${escHtml(ex.agent_response)}</div>
        </div>
      `).join('');

        threadEl.scrollTop = threadEl.scrollHeight;

        // Render summaries
        const summaries = conv.summaries || [];
        const summarySection = document.getElementById('conv-summary');
        const summaryContent = document.getElementById('conv-summary-content');
        if (summaries.length > 0) {
            summarySection.style.display = 'block';
            summaryContent.innerHTML = summaries.map(s => {
                const facts = s.facts_extracted || [];
                const decisions = s.decisions_made || [];
                return `
                    <div class="bg-base-300/40 rounded-lg p-4 mb-2 border-l-3 border-primary">
                        <p class="text-sm leading-relaxed mb-2">${escHtml(s.summary_text || 'No summary text')}</p>
                        ${facts.length ? `
                            <div class="mt-2">
                                <div class="text-xs font-semibold text-base-content/60 mb-1">ðŸ“Œ Key Facts</div>
                                <ul class="list-disc pl-5 text-sm space-y-0.5">${facts.map(f => `<li>${escHtml(f)}</li>`).join('')}</ul>
                            </div>
                        ` : ''}
                        ${decisions.length ? `
                            <div class="mt-2">
                                <div class="text-xs font-semibold text-base-content/60 mb-1">ðŸ”® Decisions</div>
                                <ul class="list-disc pl-5 text-sm space-y-0.5">${decisions.map(d => `<li>${escHtml(d)}</li>`).join('')}</ul>
                            </div>
                        ` : ''}
                        <div class="text-xs text-base-content/40 mt-2">Exchanges #${s.from_sequence}â€“#${s.to_sequence} Â· ${timeAgo(s.created_at)}</div>
                    </div>
                `;
            }).join('');
        } else {
            summarySection.style.display = 'none';
        }

        loadConversationKnowledge(conv.memories || []);

    } catch (err) {
        threadEl.innerHTML = `<div class="text-center text-error py-8">âŒ Error: ${err.message}</div>`;
    }
}

async function loadConversationKnowledge(memories) {
    const section = document.getElementById('conv-knowledge');
    const list = document.getElementById('conv-knowledge-list');

    if (!memories.length) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    list.innerHTML = memories.map(m => {
        const typeIcon = m.type === 'fact' ? 'âœ…' : m.type === 'decision' ? 'ðŸ”®' : m.type === 'preference' ? 'â­' : 'ðŸ“';
        const typeLabel = m.type || 'memory';
        const actorIcon = m.actor_id === 'assistant' ? 'ðŸ¤–' : 'ðŸ‘¤';
        return `<span class="badge badge-outline badge-sm gap-1 py-3" title="${typeLabel} (${actorIcon} ${m.actor_id || 'user'})">${typeIcon} ${escHtml(typeLabel)}: ${escHtml(truncate(m.content, 90))}</span>`;
    }).join('');
}

// ============ MEMORIES / EXCHANGES ============

function renderExchange(ex) {
    const agentId = ex.agent_id || ex.source_agent_id || 'â€”';
    const topic = ex.topic || '';
    return `
    <div class="card bg-base-200 shadow-sm mb-2 cursor-pointer hover:bg-base-300/50 transition-colors" data-type="exchange" onclick="toggleExpand(this)">
      <div class="card-body p-3">
        <div class="flex items-center gap-1.5 flex-wrap mb-1">
          <span class="badge badge-info badge-sm">ðŸ’¬ exchange</span>
          <span class="badge badge-ghost badge-xs">${escHtml(agentId)}</span>
          ${topic ? `<span class="badge badge-ghost badge-xs">${escHtml(topic)}</span>` : ''}
          <span class="ml-auto text-xs text-base-content/40">${timeAgo(ex.created_at)}</span>
        </div>
        <div class="text-sm leading-relaxed">
          <div class="mb-1"><strong class="text-info">ðŸ‘¤ User:</strong> ${escHtml(truncate(ex.user_message, 200))}</div>
          <div><strong class="text-success">ðŸ¤– Agent:</strong> ${escHtml(truncate(ex.agent_response, 200))}</div>
        </div>
        <div class="text-xs text-primary cursor-pointer mt-1 expand-btn">â–¼ Show full</div>
        <div class="memory-detail">
          <div class="bg-base-300/50 rounded-lg p-3 mt-2 space-y-1 text-sm">
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">ID</span><span class="break-all">${ex.id || 'â€”'}</span></div>
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Conversation</span><span class="break-all">${ex.conversation_id || 'â€”'}</span></div>
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Sequence</span><span>#${ex.sequence_num || 'â€”'}</span></div>
            ${topic ? `<div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Topic</span><span>${escHtml(topic)}</span></div>` : ''}
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Created</span><span>${ex.created_at || 'â€”'}</span></div>
            <div class="bg-base-300/40 rounded-lg p-3 mt-2 text-sm whitespace-pre-wrap"><strong class="text-info">ðŸ‘¤ User:</strong>\n${escHtml(ex.user_message)}\n\n<strong class="text-success">ðŸ¤– Agent:</strong>\n${escHtml(ex.agent_response)}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderMemory(m) {
    if (m.user_message) return renderExchange(m);
    const type = m.type || 'exchange';
    const score = m.importance_score || m.importanceScore || 0.5;
    const topic = m.topic || m.metadata?.topic || '';
    const scope = m.scope || m.metadata?.scope || '';
    const domain = m.domain || m.metadata?.domain || '';
    const actorId = m.actor_id || m.actorId || 'user';
    const contentHash = m.content_hash || m.contentHash || '';
    const isSuperseded = !!(m.superseded_by);
    const status = m.status || (isSuperseded ? 'superseded' : 'active');
    const typeIcon = type === 'fact' ? 'âœ…' : type === 'decision' ? 'ðŸ”®' : type === 'preference' ? 'â­' : 'ðŸ“';
    const scorePercent = (score * 100).toFixed(0);
    const progressClass = score >= 0.7 ? 'progress-success' : score >= 0.4 ? 'progress-warning' : 'progress-error';
    const scoreTextClass = score >= 0.7 ? 'text-success' : score >= 0.4 ? 'text-warning' : 'text-error';
    const actorIcon = actorId === 'assistant' ? 'ðŸ¤–' : actorId === 'manual' ? 'âœï¸' : 'ðŸ‘¤';
    const actorLabel = actorId === 'assistant' ? 'Assistant' : actorId === 'manual' ? 'Manual' : 'User';
    const actorBadgeClass = actorId === 'assistant' ? 'badge-success' : actorId === 'manual' ? 'badge-accent' : 'badge-info';
    const statusBadge = isSuperseded
        ? '<span class="badge badge-warning badge-xs">ðŸ”„ superseded</span>'
        : '<span class="badge badge-success badge-xs">â— active</span>';
    const cardClass = isSuperseded ? 'card bg-base-200 shadow-sm mb-2 opacity-60 cursor-pointer hover:opacity-80 transition-all' : 'card bg-base-200 shadow-sm mb-2 cursor-pointer hover:bg-base-300/50 transition-colors';
    return `
    <div class="${cardClass}" data-type="${type}" data-actor="${actorId}" data-status="${status}" onclick="toggleExpand(this)">
      <div class="card-body p-3">
        <div class="flex items-center gap-1.5 flex-wrap mb-1">
          ${statusBadge}
          <span class="badge badge-primary badge-sm">${typeIcon} ${type}</span>
          <span class="badge ${actorBadgeClass} badge-xs">${actorIcon} ${actorLabel}</span>
          <span class="badge badge-ghost badge-xs">${escHtml(m.source_agent_id || m.agentId || 'â€”')}</span>
          ${topic ? `<span class="badge badge-ghost badge-xs">${escHtml(topic)}</span>` : ''}
          <span class="ml-auto text-xs text-base-content/40">${timeAgo(m.created_at || m.createdAt)}</span>
        </div>
        <p class="text-sm leading-relaxed">${escHtml(truncate(m.content, 300))}</p>
        <div class="flex items-center gap-2 mt-1">
          <span class="text-xs text-base-content/50">Importance:</span>
          <progress class="progress ${progressClass} w-32 h-1.5" value="${scorePercent}" max="100"></progress>
          <span class="text-xs font-bold ${scoreTextClass}">${scorePercent}%</span>
        </div>
        <div class="text-xs text-primary cursor-pointer mt-1 expand-btn">â–¼ Show full</div>
        <div class="memory-detail">
          <div class="bg-base-300/50 rounded-lg p-3 mt-2 space-y-1 text-sm">
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">ID</span><span class="break-all font-mono text-xs">${m.id || 'â€”'}</span></div>
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Status</span><span>${statusBadge}</span></div>
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Type</span><span>${typeIcon} ${type}</span></div>
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Source</span><span class="badge ${actorBadgeClass} badge-xs">${actorIcon} ${actorLabel}</span></div>
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Agent</span><span>${m.source_agent_id || m.agentId || 'â€”'}</span></div>
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Conversation</span><span class="break-all">${m.source_conversation_id || m.conversation_id || 'â€”'}</span></div>
            ${isSuperseded ? `<div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Superseded By</span><span class="font-mono text-xs text-error break-all">${m.superseded_by}</span></div>` : ''}
            ${topic ? `<div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Topic</span><span>${escHtml(topic)}</span></div>` : ''}
            ${scope ? `<div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Scope</span><span>${escHtml(scope)}</span></div>` : ''}
            ${domain ? `<div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Domain</span><span>${escHtml(domain)}</span></div>` : ''}
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Importance</span><span class="font-bold ${scoreTextClass}">${scorePercent}%</span></div>
            ${contentHash ? `<div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Hash</span><span class="font-mono text-xs text-base-content/40 break-all">${contentHash}</span></div>` : ''}
            <div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Created</span><span>${m.created_at || m.createdAt || 'â€”'}</span></div>
            ${m.tags && m.tags.length ? `<div class="flex gap-3"><span class="text-xs font-semibold text-base-content/50 w-28 shrink-0">Tags</span><span class="flex gap-1 flex-wrap">${m.tags.map(t => `<span class="badge badge-outline badge-xs">${escHtml(t)}</span>`).join('')}</span></div>` : ''}
            <div class="bg-base-300/40 rounded-lg p-3 mt-2 text-sm whitespace-pre-wrap">${escHtml(m.content)}</div>
            <div class="flex gap-2 mt-3 pt-3 border-t border-base-300">
              <button class="btn btn-error btn-sm" onclick="event.stopPropagation(); deleteMemory('${m.id}', this)" title="Delete this memory permanently">
                ðŸ—‘ï¸ Delete
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function toggleExpand(el) {
    el.classList.toggle('expanded');
    const btn = el.querySelector('.expand-btn');
    if (btn) btn.textContent = el.classList.contains('expanded') ? 'â–² Collapse' : 'â–¼ Show full';
}

async function loadDashMemories() {
    try {
        const res = await api('GET', '/api/memory/exchanges?limit=10');
        if (res.success && res.data) {
            renderFilteredMemories('dash-memories-list', res.data);
        }
    } catch {
        document.getElementById('dash-memories-list').innerHTML =
            '<div class="text-center text-base-content/40 py-8">ðŸ’¾</span> No exchanges yet</div>';
    }
}

function renderFilteredMemories(containerId, items) {
    const container = document.getElementById(containerId);
    if (!items.length) {
        container.innerHTML = '<div class="text-center text-base-content/40 py-8">ðŸ’¾</span> No data found</div>';
        return;
    }
    container.innerHTML = items.map(renderMemory).join('');
}

async function searchDashMemories(query) {
    if (!query.trim()) { loadDashMemories(); return; }
    try {
        const res = await api('POST', '/api/memory/search', { query, limit: 20 });
        const memories = res.data || res;
        renderFilteredMemories('dash-memories-list', Array.isArray(memories) ? memories : []);
    } catch { }
}

async function loadMemoriesFull() {
    try {
        // Use /api/memory/memories for full PG data (includes superseded_by, all fields)
        const [exRes, memRes] = await Promise.all([
            api('GET', '/api/memory/exchanges?limit=100'),
            api('GET', '/api/memory/memories?limit=200'),
        ]);
        const exchanges = (exRes.success && exRes.data) ? exRes.data : [];
        const memories = (memRes.success && memRes.data) ? memRes.data : [];
        allMemories = [...exchanges, ...memories];
        const seen = new Set();
        allMemories = allMemories.filter(m => {
            const id = m.id;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
        // Sort by timestamp, newest first
        allMemories.sort((a, b) => {
            const ta = new Date(a.created_at || a.createdAt || 0).getTime();
            const tb = new Date(b.created_at || b.createdAt || 0).getTime();
            return tb - ta;
        });
        applyMemoryFilters();
    } catch {
        document.getElementById('memories-full-list').innerHTML =
            '<div class="text-center text-base-content/40 py-8">ðŸ’¾</span> Failed to load data</div>';
    }
}

let searchDebounce = null;
function debounceSearchMemories(query) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
        if (!query.trim()) { loadMemoriesFull(); return; }
        const res = await api('POST', '/api/memory/search', { query, limit: 100 });
        const mems = res.data || res;
        allMemories = Array.isArray(mems) ? mems : [];
        applyMemoryFilters();
    }, 300);
}

function filterMemoryType(type, btn) {
    currentMemoryFilter = type;
    btn.parentElement.querySelectorAll('.btn').forEach(b => b.classList.remove('btn-active'));
    btn.classList.add('btn-active');
    applyMemoryFilters();
}

function filterMemoryActor(actor, btn) {
    currentActorFilter = actor;
    btn.parentElement.querySelectorAll('.btn').forEach(b => b.classList.remove('btn-active'));
    btn.classList.add('btn-active');
    applyMemoryFilters();
}

function filterMemoryStatus(status, btn) {
    currentStatusFilter = status;
    btn.parentElement.querySelectorAll('.btn').forEach(b => b.classList.remove('btn-active'));
    btn.classList.add('btn-active');
    applyMemoryFilters();
}

function applyMemoryFilters() {
    let filtered = allMemories;
    // Type filter
    if (currentMemoryFilter !== 'all') {
        if (currentMemoryFilter === 'exchange') {
            filtered = filtered.filter(m => m.user_message);
        } else {
            filtered = filtered.filter(m => m.type === currentMemoryFilter);
        }
    }
    // Actor filter (user vs assistant)
    if (currentActorFilter !== 'all') {
        filtered = filtered.filter(m => {
            const actor = m.actor_id || m.actorId || 'user';
            return actor === currentActorFilter;
        });
    }
    // Status filter (active vs superseded)
    if (currentStatusFilter !== 'all') {
        filtered = filtered.filter(m => {
            const isSuperseded = !!(m.superseded_by);
            if (currentStatusFilter === 'active') return !isSuperseded && !m.user_message;
            if (currentStatusFilter === 'superseded') return isSuperseded;
            return true;
        });
    }
    renderFilteredMemories('memories-full-list', filtered);
}

// ============ KNOWLEDGE (removed â€” Mem0 style, facts in Qdrant are the KB) ============

// ============ LOGS ============

async function loadInitialLogs() {
    try {
        const res = await api('GET', '/api/logs?limit=200');
        if (res.success && res.data) {
            res.data.reverse().forEach(entry => addLogEntry(entry, false));
        }
    } catch { }
}

function addLogEntry(entry, animate = true) {
    allLogs.push(entry);
    if (allLogs.length > 1000) allLogs.shift();

    document.getElementById('nav-log-count').textContent = allLogs.length;

    renderLogEntry(entry, 'dash-logs-list', animate);
    renderLogEntry(entry, 'logs-full-list', animate);
}

function renderLogEntry(entry, containerId, animate) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const empty = container.querySelector('.text-center');
    if (empty) empty.remove();

    if (currentLogFilter !== 'all' && entry.level !== currentLogFilter) return;

    const div = document.createElement('div');
    div.className = 'log-entry';
    if (!animate) div.style.animation = 'none';
    div.dataset.level = entry.level;

    const levelColors = { info: 'badge-info', warn: 'badge-warning', error: 'badge-error', debug: 'badge-ghost' };
    const levelClass = levelColors[entry.level] || 'badge-ghost';
    const source = entry.source ? `<span class="log-source">${entry.source}</span>` : '';

    div.innerHTML = `
    <span class="log-time">${formatLogTime(entry.timestamp)}</span>
    <span class="badge badge-xs ${levelClass}">${entry.level}</span>
    ${source}
    <span class="log-msg">${escHtml(entry.message)}</span>
  `;

    container.appendChild(div);

    if (logAutoScroll) {
        container.scrollTop = container.scrollHeight;
    }

    while (container.children.length > 500) {
        container.removeChild(container.firstChild);
    }
}

function filterLogs(level, btn) {
    currentLogFilter = level;
    btn.parentElement.querySelectorAll('.btn').forEach(b => b.classList.remove('btn-active'));
    btn.classList.add('btn-active');

    ['dash-logs-list', 'logs-full-list'].forEach(id => {
        const container = document.getElementById(id);
        if (!container) return;
        container.innerHTML = '';
        allLogs.forEach(entry => {
            if (level === 'all' || entry.level === level) {
                renderLogEntry(entry, id, false);
            }
        });
    });
}

function clearLogs() {
    allLogs = [];
    ['dash-logs-list', 'logs-full-list'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<div class="text-center text-base-content/40 py-8">ðŸ“‹</span> Logs cleared</div>';
    });
}

// ============ UTILS ============

function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escAttr(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
}

function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function timeAgo(dateStr) {
    if (!dateStr) return 'â€”';
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function formatLogTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-GB', { hour12: false });
}

// ============ INIT ============

async function init() {
    // Load initial data
    await loadStats();
    await loadDashMemories();

    // Start SSE
    initSSE();

    // No more polling! Stats come via SSE stats:update events
    // Only do a fallback health check every 60s
    setInterval(loadStats, 60000);
}

init();

// ============ SETTINGS ============

let settingsData = {};
let settingsModified = {};

async function loadSettings() {
    try {
        const res = await fetch(`/api/config`);
        const json = await res.json();
        if (json.success) {
            settingsData = json.data;
            settingsModified = {};
            renderMemoloApiKeysPanel();
            renderSettingsForm();
        }
    } catch (err) {
        console.error('Failed to load settings:', err);
    }
}

// ============ API KEYS PANEL ============

async function renderMemoloApiKeysPanel() {
    try {
        const res = await fetch('/api');
        const json = await res.json();
        const statusEl = document.getElementById('master-key-status');
        if (statusEl && json) {
            const authEnabled = json.auth === 'enabled';
            const badgeClass = authEnabled ? 'badge-success' : 'badge-warning';
            const statusIcon = authEnabled ? 'âœ“' : 'âš ';
            const statusText = authEnabled ? 'Enabled' : 'Disabled (dev mode)';
            statusEl.innerHTML = `<span class="badge ${badgeClass}">${statusIcon} ${statusText}</span>`;
        }
    } catch { }

    try {
        const res = await api('GET', '/api/memory/agents');
        const countEl = document.getElementById('agent-keys-count');
        if (countEl && res.success) {
            const count = res.data.length;
            countEl.innerHTML = `<span class="badge badge-ghost">ðŸ¤– ${count} agent${count !== 1 ? 's' : ''}</span>`;
        }
    } catch { }
}

function renderSettingsForm() {
    const container = document.getElementById('settings-container');
    if (!container) return;

    // Group settings by group name
    const groups = {};
    for (const [key, meta] of Object.entries(settingsData)) {
        const group = meta.group || 'Other';
        if (!groups[group]) groups[group] = [];
        groups[group].push({ key, ...meta });
    }

    const groupIcons = {
        'LLM Models': 'ðŸ¤–',
        'Embeddings': 'ðŸ”—',
        'Feature Toggles': 'ðŸ”€',
        'Timeouts': 'â±ï¸',
        'Memory': 'ðŸ§ ',
        'Scheduler': 'ðŸ“…',
        'Batch': 'ðŸ“¦',
        'Prompts': 'ðŸ“',
    };


    let html = '';
    for (const [groupName, items] of Object.entries(groups)) {
        const icon = groupIcons[groupName] || 'âš™ï¸';
        html += `<div class="setting-group">`;
        html += `<div class="setting-group-header">${icon} ${groupName}</div>`;

        // Show Active LLM status banner for LLM Models group
        if (groupName === 'LLM Models') {
            const currentModel = (settingsModified['minimax.model'] !== undefined ? settingsModified['minimax.model'] : settingsData['minimax.model']?.value) || 'MiniMax-M2.5';
            html += `<div class="llm-status-banner" style="background: linear-gradient(135deg, #6366f122, #6366f111); border: 1px solid #6366f144; border-radius: 12px; padding: 16px 20px; margin: 12px 16px 4px;">`;
            html += `<div style="display: flex; align-items: center; gap: 12px;">`;
            html += `<div style="font-size: 28px;">â˜ï¸</div>`;
            html += `<div>`;
            html += `<div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6366f1; font-weight: 600; margin-bottom: 2px;">Active LLM Provider</div>`;
            html += `<div style="font-size: 18px; font-weight: 700; color: var(--text-primary);">MiniMax (Cloud)</div>`;
            html += `<div style="font-size: 13px; color: var(--text-secondary); margin-top: 2px;">Model: <strong>${currentModel}</strong></div>`;
            html += `</div></div></div>`;
        }

        html += `<div class="py-1">`;

        for (const item of items) {
            const isModified = settingsModified[item.key] !== undefined;
            const isDefault = item.value === item.default;

            html += `<div class="setting-row${isModified ? ' modified' : ''}">`;
            html += `<div class="setting-info">`;
            html += `<div class="setting-name">${item.label}`;
            if (!isDefault) html += ` <span class="badge badge-warning badge-xs">custom</span>`;
            html += `</div>`;
            html += `<div class="setting-desc">${item.description || ''}</div>`;
            html += `</div>`;
            html += `<div class="setting-control">`;

            if (item.type === 'boolean') {
                const checked = (settingsModified[item.key] !== undefined ? settingsModified[item.key] : item.value) ? 'checked' : '';
                html += `<input type="checkbox" class="toggle toggle-primary toggle-sm" ${checked} onchange="onSettingChange('${item.key}', this.checked)">`;
            } else if (item.type === 'select' && item.options) {
                const val = settingsModified[item.key] !== undefined ? settingsModified[item.key] : item.value;
                html += `<select class="select select-bordered select-sm" onchange="onSettingChange('${item.key}', this.value)">`;
                for (const opt of item.options) {
                    html += `<option value="${opt}" ${val === opt ? 'selected' : ''}>${opt}</option>`;
                }
                html += `</select>`;
            } else if (item.type === 'number') {
                const val = settingsModified[item.key] !== undefined ? settingsModified[item.key] : item.value;
                const step = item.step || (item.max <= 1 ? 0.05 : 1);
                const unit = item.unit ? ` <span class="setting-unit">${formatUnit(val, item.unit)}</span>` : '';
                html += `<div class="number-input-group">`;
                html += `<input type="number" class="input input-bordered input-sm w-24" value="${val}" `;
                html += `min="${item.min !== undefined ? item.min : ''}" max="${item.max !== undefined ? item.max : ''}" step="${step}" `;
                html += `onchange="onSettingChange('${item.key}', parseFloat(this.value))">`;
                html += unit;
                html += `</div>`;
            } else if (item.type === 'textarea') {
                const val = settingsModified[item.key] !== undefined ? settingsModified[item.key] : item.value;
                const charCount = (val || '').length;
                html += `<div class="w-full">`;
                html += `<textarea class="textarea textarea-bordered w-full text-xs font-mono" rows="12" `;
                html += `onchange="onSettingChange('${item.key}', this.value)" `;
                html += `oninput="this.parentElement.querySelector('.char-count').textContent = this.value.length + ' chars'">`;
                html += escHtml(val || '');
                html += `</textarea>`;
                html += `<div class="flex items-center justify-between mt-1">`;
                html += `<span class="char-count text-xs text-base-content/40">${charCount} chars</span>`;
                if (!isDefault) {
                    html += `<button class="btn btn-ghost btn-xs" onclick="resetSingleSetting('${item.key}')" title="Reset to default prompt">â†© Reset</button>`;
                }
                html += `</div>`;
                html += `</div>`;
            } else {
                const val = settingsModified[item.key] !== undefined ? settingsModified[item.key] : item.value;
                // Mask API keys
                const inputType = item.key.includes('apiKey') || item.key.includes('Key') ? 'password' : 'text';
                html += `<input type="${inputType}" class="input input-bordered input-sm" value="${val}" `;
                html += `onchange="onSettingChange('${item.key}', this.value)"`;
                html += `${inputType === 'password' ? ' autocomplete="off"' : ''}>`;
            }

            // Reset single setting button (skip for textarea â€” they have their own)
            if (!isDefault && item.type !== 'textarea') {
                html += `<button class="btn btn-ghost btn-xs" onclick="resetSingleSetting('${item.key}')" title="Reset to default: ${item.default}">â†©</button>`;
            }

            html += `</div>`; // setting-control
            html += `</div>`; // setting-row
        }

        html += `</div>`; // py-1
        html += `</div>`; // setting-group
    }

    container.innerHTML = html;
}

function formatUnit(value, unit) {
    if (unit === 'ms') {
        if (value >= 3600000) return `${(value / 3600000).toFixed(1)}h`;
        if (value >= 60000) return `${(value / 60000).toFixed(1)}m`;
        if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
        return `${value}ms`;
    }
    return unit;
}

function onSettingChange(key, value) {
    settingsModified[key] = value;
    // Mark the row as modified visually
    renderSettingsForm();
}

async function saveSettings() {
    if (Object.keys(settingsModified).length === 0) {
        showToast('No changes to save', 'info');
        return;
    }

    try {
        const res = await fetch(`/api/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: settingsModified }),
        });
        const json = await res.json();

        if (json.success) {
            showToast(`âœ… Saved ${Object.keys(settingsModified).length} setting(s)`, 'success');
            settingsModified = {};
            // Reload to get fresh values
            await loadSettings();
        } else {
            showToast(`âŒ Error: ${json.errors?.join(', ') || 'Unknown error'}`, 'error');
        }
    } catch (err) {
        showToast(`âŒ Failed to save: ${err.message}`, 'error');
    }
}

async function resetAllSettings() {
    if (!confirm('Reset ALL settings to their defaults?')) return;

    try {
        const res = await fetch(`/api/config/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all: true }),
        });
        const json = await res.json();
        if (json.success) {
            showToast('ðŸ”„ All settings reset to defaults', 'success');
            settingsModified = {};
            await loadSettings();
        }
    } catch (err) {
        showToast(`âŒ Failed to reset: ${err.message}`, 'error');
    }
}

async function resetSingleSetting(key) {
    try {
        const res = await fetch(`/api/config/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
        });
        const json = await res.json();
        if (json.success) {
            delete settingsModified[key];
            showToast(`â†© Reset ${key}`, 'info');
            await loadSettings();
        }
    } catch (err) {
        showToast(`âŒ Failed to reset: ${err.message}`, 'error');
    }
}

// ============ RECALL PLAYGROUND ============

let lastRecallResponse = null;

// Handle Enter key in query input
document.addEventListener('DOMContentLoaded', () => {
    const queryInput = document.getElementById('recall-query');
    if (queryInput) {
        queryInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') executeRecall();
        });
    }
});

async function executeRecall() {
    const query = document.getElementById('recall-query').value.trim();
    if (!query) {
        showToast('Please enter a query', 'info');
        return;
    }

    const agentId = document.getElementById('recall-agent').value.trim() || undefined;
    const conversationId = document.getElementById('recall-conv').value.trim() || undefined;
    const topic = document.getElementById('recall-topic').value.trim() || undefined;
    const limit = parseInt(document.getElementById('recall-limit').value) || 10;
    const format = document.getElementById('recall-format').value;

    const btn = document.getElementById('recall-btn');
    const resultsDiv = document.getElementById('recall-results');

    btn.disabled = true;
    btn.textContent = 'â³ Recalling...';
    resultsDiv.innerHTML = '<div class="text-center text-base-content/40 py-8">â³</span> Searching memories...</div>';

    const t0 = performance.now();

    try {
        const body = { query, limit };
        if (agentId) body.agentId = agentId;
        if (conversationId) body.conversationId = conversationId;
        if (topic) body.topic = topic;
        if (format === 'context') body.format = 'context';

        const res = await fetch('/api/memory/recall', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await res.json();
        const elapsed = (performance.now() - t0).toFixed(0);

        lastRecallResponse = json;

        if (!json.success) {
            resultsDiv.innerHTML = `<div class="text-center text-base-content/40 py-8">âŒ</span> Error: ${json.error || 'Unknown error'}</div>`;
            return;
        }

        if (format === 'context' && json.context) {
            renderContextFormat(json, elapsed, query);
        } else {
            renderRecallResults(json.data, elapsed, query);
        }

    } catch (err) {
        resultsDiv.innerHTML = `<div class="text-center text-base-content/40 py-8">âŒ</span> Failed: ${err.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'ðŸ” Recall';
    }
}

function renderRecallResults(data, elapsed, query) {
    const container = document.getElementById('recall-results');

    const sections = [
        { key: 'semanticMemories', label: 'ðŸ§  Semantic Memories', icon: 'ðŸ§ ', description: 'Extracted facts via vector search' },
        { key: 'crossAgentMemories', label: 'ðŸ”— Cross-Agent Memories', icon: 'ðŸ”—', description: 'Memories from other agents' },
        { key: 'summaries', label: 'ðŸ“ Summaries', icon: 'ðŸ“', description: 'Conversation summaries' },
    ];

    let totalCount = 0;
    for (const s of sections) {
        const arr = data[s.key];
        if (Array.isArray(arr)) totalCount += arr.length;
    }

    let html = `<div class="flex items-center gap-3 bg-base-200 rounded-lg p-3 mb-4">`;
    html += `<span class="text-sm">ðŸ” <strong>${totalCount}</strong> results in <strong>${elapsed}ms</strong></span>`;
    html += `<span class="text-xs text-base-content/50 flex-1">Query: "${escapeHtml(query)}"</span>`;
    html += `<button class="btn btn-ghost btn-sm" onclick="toggleRawJson()">ðŸ“¦ Show JSON</button>`;
    html += `</div>`;

    for (const section of sections) {
        const items = data[section.key];
        if (!Array.isArray(items) || items.length === 0) continue;

        html += `<div class="card bg-base-200 shadow-sm mb-3">`;
        html += `<div class="card-body p-0">`;
        html += `<div class="px-4 py-2 border-b border-base-300 flex items-center gap-2"><span class="font-bold text-sm">${section.label}</span><span class="badge badge-primary badge-sm">${items.length}</span></div>`;
        html += `<div class="p-3 space-y-2">`;

        for (const item of items) {
            html += renderRecallItem(item, section.key);
        }

        html += `</div></div></div>`;
    }

    if (data.conversationProfile && Object.keys(data.conversationProfile).length > 0) {
        html += `<div class="card bg-base-200 shadow-sm mb-3">`;
        html += `<div class="card-body p-0">`;
        html += `<div class="px-4 py-2 border-b border-base-300 font-bold text-sm">ðŸ‘¤ Conversation Profile</div>`;
        html += `<div class="p-3"><pre class="text-xs whitespace-pre-wrap font-mono bg-base-300/50 rounded-lg p-3">${escapeHtml(JSON.stringify(data.conversationProfile, null, 2))}</pre></div>`;
        html += `</div></div>`;
    }

    if (totalCount === 0) {
        html += `<div class="text-center text-base-content/40 py-8">ðŸ¤· No memories found for this query</div>`;
    }

    container.innerHTML = html;
}

function renderRecallItem(item, sectionKey) {
    let html = `<div class="bg-base-300/40 rounded-lg p-3">`;

    if (sectionKey === 'semanticMemories' || sectionKey === 'crossAgentMemories') {
        const score = item.score !== undefined ? (item.score * 100).toFixed(1) : null;
        const payload = item.payload || item;
        const content = payload.content || payload.user_message || JSON.stringify(payload);
        const agentId = payload.agent_id || '';
        const importance = payload.importance_score;
        const tags = payload.content_tags || [];
        const topic = payload.topic || '';

        html += `<div class="flex items-center gap-1.5 flex-wrap mb-2">`;
        if (score !== null) {
            const scoreBadge = score >= 70 ? 'badge-success' : score >= 50 ? 'badge-warning' : 'badge-error';
            html += `<span class="badge ${scoreBadge} badge-sm font-mono">${score}%</span>`;
        }
        if (agentId) html += `<span class="badge badge-ghost badge-xs">${escapeHtml(agentId)}</span>`;
        if (topic) html += `<span class="badge badge-ghost badge-xs">${escapeHtml(topic)}</span>`;
        if (importance !== undefined) html += `<span class="badge badge-accent badge-xs">âš¡${(importance * 100).toFixed(0)}</span>`;
        html += `</div>`;
        html += `<div class="text-sm">${escapeHtml(content)}</div>`;
        if (tags.length > 0) {
            html += `<div class="flex gap-1 flex-wrap mt-2">${tags.map(t => `<span class="badge badge-outline badge-xs">${escapeHtml(t)}</span>`).join('')}</div>`;
        }
    } else if (sectionKey === 'summaries') {
        const summary = item.summary || item.content || JSON.stringify(item);
        html += `<div class="text-sm italic">${escapeHtml(summary)}</div>`;
    } else {
        html += `<div class="text-sm font-mono">${escapeHtml(JSON.stringify(item, null, 2))}</div>`;
    }

    html += `</div>`;
    return html;
}

function renderContextFormat(json, elapsed, query) {
    const container = document.getElementById('recall-results');
    const rawCount = json.raw ? Object.values(json.raw).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0) : 0;

    let html = `<div class="flex items-center gap-3 bg-base-200 rounded-lg p-3 mb-4">`;
    html += `<span class="text-sm">ðŸ” <strong>${rawCount}</strong> memories â†’ context in <strong>${elapsed}ms</strong></span>`;
    html += `<span class="text-xs text-base-content/50 flex-1">Query: "${escapeHtml(query)}"</span>`;
    html += `<button class="btn btn-ghost btn-sm" onclick="toggleRawJson()">ðŸ“¦ Show JSON</button>`;
    html += `</div>`;

    html += `<div class="card bg-base-200 shadow-sm">`;
    html += `<div class="card-body p-0">`;
    html += `<div class="px-4 py-2 border-b border-base-300 font-bold text-sm">ðŸ“„ LLM Context String</div>`;
    html += `<div class="p-3 relative">`;
    html += `<button class="btn btn-ghost btn-sm absolute top-4 right-4" onclick="copyContext()">ðŸ“‹ Copy</button>`;
    html += `<pre class="text-xs whitespace-pre-wrap font-mono bg-base-300/50 rounded-lg p-3">${escapeHtml(json.context)}</pre>`;
    html += `</div></div></div>`;

    container.innerHTML = html;
}

function copyContext() {
    if (!lastRecallResponse || !lastRecallResponse.context) return;
    navigator.clipboard.writeText(lastRecallResponse.context).then(() => {
        showToast('ðŸ“‹ Context copied to clipboard', 'success');
    });
}

function toggleRawJson() {
    const panel = document.getElementById('recall-raw-json');
    const pre = document.getElementById('recall-json-content');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        pre.textContent = JSON.stringify(lastRecallResponse, null, 2);
    } else {
        panel.style.display = 'none';
    }
}

function escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============ MEMORY MANAGEMENT: DELETE + ADD ============

async function deleteMemory(memoryId, btnEl) {
    if (!confirm('Are you sure you want to permanently delete this memory?\n\nThis will remove it from both the database and vector store.')) {
        return;
    }

    btnEl.disabled = true;
    btnEl.textContent = 'â³ Deleting...';

    try {
        const result = await api('DELETE', `/api/memory/${memoryId}`);
        if (result.success) {
            // Animate removal
            const card = btnEl.closest('.memory-item');
            if (card) {
                card.style.transition = 'opacity 0.3s, transform 0.3s';
                card.style.opacity = '0';
                card.style.transform = 'translateX(-20px)';
                setTimeout(() => card.remove(), 300);
            }
            // Remove from allMemories
            allMemories = allMemories.filter(m => m.id !== memoryId);
            showToast('ðŸ—‘ï¸', 'Memory Deleted', 'Successfully removed from database and vector store');
        } else {
            throw new Error(result.error || 'Delete failed');
        }
    } catch (err) {
        btnEl.disabled = false;
        btnEl.textContent = 'ðŸ—‘ï¸ Delete';
        showToast('âŒ', 'Delete Failed', err.message);
    }
}

function toggleAddMemoryForm() {
    const panel = document.getElementById('add-memory-panel');
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
        document.getElementById('add-mem-content').focus();
    }
}

async function submitAddMemory() {
    const content = document.getElementById('add-mem-content').value.trim();
    const type = document.getElementById('add-mem-type').value;
    const topic = document.getElementById('add-mem-topic').value.trim() || 'general';
    const tagsRaw = document.getElementById('add-mem-tags').value.trim();
    const importance = parseInt(document.getElementById('add-mem-importance').value) / 100;

    if (!content) {
        showToast('âš ï¸', 'Missing Content', 'Please enter the memory content');
        document.getElementById('add-mem-content').focus();
        return;
    }

    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(t => t) : [];
    const btn = document.getElementById('btn-add-memory-submit');
    btn.disabled = true;
    btn.textContent = 'â³ Adding...';

    try {
        const result = await api('POST', '/api/memory/memories/add', {
            content,
            type,
            topic,
            tags,
            importance,
        });

        if (result.success) {
            showToast('âœ…', 'Memory Added', `"${content.substring(0, 50)}..." saved successfully`);
            // Reset form
            document.getElementById('add-mem-content').value = '';
            document.getElementById('add-mem-tags').value = '';
            document.getElementById('add-mem-importance').value = '70';
            document.getElementById('add-mem-imp-label').textContent = '70%';
            // Hide form
            toggleAddMemoryForm();
            // Reload memories
            loadMemoriesFull();
        } else {
            throw new Error(result.error || 'Failed to add memory');
        }
    } catch (err) {
        showToast('âŒ', 'Add Failed', err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'âž• Add Memory';
    }
}
