import { extension_settings } from '../../../extensions.js';
import {
    chat,
    generateRaw,
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    saveSettingsDebounced,
    chat_metadata,
    characters,
    this_chid,
} from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { getStringHash } from '../../../utils.js';

const extensionName = 'amor';
const VERSION = '1.3.2';

// ---------------- 维度常量 ----------------
const RHYTHMS = ['平缓', '日常', '暧昧', '紧张', '冲突', '高潮', '余波'];
const CAMERAS = ['近景', '中景', '远景', '人物特写', '环境描写', '动作描写'];
const FOCUS_KEYS = [
    { key: 'psy', label: '人物心理' },
    { key: 'env', label: '环境描写' },
    { key: 'dialog', label: '对白' },
    { key: 'action', label: '动作' },
];
const INITIATIVE_ROLES = [
    { key: 'user', label: '用户角色' },
    { key: 'ai', label: 'AI 角色' },
    { key: 'npc', label: 'NPC' },
];
const INIT_LEVELS = ['低', '中', '高'];

// ---------------- 状态 ----------------
function freshSettings() {
    return {
        enabled: false,
        rhythm: '',            // RHYTHMS 之一，空 = 不指定
        camera: '',            // CAMERAS 之一，空 = 不指定
        focus: { psy: 5, env: 3, dialog: 5, action: 5 },  // 0-10
        initiative: { user: '中', ai: '中', npc: '中' },   // 低/中/高
        pacing: 5,             // 0-10，0=慢 10=快
        custom: '',            // 自定义导演指令
        autoDirector: false,   // 自动导演模式（每轮生成后 AI 分析并调整旋钮）
        autoNote: '',          // AI 自动生成的导演指令
        lastAnalysisAt: 0,     // 上次自动分析时间戳
        autoRefresh: false,    // 定时自动刷新（开启自动导演时按间隔重新分析）
        autoRefreshSec: 60,    // 定时刷新间隔（秒）
        presets: [],           // [{ id, name, data }]
        planner: freshPlanner(),   // 剧情规划（场景 / 目标 / 冲突 / 节拍）
    };
}
function freshPlanner() {
    return {
        enabled: false,
        mode: 'assisted',      // assisted 自动规划并注入 | manual 只分析不注入
        everyN: 1,             // 每几轮规划一次
        tokenBudget: 2500,     // 向 Serendipity 索取事实的预算
        api: { url: '', key: '', model: '' },   // 规划专用模型，留空则用酒馆当前 API
        chats: {},             // 按「角色 + 聊天」分开存的规划状态
    };
}
let settings = freshSettings();

function loadSettings() {
    const s = extension_settings[extensionName];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
        extension_settings[extensionName] = freshSettings();
        settings = extension_settings[extensionName];
        return;
    }
    const def = freshSettings();
    s.focus = Object.assign({}, def.focus, (s.focus && typeof s.focus === 'object') ? s.focus : {});
    s.initiative = Object.assign({}, def.initiative, (s.initiative && typeof s.initiative === 'object') ? s.initiative : {});
    if (typeof s.enabled !== 'boolean') s.enabled = !!s.enabled;
    if (typeof s.rhythm !== 'string') s.rhythm = '';
    if (typeof s.camera !== 'string') s.camera = '';
    if (typeof s.custom !== 'string') s.custom = '';
    if (s.pacing == null) s.pacing = def.pacing;
    if (typeof s.autoDirector !== 'boolean') s.autoDirector = !!s.autoDirector;
    if (typeof s.autoNote !== 'string') s.autoNote = '';
    if (typeof s.lastAnalysisAt !== 'number') s.lastAnalysisAt = 0;
    if (typeof s.autoRefresh !== 'boolean') s.autoRefresh = !!s.autoRefresh;
    if (typeof s.autoRefreshSec !== 'number' || s.autoRefreshSec < 15) s.autoRefreshSec = 60;
    if (!Array.isArray(s.presets)) s.presets = [];
    const pdef = freshPlanner();
    const p = (s.planner && typeof s.planner === 'object' && !Array.isArray(s.planner)) ? s.planner : {};
    p.api = Object.assign({}, pdef.api, (p.api && typeof p.api === 'object') ? p.api : {});
    if (typeof p.enabled !== 'boolean') p.enabled = false;
    if (p.mode !== 'manual') p.mode = 'assisted';
    if (!Number.isFinite(p.everyN) || p.everyN < 1) p.everyN = pdef.everyN;
    if (!Number.isFinite(p.tokenBudget) || p.tokenBudget < 500) p.tokenBudget = pdef.tokenBudget;
    if (!p.chats || typeof p.chats !== 'object' || Array.isArray(p.chats)) p.chats = {};
    // 1.3.0 会给打开过的每个聊天建空档，这里清掉从未产生过内容的空条目
    const emptyState = JSON.stringify(freshPlanState());
    for (const k of Object.keys(p.chats)) {
        const c = p.chats[k];
        const ds = c && c.directorState ? JSON.stringify(Object.assign(freshPlanState(), c.directorState, { scene: Object.assign(freshPlanState().scene, c.directorState.scene || {}) })) : emptyState;
        const noRev = !c || !c.revision || !c.revision.amorRevision;
        if (!c || (noRev && !(c.snapshots && c.snapshots.length) && !(c.outcomes && c.outcomes.length) && ds === emptyState)) delete p.chats[k];
    }
    s.planner = p;
    settings = s;
}

function saveSettings() { saveSettingsDebounced(); }
function uid() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 导演指令生成 ----------------
function focusBar(v) {
    v = Math.max(0, Math.min(10, Math.round(v)));
    return '█'.repeat(v) + '░'.repeat(10 - v);
}
function pacingDesc(v) {
    v = Math.max(0, Math.min(10, Math.round(v)));
    if (v <= 2) return '非常缓慢（几乎不推进剧情，专注当下细节）';
    if (v <= 4) return '较慢（少量推进，重在氛围与铺垫）';
    if (v <= 6) return '适中（自然推进剧情）';
    if (v <= 8) return '较快（明显推进主线）';
    return '非常快（大幅推进、快速进入下一阶段）';
}
function buildDirectorPrompt() {
    if (!settings.enabled) return '';
    const lines = ['[Amor 导演指令]'];
    lines.push('以下是你本轮剧情创作必须严格遵守的导演指令，优先级高于角色设定与历史对话，请完全依照它来创作本段剧情，不要偏离。');
    if (settings.autoDirector && settings.autoNote && settings.autoNote.trim()) lines.push('· 导演特别指示：' + settings.autoNote.trim() + '。');
    if (settings.rhythm) lines.push('· 剧情节奏：' + settings.rhythm + '。');
    if (settings.camera) lines.push('· 镜头语言：' + settings.camera + '。');
    const f = settings.focus || {};
    lines.push('· 叙事重点（条越满越侧重）：人物心理 ' + focusBar(f.psy) + ' ／ 环境描写 ' + focusBar(f.env) + ' ／ 对白 ' + focusBar(f.dialog) + ' ／ 动作 ' + focusBar(f.action) + '。');
    const ini = settings.initiative || {};
    lines.push('· 角色主动性：用户角色 ' + (ini.user || '中') + '、AI 角色 ' + (ini.ai || '中') + '、NPC ' + (ini.npc || '中') + '。');
    lines.push('· 剧情推进速度：' + pacingDesc(settings.pacing != null ? settings.pacing : 5));
    if (settings.custom && settings.custom.trim()) lines.push('· 自定义导演指令：' + settings.custom.trim());
    return lines.join('\n');
}

