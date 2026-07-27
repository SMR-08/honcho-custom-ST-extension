import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    getCurrentChatId,
    chat_metadata,
    updateChatMetadata,
    characters,
    this_chid,
    chat,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
    saveMetadataDebounced,
} from '../../../extensions.js';
import { selected_group, groups } from '../../../group-chats.js';
import { oai_settings } from '../../../openai.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT, Popup } from '../../../popup.js';

const MODULE_NAME = 'honcho';
const MESSAGE_CHAR_LIMIT = 24000;
const QUERY_CHAR_LIMIT = 10000;
const MAX_LATE_CACHE = 50;
const SYNC_SCHEMA_VERSION = 1;

const defaultSettings = {
    enabled: false,
    apiKey: 'local-dev-no-auth',
    baseUrl: 'http://127.0.0.1:8000',
    workspaceId: 'st-rp',
    peerMode: 'per_persona',
    sessionNaming: 'auto',
    customSessionName: '',
    contextMode: 'reasoning',
    prefetchQueries: ['What do you know about the user?'],
    prefetchInterval: 8,
    injectionPosition: extension_prompt_types.IN_PROMPT,
    injectionDepth: 4,
    promptTemplate: '[Honcho Memory]\n{{text}}',
    contextTokens: 2000,
    outputTokens: 500,
    contextInterval: 1,
    contextSummary: true,
    peerName: '',
};

let sessionSetupInProgress = false;
let pendingChatId = null;
let lastGenerationChatIndex = -1;
let turnsSinceLastReasoning = Infinity;
let cachedContextText = null;
let contextRefreshInFlight = false;
let turnsSinceLastContextRefresh = Infinity;
let cachedReasoningText = null;
let reasoningRefreshInFlight = false;
let syncInProgress = false;
let pendingSyncReason = null;
const lateResultCache = new Map();
const pendingBackgroundQueries = new Map();
const activeAbortControllers = new Set();

function settings() {
    return extension_settings.honcho;
}

function sanitizeId(value) {
    const cleaned = String(value || '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    return cleaned || 'unnamed';
}

function resetCaches() {
    lastGenerationChatIndex = -1;
    turnsSinceLastReasoning = Infinity;
    turnsSinceLastContextRefresh = Infinity;
    cachedContextText = null;
    contextRefreshInFlight = false;
    cachedReasoningText = null;
    reasoningRefreshInFlight = false;
    lateResultCache.clear();
    pendingBackgroundQueries.clear();
}

function abortAllInFlight() {
    for (const controller of activeAbortControllers) controller.abort();
    activeAbortControllers.clear();
}

function hasHonchoApiKey() {
    return Boolean(settings()?.apiKey);
}

function getHonchoBaseUrl() {
    return (settings()?.baseUrl || '').replace(/\/$/, '');
}

function getHonchoApiKey() {
    return settings()?.apiKey || '';
}

function isReady() {
    return Boolean(settings()?.enabled && settings()?.workspaceId && getHonchoBaseUrl() && hasHonchoApiKey());
}

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getHonchoApiKey()}`,
    };
}

function outputLimitChars() {
    return Math.max(50, Number(settings()?.outputTokens) || 500) * 4;
}

function clampHonchoOutput(text) {
    if (typeof text !== 'string') return text;
    const limit = outputLimitChars();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n[Honcho output truncated to ${settings()?.outputTokens || 500} tokens budget]`;
}

function truncate(text, limit, label) {
    if (typeof text !== 'string' || text.length <= limit) return text;
    console.warn(`[Honcho] Truncating ${label}: ${text.length} chars → ${limit} chars`);
    return text.slice(0, limit);
}

function chunkText(text, limit) {
    if (!text || text.length <= limit) return [text || ''];
    const chunks = [];
    let rest = text;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf('\n\n', limit);
        if (cut < limit * 0.5) cut = rest.lastIndexOf('. ', limit);
        if (cut < limit * 0.5) cut = limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
}