function updatePromptInjection() {
    setExtensionPrompt(
        'amor_director',
        buildDirectorPrompt(),
        extension_prompt_types.BEFORE_PROMPT,
        0,
    );
}

// 所有后台模型调用（自动导演、剧情规划）排队执行，避免同一轮生成结束后两路请求同时发出
let llmChain = Promise.resolve();
function runExclusive(fn) {
    const p = llmChain.then(fn, fn);
    llmChain = p.catch(() => {});
    return p;
}

// ---------------- 自动导演（AI 分析剧情 → 生成并应用导演指令） ----------------
const DIRECTOR_PROMPT = `你是 Amor 导演台的剧情导演。根据下面给的剧情背景与最近剧情，判断下一段剧情该怎么导：节奏、镜头、叙事重点、角色主动性、推进速度，并写一句具体的导演指令。

可用节奏：${RHYTHMS.join('/')}
可用镜头：${CAMERAS.join('/')}
叙事重点（人物心理/环境描写/对白/动作，各 0-10，条越满越侧重）
角色主动性（用户角色/AI角色/NPC，各 低/中/高）
推进速度（0-10，0 极慢，10 极快）

{contextBlock}最近剧情：
{transcript}

严格按下面格式输出，每行一项，不要多余内容，不要用 markdown：
【节奏】<节奏词>
【镜头】<镜头词>
【心理】<0-10>
【环境】<0-10>
【对白】<0-10>
【动作】<0-10>
【用户主动性】<低/中/高>
【AI主动性】<低/中/高>
【NPC主动性】<低/中/高>
【速度】<0-10>
【指令】<一句具体导演指令，说明本段该怎么演，如：本轮不要推进主线，只深化两人的关系>`;

function buildTranscript() {
    if (!Array.isArray(chat)) return '';
    const recent = chat.filter(m => m && typeof m.mes === 'string' && m.mes.trim() && !m.is_system).slice(-12);
    return recent.map(m => (m.is_user ? '用户' : (m.name || '角色')) + '：' + m.mes).join('\n\n');
}

// 读取 Serendipity 的剧情上下文（已安装则给导演完整故事背景，否则为空 → 只用最近对话）
const LEGACY_CONTEXT_BUDGET = 2500;
function getStoryContext() {
    try {
        if (typeof window.Serendipity === 'object' && typeof window.Serendipity.getDirectorContext === 'function') {
            const r = window.Serendipity.getDirectorContext({ purpose: 'amor', tokenBudget: LEGACY_CONTEXT_BUDGET });
            const c = typeof r === 'string' ? r : (r && typeof r.text === 'string' ? r.text : '');
            if (c && c.trim()) return c.length > LEGACY_CONTEXT_BUDGET * 1.5 ? c.slice(0, Math.round(LEGACY_CONTEXT_BUDGET * 1.5)) + '…' : c;
        }
    } catch (e) {}
    return '';
}

function parseDirectorOutput(text) {
    text = text || '';
    const get = (label) => {
        const m = text.match(new RegExp('【' + label + '】\\s*([^\\n【]+)'));
        return m ? m[1].trim() : '';
    };
    const clamp = (v, lo, hi, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); };
    const pick = (v, list) => (list.includes(v) ? v : '');
    const init = (v) => (['低', '中', '高'].includes(v) ? v : '中');
    return {
        rhythm: pick(get('节奏'), RHYTHMS),
        camera: pick(get('镜头'), CAMERAS),
        focus: {
            psy: clamp(get('心理'), 0, 10, 5),
            env: clamp(get('环境'), 0, 10, 3),
            dialog: clamp(get('对白'), 0, 10, 5),
            action: clamp(get('动作'), 0, 10, 5),
        },
        initiative: {
            user: init(get('用户主动性')),
            ai: init(get('AI主动性')),
            npc: init(get('NPC主动性')),
        },
        pacing: clamp(get('速度'), 0, 10, 5),
        note: get('指令'),
    };
}

let isAutoDirecting = false;
async function autoDirect() {
    if (!settings.autoDirector || isAutoDirecting) return;
    const transcript = buildTranscript();
    if (!transcript) return;
    isAutoDirecting = true;
    if ($('#st-amor').is(':visible')) {
        $('#st-amor .amor__auto-note').show().find('.amor__auto-note-body').text('导演分析中…');
    }
    try {
        const ctx = getStoryContext();
        const contextBlock = ctx ? '剧情背景（整个故事的当前状态，导戏时注意与它保持一致）：\n' + ctx + '\n\n' : '';
        const prompt = DIRECTOR_PROMPT.replace('{contextBlock}', contextBlock).replace('{transcript}', transcript);
        const result = await runExclusive(() => generateRaw({ prompt, systemPrompt: '你是一位专业的剧情导演，只负责决定下一段剧情怎么导。' }));
        const d = parseDirectorOutput(result);
        settings.rhythm = d.rhythm;
        settings.camera = d.camera;
        settings.focus = d.focus;
        settings.initiative = d.initiative;
        settings.pacing = d.pacing;
        settings.autoNote = d.note;
        settings.lastAnalysisAt = Date.now();
        saveSettings();
        updatePromptInjection();
        if ($('#st-amor').is(':visible')) renderPanel();
    } catch (e) {
        console.warn('[Amor] 自动导演分析失败：', e);
    } finally {
        isAutoDirecting = false;
    }
}

let autoRefreshTimer = null;
function syncAutoRefreshTimer() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    if (settings.autoDirector && settings.autoRefresh) {
        const sec = Math.max(15, Math.min(600, settings.autoRefreshSec || 60));
        autoRefreshTimer = setInterval(() => autoDirect(), sec * 1000);
    }
}

// ---------------- 剧情规划（场景 / 目标 / 冲突 / 节拍，评估实际结果后重规划） ----------------
// 与上面的「导演台旋钮」互不干扰：旋钮管「怎么写」（节奏/镜头/重点），规划管「写什么」（这一幕要发生什么变化）。
const PLAN_DELAY_MS = 1500;      // 生成结束后稍等再规划，避开与自动导演同一时刻发请求
const PLAN_TIMEOUT_MS = 120000;
const PLAN_INJECT_DEPTH = 1;     // 0 = 最末尾，1 = 倒数第二条之前
const MAX_SNAPSHOTS = 20;        // 每轮规划留一份快照，用于删除/重生成/Swipe 时回滚（存在酒馆设置里，别留太多）
const MAX_OUTCOMES = 30;
const TRANSCRIPT_MESSAGES = 6;   // 喂给规划的最近消息条数
const TRANSCRIPT_CHARS = 1200;   // 单条消息截断长度

const PLAN_FIELDS = [
    { path: 'scene.situation', label: '当前场景', rows: 2 },
    { path: 'scene.location', label: '地点', rows: 1 },
    { path: 'scene.participants', label: '在场人物', rows: 1 },
    { path: 'scene.objective', label: '场景目标', rows: 2 },
    { path: 'scene.conflict', label: '当前冲突', rows: 2 },
    { path: 'currentBeat', label: '当前节拍', rows: 2 },
    { path: 'emotionalDirection', label: '情绪方向', rows: 1 },
    { path: 'doNot', label: '本轮避免（每行一条）', rows: 3, list: true },
];

const clone = (v) => JSON.parse(JSON.stringify(v));
const cleanStr = (v, max) => {
    const t = (typeof v === 'string' ? v : (v == null ? '' : String(v))).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) : t;
};

let plannerBusy = false;
let planTimer = null;

function freshPlanState() {
    return {
        scene: { location: '', participants: '', situation: '', objective: '', conflict: '', emotionalTone: '' },
        currentBeat: '',
        emotionalDirection: '',
        tension: 50,
        doNot: [],
        stagnantRounds: 0,
        lastDecision: '',
    };
}

function freshPlanChat() {
    return {
        schemaVersion: 1,
        revision: { amorRevision: 0, lastProcessedMessageIndex: -1 },
        lastSeenKey: '',
        roundsSincePlan: 0,
        directorState: freshPlanState(),
        snapshots: [],
        outcomes: [],
        meta: { createdAt: Date.now(), updatedAt: Date.now() },
    };
}

function normalizePlanChat(cd) {
    const f = freshPlanChat();
    cd.revision = Object.assign(f.revision, cd.revision || {});
    cd.directorState = Object.assign(freshPlanState(), cd.directorState || {});
    cd.directorState.scene = Object.assign(freshPlanState().scene, cd.directorState.scene || {});
    if (!Array.isArray(cd.directorState.doNot)) cd.directorState.doNot = [];
    if (!Array.isArray(cd.snapshots)) cd.snapshots = [];
    if (!Array.isArray(cd.outcomes)) cd.outcomes = [];
    if (typeof cd.lastSeenKey !== 'string') cd.lastSeenKey = '';
    if (typeof cd.roundsSincePlan !== 'number') cd.roundsSincePlan = 0;
    cd.meta = Object.assign(f.meta, cd.meta || {});
    return cd;
}

// 数据按「角色 + 聊天」存，同一角色的不同聊天互不串扰（键的规则与 Serendipity 保持一致）
function currentChatKey() {
    const c = (this_chid !== undefined && Array.isArray(characters) && characters[this_chid]) ? characters[this_chid] : null;
    let ck = '';
    let cid = '';
    if (c) {
        if (c.avatar && c.avatar !== 'none') ck = 'avatar::' + c.avatar;
        else if (c.name) ck = 'name::' + c.name;
        if (typeof c.chat === 'string' && c.chat) cid = 'chat::' + c.chat;
    } else if (selected_group) {
        ck = 'group::' + selected_group;
    }
    if (!cid) {
        const cm = (typeof chat_metadata === 'object' && chat_metadata) ? chat_metadata : null;
        if (cm && cm.integrity) cid = 'integrity::' + cm.integrity;
    }
    return (ck && cid) ? (ck + '::' + cid) : '';
}

// 只读：取不到聊天标识或该聊天还没有规划数据时返回 null，不往设置里写任何东西
function plannerChatData() {
    const key = currentChatKey();
    if (!key || !settings || !settings.planner) return null;
    const cd = settings.planner.chats[key];
    return cd ? normalizePlanChat(cd) : null;
}

// 只在真正要写入规划（开启后规划 / 手动改字段）时才建档
function plannerEnsureChat() {
    const key = currentChatKey();
    if (!key || !settings || !settings.planner) return null;
    const chats = settings.planner.chats;
    if (!chats[key]) chats[key] = freshPlanChat();
    return normalizePlanChat(chats[key]);
}

// ---- 聊天文本 ----
function cleanText(t) {
    return String(t == null ? '' : t)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+\n/g, '\n')
        .trim();
}
function isRealMessage(m) {
    return !!m && !m.is_system && typeof m.mes === 'string' && m.mes.trim() !== '';
}
function lastRealIndex() {
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i--) if (isRealMessage(chat[i])) return i;
    return -1;
}
function msgHash(m) { return String(getStringHash(String(m && m.mes || ''))); }
function buildPlanTranscript(lastIdx) {
    const rows = [];
    for (let i = lastIdx; i >= 0 && rows.length < TRANSCRIPT_MESSAGES; i--) {
        const m = chat[i];
        if (!isRealMessage(m)) continue;
        let t = cleanText(m.mes);
        if (t.length > TRANSCRIPT_CHARS) t = t.slice(0, TRANSCRIPT_CHARS) + '…';
        rows.unshift((m.name || (m.is_user ? '用户' : '角色')) + (m.is_user ? '（玩家角色）' : '') + '：' + t);
    }
    return rows.join('\n\n');
}

// ---- Serendipity 事实（需要 Serendipity ≥ 2.3.6 才支持预算/分段，旧版返回整段文本也能用） ----
function serendipityConnected() {
    return typeof window.Serendipity === 'object' && typeof window.Serendipity.getDirectorContext === 'function';
}
function getPlannerFacts() {
    if (!serendipityConnected()) return '';
    try {
        const budget = settings.planner.tokenBudget;
        const r = window.Serendipity.getDirectorContext({
            purpose: 'amor',
            tokenBudget: budget,
            include: ['storyTime', 'timeline', 'recentMemory', 'characters', 'relationships', 'worldState', 'foreshadows'],
        });
        let text = '';
        if (typeof r === 'string') text = r;
        else if (r && typeof r.text === 'string') text = r.text;
        const cap = Math.round(budget * 1.5);
        return text.length > cap ? text.slice(0, cap) + '…' : text;
    } catch (e) {
        console.warn('[Amor] 读取 Serendipity 事实失败，改用聊天上下文：', e);
        return '';
    }
}