function hashText(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function normalizeMessageContent(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
}

function getHonchoMetadata(messageMetadata) {
    return messageMetadata?.honcho_st_sync || {};
}

function isLiveHonchoMessage(message) {
    const sync = getHonchoMetadata(message?.metadata || message?.h_metadata);
    return sync.schema_version === SYNC_SCHEMA_VERSION
        && sync.deleted !== true
        && sync.superseded !== true
        && sync.current !== false;
}

function getSyncNumber(sync, key, fallback = 0) {
    const value = Number(sync?.[key]);
    return Number.isFinite(value) ? value : fallback;
}

function compareHonchoMessagesBySTOrder(left, right) {
    const leftSync = getHonchoMetadata(left?.metadata || left?.h_metadata);
    const rightSync = getHonchoMetadata(right?.metadata || right?.h_metadata);
    const indexDiff = getSyncNumber(leftSync, 'st_message_index') - getSyncNumber(rightSync, 'st_message_index');
    if (indexDiff !== 0) return indexDiff;
    const chunkDiff = getSyncNumber(leftSync, 'chunk_index') - getSyncNumber(rightSync, 'chunk_index');
    if (chunkDiff !== 0) return chunkDiff;
    return String(left?.created_at || '').localeCompare(String(right?.created_at || ''));
}

function selectCurrentHonchoMessages(messages) {
    const selected = new Map();
    for (const message of messages || []) {
        if (!isLiveHonchoMessage(message)) continue;
        const sync = getHonchoMetadata(message?.metadata || message?.h_metadata);
        const key = `${sync.st_message_key ?? sync.st_message_index}:${getSyncNumber(sync, 'chunk_index')}`;
        const current = selected.get(key);
        if (!current) {
            selected.set(key, message);
            continue;
        }
        const currentSync = getHonchoMetadata(current?.metadata || current?.h_metadata);
        const versionDiff = getSyncNumber(sync, 'st_message_version') - getSyncNumber(currentSync, 'st_message_version');
        if (versionDiff > 0 || (versionDiff === 0 && String(message.created_at || '') > String(current.created_at || ''))) {
            selected.set(key, message);
        }
    }
    return Array.from(selected.values()).sort(compareHonchoMessagesBySTOrder);
}

async function honchoRequest(method, path, { body = null, query = null, signal = null } = {}) {
    const baseUrl = getHonchoBaseUrl();
    if (!baseUrl) throw new Error('Honcho URL is required');

    const url = new URL(`${baseUrl}${path}`);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
    }

    const response = await fetch(url.toString(), {
        method,
        headers: authHeaders(),
        body: body === null ? undefined : JSON.stringify(body),
        signal,
    });

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
    if (!response.ok) {
        const detail = data?.detail || data?.error || data?.message || response.statusText || `HTTP ${response.status}`;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return data;
}

async function honchoFetchRaw(endpoint, body, signal = null) {
    try {
        return await callHonchoOperation(endpoint, body, signal);
    } catch (err) {
        if (err.name !== 'AbortError') console.warn(`[Honcho] ${endpoint} error:`, err.message);
        return null;
    }
}

async function honchoFetchRawTracked(endpoint, body) {
    if (!isReady()) return null;
    const controller = new AbortController();
    activeAbortControllers.add(controller);
    try {
        return await honchoFetchRaw(endpoint, body, controller.signal);
    } finally {
        activeAbortControllers.delete(controller);
    }
}

async function honchoFetch(endpoint, body, timeoutMs = 30000, cacheKey = null) {
    if (cacheKey && lateResultCache.has(cacheKey)) {
        const cached = lateResultCache.get(cacheKey);
        lateResultCache.delete(cacheKey);
        return cached;
    }

    if (!cacheKey) {
        const controller = new AbortController();
        activeAbortControllers.add(controller);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await honchoFetchRaw(endpoint, body, controller.signal);
        } finally {
            clearTimeout(timer);
            activeAbortControllers.delete(controller);
        }
    }

    const readController = new AbortController();
    activeAbortControllers.add(readController);
    const fetchPromise = honchoFetchRaw(endpoint, body, readController.signal)
        .finally(() => activeAbortControllers.delete(readController));

    try {
        const result = await Promise.race([
            fetchPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ]);
        pendingBackgroundQueries.delete(cacheKey);
        return result;
    } catch {
        console.warn(`[Honcho] ${endpoint} timed out after ${timeoutMs}ms (key: ${cacheKey})`);
        if (!pendingBackgroundQueries.has(cacheKey)) {
            const backgroundPromise = fetchPromise.then(result => {
                if (isReady() && result) {
                    if (lateResultCache.size >= MAX_LATE_CACHE) lateResultCache.delete(lateResultCache.keys().next().value);
                    lateResultCache.set(cacheKey, result);
                }
                pendingBackgroundQueries.delete(cacheKey);
            }).catch(() => pendingBackgroundQueries.delete(cacheKey));
            pendingBackgroundQueries.set(cacheKey, backgroundPromise);
        }
        return null;
    }
}

async function callHonchoOperation(endpoint, body, signal) {
    const workspaceId = settings().workspaceId;
    switch (endpoint) {
        case '/peer': {
            const configuration = typeof body.observeMe === 'boolean' ? { observe_me: body.observeMe } : undefined;
            const peer = await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(workspaceId)}/peers`, {
                body: { id: body.peerId, ...(configuration ? { configuration } : {}) },
                signal,
            });
            return { id: peer?.id || peer?.name || body.peerId, workspaceId };
        }
        case '/session': {
            const peers = buildSessionPeers(body.userPeerId, body.charPeerId, body.charPeerIds);
            const session = await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
                body: { id: body.sessionId, peers },
                signal,
            });
            return { id: session?.id || session?.name || body.sessionId, workspaceId };
        }
        case '/session/add-peers': {
            const peers = {};
            for (const peerId of body.peerIds || []) peers[peerId] = { observe_me: false };
            await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(body.sessionId)}/peers`, {
                body: peers,
                signal,
            });
            return { ok: true };
        }
        case '/session/messages': {
            const messages = [];
            for (const message of body.messages || []) {
                if (!message.peerId || !message.content) continue;
                const chunks = chunkText(message.content, MESSAGE_CHAR_LIMIT);
                for (const [chunkIndex, chunk] of chunks.entries()) {
                    messages.push({
                        peer_id: message.peerId,
                        content: chunk,
                        ...(message.metadata ? {
                            metadata: {
                                ...message.metadata,
                                honcho_st_sync: {
                                    ...message.metadata.honcho_st_sync,
                                    chunk_index: chunkIndex,
                                    chunk_count: chunks.length,
                                },
                            },
                        } : {}),
                    });
                }
            }
            if (!messages.length) throw new Error('No valid messages provided');
            const stored = await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(body.sessionId)}/messages`, {
                body: { messages },
                signal,
            });
            return {
                count: Array.isArray(stored) ? stored.length : messages.length,
                messages: Array.isArray(stored) ? stored : [],
                ids: Array.isArray(stored) ? stored.map(message => message.id || message.public_id).filter(Boolean) : [],
            };
        }
        case '/session/message-metadata': {
            const updated = await honchoRequest('PUT', `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(body.sessionId)}/messages/${encodeURIComponent(body.messageId)}`, {
                body: { metadata: body.metadata || {} },
                signal,
            });
            return { ok: true, message: updated };
        }
        case '/session/list-messages': {
            const listed = await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(body.sessionId)}/messages/list`, {
                body: {},
                query: { page: body.page || 1, size: body.size || 100, reverse: body.reverse === true },
                signal,
            });
            return listed;
        }
        case '/context': {
            const query = {
                tokens: body.tokens,
                summary: typeof body.summary === 'boolean' ? body.summary : undefined,
            };
            // Only attach peer perspective when explicitly requested.
            if (body.userPeerId) {
                query.peer_perspective = body.userPeerId;
                query.peer_target = body.userPeerId;
            }
            const context = await honchoRequest('GET', `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(body.sessionId)}/context`, {
                query,
                signal,
            });
            return { context: formatSessionContext(context) };
        }
        case '/chat': {
            const response = await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(workspaceId)}/peers/${encodeURIComponent(body.peerId)}/chat`, {
                body: {
                    query: truncate(body.query, QUERY_CHAR_LIMIT, `dialectic query for ${body.peerId}`),
                    session_id: body.sessionId || undefined,
                    reasoning_level: 'low',
                    stream: false,
                },
                signal,
            });
            return { response: clampHonchoOutput(response?.content || '') };
        }
        case '/conclusion': {
            const honchoMeta = chat_metadata?.honcho;
            const created = await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(workspaceId)}/conclusions`, {
                body: {
                    conclusions: [{
                        content: body.content,
                        observer_id: body.peerId,
                        observed_id: body.peerId,
                        session_id: honchoMeta?.sessionId || undefined,
                    }],
                },
                signal,
            });
            const conclusion = Array.isArray(created) ? created[0] : created;
            return { id: conclusion?.id, content: conclusion?.content || body.content };
        }
        case '/search': {
            const results = await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(workspaceId)}/search`, {
                body: {
                    query: body.query,
                    limit: body.limit || 5,
                    filters: { session_id: body.sessionId },
                },
                signal,
            });
            return { results: Array.isArray(results) ? results : [] };
        }
        default:
            throw new Error(`Unsupported Honcho operation: ${endpoint}`);
    }
}

function buildSessionPeers(userPeerId, charPeerId, charPeerIds) {
    const peers = {};
    if (userPeerId) peers[userPeerId] = { observe_me: true, observe_others: true };
    const charIds = Array.isArray(charPeerIds) && charPeerIds.length > 0 ? charPeerIds : (charPeerId ? [charPeerId] : []);
    for (const id of charIds) peers[id] = { observe_me: false, observe_others: false };
    return peers;
}

function contextBudgetChars() {
    return Math.max(400, Number(settings()?.contextTokens) || 2000) * 4;
}

function clampToBudget(text, budgetChars = contextBudgetChars(), label = 'Honcho context') {
    if (typeof text !== 'string' || !text) return text || '';
    if (text.length <= budgetChars) return text;
    console.warn(`[Honcho] Truncating ${label}: ${text.length} chars → ${budgetChars} chars`);
    return `${text.slice(0, Math.max(0, budgetChars - 80))}\n[Honcho truncated to ${settings()?.contextTokens || 2000} token budget]`;
}

function formatSessionContext(context) {
    if (!context) return null;
    const parts = [];
    // Order: summary first (most useful for long RP), then card, then a short representation slice.
    if (context.summary?.content) {
        parts.push(`Session summary:\n${String(context.summary.content).trim()}`);
    }
    if (Array.isArray(context.peer_card) && context.peer_card.length) {
        parts.push(`Peer card:\n${context.peer_card.map(item => `- ${item}`).join('\n')}`);
    }
    if (context.peer_representation) {
        // Full representation can be huge; keep a compact head for prompt injection.
        const rep = String(context.peer_representation).trim().replace(/\s+\n/g, '\n');
        const compact = rep.length > 1800 ? `${rep.slice(0, 1800)}\n[peer representation truncated]` : rep;
        parts.push(`Peer representation:\n${compact}`);
    }
    // Raw recent messages are last-resort only, and short.
    if (!parts.length && Array.isArray(context.messages) && context.messages.length) {
        const recent = context.messages.slice(-4).map(message => {
            const who = message.peer_id || message.peer_name || 'peer';
            const content = String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 220);
            return `- ${who}: ${content}`;
        });
        parts.push(`Recent session snippets:\n${recent.join('\n')}`);
    }
    return parts.join('\n\n') || null;
}

function formatSemanticHits(results, limit = 6) {
    const liveResults = selectCurrentHonchoMessages((results || []).filter(item => typeof item !== 'string'));
    if (!liveResults.length) return null;
    const lines = liveResults.slice(0, limit).map((item, index) => {
        const content = String(item.content || item || '').replace(/\s+/g, ' ').trim().slice(0, 280);
        const who = item.peer_id || item.peer_name || '';
        return `${index + 1}. ${who ? `${who}: ` : ''}${content}`;
    });
    return `Relevant memory hits:\n${lines.join('\n')}`;
}

/**
 * Context-only enrichment:
 * - Prefer curated Honcho memory: representation / peer card / summary via /context
 * - Optionally add compact semantic hits for the latest user turn
 * - Never dump long raw chat history as the primary memory block
 */
async function fetchCuratedContext(honchoMeta, lastUserMessage = '') {
    const parts = [];
    const includeSummary = settings().contextSummary !== false;
    const tokens = Math.max(100, Number(settings().contextTokens) || 2000);

    // Prefer session-level context first (summary lives on the session).
    // Peer perspective can omit summary depending on Honcho selection logic.
    let contextResult = await honchoFetch('/context', {
        sessionId: honchoMeta.sessionId,
        tokens,
        summary: includeSummary,
    }, 30000, `ctxsess:${honchoMeta.sessionId}:${tokens}:${includeSummary ? 1 : 0}`);

    if (contextResult?.context) parts.push(contextResult.context);

    // If we still lack card/representation, try peer perspective once.
    if (!contextResult?.context || !/Peer card:|Peer representation:|Session summary:/.test(contextResult.context)) {
        const peerCtx = await honchoFetch('/context', {
            sessionId: honchoMeta.sessionId,
            userPeerId: honchoMeta.userPeerId,
            tokens,
            summary: includeSummary,
        }, 30000, `ctxpeer:${honchoMeta.sessionId}:${honchoMeta.userPeerId}:${tokens}`);
        if (peerCtx?.context && peerCtx.context !== contextResult?.context) {
            parts.push(peerCtx.context);
        }
    }

    // Semantic refinement around the latest user turn when available.
    const query = String(lastUserMessage || '').trim();
    if (query) {
        const search = await honchoFetch(
            '/search',
            { sessionId: honchoMeta.sessionId, query: truncate(query, QUERY_CHAR_LIMIT, 'context search'), limit: 6 },
            30000,
            `ctxsearch:${honchoMeta.sessionId}:${hashText(query).slice(0, 12)}`,
        );
        const hits = formatSemanticHits(search?.results || [], 6);
        if (hits) parts.push(hits);
    }

    // De-dupe crude repeats if both context calls returned similar blocks.
    const unique = [];
    for (const part of parts.filter(Boolean)) {
        if (!unique.some(existing => existing === part || existing.includes(part) || part.includes(existing))) {
            unique.push(part);
        }
    }
    const joined = unique.join('\n\n').trim();
    return joined ? clampToBudget(joined) : null;
}

/**
 * Reasoning enrichment:
 * Run the configured Reasoning queries through Honcho dialectic (/chat),
 * not through raw message search.
 */
async function fetchReasoningAnswers(honchoMeta, lastUserMessage = '') {
    const answers = [];
    const queries = settings().prefetchQueries || [];
    for (const query of queries) {
        if (!isReady()) break;
        const trimmed = String(query || '').trim().replace(/\{\{message\}\}/gi, lastUserMessage);
        if (!trimmed) continue;
        const result = await honchoFetch(
            '/chat',
            {
                peerId: honchoMeta.userPeerId,
                sessionId: honchoMeta.sessionId,
                query: trimmed,
            },
            45000,
            `reason:${honchoMeta.sessionId}:${hashText(trimmed).slice(0, 12)}`,
        );
        const answer = String(result?.response || '').trim();
        if (answer) {
            answers.push(`Q: ${trimmed}\nA: ${answer}`);
        }
    }
    if (!answers.length) return null;
    return clampToBudget(answers.join('\n\n'), contextBudgetChars(), 'Honcho reasoning');
}

function getUserPeerId() {
    const context = getContext();
    const explicit = settings().peerName || context.name1 || 'default-user';
    if (settings().peerMode === 'per_persona') {
        const personaName = context.name1 || 'default';
        if (sanitizeId(personaName) === sanitizeId(explicit)) return sanitizeId(explicit);
        return sanitizeId(`${explicit}-${personaName}`);
    }
    return sanitizeId(explicit);
}

function getCharName() {
    if (selected_group) {
        const group = groups.find(item => item.id === selected_group);
        return group?.name || 'group';
    }
    return characters[this_chid]?.name || 'character';
}

function getCharPeerId() {
    return sanitizeId(getCharName());
}

function getGroupCharPeerIds() {
    if (!selected_group) return [];
    const group = groups.find(item => item.id === selected_group);
    if (!group?.members?.length) return [];
    return group.members.map(member => sanitizeId(characters[member]?.name || member)).filter(Boolean);
}

function getPeerIdForMessage(message) {
    return sanitizeId(message?.name || getCharName());
}

/**
 * SillyTavern "Hide" marks roleplay messages with is_system=true so they leave the
 * model context budget. That flag must NOT drop them from Honcho: large RPs hide old
 * turns to save prompt space while long-term memory still needs those turns.
 *
 * Real ST system/UI messages set extra.type (help, welcome, slash help, etc.) and are
 * still excluded. Narrator posts are roleplay content and stay eligible.
 */
function isNonRoleplaySystemMessage(message) {
    if (!message) return true;
    if (message.is_user) return false;

    if (Array.isArray(message.extra?.tool_invocations) && message.extra.tool_invocations.length > 0) {
        return true;
    }

    const type = message.extra?.type;
    if (!type) {
        // Hidden user/character messages only flip is_system; keep them for Honcho.
        return false;
    }

    if (type === 'narrator') return false;

    return [
        'help',
        'welcome',
        'empty',
        'generic',
        'comment',
        'slash_commands',
        'formatting',
        'hotkeys',
        'macros',
        'welcome_prompt',
        'assistant_note',
        'assistant_message',
    ].includes(type);
}

function getPeerIdForChatMessage(message, index, honchoMeta) {
    if (message?.is_user) return honchoMeta.userPeerId;
    if (isNonRoleplaySystemMessage(message)) return null;
    return getPeerIdForMessage(message) || honchoMeta.charPeerId;
}

function getSyncedMessageMap(honchoMeta) {
    if (!honchoMeta.messageMap || typeof honchoMeta.messageMap !== 'object') {
        honchoMeta.messageMap = {};
    }
    return honchoMeta.messageMap;
}

function buildCurrentSyncEntries(honchoMeta) {
    const entries = [];
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        // Ignore Hide/is_system for roleplay turns; only skip real ST system/UI noise.
        if (!message || isNonRoleplaySystemMessage(message)) continue;
        const content = normalizeMessageContent(message.mes);
        if (!content) continue;
        const peerId = getPeerIdForChatMessage(message, index, honchoMeta);
        if (!peerId) continue;
        entries.push({
            key: String(index),
            index,
            peerId,
            role: message.is_user ? 'user' : 'assistant',
            content,
            hash: hashText(`${peerId}\n${content}`),
            name: message.name || (message.is_user ? getContext().name1 : getCharName()),
            hidden: message.is_system === true,
        });
    }
    return entries;
}

function buildMessageMetadata(entry, version, status = {}) {
    return {
        honcho_st_sync: {
            schema_version: SYNC_SCHEMA_VERSION,
            st_message_index: entry.index,
            st_message_key: entry.key,
            st_message_hash: entry.hash,
            st_message_version: version,
            st_peer_id: entry.peerId,
            st_role: entry.role,
            st_name: entry.name,
            // Reflect ST Hide state for debugging only. Hidden messages stay current.
            st_hidden: entry.hidden === true,
            current: status.current !== false,
            deleted: status.deleted === true,
            superseded: status.superseded === true,
            superseded_by: status.supersededBy || null,
            updated_at: new Date().toISOString(),
        },
    };
}

async function markHonchoMessageIds(sessionId, messageIds, metadata) {
    for (const messageId of messageIds || []) {
        await honchoFetch('/session/message-metadata', { sessionId, messageId, metadata });
    }
}

async function storeSyncedMessage(honchoMeta, entry, previousRecord = null) {
    const version = (previousRecord?.version || 0) + 1;
    const metadata = buildMessageMetadata(entry, version);
    const result = await honchoFetch('/session/messages', {
        sessionId: honchoMeta.sessionId,
        messages: [{ peerId: entry.peerId, content: entry.content, metadata }],
    });
    if (!result?.ids?.length) return null;
    return {
        honchoMessageIds: result.ids,
        hash: entry.hash,
        peerId: entry.peerId,
        role: entry.role,
        name: entry.name,
        version,
        deleted: false,
        contentLength: entry.content.length,
        updatedAt: new Date().toISOString(),
    };
}

async function reconcileHonchoMessages(reason = 'sync') {
    if (!isReady()) return;
    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId || !honchoMeta?.userPeerId) return;

    if (syncInProgress) {
        pendingSyncReason = reason;
        return;
    }

    syncInProgress = true;
    try {
        const messageMap = getSyncedMessageMap(honchoMeta);
        const currentEntries = buildCurrentSyncEntries(honchoMeta);
        const currentByKey = new Map(currentEntries.map(entry => [entry.key, entry]));
        let changed = false;
        let firstChangedIndex = null;

        for (const [key, record] of Object.entries(messageMap)) {
            if (record?.deleted) continue;
            const index = Number(key);
            const current = currentByKey.get(key);
            const changedAtKey = !current || record.hash !== current.hash || record.peerId !== current.peerId;
            if (changedAtKey && (firstChangedIndex === null || index < firstChangedIndex)) {
                firstChangedIndex = index;
            }
        }

        for (const entry of currentEntries) {
            const previous = messageMap[entry.key];
            if ((!previous || previous.deleted) && (firstChangedIndex === null || entry.index < firstChangedIndex)) {
                firstChangedIndex = entry.index;
            }
        }

        if (firstChangedIndex === null) {
            return;
        }

        const staleKeys = Object.keys(messageMap)
            .map(key => Number(key))
            .filter(index => Number.isFinite(index) && index >= firstChangedIndex)
            .sort((a, b) => a - b)
            .map(index => String(index));

        for (const key of staleKeys) {
            const record = messageMap[key];
            if (!record || record.deleted) continue;
            const staleEntry = {
                key,
                index: Number(key),
                hash: record.hash,
                peerId: record.peerId,
                role: record.role,
                name: record.name || record.peerId,
            };
            await markHonchoMessageIds(honchoMeta.sessionId, record.honchoMessageIds, buildMessageMetadata(staleEntry, record.version || 1, {
                current: false,
                superseded: currentByKey.has(key),
                deleted: !currentByKey.has(key),
            }));
            record.deleted = !currentByKey.has(key);
            record.superseded = currentByKey.has(key);
            record.updatedAt = new Date().toISOString();
            changed = true;
        }

        const entriesToRebuild = currentEntries.filter(entry => entry.index >= firstChangedIndex);
        for (const entry of entriesToRebuild) {
            const previous = messageMap[entry.key];
            const stored = await storeSyncedMessage(honchoMeta, entry, previous);
            if (stored) {
                messageMap[entry.key] = stored;
                changed = true;
            }
        }

        if (changed) {
            honchoMeta.syncSchemaVersion = SYNC_SCHEMA_VERSION;
            honchoMeta.lastSyncReason = reason;
            honchoMeta.lastRebuiltFromIndex = firstChangedIndex;
            honchoMeta.lastSyncedAt = new Date().toISOString();
            updateChatMetadata({ honcho: honchoMeta });
            saveMetadataDebounced();
            resetCaches();
        }
    } catch (err) {
        console.warn(`[Honcho] Reconcile failed (${reason}):`, err.message);
    } finally {
        syncInProgress = false;
        if (pendingSyncReason) {
            const nextReason = pendingSyncReason;
            pendingSyncReason = null;
            reconcileHonchoMessages(nextReason);
        }
    }
}

function getSessionId(rawChatId) {
    const charName = getCharName();
    const mode = settings().sessionNaming || 'auto';
    if (mode === 'custom' && settings().customSessionName) return sanitizeId(settings().customSessionName);
    if (mode === 'character') return sanitizeId(charName);
    const dateMatch = String(rawChatId).match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
    const shortHash = Math.abs(Array.from(String(rawChatId)).reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)).toString(36);
    return sanitizeId(`${charName}-${date}-${shortHash}`);
}

async function onChatChanged() {
    if (!isReady()) return;
    resetCaches();
    const rawChatId = getCurrentChatId();
    if (!rawChatId) return;

    const chatId = chat_metadata?.honcho?.sessionId || getSessionId(rawChatId);
    if (sessionSetupInProgress) {
        pendingChatId = rawChatId;
        return;
    }

    sessionSetupInProgress = true;
    try {
        const existingMeta = chat_metadata?.honcho;
        const userPeerId = existingMeta?.userPeerId || getUserPeerId();
        const charPeerId = existingMeta?.charPeerId || getCharPeerId();
        const groupCharPeerIds = existingMeta?.charPeerIds?.length ? existingMeta.charPeerIds : getGroupCharPeerIds();

        await honchoFetch('/peer', { peerId: userPeerId, observeMe: true });
        for (const peerId of groupCharPeerIds.length ? groupCharPeerIds : [charPeerId]) {
            await honchoFetch('/peer', { peerId, observeMe: false });
        }

        const result = await honchoFetch('/session', {
            sessionId: chatId,
            userPeerId,
            charPeerId,
            charPeerIds: groupCharPeerIds.length ? groupCharPeerIds : undefined,
        });

        if (result) {
            updateChatMetadata({
                honcho: {
                    ...existingMeta,
                    sessionId: chatId,
                    userPeerId,
                    charPeerId,
                    charPeerIds: groupCharPeerIds,
                    messageMap: existingMeta?.messageMap || {},
                    syncSchemaVersion: SYNC_SCHEMA_VERSION,
                },
            });
            saveMetadataDebounced();
            updateActiveSessionDisplay();
            await reconcileHonchoMessages('chat_changed');
        } else {
            console.warn('[Honcho] Session setup failed');
        }
    } catch (err) {
        console.error('[Honcho] onChatChanged error:', err);
    } finally {
        sessionSetupInProgress = false;
        if (pendingChatId) {
            pendingChatId = null;
            onChatChanged();
        }
    }
}

async function onGeneration() {
    if (!isReady()) return;
    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId || !honchoMeta?.userPeerId) return;

    await reconcileHonchoMessages('before_generation');

    const currentIndex = chat.length - 1;
    if (currentIndex >= 0 && currentIndex === lastGenerationChatIndex) return;
    lastGenerationChatIndex = currentIndex;

    let lastUserMessage = '';
    for (let index = chat.length - 1; index >= 0; index--) {
        if (chat[index]?.is_user && chat[index]?.mes) {
            lastUserMessage = chat[index].mes;
            break;
        }
    }

    const mode = settings().contextMode || 'context';
    const parts = [];
    try {
        // Base layer for all modes: curated memory (summary/card/representation + optional semantic hits).
        // Never dump long raw chat history here.
        turnsSinceLastContextRefresh++;
        if (cachedContextText === null) {
            const contextResult = await fetchCuratedContext(honchoMeta, lastUserMessage);
            if (!isReady()) return;
            if (contextResult) cachedContextText = contextResult;
            turnsSinceLastContextRefresh = 0;
        } else if (turnsSinceLastContextRefresh >= (settings().contextInterval || 1) && !contextRefreshInFlight) {
            turnsSinceLastContextRefresh = 0;
            contextRefreshInFlight = true;
            fetchCuratedContext(honchoMeta, lastUserMessage)
                .then(result => { if (isReady() && result) cachedContextText = result; })
                .finally(() => { contextRefreshInFlight = false; });
        }
        if (cachedContextText) parts.push(cachedContextText);

        // Reasoning mode only: dialectic answers for configured queries.
        // Tool-call mode intentionally does NOT run these; the chat model asks on demand.
        if (mode === 'reasoning') {
            turnsSinceLastReasoning++;
            if (cachedReasoningText === null) {
                const results = await fetchReasoningAnswers(honchoMeta, lastUserMessage);
                if (!isReady()) return;
                if (results) cachedReasoningText = results;
                turnsSinceLastReasoning = 0;
            } else if (turnsSinceLastReasoning >= (settings().prefetchInterval || 8) && !reasoningRefreshInFlight) {
                turnsSinceLastReasoning = 0;
                reasoningRefreshInFlight = true;
                fetchReasoningAnswers(honchoMeta, lastUserMessage)
                    .then(results => { if (isReady() && results) cachedReasoningText = results; })
                    .finally(() => { reasoningRefreshInFlight = false; });
            }
            if (cachedReasoningText) parts.push(`Honcho reasoning:\n${cachedReasoningText}`);
        }
    } catch (err) {
        console.warn('[Honcho] Context injection error:', err.message);
    }

    const contextText = parts.join('\n\n').trim();
    if (!contextText) {
        setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, 0);
        return;
    }

    const formatted = (settings().promptTemplate || '{{text}}').replace('{{text}}', contextText);
    const position = Number(settings().injectionPosition);
    const depth = position === extension_prompt_types.IN_CHAT ? Number(settings().injectionDepth) : 0;
    setExtensionPrompt(MODULE_NAME, formatted, position, depth, false, extension_prompt_roles.SYSTEM);
}

async function onMessageSent(messageIndex) {
    if (!isReady()) return;
    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId) return;
    await reconcileHonchoMessages(`message_sent:${messageIndex}`);
}

async function onCharResponse(messageIndex) {
    if (!isReady()) return;
    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId) return;
    const message = chat[messageIndex];
    // Hidden (is_system) character replies still sync; only real system/UI is skipped.
    if (!message || message.is_user || isNonRoleplaySystemMessage(message) || messageIndex !== chat.length - 1) return;

    const peerId = getPeerIdForMessage(message);
    if (selected_group) {
        const known = honchoMeta.charPeerIds || [];
        if (!known.includes(peerId)) {
            const created = await honchoFetch('/peer', { peerId, observeMe: false });
            if (created) {
                const added = await honchoFetch('/session/add-peers', { sessionId: honchoMeta.sessionId, peerIds: [peerId] });
                if (added) {
                    honchoMeta.charPeerIds = [...known, peerId];
                    updateChatMetadata({ honcho: honchoMeta });
                    saveMetadataDebounced();
                }
            }
        }
    }

    await reconcileHonchoMessages(`character_message_rendered:${messageIndex}`);
}

async function onMessageEdited(messageIndex) {
    await reconcileHonchoMessages(`message_edited:${messageIndex ?? 'unknown'}`);
}

async function onMessageDeleted(messageIndex) {
    await reconcileHonchoMessages(`message_deleted:${messageIndex ?? 'unknown'}`);
}

function registerHonchoTools() {
    const context = getContext();
    const shouldRegister = () => isReady() && settings().contextMode === 'tool_call';

    context.registerFunctionTool({
        name: 'honcho_query_memory',
        displayName: 'Honcho: Query Memory',
        description: 'Ask Honcho a natural-language question about long-term memory for this roleplay (who someone is, what happened somewhere, preferences, relationships, past events). Use this instead of guessing from current chat alone.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { query: { type: 'string', description: 'Natural language question about memory. Examples: "Who is Eleonora?", "What happened in the ruins?", "What does Matei want?"' } },
            required: ['query'],
        },
        action: async (args) => {
            if (!args?.query) return 'No query provided.';
            const honchoMeta = chat_metadata?.honcho;
            if (!honchoMeta?.sessionId || !honchoMeta?.userPeerId) return 'Honcho session not initialized for this chat.';

            // Dialectic first: curated answer from Honcho memory.
            const dialectic = await honchoFetch('/chat', {
                peerId: honchoMeta.userPeerId,
                sessionId: honchoMeta.sessionId,
                query: args.query,
            }, 45000, `toolchat:${honchoMeta.sessionId}:${hashText(args.query).slice(0, 12)}`);
            const answer = String(dialectic?.response || '').trim();
            if (answer) return clampHonchoOutput(answer);

            // Fallback: compact semantic hits if dialectic is empty.
            const search = await honchoFetch('/search', {
                sessionId: honchoMeta.sessionId,
                query: args.query,
                limit: 6,
            }, 30000, `toolsearch:${honchoMeta.sessionId}:${hashText(args.query).slice(0, 12)}`);
            const hits = formatSemanticHits(search?.results || [], 6);
            return hits ? clampHonchoOutput(hits) : 'No information available in Honcho memory for that query.';
        },
        formatMessage: () => 'Querying Honcho memory...',
        shouldRegister,
        stealth: false,
    });

    context.registerFunctionTool({
        name: 'honcho_save_conclusion',
        displayName: 'Honcho: Save Conclusion',
        description: 'Save an important conclusion, insight, or fact about the user/character to persistent Honcho memory.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { content: { type: 'string', description: 'Conclusion to save.' } },
            required: ['content'],
        },
        action: async (args) => {
            if (!args?.content) return 'No content provided.';
            const honchoMeta = chat_metadata?.honcho;
            if (!honchoMeta?.userPeerId) return 'Honcho session not initialized for this chat.';
            const result = await honchoFetch('/conclusion', { peerId: honchoMeta.userPeerId, content: args.content });
            return result ? `Conclusion saved: ${args.content}` : 'Failed to save conclusion.';
        },
        formatMessage: () => 'Saving conclusion to memory...',
        shouldRegister,
        stealth: true,
    });

    context.registerFunctionTool({
        name: 'honcho_search_history',
        displayName: 'Honcho: Search History',
        description: 'Semantic search over stored conversation/memory in Honcho for this session. Prefer honcho_query_memory for open questions; use this for finding specific past details.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { query: { type: 'string', description: 'What to search in conversation/memory history.' } },
            required: ['query'],
        },
        action: async (args) => {
            if (!args?.query) return 'No query provided.';
            const honchoMeta = chat_metadata?.honcho;
            if (!honchoMeta?.sessionId) return 'Honcho session not initialized for this chat.';
            const result = await honchoFetch('/search', { sessionId: honchoMeta.sessionId, query: args.query, limit: 6 });
            const hits = formatSemanticHits(result?.results || [], 6);
            return hits ? clampHonchoOutput(hits) : 'No matching memory hits found.';
        },
        formatMessage: () => 'Searching Honcho history...',
        shouldRegister,
        stealth: false,
    });
}

function updateStatusIndicator() {
    const $status = $('#honcho_status');
    $('#honcho_api_key').attr('placeholder', hasHonchoApiKey() ? '✔️ Key saved locally' : 'Click to set key');
    if (isReady()) {
        $status.text('Ready').removeClass('not-ready').addClass('ready');
        return;
    }
    const reasons = [];
    if (!settings()?.enabled) reasons.push('disabled');
    if (!getHonchoBaseUrl()) reasons.push('no Honcho URL');
    if (!settings()?.workspaceId) reasons.push('no workspace ID');
    if (!hasHonchoApiKey()) reasons.push('no API key');
    $status.text(`Not ready: ${reasons.join(', ')}`).removeClass('ready').addClass('not-ready');
}

function updateConditionalSections() {
    $('#honcho_prefetch_section').toggle(settings()?.contextMode === 'reasoning');
    $('#honcho_depth_section').toggle(Number(settings()?.injectionPosition) === extension_prompt_types.IN_CHAT);
    $('#honcho_custom_session_section').toggle((settings()?.sessionNaming || 'auto') === 'custom');
}

function updateActiveSessionDisplay() {
    $('#honcho_active_session').val(chat_metadata?.honcho?.sessionId || '');
}

function syncFunctionCallingFlag() {
    if (settings()?.contextMode === 'tool_call') oai_settings.function_calling = true;
}

function loadSettingsUI() {
    const s = settings();
    if (s.contextMode === 'prefetch') {
        s.contextMode = 'reasoning';
        saveSettingsDebounced();
    }
    $('#honcho_enabled').prop('checked', !!s.enabled);
    $('#honcho_base_url').val(s.baseUrl || '');
    $('#honcho_workspace_id').val(s.workspaceId || '');
    $('#honcho_peer_name').val(s.peerName || '');
    $(`input[name="honcho_peer_mode"][value="${s.peerMode}"]`).prop('checked', true);
    $(`input[name="honcho_session_naming"][value="${s.sessionNaming || 'auto'}"]`).prop('checked', true);
    $('#honcho_custom_session').val(s.customSessionName || '');
    $(`input[name="honcho_context_mode"][value="${s.contextMode}"]`).prop('checked', true);
    syncFunctionCallingFlag();
    $('#honcho_prefetch_queries').val((s.prefetchQueries || []).join('\n'));
    $('#honcho_prefetch_interval').val(s.prefetchInterval || 8);
    $(`input[name="honcho_injection_position"][value="${s.injectionPosition}"]`).prop('checked', true);
    $('#honcho_injection_depth').val(s.injectionDepth);
    $('#honcho_prompt_template').val(s.promptTemplate);
    $('#honcho_context_tokens').val(s.contextTokens);
    $('#honcho_output_tokens').val(s.outputTokens || 500);
    $('#honcho_context_interval').val(s.contextInterval || 1);
    $('#honcho_context_summary').prop('checked', s.contextSummary);
    updateConditionalSections();
    updateStatusIndicator();
    updateActiveSessionDisplay();
}

async function runFunctionalValidation() {
    if (!getHonchoBaseUrl()) throw new Error('Honcho URL is required');
    if (!settings().workspaceId) throw new Error('Workspace ID is required');
    if (!hasHonchoApiKey()) throw new Error('Honcho API key is required');

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const peerId = sanitizeId(`st_validate_${suffix}`);
    const sessionId = sanitizeId(`st_validate_${suffix}`);

    await honchoRequest('GET', '/health');
    await honchoRequest('POST', '/v3/workspaces', { body: { id: settings().workspaceId } });
    await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(settings().workspaceId)}/peers`, { body: { id: peerId, configuration: { observe_me: true } } });
    await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(settings().workspaceId)}/sessions`, { body: { id: sessionId, peers: { [peerId]: { observe_me: true } } } });
    const stored = await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(settings().workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`, {
        body: { messages: [{ peer_id: peerId, content: 'SillyTavern Honcho functional validation.' }] },
    });
    const listed = await honchoRequest('POST', `/v3/workspaces/${encodeURIComponent(settings().workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages/list`, {
        body: {},
        query: { page: 1, size: 5, reverse: true },
    });

    return {
        ok: true,
        workspaceId: settings().workspaceId,
        peerId,
        sessionId,
        storedMessages: Array.isArray(stored) ? stored.length : 0,
        listedMessages: listed?.items?.length || 0,
    };
}