// ---- 模型调用（规划专用 API 优先，未设置/失败则用酒馆默认） ----
function plannerApiConfigured() {
    const c = settings.planner.api || {};
    return !!(c.url && c.model);
}
function plannerEndpoint(url) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(url)) return url;
    return url + '/chat/completions';
}
function safeErrorText(e, key, max = 120) {
    let t = String((e && e.message) ? e.message : e);
    const k = String(key || '').trim();
    if (k.length >= 6) t = t.split(k).join('***');
    t = t.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, 'Bearer ***')
        .replace(/\b(sk|rk|pk|ak|key)-[A-Za-z0-9_*-]{6,}/gi, '$1-***')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
}
function withTimeout(p, ms) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('请求超时（' + Math.round(ms / 1000) + ' 秒）')), ms); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
async function callPlannerApi({ prompt, systemPrompt }) {
    const c = settings.planner.api;
    const headers = { 'Content-Type': 'application/json' };
    if (c.key) headers.Authorization = 'Bearer ' + c.key.trim();
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PLAN_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(plannerEndpoint(c.url), {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: c.model.trim(), messages, stream: false }),
            signal: ctrl.signal,
        });
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('请求超时（' + Math.round(PLAN_TIMEOUT_MS / 1000) + ' 秒）');
        throw new Error(safeErrorText(e, c.key) || '网络请求失败');
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        const detail = safeErrorText(t, c.key);
        throw new Error('HTTP ' + res.status + (detail ? ' ' + detail : ''));
    }
    const d = await res.json();
    const out = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!out) throw new Error('返回内容为空');
    return out;
}
async function callPlannerLLM({ prompt, systemPrompt }) {
    if (plannerApiConfigured()) {
        try {
            return await callPlannerApi({ prompt, systemPrompt });
        } catch (e) {
            const detail = safeErrorText(e, settings.planner.api.key);
            console.warn('[Amor] 规划专用 API 调用失败，改用酒馆默认 API：', detail);
            toastr.warning('Amor 规划专用 API 调用失败（' + detail + '），已改用酒馆默认 API');
        }
    }
    return withTimeout(Promise.resolve(generateRaw({ prompt, systemPrompt })), PLAN_TIMEOUT_MS + 60000);
}

// ---- 规划 ----
const PLANNER_SYSTEM = `你是一名角色扮演故事的「剧情规划师」。你不写正文，只负责判断剧情现在走到了哪里，并决定下一步应该发生什么。

工作规则：
1. 已知事实（来自 Serendipity）和聊天里实际发生的内容是事实；你自己的推测和上一轮的计划都不是事实。实际发生的剧情永远优先于上一轮计划。
2. 先评估：对照「上一轮规划状态」里的当前节拍，看最近剧情里它有没有真的发生，用一句话写出实际发生的具体变化（outcome）。
3. 再规划：给出场景目标、冲突，以及下一个节拍（nextBeat）。节拍必须是「一个具体的变化」，且至少改变以下之一：信息、人物关系、人物目标、情绪、资源、风险、场景状态。不能写「让剧情继续」「推进感情」这类空话。
4. 防空转：如果最近几轮只是聊天/吃饭/散步，没有任何变化，把 stagnation 设为 true，并让 nextBeat 引入外部事件、让 NPC 主动行动，或推进某条未完成的线索。
5. 尊重玩家角色（标注「玩家角色」的人）的自主权：只能制造压力、提供机会、改变环境、让 NPC 行动、提供选择，不能替玩家角色做重大决定（杀人、告白、背叛、接受任务、离开等）。
6. 自然事件优先于强制剧情；不要直接揭示真相或一次性抖出所有伏笔。
7. 尊重人物已有的性格、关系和知识范围，不让人物说出自己不可能知道的信息。

只输出一个 JSON 对象，不要任何解释，不要代码块。格式：
{
  "outcome": "上一轮实际发生的具体变化，一句话；没有变化就写空字符串",
  "beatCompleted": true,
  "scene": {
    "location": "当前地点",
    "participants": "在场人物，逗号分隔",
    "situation": "这一幕正在发生什么，一两句话",
    "objective": "这一幕应该达成的目标（对剧情的作用，不是结果）",
    "conflict": "当前的主要冲突或阻力",
    "emotionalTone": "当前情绪基调"
  },
  "nextBeat": "下一个节拍：一个具体的变化",
  "emotionalDirection": "情绪走向，如：克制 → 怀疑",
  "tension": 50,
  "doNot": ["本轮不要做的事，如：直接揭示真相"],
  "stagnation": false,
  "reason": "一句话说明你为什么这样安排"
}
tension 为 0 到 100 的整数；doNot 最多 4 条。`;

function planStateForPrompt(s) {
    return JSON.stringify({
        scene: s.scene,
        currentBeat: s.currentBeat,
        emotionalDirection: s.emotionalDirection,
        tension: s.tension,
        doNot: s.doNot,
    }, null, 1);
}

function buildPlanPrompt(cd, lastIdx) {
    const facts = getPlannerFacts();
    const s = cd.directorState;
    const hasState = !!(s.currentBeat || s.scene.objective || s.scene.situation);
    const recent = cd.outcomes.slice(-5).map(o => '- ' + o.text).join('\n');
    return [
        '【已知事实（来自 Serendipity）】\n' + (facts || '（没有可用的 Serendipity 事实，请只依据最近剧情）'),
        '【上一轮规划状态】\n' + (hasState ? planStateForPrompt(s) : '（尚无规划状态，这是第一次规划）'),
        recent ? '【最近几轮的实际结果记录】\n' + recent : '',
        '【最近剧情】\n' + buildPlanTranscript(lastIdx),
        '请按规则输出 JSON。',
    ].filter(Boolean).join('\n\n');
}

function parsePlanJson(text) {
    let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('规划返回的不是 JSON');
    return JSON.parse(t.slice(a, b + 1));
}

function applyPlan(cd, plan, msgIndex) {
    const s = cd.directorState;
    const outcome = cleanStr(plan.outcome, 200);
    if (outcome) {
        cd.outcomes.push({ msgIndex, text: outcome, beatCompleted: plan.beatCompleted !== false });
        if (cd.outcomes.length > MAX_OUTCOMES) cd.outcomes.splice(0, cd.outcomes.length - MAX_OUTCOMES);
    }
    const sc = (plan.scene && typeof plan.scene === 'object') ? plan.scene : {};
    for (const k of Object.keys(s.scene)) {
        const v = cleanStr(sc[k], 200);
        if (v) s.scene[k] = v;
    }
    const beat = cleanStr(plan.nextBeat, 200);
    if (beat) s.currentBeat = beat;
    const emo = cleanStr(plan.emotionalDirection, 80);
    if (emo) s.emotionalDirection = emo;
    const tension = Number(plan.tension);
    if (Number.isFinite(tension)) s.tension = Math.max(0, Math.min(100, Math.round(tension)));
    if (Array.isArray(plan.doNot)) s.doNot = plan.doNot.map(x => cleanStr(x, 80)).filter(Boolean).slice(0, 4);
    s.stagnantRounds = plan.stagnation === true ? (s.stagnantRounds || 0) + 1 : 0;
    s.lastDecision = cleanStr(plan.reason, 200);
    cd.revision.amorRevision += 1;
    cd.revision.lastProcessedMessageIndex = msgIndex;
    cd.roundsSincePlan = 0;
    cd.meta.updatedAt = Date.now();
}

function pushPlanSnapshot(cd, msgIndex) {
    const m = chat[msgIndex];
    if (!m) return;
    cd.snapshots = cd.snapshots.filter(sn => sn.msgIndex !== msgIndex);
    cd.snapshots.push({ msgIndex, hash: msgHash(m), state: clone(cd.directorState) });
    if (cd.snapshots.length > MAX_SNAPSHOTS) cd.snapshots.splice(0, cd.snapshots.length - MAX_SNAPSHOTS);
}