function bindSettingsListeners() {
    $('#honcho_enabled').on('change', function () {
        const wasEnabled = settings().enabled;
        const nowEnabled = $(this).prop('checked');
        settings().enabled = nowEnabled;
        saveSettingsDebounced();
        updateStatusIndicator();
        if (wasEnabled && !nowEnabled) {
            abortAllInFlight();
            resetCaches();
        } else if (!wasEnabled && nowEnabled) {
            onChatChanged();
        }
    });

    const saveBaseUrl = () => {
        const value = $('#honcho_base_url').val().trim().replace(/\/$/, '');
        settings().baseUrl = value;
        resetCaches();
        saveSettingsDebounced();
        updateStatusIndicator();
        $('#honcho_base_url_hint').text(value ? `Saved locally — URL: ${value}` : 'Honcho URL cleared.');
    };
    $('#honcho_base_url').on('input change', saveBaseUrl);

    $('#honcho_test_connection').on('click', async function () {
        saveBaseUrl();
        const $button = $(this);
        $button.prop('disabled', true).text('Testing...');
        try {
            const data = await runFunctionalValidation();
            $('#honcho_base_url_hint').text(`Functional Honcho OK — ${data.workspaceId}/${data.sessionId}`);
            toastr.success('Honcho functional roundtrip OK');
        } catch (err) {
            $('#honcho_base_url_hint').text(`Test failed: ${err.message}`);
            toastr.error(`Honcho test failed: ${err.message}`);
        } finally {
            $button.prop('disabled', false).text('Test');
            updateStatusIndicator();
        }
    });

    $('#honcho_workspace_id').on('input change', function () {
        settings().workspaceId = $(this).val().trim();
        resetCaches();
        saveSettingsDebounced();
        updateStatusIndicator();
        $('#honcho_workspace_id_hint').text(settings().workspaceId ? `Saved locally — workspace: ${settings().workspaceId}` : 'Workspace cleared.');
    });

    $('#honcho_peer_name').on('input change', function () {
        settings().peerName = $(this).val().trim();
        resetCaches();
        saveSettingsDebounced();
        $('#honcho_peer_name_hint').text(settings().peerName ? `Saved locally — peer: ${settings().peerName}` : 'Local peer name cleared.');
    });

    $('#honcho_reset_session').on('click', async function () {
        const oldId = chat_metadata?.honcho?.sessionId;
        if (!oldId) return;
        const confirmed = await callGenericPopup(
            `Start a new Honcho session for this chat? Existing Honcho session remains stored but this chat will link to a fresh session.\n\nOld session: ${oldId}`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Start new session', cancelButton: 'Cancel' },
        );
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        updateChatMetadata({ honcho: null });
        saveMetadataDebounced();
        resetCaches();
        await onChatChanged();
        updateActiveSessionDisplay();
    });

    $('input[name="honcho_peer_mode"]').on('change', function () {
        settings().peerMode = $(this).val();
        resetCaches();
        saveSettingsDebounced();
    });

    $('input[name="honcho_session_naming"]').on('change', function () {
        settings().sessionNaming = $(this).val();
        saveSettingsDebounced();
        updateConditionalSections();
    });

    $('#honcho_custom_session').on('input', function () {
        settings().customSessionName = $(this).val().trim();
        saveSettingsDebounced();
    });

    $('input[name="honcho_context_mode"]').on('change', function () {
        settings().contextMode = $(this).val();
        syncFunctionCallingFlag();
        resetCaches();
        saveSettingsDebounced();
        updateConditionalSections();
    });

    $('#honcho_prefetch_queries').on('input', function () {
        settings().prefetchQueries = $(this).val().split('\n').map(item => item.trim()).filter(Boolean);
        saveSettingsDebounced();
    });

    $('#honcho_prefetch_interval').on('input', function () {
        settings().prefetchInterval = Math.max(1, Number($(this).val()) || 8);
        saveSettingsDebounced();
    });

    $('input[name="honcho_injection_position"]').on('change', function () {
        settings().injectionPosition = Number($(this).val());
        saveSettingsDebounced();
        updateConditionalSections();
    });

    $('#honcho_injection_depth').on('input', function () {
        settings().injectionDepth = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#honcho_prompt_template').on('input', function () {
        settings().promptTemplate = $(this).val();
        saveSettingsDebounced();
    });

    $('#honcho_context_tokens').on('input', function () {
        settings().contextTokens = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#honcho_output_tokens').on('input', function () {
        settings().outputTokens = Math.max(50, Number($(this).val()) || 500);
        saveSettingsDebounced();
    });

    $('#honcho_context_interval').on('input', function () {
        settings().contextInterval = Math.max(1, Number($(this).val()) || 1);
        saveSettingsDebounced();
    });

    $('#honcho_context_summary').on('change', function () {
        settings().contextSummary = $(this).prop('checked');
        saveSettingsDebounced();
    });

    const openApiKeyDialog = async () => {
        const raw = await Popup.show.input('Honcho API Key', 'Paste your Honcho API key:', '', { okButton: 'Save', cancelButton: 'Cancel' });
        if (raw === null) return;
        settings().apiKey = raw.trim();
        saveSettingsDebounced();
        updateStatusIndicator();
        toastr.success(settings().apiKey ? 'Honcho API key saved locally' : 'Honcho API key cleared locally');
    };
    $('#honcho_api_key, #honcho_api_key_btn').on('click', openApiKeyDialog);
}

async function loadSettingsHtml() {
    const settingsUrl = new URL('./settings.html', import.meta.url);
    const response = await fetch(settingsUrl);
    if (!response.ok) {
        throw new Error(`Error loading ${settingsUrl.pathname}: ${response.status} ${response.statusText}`);
    }
    return response.text();
}

jQuery(async () => {
    if (!extension_settings.honcho) extension_settings.honcho = {};
    extension_settings.honcho = Object.assign({}, defaultSettings, extension_settings.honcho);

    const settingsHtml = await loadSettingsHtml();
    $('#extensions_settings2').append(settingsHtml);

    loadSettingsUI();
    bindSettingsListeners();
    registerHonchoTools();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGeneration);
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onCharResponse);

    console.log('[Honcho] Browser-only extension loaded');
});