async function runPlanner({ manual = false } = {}) {
    if (!settings.planner.enabled) { if (manual) toastr.warning('请先开启「剧情规划」'); return; }
    if (plannerBusy) return;
    if (!currentChatKey()) { if (manual) toastr.warning('请先打开一个聊天'); return; }
    const lastIdx = lastRealIndex();
    if (lastIdx < 0) { if (manual) toastr.warning('当前聊天还没有剧情可供规划'); return; }
    const cd = plannerEnsureChat();
    const hash0 = msgHash(chat[lastIdx]);
    plannerBusy = true;
    setPlannerStatus('规划中…');
    try {
        const planPrompt = buildPlanPrompt(cd, lastIdx);
        const raw = await runExclusive(() => callPlannerLLM({ systemPrompt: PLANNER_SYSTEM, prompt: planPrompt }));
        // 等待期间聊天可能已被删除/重新生成/重置：以返回时的聊天为准，对不上就丢弃这次规划
        const m = chat[lastIdx];
        if (!m || msgHash(m) !== hash0 || plannerChatData() !== cd) { setPlannerStatus(''); return; }
        applyPlan(cd, parsePlanJson(raw), lastIdx);
        pushPlanSnapshot(cd, lastIdx);
        saveSettings();
        updatePlannerInjection();
        renderPlanner();
        setPlannerStatus('');
        if (manual) toastr.success('Amor 已重新规划');
    } catch (e) {
        // 规划失败不影响正文生成：沿用上一份规划状态
        const detail = safeErrorText(e, settings.planner.api.key);
        console.warn('[Amor] 规划失败：', e);
        setPlannerStatus('规划失败：' + detail);
        if (manual) toastr.error('Amor 规划失败：' + detail);
    } finally {
        plannerBusy = false;
    }
}

// 生成结束后：有新消息才算一轮，按频率触发规划
function onPlannerGenerationEnded() {
    if (!settings.planner.enabled || settings.planner.mode !== 'assisted') return;
    if (!currentChatKey()) return;
    plannerReconcile();
    const idx = lastRealIndex();
    if (idx < 0) return;
    const cd = plannerEnsureChat();
    const m = chat[idx];
    if (m.is_user) return;
    const seen = idx + ':' + msgHash(m);
    if (seen === cd.lastSeenKey) return;
    cd.lastSeenKey = seen;
    cd.roundsSincePlan += 1;
    if (cd.roundsSincePlan < (settings.planner.everyN || 1)) { saveSettings(); return; }
    clearTimeout(planTimer);
    planTimer = setTimeout(() => runPlanner(), PLAN_DELAY_MS);
}

// ---- 回滚（删除消息 / 重新生成 / Swipe / 编辑历史） ----
function plannerReconcile() {
    const cd = plannerChatData();
    if (!cd) return false;
    const valid = [];
    for (const sn of cd.snapshots) {
        const m = chat[sn.msgIndex];
        if (m && msgHash(m) === sn.hash) valid.push(sn);
        else break;
    }
    if (valid.length === cd.snapshots.length) return false;
    const last = valid[valid.length - 1];
    cd.snapshots = valid;
    cd.directorState = last ? clone(last.state) : freshPlanState();
    cd.revision.lastProcessedMessageIndex = last ? last.msgIndex : -1;
    cd.outcomes = cd.outcomes.filter(o => o.msgIndex <= cd.revision.lastProcessedMessageIndex);
    cd.lastSeenKey = '';
    cd.revision.amorRevision += 1;
    saveSettings();
    updatePlannerInjection();
    renderPlanner();
    return true;
}

// ---- 注入 ----
function buildPlanBlock(s) {
    if (!s.currentBeat && !s.scene.objective) return '';
    const sc = s.scene;
    const lines = [];
    if (sc.situation) lines.push('当前场景：' + sc.situation);
    if (sc.location) lines.push('地点：' + sc.location);
    if (sc.participants) lines.push('在场人物：' + sc.participants);
    if (sc.objective) lines.push('场景目标：' + sc.objective);
    if (sc.conflict) lines.push('当前冲突：' + sc.conflict);
    if (s.currentBeat) lines.push('本轮应推进的节拍：' + s.currentBeat);
    if (s.emotionalDirection || sc.emotionalTone) lines.push('情绪方向：' + (s.emotionalDirection || sc.emotionalTone));
    if (s.stagnantRounds >= 1) lines.push('剧情近期有空转迹象，请让这一轮产生明确的变化。');
    if (s.doNot.length) lines.push('本轮避免：' + s.doNot.join('；'));
    return '[Amor 剧情规划]\n' +
        '以下是对接下来剧情走向的建议，不是既成事实；已发生的剧情和已有设定始终优先。请把它自然地融入叙事，不要生硬点明，也不要一口气写完整个节拍。\n\n' +
        lines.join('\n') + '\n\n' +
        '玩家自主权：不得替 {{user}} 做重大决定（杀人、告白、背叛、接受任务、离开等）。可以制造压力、提供机会、改变环境、让其他人物行动，把选择留给 {{user}}。';
}

function updatePlannerInjection() {
    let text = '';
    try {
        const cd = plannerChatData();
        if (settings.planner.enabled && settings.planner.mode === 'assisted' && cd) text = buildPlanBlock(cd.directorState);
    } catch (e) {
        console.warn('[Amor] 构建规划注入失败：', e);
    }
    // 放在聊天记录靠近末尾处（深度 1），比放进系统提示词区域更能影响下一条回复
    setExtensionPrompt('amor_story', text, extension_prompt_types.IN_CHAT, PLAN_INJECT_DEPTH);
}

// ---- 对外接口 ----
window.Amor = window.Amor || {};
window.Amor.getStoryDirection = function (opts) {
    if (!currentChatKey()) return null;
    const cd = plannerChatData() || freshPlanChat();
    const s = cd.directorState;
    const all = {
        currentScene: clone(s.scene),
        currentBeat: s.currentBeat,
        directorState: clone(s),
        activeGoals: s.scene.objective ? [s.scene.objective] : [],
    };
    const include = opts && Array.isArray(opts.include) ? opts.include : null;
    const out = { revision: clone(cd.revision) };
    for (const k of Object.keys(all)) if (!include || include.includes(k)) out[k] = all[k];
    return out;
};

// ---- 规划页 ----
function getPath(s, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), s);
}
function setPath(s, path, v) {
    const ks = path.split('.');
    const last = ks.pop();
    const o = ks.reduce((x, k) => x[k], s);
    o[last] = v;
}

function plannerPageHtml() {
    const fieldsHtml = PLAN_FIELDS.map(f => `
          <div class="amor__p-field">
            <div class="amor__p-field-label">${f.label}</div>
            <textarea class="amor__p-text amor__p-input" data-path="${f.path}" rows="${f.rows}" spellcheck="false"></textarea>
          </div>`).join('');
    return `
      <div class="amor__body amor__pbody" data-page="planner" style="display:none">
        <div class="amor__master">
          <label class="amor__switch"><input type="checkbox" class="amor__p-enabled"><span class="amor__switch-slider"></span></label>
          <span class="amor__master-label">剧情规划</span>
          <span class="amor__master-sep"></span>
          <select class="amor__p-mode">
            <option value="assisted">辅助：自动规划并注入</option>
            <option value="manual">手动：只分析，不注入</option>
          </select>
        </div>
        <div class="amor__auto-ctl">
          <div class="amor__auto-ctl-row">
            <button type="button" class="amor__direct-now amor__p-plan">立即规划</button>
            <button type="button" class="amor__p-reset">重置本聊天规划</button>
          </div>
          <div class="amor__auto-ctl-row">
            <span class="amor__link-status amor__p-link"></span>
            <span class="amor__p-status"></span>
          </div>
        </div>

        <div class="amor__section">
          <div class="amor__label">当前规划（可直接修改，改完立即生效）</div>
          <div class="amor__p-tension">
            <span>张力</span>
            <div class="amor__p-bar"><i></i></div>
            <b class="amor__p-tension-val">50</b>
          </div>
          <div class="amor__p-warn" style="display:none"></div>
          ${fieldsHtml}
          <div class="amor__pacing-hint amor__p-decision"></div>
        </div>

        <div class="amor__section">
          <div class="amor__label">实际结果记录</div>
          <ul class="amor__p-outcomes"></ul>
        </div>

        <div class="amor__section">
          <div class="amor__label">规划设置</div>
          <div class="amor__p-field">
            <div class="amor__p-field-label">每几轮规划一次</div>
            <input type="number" class="amor__p-set" data-set="everyN" min="1" max="20">
          </div>
          <div class="amor__p-field">
            <div class="amor__p-field-label">向 Serendipity 索取事实的 token 预算</div>
            <input type="number" class="amor__p-set" data-set="tokenBudget" min="500" max="8000" step="100">
          </div>
          <div class="amor__p-field-label amor__p-sub">规划专用模型（留空则用酒馆当前 API）</div>
          <div class="amor__p-field"><div class="amor__p-field-label">API 地址（OpenAI 兼容）</div><input type="text" class="amor__p-api" data-api="url" placeholder="https://.../v1" autocomplete="off"></div>
          <div class="amor__p-field"><div class="amor__p-field-label">API Key</div><input type="password" class="amor__p-api" data-api="key" autocomplete="off"></div>
          <div class="amor__p-field"><div class="amor__p-field-label">模型名</div><input type="text" class="amor__p-api" data-api="model" autocomplete="off"></div>
        </div>

        <div class="amor__hint">剧情规划和「导演台」是两件事：导演台调的是「怎么写」（节奏 / 镜头 / 重点），规划决定的是「写什么」——这一幕的目标、冲突和下一个要发生的具体变化。每轮回复结束后，规划会先评估上一个节拍实际发生了什么，再重新规划，并把建议注入下一轮。规划只是建议，不会写入 Serendipity 的事实；删除消息、重新生成、Swipe 时会自动回滚。</div>
      </div>`;
}

function bindPlannerEvents() {
    const panel = $('#st-amor');

    panel.on('click', '.amor__tab', function () {
        const tab = $(this).data('tab');
        panel.find('.amor__tab').removeClass('on').filter(this).addClass('on');
        panel.find('[data-page]').hide().filter(`[data-page="${tab}"]`).show();
        if (tab === 'planner') renderPlanner();
    });

    panel.on('change', '.amor__p-enabled', function () {
        settings.planner.enabled = this.checked;
        saveSettings();
        updatePlannerInjection();
    });
    panel.on('change', '.amor__p-mode', function () {
        settings.planner.mode = $(this).val() === 'manual' ? 'manual' : 'assisted';
        saveSettings();
        updatePlannerInjection();
    });
    panel.on('click', '.amor__p-plan', () => runPlanner({ manual: true }));
    panel.on('click', '.amor__p-reset', () => {
        if (!confirm('重置后，本聊天的规划状态和结果记录会清空（Serendipity 的数据不受影响）。继续吗？')) return;
        const key = currentChatKey();
        if (!key) return;
        delete settings.planner.chats[key];
        saveSettings();
        updatePlannerInjection();
        renderPlanner();
    });
    // 手动改字段：写入当前状态，并同步到最新快照，避免之后回滚时把手改的内容冲掉
    panel.on('change', '.amor__p-input', function () {
        const cd = plannerEnsureChat();
        if (!cd) return;
        const path = $(this).data('path');
        const f = PLAN_FIELDS.find(x => x.path === path);
        const raw = $(this).val();
        const v = f.list ? String(raw).split('\n').map(x => cleanStr(x, 80)).filter(Boolean).slice(0, 4) : cleanStr(raw, 200);
        setPath(cd.directorState, path, v);
        const last = cd.snapshots[cd.snapshots.length - 1];
        if (last) setPath(last.state, path, clone(v));
        cd.meta.updatedAt = Date.now();
        saveSettings();
        updatePlannerInjection();
    });
    panel.on('change', '.amor__p-set', function () {
        const k = $(this).data('set');
        const n = parseInt($(this).val(), 10);
        const def = freshPlanner()[k];
        let v = Number.isFinite(n) ? n : def;
        if (k === 'everyN') v = Math.max(1, Math.min(20, v));
        if (k === 'tokenBudget') v = Math.max(500, Math.min(8000, v));
        settings.planner[k] = v;
        $(this).val(v);
        saveSettings();
    });
    panel.on('change', '.amor__p-api', function () {
        settings.planner.api[$(this).data('api')] = String($(this).val()).trim();
        saveSettings();
    });
}

function setPlannerStatus(text) {
    $('#st-amor .amor__p-status').text(text || '');
}

function renderPlanner() {
    const panel = $('#st-amor');
    if (!panel.length || !settings.planner) return;
    const p = settings.planner;
    panel.find('.amor__p-enabled').prop('checked', p.enabled);
    panel.find('.amor__p-mode').val(p.mode);
    panel.find('.amor__p-set').each(function () { $(this).val(p[$(this).data('set')]); });
    panel.find('.amor__p-api').each(function () { $(this).val(p.api[$(this).data('api')] || ''); });
    panel.find('.amor__p-link')
        .text(serendipityConnected() ? '已接入 Serendipity 剧情事实' : '未检测到 Serendipity（仅用最近对话）');

    const cd = currentChatKey() ? (plannerChatData() || freshPlanChat()) : null;
    if (!cd) {
        panel.find('.amor__p-input').val('').prop('disabled', true);
        panel.find('.amor__p-outcomes').empty();
        panel.find('.amor__p-decision').text('请先打开一个聊天。');
        return;
    }
    const s = cd.directorState;
    panel.find('.amor__p-input').prop('disabled', false).each(function () {
        const v = getPath(s, $(this).data('path'));
        $(this).val(Array.isArray(v) ? v.join('\n') : (v || ''));
    });
    panel.find('.amor__p-bar i').css('width', s.tension + '%');
    panel.find('.amor__p-tension-val').text(s.tension);
    const warn = panel.find('.amor__p-warn');
    if (s.stagnantRounds >= 1) warn.text('剧情近期有空转迹象（连续 ' + s.stagnantRounds + ' 轮），下一个节拍会尝试引入变化。').show();
    else warn.hide();
    panel.find('.amor__p-decision').text(s.lastDecision ? '规划思路：' + s.lastDecision : '');
    const ul = panel.find('.amor__p-outcomes').empty();
    const outs = cd.outcomes.slice(-8).reverse();
    if (!outs.length) ul.append($('<li class="is-empty">').text('还没有记录。规划几轮后，这里会列出每轮实际发生的变化。'));
    for (const o of outs) ul.append($('<li>').text(o.text));
}

// ---------------- 面板 ----------------
function buildMenuButton() {
    if ($('#st-amor-menu-button').length) return;
    const btn = $(`
        <div id="st-amor-menu-button" class="list-group-item flex-container flexGap5 interactable"
             title="Amor：AI 剧情导演台" tabindex="0" role="listitem">
            <div class="fa-fw fa-solid fa-clapperboard extensionsMenuExtensionButton"></div>
            <span>Amor</span>
        </div>`);
    btn.on('click', () => togglePanel());
    $('#extensionsMenu').append(btn);
}

function togglePanel(show) {
    const panel = $('#st-amor');
    if (show == null) show = !panel.is(':visible');
    if (show) { renderPanel(); panel.show(); } else { panel.hide(); }
    document.body.classList.toggle('amor-open', show);
}

function buildPanel() {
    if ($('#st-amor').length) return;
    const html = `
    <div id="st-amor" class="amor__panel" style="display:none">
      <div class="amor__head">
        <div class="amor__head-titles">
          <span class="amor__title">Amor</span>
          <span class="amor__version">v${VERSION}</span>
        </div>
        <button type="button" class="amor__close" title="关闭">×</button>
      </div>
      <div class="amor__tabs">
        <button type="button" class="amor__tab on" data-tab="director">导演台</button>
        <button type="button" class="amor__tab" data-tab="planner">剧情规划</button>
      </div>
      <div class="amor__body" data-page="director">
        <div class="amor__master">
          <label class="amor__switch"><input type="checkbox" class="amor__enabled"><span class="amor__switch-slider"></span></label>
          <span class="amor__master-label">导演模式</span>
          <span class="amor__master-sep"></span>
          <label class="amor__switch"><input type="checkbox" class="amor__auto"><span class="amor__switch-slider"></span></label>
          <span class="amor__master-label">自动导演</span>
        </div>
        <div class="amor__auto-note" style="display:none">
          <div class="amor__auto-note-head">AI 导演指令</div>
          <div class="amor__auto-note-body"></div>
        </div>
        <div class="amor__auto-ctl">
          <div class="amor__auto-ctl-row">
            <button type="button" class="amor__direct-now">立即导演</button>
            <span class="amor__link-status"></span>
          </div>
          <div class="amor__auto-ctl-row">
            <label class="amor__switch amor__switch--sm"><input type="checkbox" class="amor__auto-refresh"><span class="amor__switch-slider"></span></label>
            <span class="amor__auto-ctl-label">定时自动刷新</span>
            <input type="number" class="amor__auto-refresh-sec" min="15" max="600" step="5">
            <span class="amor__auto-ctl-label">秒</span>
          </div>
        </div>

        <div class="amor__section">
          <div class="amor__label">剧情节奏</div>
          <div class="amor__seg amor__rhythm"></div>
        </div>

        <div class="amor__section">
          <div class="amor__label">镜头语言</div>
          <div class="amor__seg amor__camera"></div>
        </div>

        <div class="amor__section">
          <div class="amor__label">叙事重点</div>
          <div class="amor__focus"></div>
        </div>

        <div class="amor__section">
          <div class="amor__label">角色主动性</div>
          <div class="amor__initiative"></div>
        </div>

        <div class="amor__section">
          <div class="amor__label">剧情推进速度</div>
          <input type="range" class="amor__pacing" min="0" max="10" step="1">
          <div class="amor__pacing-hint"></div>
        </div>

        <div class="amor__section">
          <div class="amor__label">自定义导演指令</div>
          <textarea class="amor__custom" rows="3" spellcheck="false" placeholder="如：本轮不要推进主线，只深化两人的关系。"></textarea>
        </div>

        <div class="amor__section">
          <div class="amor__label">预设</div>
          <div class="amor__preset-add">
            <input type="text" class="amor__preset-name" placeholder="预设名，如 甜宠日常">
            <button type="button" class="amor__preset-save">保存当前为预设</button>
          </div>
          <div class="amor__presets"></div>
        </div>

        <div class="amor__hint">导演模式开启后，每次生成都会在角色设定之前注入一段「导演指令」，控制 AI 的节奏 / 镜头 / 叙事重点 / 角色主动性 / 推进速度。指令优先级最高，AI 会照着演。开启「自动导演」后，每轮生成结束 AI 会自动分析剧情、调整下方旋钮并写一句导演指令；若已安装 Serendipity，会自动读取其剧情时间/时间线/人物/关系/世界状态/伏笔作为剧情背景。可点「立即导演」手动分析，或开启「定时自动刷新」按间隔持续分析。</div>
      </div>
      ${plannerPageHtml()}
    </div>`;
    $('body').append(html);
    bindPanelEvents();
    bindPlannerEvents();
}

function renderPanel() {
    const panel = $('#st-amor');
    if (!panel.length) return;
    renderPlanner();
    panel.find('.amor__enabled').prop('checked', settings.enabled);
    panel.find('.amor__auto').prop('checked', settings.autoDirector);
    panel.toggleClass('amor__on', settings.enabled);

    const noteWrap = panel.find('.amor__auto-note');
    if (settings.autoDirector) {
        noteWrap.show();
        noteWrap.find('.amor__auto-note-body').text(settings.autoNote && settings.autoNote.trim() ? settings.autoNote : '导演分析中…');
    } else {
        noteWrap.hide();
    }

    panel.find('.amor__auto-refresh').prop('checked', settings.autoRefresh);
    panel.find('.amor__auto-refresh-sec').val(settings.autoRefreshSec);
    const hasSD = typeof window.Serendipity === 'object' && typeof window.Serendipity.getDirectorContext === 'function';
    panel.find('.amor__link-status').text(hasSD ? '已接入 Serendipity 剧情上下文' : '未检测到 Serendipity（仅用最近对话）');

    // 剧情节奏
    const r = panel.find('.amor__rhythm').empty();
    RHYTHMS.forEach(v => r.append(`<button type="button" class="amor__seg-btn${settings.rhythm === v ? ' on' : ''}" data-v="${v}">${v}</button>`));

    // 镜头语言
    const c = panel.find('.amor__camera').empty();
    CAMERAS.forEach(v => c.append(`<button type="button" class="amor__seg-btn${settings.camera === v ? ' on' : ''}" data-v="${v}">${v}</button>`));

    // 叙事重点
    const f = panel.find('.amor__focus').empty();
    FOCUS_KEYS.forEach(fk => {
        f.append(`<div class="amor__focus-row">
          <span class="amor__focus-label">${fk.label}</span>
          <input type="range" min="0" max="10" step="1" value="${settings.focus[fk.key] != null ? settings.focus[fk.key] : 5}" data-key="${fk.key}">
        </div>`);
    });

    // 角色主动性
    const ini = panel.find('.amor__initiative').empty();
    INITIATIVE_ROLES.forEach(role => {
        const segs = INIT_LEVELS.map(lv => `<button type="button" class="amor__seg-btn${settings.initiative[role.key] === lv ? ' on' : ''}" data-role="${role.key}" data-v="${lv}">${lv}</button>`).join('');
        ini.append(`<div class="amor__init-row"><span class="amor__init-label">${role.label}</span><div class="amor__seg">${segs}</div></div>`);
    });

    // 推进速度
    panel.find('.amor__pacing').val(settings.pacing);
    panel.find('.amor__pacing-hint').text(pacingDesc(settings.pacing));

    // 自定义指令
    panel.find('.amor__custom').val(settings.custom);

    renderPresets();
}

function renderPresets() {
    const el = $('#st-amor .amor__presets');
    if (!el.length) return;
    el.empty();
    if (!settings.presets.length) { el.append('<div class="amor__preset-empty">暂无预设</div>'); return; }
    settings.presets.forEach(p => {
        el.append(`<div class="amor__preset-row">
          <span class="amor__preset-name">${escapeHtml(p.name)}</span>
          <button type="button" class="amor__preset-load" data-id="${p.id}">载入</button>
          <button type="button" class="amor__preset-del" data-id="${p.id}">删除</button>
        </div>`);
    });
}

function snapshotDirector() {
    return {
        rhythm: settings.rhythm,
        camera: settings.camera,
        focus: Object.assign({}, settings.focus),
        initiative: Object.assign({}, settings.initiative),
        pacing: settings.pacing,
        custom: settings.custom,
    };
}

function bindPanelEvents() {
    const panel = $('#st-amor');

    panel.find('.amor__close').on('click', () => togglePanel(false));

    // 导演模式总开关
    panel.on('change', '.amor__enabled', function () {
        settings.enabled = this.checked;
        if (!settings.enabled) settings.autoDirector = false;
        saveSettings();
        updatePromptInjection();
        panel.toggleClass('amor__on', settings.enabled);
        renderPanel();
        syncAutoRefreshTimer();
    });

    // 自动导演开关
    panel.on('change', '.amor__auto', function () {
        settings.autoDirector = this.checked;
        if (settings.autoDirector) {
            settings.enabled = true;
            panel.find('.amor__enabled').prop('checked', true);
            panel.toggleClass('amor__on', true);
        }
        saveSettings();
        updatePromptInjection();
        renderPanel();
        syncAutoRefreshTimer();
        if (settings.autoDirector) autoDirect();
    });

    // 立即导演（手动触发一次分析）
    panel.on('click', '.amor__direct-now', function () {
        if (!settings.autoDirector) { toastr.warning('请先开启「自动导演」'); return; }
        toastr.info('正在分析剧情…');
        autoDirect();
    });

    // 定时自动刷新
    panel.on('change', '.amor__auto-refresh', function () {
        settings.autoRefresh = this.checked;
        saveSettings();
        syncAutoRefreshTimer();
    });
    panel.on('change', '.amor__auto-refresh-sec', function () {
        let v = parseInt(this.value, 10);
        if (isNaN(v) || v < 15) v = 15;
        if (v > 600) v = 600;
        settings.autoRefreshSec = v;
        this.value = v;
        saveSettings();
        syncAutoRefreshTimer();
    });

    // 剧情节奏 / 镜头（单选，再点取消）
    panel.on('click', '.amor__rhythm .amor__seg-btn', function () {
        const v = $(this).data('v');
        settings.rhythm = (settings.rhythm === v) ? '' : v;
        saveSettings(); updatePromptInjection();
        panel.find('.amor__rhythm .amor__seg-btn').each(function () { $(this).toggleClass('on', $(this).data('v') === settings.rhythm); });
    });
    panel.on('click', '.amor__camera .amor__seg-btn', function () {
        const v = $(this).data('v');
        settings.camera = (settings.camera === v) ? '' : v;
        saveSettings(); updatePromptInjection();
        panel.find('.amor__camera .amor__seg-btn').each(function () { $(this).toggleClass('on', $(this).data('v') === settings.camera); });
    });

    // 角色主动性（每角色单选）
    panel.on('click', '.amor__initiative .amor__seg-btn', function () {
        const role = $(this).data('role');
        const lv = $(this).data('v');
        settings.initiative[role] = lv;
        saveSettings(); updatePromptInjection();
        panel.find(`.amor__initiative .amor__seg-btn[data-role="${role}"]`).each(function () { $(this).toggleClass('on', $(this).data('v') === settings.initiative[role]); });
    });

    // 叙事重点滑条
    panel.on('input', '.amor__focus-row input', function () {
        settings.focus[$(this).data('key')] = parseInt(this.value, 10);
        saveSettings(); updatePromptInjection();
    });

    // 推进速度滑条
    panel.on('input', '.amor__pacing', function () {
        settings.pacing = parseInt(this.value, 10);
        saveSettings(); updatePromptInjection();
        panel.find('.amor__pacing-hint').text(pacingDesc(settings.pacing));
    });

    // 自定义指令
    panel.on('input', '.amor__custom', function () {
        settings.custom = this.value;
        saveSettings(); updatePromptInjection();
    });

    // 预设
    panel.on('click', '.amor__preset-save', function () {
        const name = String(panel.find('.amor__preset-name').val() || '').trim();
        if (!name) { toastr.warning('请先填预设名'); return; }
        settings.presets = settings.presets.filter(p => p.name !== name);
        settings.presets.push({ id: uid(), name, data: snapshotDirector() });
        saveSettings();
        panel.find('.amor__preset-name').val('');
        renderPresets();
        toastr.success('已保存预设「' + name + '」');
    });
    panel.on('click', '.amor__preset-load', function () {
        const p = settings.presets.find(x => x.id === $(this).data('id'));
        if (!p) return;
        Object.assign(settings, snapshotDirector(), p.data);
        saveSettings();
        renderPanel();
        updatePromptInjection();
        toastr.success('已载入预设「' + p.name + '」');
    });
    panel.on('click', '.amor__preset-del', function () {
        settings.presets = settings.presets.filter(x => x.id !== $(this).data('id'));
        saveSettings(); renderPresets();
    });
}

// ---------------- 初始化 ----------------
jQuery(async () => {
    loadSettings();
    buildMenuButton();
    buildPanel();
    updatePromptInjection();
    updatePlannerInjection();
    syncAutoRefreshTimer();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            updatePromptInjection();
            plannerReconcile();
            updatePlannerInjection();
            renderPlanner();
        }, 100);
    });
    // 删除消息 / 重新生成 / Swipe：规划状态回滚到仍然有效的最近快照
    for (const ev of [event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPED]) {
        if (ev) eventSource.on(ev, () => setTimeout(() => plannerReconcile(), 200));
    }

    // 每轮生成结束后，自动导演分析剧情并调整下一轮的导演指令
    eventSource.on(event_types.GENERATION_ENDED, () => {
        setTimeout(() => autoDirect(), 300);
        onPlannerGenerationEnded();
    });
});
