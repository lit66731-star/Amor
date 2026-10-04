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
    name1,
} from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { getStringHash } from '../../../utils.js';

const extensionName = 'amor';
const VERSION = '1.6.3';

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
const MAX_THREADS = 8;
const MAX_ARCS = 5;
const MAX_KNOWLEDGE = 8;
const MAX_KNOW_NAMES = 6;
const KNOW_CONFIDENCE = { high: '把握大', mid: '一般', low: '把握小' };
const FORE_STAGE = { sleep: '潜伏', hint: '暗示', build: '铺垫', ready: '可回收' };
const MAX_FORE = 8;
const FORE_IDLE_WARN = 6;        // 已安排暗示/铺垫的伏笔，这么多次规划都没被带出，视为久未提及
const INSPECT_MIN_REV = 2;       // 规划次数少于这个值时数据太少，不做诊断
const BEAT_MISS_WARN = 2;        // 节拍连续这么多轮没有真正发生，提醒换切入点
const TENSION_FLAT_ROUNDS = 4;   // 看最近这么多次规划的张力走势
const TENSION_FLAT_RANGE = 5;
const TENSION_HIGH = 85;
const KNOW_STALE = 10;           // 信息差这么多次规划都没变化，视为停滞
const FORE_TOO_MANY = 7;
const INSPECT_AREAS = { pace: '推进', threads: '剧情线', foreshadow: '伏笔', emotion: '人物情绪', knowledge: '信息差', facts: '事实一致' };
const INSPECT_SEV = { high: '严重', mid: '注意', low: '提示' };
const HEALTH_PENALTY = { high: 35, mid: 20, low: 10 };
const HEALTH_LEVELS = [{ min: 80, key: 'good', label: '良好' }, { min: 60, key: 'fair', label: '一般' }, { min: 0, key: 'poor', label: '需要关注' }];
const MAX_ARC_HISTORY = 5;
const ARC_RECENT = 3;           // 最近这么多次规划内发生的情绪变化，才会写进注入
const THREAD_KINDS = { main: '主线', character: '人物线', world: '世界线' };
const THREAD_STATUS = { active: '进行中', paused: '暂停', resolved: '已完结' };
const THREAD_IMPORTANCE = { high: '高', mid: '中', low: '低' };
const THREAD_IDLE_WARN = 4;      // 重要的进行中剧情线连续这么多次规划都没推进，就提醒规划师优先处理
const TRANSCRIPT_MESSAGES = 6;   // 喂给规划的最近消息条数
const MIN_NEW_CHARS = 150;       // 距上次规划新增的正文少于这个字数、且事实没变化时，跳过规划
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
        threads: [],
        beatThread: '',
        emotionalArcs: [],
        knowledge: [],
        foreshadowPlan: [],
        stagnantRounds: 0,
        lastDecision: '',
    };
}

function freshPlanChat() {
    return {
        schemaVersion: 1,
        revision: { amorRevision: 0, lastProcessedMessageIndex: -1, serendipityRevision: '' },
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
    if (!Array.isArray(cd.directorState.threads)) cd.directorState.threads = [];
    if (typeof cd.directorState.beatThread !== 'string') cd.directorState.beatThread = '';
    if (!Array.isArray(cd.directorState.emotionalArcs)) cd.directorState.emotionalArcs = [];
    if (!Array.isArray(cd.directorState.knowledge)) cd.directorState.knowledge = [];
    if (!Array.isArray(cd.directorState.foreshadowPlan)) cd.directorState.foreshadowPlan = [];
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
// Serendipity 的事实指纹：事实有变化它就变；取不到返回空串
function getSerendipityRevision() {
    if (!serendipityConnected()) return '';
    try {
        const r = window.Serendipity.getDirectorContext({ purpose: 'amor', tokenBudget: 200, include: ['storyTime'] });
        return (r && typeof r === 'object' && r.revision != null) ? String(r.revision) : '';
    } catch (e) { return ''; }
}

// 第 0 层规则判断（不调用模型）：没有实质新内容、事实也没变，就不值得再规划一次
function plannerWorthRunning(cd, idx) {
    if (!cd.revision.amorRevision) return true;
    const rev = getSerendipityRevision();
    if (rev && rev !== cd.revision.serendipityRevision) return true;
    let chars = 0;
    for (let i = cd.revision.lastProcessedMessageIndex + 1; i <= idx; i++) {
        if (isRealMessage(chat[i])) chars += cleanText(chat[i].mes).length;
    }
    return chars >= MIN_NEW_CHARS;
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

// ---- 剧情线（Plot Thread）：Amor 对故事脉络的归纳，属于解释，不是事实 ----
const pickKey = (v, map, def) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(map, v) ? v : def);
const clampPct = (v, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : def; };
function newThreadId(threads) {
    let id;
    do { id = 't' + Math.random().toString(36).slice(2, 7); } while (threads.some(t => t.id === id));
    return id;
}
function makeThread(threads, rev, init) {
    return {
        id: newThreadId(threads),
        title: cleanStr(init.title, 40) || '新剧情线',
        kind: pickKey(init.kind, THREAD_KINDS, 'main'),
        status: pickKey(init.status, THREAD_STATUS, 'active'),
        importance: pickKey(init.importance, THREAD_IMPORTANCE, 'mid'),
        progress: clampPct(init.progress, 0),
        characters: cleanStr(init.characters, 60),
        lastAdvancedAt: rev,
    };
}
function threadIdle(cd, t) { return Math.max(0, cd.revision.amorRevision - (Number.isFinite(t.lastAdvancedAt) ? t.lastAdvancedAt : 0)); }
function findThread(threads, ref) {
    if (!ref) return null;
    const r = String(ref).trim();
    return threads.find(t => t.id === r) || threads.find(t => t.title === r) || null;
}
function trimThreads(cd, s) {
    // 完结很久的先清掉
    s.threads = s.threads.filter(t => !(t.status === 'resolved' && threadIdle(cd, t) >= 5));
    const rank = { resolved: 0, paused: 1, active: 2 };
    const imp = { low: 0, mid: 1, high: 2 };
    while (s.threads.length > MAX_THREADS) {
        let worst = 0;
        for (let i = 1; i < s.threads.length; i++) {
            const a = s.threads[i], b = s.threads[worst];
            if (rank[a.status] < rank[b.status] || (rank[a.status] === rank[b.status] && imp[a.importance] < imp[b.importance])) worst = i;
        }
        s.threads.splice(worst, 1);
    }
}
function mergeThreads(cd, s, list) {
    if (!Array.isArray(list)) return;
    const rev = cd.revision.amorRevision;
    for (const raw of list.slice(0, MAX_THREADS + 2)) {
        if (!raw || typeof raw !== 'object') continue;
        const title = cleanStr(raw.title, 40);
        let t = findThread(s.threads, raw.id) || (title ? s.threads.find(x => x.title === title) : null);
        if (!t) {
            if (!title) continue;
            t = makeThread(s.threads, rev, raw);
            s.threads.push(t);
        } else {
            if (title) t.title = title;
            t.kind = pickKey(raw.kind, THREAD_KINDS, t.kind);
            t.status = pickKey(raw.status, THREAD_STATUS, t.status);
            t.importance = pickKey(raw.importance, THREAD_IMPORTANCE, t.importance);
            t.progress = clampPct(raw.progress, t.progress);
            const ch = cleanStr(raw.characters, 60);
            if (ch) t.characters = ch;
        }
        if (raw.advanced === true) t.lastAdvancedAt = rev;
    }
    trimThreads(cd, s);
}
function threadsForPrompt(cd, s) {
    if (!s.threads.length) return '';
    return s.threads.map(t => {
        const idle = threadIdle(cd, t);
        return `- id=${t.id} | ${t.title} | ${THREAD_KINDS[t.kind]} | ${THREAD_STATUS[t.status]} | 重要度${THREAD_IMPORTANCE[t.importance]} | 进度${t.progress}%` +
            (t.characters ? ' | 人物：' + t.characters : '') +
            (t.status === 'active' ? (idle >= THREAD_IDLE_WARN && t.importance !== 'low' ? ` | 已${idle}次规划没有推进（需要优先考虑）` : (idle ? ` | ${idle}次规划前推进过` : ' | 刚推进过')) : '');
    }).join('\n');
}

// ---- 情绪弧线（Emotional Arc）：关注情绪「为什么变化」，不记数值 ----
const isPlayerName = (n) => !!n && typeof name1 === 'string' && n.trim() === name1.trim();
function mergeEmotionalArcs(cd, s, list) {
    if (!Array.isArray(list)) return;
    const rev = cd.revision.amorRevision;
    for (const raw of list.slice(0, MAX_ARCS + 2)) {
        if (!raw || typeof raw !== 'object') continue;
        const character = cleanStr(raw.character, 20);
        if (!character) continue;
        const cur = cleanStr(raw.current, 30);
        let arc = s.emotionalArcs.find(a => a.character === character);
        if (!arc) {
            if (!cur) continue;
            arc = { id: newThreadId(s.emotionalArcs), character, current: cur, direction: '', history: [], lastChangedAt: rev };
            s.emotionalArcs.push(arc);
        } else if (cur && cur !== arc.current) {
            arc.history.push({ from: arc.current, to: cur, cause: cleanStr(raw.cause, 80), at: rev });
            if (arc.history.length > MAX_ARC_HISTORY) arc.history.splice(0, arc.history.length - MAX_ARC_HISTORY);
            arc.current = cur;
            arc.lastChangedAt = rev;
        }
        // 玩家角色只记录已经表现出来的情绪，不规划其内心走向
        if (isPlayerName(character)) arc.direction = '';
        else if (typeof raw.direction === 'string') arc.direction = cleanStr(raw.direction, 60);
    }
    while (s.emotionalArcs.length > MAX_ARCS) {
        let oldest = 0;
        for (let i = 1; i < s.emotionalArcs.length; i++) if (s.emotionalArcs[i].lastChangedAt < s.emotionalArcs[oldest].lastChangedAt) oldest = i;
        s.emotionalArcs.splice(oldest, 1);
    }
}
function arcsForPrompt(s) {
    if (!s.emotionalArcs.length) return '';
    return s.emotionalArcs.map(a => {
        const hist = a.history.slice(-3).map(h => `${h.from}→${h.to}${h.cause ? '（' + h.cause + '）' : ''}`).join('；');
        return `- ${a.character}${isPlayerName(a.character) ? '（玩家角色）' : ''} | 当前：${a.current}` + (hist ? ' | 近期变化：' + hist : '') + (a.direction ? ' | 倾向：' + a.direction : '');
    }).join('\n');
}

// ---- 知识状态（Knowledge State）：世界知道什么，不等于角色知道什么 ----
const splitNames = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，、;；\n]+/))
    .map(x => cleanStr(x, 20)).filter(Boolean);
const uniqNames = (arr) => Array.from(new Set(arr)).slice(0, MAX_KNOW_NAMES);
// 一个人只会出现在一栏里：知情 > 怀疑 > 不知情
function normalizeKnowledge(k) {
    k.knownBy = uniqNames(k.knownBy);
    k.suspectedBy = uniqNames(k.suspectedBy.filter(n => !k.knownBy.includes(n)));
    k.unknownBy = uniqNames(k.unknownBy.filter(n => !k.knownBy.includes(n) && !k.suspectedBy.includes(n)));
}
function mergeKnowledge(cd, s, list) {
    if (!Array.isArray(list)) return;
    const rev = cd.revision.amorRevision;
    for (const raw of list.slice(0, MAX_KNOWLEDGE + 2)) {
        if (!raw || typeof raw !== 'object') continue;
        const subject = cleanStr(raw.subject, 40);
        let k = findThread(s.knowledge, raw.id) || (subject ? s.knowledge.find(x => x.subject === subject) : null);
        const known = splitNames(raw.knownBy), sus = splitNames(raw.suspectedBy), unk = splitNames(raw.unknownBy);
        if (!k) {
            if (!subject) continue;
            k = { id: newThreadId(s.knowledge), subject, fact: cleanStr(raw.fact, 120), knownBy: known, suspectedBy: sus, unknownBy: unk, confidence: pickKey(raw.confidence, KNOW_CONFIDENCE, 'mid'), lastChangedAt: rev };
            s.knowledge.push(k);
        } else {
            // 已经知道的事不会被忘掉（失忆等特殊情况请手动修改）；怀疑 / 不知情以最新判断为准
            const before = JSON.stringify([k.knownBy, k.suspectedBy, k.unknownBy]);
            k.knownBy = uniqNames(k.knownBy.concat(known));
            k.suspectedBy = sus;
            k.unknownBy = unk;
            const fact = cleanStr(raw.fact, 120);
            if (fact) k.fact = fact;
            k.confidence = pickKey(raw.confidence, KNOW_CONFIDENCE, k.confidence);
            normalizeKnowledge(k);
            if (JSON.stringify([k.knownBy, k.suspectedBy, k.unknownBy]) !== before) k.lastChangedAt = rev;
            continue;
        }
        normalizeKnowledge(k);
    }
    while (s.knowledge.length > MAX_KNOWLEDGE) {
        let oldest = 0;
        for (let i = 1; i < s.knowledge.length; i++) if (s.knowledge[i].lastChangedAt < s.knowledge[oldest].lastChangedAt) oldest = i;
        s.knowledge.splice(oldest, 1);
    }
}
function knowledgeLine(k) {
    const parts = [];
    if (k.knownBy.length) parts.push('知情：' + k.knownBy.join('、'));
    if (k.suspectedBy.length) parts.push('怀疑：' + k.suspectedBy.join('、'));
    if (k.unknownBy.length) parts.push('不知情：' + k.unknownBy.join('、'));
    return parts.join('；');
}
function knowledgeForPrompt(s) {
    if (!s.knowledge.length) return '';
    return s.knowledge.map(k => `- id=${k.id} | ${k.subject}` + (k.fact ? '：' + k.fact : '') + ' | ' + (knowledgeLine(k) || '（尚无记录）') + ' | ' + KNOW_CONFIDENCE[k.confidence]).join('\n');
}

// ---- 伏笔导演（Foreshadow Director）：伏笔本身归 Serendipity，这里只规划「何时、怎样」铺垫与回收 ----
function getSerendipityForeshadows() {
    if (typeof window.Serendipity !== 'object' || typeof window.Serendipity.getForeshadows !== 'function') return null;
    try {
        const r = window.Serendipity.getForeshadows();
        return (r && Array.isArray(r.items)) ? r : null;
    } catch (e) { return null; }
}
// 当前仍未回收的伏笔（以 Serendipity 为准）：id → 条目；取不到返回 null
function liveForeshadowMap() {
    const r = getSerendipityForeshadows();
    if (!r) return null;
    return new Map(r.items.filter(x => x.status !== '已回收').map(x => [String(x.id), x]));
}
// 让规划条目与 Serendipity 对齐：新伏笔加入（默认潜伏），已回收 / 已删除的移除。返回有没有变化
function syncForeshadowPlan(cd) {
    const live = liveForeshadowMap();
    if (!live) return false;
    const s = cd.directorState;
    const rev = cd.revision.amorRevision;
    const before = JSON.stringify(s.foreshadowPlan.map(p => [p.id, p.title]));
    s.foreshadowPlan = s.foreshadowPlan.filter(p => live.has(String(p.id)));
    for (const x of live.values()) {
        const p = s.foreshadowPlan.find(q => String(q.id) === String(x.id));
        if (p) { p.title = x.title; continue; }
        if (s.foreshadowPlan.length >= MAX_FORE) continue;
        s.foreshadowPlan.push({ id: String(x.id), title: x.title, stage: 'sleep', nextHint: '', revealWhen: '', hints: 0, lastHintedAt: rev });
    }
    return JSON.stringify(s.foreshadowPlan.map(p => [p.id, p.title])) !== before;
}
function mergeForeshadowPlan(cd, s, list) {
    if (!Array.isArray(list)) return;
    const rev = cd.revision.amorRevision;
    for (const raw of list.slice(0, MAX_FORE + 2)) {
        if (!raw || typeof raw !== 'object') continue;
        // 只能处理 Serendipity 里已有的伏笔，不新增、不宣布回收
        const p = findThread(s.foreshadowPlan, raw.id) || findThread(s.foreshadowPlan, raw.title);
        if (!p) continue;
        p.stage = pickKey(raw.stage, FORE_STAGE, p.stage);
        if (typeof raw.nextHint === 'string') p.nextHint = cleanStr(raw.nextHint, 80);
        if (typeof raw.revealWhen === 'string') p.revealWhen = cleanStr(raw.revealWhen, 80);
        if (raw.hinted === true) { p.lastHintedAt = rev; p.hints = (p.hints || 0) + 1; }
    }
}
const foreIdle = (cd, p) => Math.max(0, cd.revision.amorRevision - (Number.isFinite(p.lastHintedAt) ? p.lastHintedAt : 0));
function foreshadowsForPrompt(cd, s) {
    const live = liveForeshadowMap();
    if (!live) return '';
    const rows = s.foreshadowPlan.filter(p => live.has(String(p.id)));
    if (!rows.length) return '';
    return rows.map(p => {
        const x = live.get(String(p.id));
        return `- id=${p.id} | ${p.title} | 状态：${x.status}` + (x.day != null ? ` | 第${x.day}天埋下` : '') + (x.note ? ' | 备注：' + cleanStr(x.note, 60) : '') +
            ` | 你的安排：${FORE_STAGE[p.stage]}` + (p.hints ? ` | 已带出${p.hints}次，最近一次在${foreIdle(cd, p)}次规划前` : ' | 还没有带出过') +
            (p.nextHint ? ' | 铺垫思路：' + p.nextHint : '') + (p.revealWhen ? ' | 回收条件：' + p.revealWhen : '');
    }).join('\n');
}

// ---- 故事巡检（Story Inspector）：纯规则，不调用模型；只指出问题，不修改任何数据 ----
function serendipityIssueCount() {
    if (!serendipityConnected()) return 0;
    try {
        const r = window.Serendipity.getDirectorContext({ purpose: 'amor', tokenBudget: 600, include: ['consistency'] });
        const t = r && r.sections && r.sections.consistency;
        return t ? String(t).split('\n').filter(l => l.trim()).length : 0;
    } catch (e) { return 0; }
}
function inspectStory(cd, { withFacts = true } = {}) {
    const s = cd.directorState;
    const rev = cd.revision.amorRevision;
    const out = [];
    if (rev < INSPECT_MIN_REV) return out;
    const add = (area, sev, text) => out.push({ area, sev, text });
    const names = (arr, n = 3) => arr.slice(0, n).map(x => '「' + x + '」').join('') + (arr.length > n ? '等' : '');

    // 推进
    if (s.stagnantRounds >= 2) add('pace', 'high', '剧情已连续 ' + s.stagnantRounds + ' 轮空转，没有产生实质变化');
    else if (s.stagnantRounds === 1) add('pace', 'mid', '剧情近期有空转迹象');
    let miss = 0;
    for (let i = cd.outcomes.length - 1; i >= 0 && cd.outcomes[i].beatCompleted === false; i--) miss++;
    if (miss >= BEAT_MISS_WARN + 1) add('pace', 'high', '规划的节拍已连续 ' + miss + ' 轮没有真正发生，可能不容易落地，或被剧情走向绕开了，考虑换一个切入点');
    else if (miss >= BEAT_MISS_WARN) add('pace', 'mid', '规划的节拍已连续 ' + miss + ' 轮没有真正发生，可以考虑换一个更容易自然发生的切入点');
    const ts = cd.snapshots.slice(-TENSION_FLAT_ROUNDS).map(sn => sn.state && sn.state.tension).filter(Number.isFinite);
    if (ts.length >= TENSION_FLAT_ROUNDS) {
        if (Math.max(...ts) - Math.min(...ts) <= TENSION_FLAT_RANGE) add('pace', 'low', '张力连续 ' + ts.length + ' 次规划几乎没有起伏（约 ' + ts[ts.length - 1] + '），节奏可能偏平');
        if (ts.slice(-3).every(t => t >= TENSION_HIGH)) add('pace', 'mid', '张力长时间处于高位，需要一次释放或喘息，否则容易疲劳');
    }

    // 剧情线
    const active = s.threads.filter(t => t.status === 'active');
    if (s.threads.length && !active.length) add('threads', 'mid', '所有剧情线都已暂停或完结，接下来的走向缺少牵引');
    else if (!s.threads.length && rev >= 4) add('threads', 'low', '尚未归纳出任何剧情线');
    else if (active.length && !active.some(t => t.kind === 'main')) add('threads', 'low', '没有进行中的主线');
    const idleHigh = active.filter(t => t.importance === 'high' && threadIdle(cd, t) >= THREAD_IDLE_WARN * 2);
    const idleMid = active.filter(t => t.importance !== 'low' && !idleHigh.includes(t) && threadIdle(cd, t) >= THREAD_IDLE_WARN);
    if (idleHigh.length) add('threads', 'high', '重要的剧情线' + names(idleHigh.map(t => t.title)) + '已经很久没有推进');
    if (idleMid.length) add('threads', 'mid', '剧情线' + names(idleMid.map(t => t.title)) + '久未推进');

    // 伏笔（事实在 Serendipity，这里只看铺垫与回收的节奏）
    const live = liveForeshadowMap();
    if (live) {
        if (live.size >= FORE_TOO_MANY) add('foreshadow', 'mid', '未回收的伏笔有 ' + live.size + ' 条，过多容易被遗忘或互相冲淡，考虑回收其中几条');
        const fp = s.foreshadowPlan.filter(p => live.has(String(p.id)));
        const ready = fp.filter(p => p.stage === 'ready' && foreIdle(cd, p) >= 3);
        if (ready.length) add('foreshadow', 'mid', names(ready.map(p => p.title)) + '时机已经成熟，却迟迟没有创造回收的契机');
        const stale = fp.filter(p => (p.stage === 'hint' || p.stage === 'build') && foreIdle(cd, p) >= FORE_IDLE_WARN);
        if (stale.length) add('foreshadow', 'low', names(stale.map(p => p.title)) + '已安排铺垫，但很久没有被带出');
        if (fp.length && fp.every(p => p.stage === 'sleep') && Math.max(...fp.map(p => foreIdle(cd, p))) >= KNOW_STALE) add('foreshadow', 'low', '所有伏笔都处于潜伏，已经很久没有任何暗示');
    }

    // 人物情绪
    const noCause = [], volatile = [];
    for (const a of s.emotionalArcs) {
        const h = a.history[a.history.length - 1];
        if (h && !h.cause && rev - h.at <= ARC_RECENT) noCause.push(a.character);
        if (a.history.filter(x => rev - x.at <= 3).length >= 3) volatile.push(a.character);
    }
    if (noCause.length) add('emotion', 'low', names(noCause) + '的情绪发生了变化，但没有记录到原因，要留意是否突兀');
    if (volatile.length) add('emotion', 'mid', names(volatile) + '的情绪在短时间内多次转折，容易显得突兀');

    // 信息差
    const stale = s.knowledge.filter(k => (k.unknownBy.length || k.suspectedBy.length) && rev - k.lastChangedAt >= KNOW_STALE);
    if (stale.length) add('knowledge', 'low', '关于' + names(stale.map(k => k.subject)) + '的信息差已经很久没有变化，可以让它有所松动（试探、线索或误会）');

    // 事实一致（来自 Serendipity 的一致性检查结果）
    if (withFacts) {
        const n = serendipityIssueCount();
        if (n) add('facts', 'mid', 'Serendipity 里有 ' + n + ' 条待处理的一致性问题');
    }
    const rank = { high: 0, mid: 1, low: 2 };
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}
// ---- 故事健康度（Story Health）：由巡检结果推算的参考分，不是对故事好坏的评价 ----
function storyHealth(cd, findings) {
    if (cd.revision.amorRevision < INSPECT_MIN_REV) return null;
    const list = findings || inspectStory(cd);
    const na = { foreshadow: !liveForeshadowMap(), facts: !serendipityConnected() };
    const areas = Object.keys(INSPECT_AREAS).filter(k => !na[k]).map(k => {
        const score = list.filter(f => f.area === k).reduce((v, f) => Math.max(0, v - HEALTH_PENALTY[f.sev]), 100);
        return { key: k, label: INSPECT_AREAS[k], score };
    });
    const vals = areas.map(a => a.score);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const score = Math.round(0.6 * mean + 0.4 * Math.min(...vals));
    const level = HEALTH_LEVELS.find(l => score >= l.min);
    return { score, level: level.key, label: level.label, areas };
}
function inspectionForPrompt(cd) {
    const list = inspectStory(cd).filter(f => f.sev !== 'low').slice(0, 4);
    return list.map(f => '- [' + INSPECT_AREAS[f.area] + '] ' + f.text).join('\n');
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
8. 剧情线（threads）是你对故事脉络的归纳（主线、人物线、世界线），是解释，不是事实。只归纳已知事实和实际剧情里确实存在的持续线索；出现新的持续性矛盾、目标或悬念时才新增，不要凭空编造；某条线已经收束就把 status 设为 resolved。已有剧情线必须沿用原 id。每个节拍尽量推进一条剧情线，标注了「需要优先考虑」的线优先。
9. 情绪弧线（emotionalArcs）关注人物情绪「为什么变化」，不记数值。只为情绪有明显变化、或对接下来的节拍很重要的人物记录（最多 4 人）。current 用一两个词；与上一轮相比发生变化时，cause 必须是剧情里实际发生的具体事件，不能写「剧情需要」。情绪变化要有铺垫，没有足以引发它的事件时，不要让人物情绪突变。玩家角色只记录已经表现出来的情绪，direction 留空。
10. 知识状态（knowledge）记录「谁知道什么」：世界上存在的信息，不等于每个人物都知道。只记录对剧情有影响的信息差（秘密、隐瞒、误会、尚未公开的真相），最多 8 条。人物只有在剧情里亲眼看到、亲耳听到或被告知后才算「知情」，没有证据不要假定他知道；有迹象但没确认的放进「怀疑」。已知情的人不会忘记。不知情的人物不能说出或表现出自己知道这件事，除非接下来的节拍让他得知；让玩家角色得知信息，只能靠剧情里的线索或他人的行动，不能替玩家角色「想起来」或「领悟」。
11. 伏笔（foreshadows）本身由 Serendipity 记录，你只规划「何时、怎样」铺垫与回收：只能处理【伏笔】列表里已有的 id，不能新增伏笔，也不能宣布某条伏笔已回收。stage 取值：sleep 暂时不碰；hint 偶尔在细节里轻轻带过；build 可以进一步铺垫；ready 时机成熟，可以创造让它浮出水面的契机。每个节拍最多自然带出一条伏笔，不要直接说破真相，也不要一次抖出多条。回收需要玩家角色做选择或行动时，只能创造契机，不能替玩家完成。nextHint 写「在场景里怎样自然带出」，revealWhen 写「什么条件下可以回收」，都要具体。hinted 表示上一轮实际剧情是否带出了这条伏笔。
12. 「巡检发现的问题」是规则检测出的参考，不一定都是真问题。确实存在的，在下一个节拍里用剧情内的方式自然化解，不要为此破坏已有设定、不要替玩家角色做决定；判断不是问题的可以忽略。

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
  "beatThread": "下一个节拍主要推进的剧情线（填 id 或标题），没有就留空",
  "threads": [
    { "id": "已有剧情线填原 id，新线留空", "title": "剧情线名，简短", "kind": "main / character / world", "status": "active / paused / resolved", "importance": "high / mid / low", "progress": 0, "characters": "相关人物，逗号分隔", "advanced": false }
  ],
  "emotionalDirection": "情绪走向，用「甲 → 乙」的形式写出起点和终点",
  "emotionalArcs": [
    { "character": "人物名", "current": "当前情绪，一两个词", "cause": "与上一轮相比若发生变化，写实际发生的原因，一句话；没变化留空", "direction": "接下来情绪可能的走向，一句话；玩家角色留空" }
  ],
  "knowledge": [
    { "id": "已有条目填原 id，新条目留空", "subject": "这条信息的主题，简短", "fact": "信息内容，一句话", "knownBy": ["知情的人物"], "suspectedBy": ["怀疑但未确认的人物"], "unknownBy": ["不知情的人物"], "confidence": "high / mid / low（你对这份信息分布的把握）" }
  ],
  "foreshadows": [
    { "id": "伏笔列表里的 id", "stage": "sleep / hint / build / ready", "nextHint": "怎样在场景里自然带出，一句话", "revealWhen": "什么条件下可以回收，一句话", "hinted": false }
  ],
  "tension": 50,
  "doNot": ["本轮不要做的事，每条一句，最多 4 条"],
  "stagnation": false,
  "reason": "一句话说明你为什么这样安排"
}
tension 为 0 到 100 的整数；doNot 最多 4 条；knowledge 最多 8 条，threads 最多 8 条，foreshadows 只列出需要调整安排的伏笔，advanced 表示上一轮实际剧情是否推进了这条线，progress 为 0 到 100 的整数。`;

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
        threadsForPrompt(cd, s) ? '【当前剧情线（你上一轮维护的）】\n' + threadsForPrompt(cd, s) : '',
        arcsForPrompt(s) ? '【人物情绪弧线（你上一轮维护的）】\n' + arcsForPrompt(s) : '',
        knowledgeForPrompt(s) ? '【信息分布：谁知道什么（你上一轮维护的）】\n' + knowledgeForPrompt(s) : '',
        foreshadowsForPrompt(cd, s) ? '【伏笔（事实来自 Serendipity，安排是你上一轮维护的）】\n' + foreshadowsForPrompt(cd, s) : '',
        inspectionForPrompt(cd) ? '【巡检发现的问题（规则检测，供参考）】\n' + inspectionForPrompt(cd) : '',
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
    mergeThreads(cd, s, plan.threads);
    mergeEmotionalArcs(cd, s, plan.emotionalArcs);
    mergeKnowledge(cd, s, plan.knowledge);
    syncForeshadowPlan(cd);
    mergeForeshadowPlan(cd, s, plan.foreshadows);
    const bt = findThread(s.threads, plan.beatThread);
    s.beatThread = bt ? bt.id : '';
    cd.roundsSincePlan = 0;
    cd.meta.updatedAt = Date.now();
}

function pushPlanSnapshot(cd, msgIndex) {
    const m = chat[msgIndex];
    if (!m) return;
    cd.snapshots = cd.snapshots.filter(sn => sn.msgIndex !== msgIndex);
    const h = storyHealth(cd);
    cd.snapshots.push({ msgIndex, hash: msgHash(m), state: clone(cd.directorState), health: h ? h.score : null });
    if (cd.snapshots.length > MAX_SNAPSHOTS) cd.snapshots.splice(0, cd.snapshots.length - MAX_SNAPSHOTS);
}

async function runPlanner({ manual = false } = {}) {
    if (!settings.planner.enabled) { if (manual) toastr.warning('请先开启「剧情规划」'); return; }
    if (plannerBusy) return;
    if (!currentChatKey()) { if (manual) toastr.warning('请先打开一个聊天'); return; }
    const lastIdx = lastRealIndex();
    if (lastIdx < 0) { if (manual) toastr.warning('当前聊天还没有剧情可供规划'); return; }
    const cd = plannerEnsureChat();
    syncForeshadowPlan(cd);
    const hash0 = msgHash(chat[lastIdx]);
    const rev0 = getSerendipityRevision();
    plannerBusy = true;
    setPlannerStatus('规划中…');
    try {
        const planPrompt = buildPlanPrompt(cd, lastIdx);
        const raw = await runExclusive(() => callPlannerLLM({ systemPrompt: PLANNER_SYSTEM, prompt: planPrompt }));
        // 等待期间聊天可能已被删除/重新生成/重置：以返回时的聊天为准，对不上就丢弃这次规划
        const m = chat[lastIdx];
        if (!m || msgHash(m) !== hash0 || plannerChatData() !== cd) { setPlannerStatus(''); return; }
        applyPlan(cd, parsePlanJson(raw), lastIdx);
        cd.revision.serendipityRevision = rev0;
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
    if (!plannerWorthRunning(cd, idx)) {
        saveSettings();
        setPlannerStatus('新增内容很少且事实无变化，已跳过本轮规划');
        return;
    }
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
function buildPlanBlock(s, cd) {
    if (!s.currentBeat && !s.scene.objective) return '';
    const sc = s.scene;
    const lines = [];
    if (sc.situation) lines.push('当前场景：' + sc.situation);
    if (sc.location) lines.push('地点：' + sc.location);
    if (sc.participants) lines.push('在场人物：' + sc.participants);
    if (sc.objective) lines.push('场景目标：' + sc.objective);
    if (sc.conflict) lines.push('当前冲突：' + sc.conflict);
    const bt = findThread(s.threads, s.beatThread);
    if (s.currentBeat) lines.push('本轮应推进的节拍：' + s.currentBeat + (bt ? '（对应剧情线：' + bt.title + '）' : ''));
    const active = s.threads.filter(t => t.status === 'active');
    if (active.length) {
        const order = { high: 0, mid: 1, low: 2 };
        const top = active.slice().sort((a, b) => order[a.importance] - order[b.importance]).slice(0, 4);
        lines.push('进行中的剧情线：' + top.map(t => t.title + '（' + t.progress + '%）').join('；'));
        const idle = active.filter(t => t.importance !== 'low' && threadIdle(cd, t) >= THREAD_IDLE_WARN && (!bt || bt.id !== t.id));
        if (idle.length) lines.push('久未推进的剧情线：' + idle.map(t => t.title).join('、') + '（适当让它们在场景里有所体现，不必强行推进）');
    }
    const arcs = s.emotionalArcs.filter(a => a.current);
    if (arcs.length) {
        lines.push('人物情绪：' + arcs.slice(0, 4).map(a => {
            const h = a.history[a.history.length - 1];
            const why = h && h.cause && cd.revision.amorRevision - h.at <= ARC_RECENT ? '，因' + h.cause : '';
            return a.character + '目前' + a.current + why + (a.direction ? '，可导向' + a.direction : '');
        }).join('；'));
        lines.push('人物情绪的变化要有原因和铺垫，不要无缘由突变。');
    }
    const gaps = s.knowledge.filter(k => k.unknownBy.length || k.suspectedBy.length);
    if (gaps.length) {
        const here = sc.participants || '';
        const involved = (k) => k.unknownBy.concat(k.suspectedBy).some(n => here.includes(n));
        const pick = gaps.slice().sort((a, b) => Number(involved(b)) - Number(involved(a))).slice(0, 4);
        lines.push('信息边界（谁知道什么）：' + pick.map(k => k.subject + (k.fact ? '（' + k.fact + '）' : '') + ' —— ' + knowledgeLine(k)).join('；'));
        lines.push('不知情的人物不能说出或表现出自己知道这些事；怀疑者只能有猜测和试探，不能当作确知；除非本轮剧情让他们得知。');
    }
    const live = liveForeshadowMap();
    if (live) {
        const fp = s.foreshadowPlan.filter(p => live.has(String(p.id)) && p.stage !== 'sleep');
        const byIdle = (a, b) => (a.lastHintedAt || 0) - (b.lastHintedAt || 0);
        const soft = fp.filter(p => p.stage === 'hint' || p.stage === 'build').sort(byIdle)[0];
        const ready = fp.filter(p => p.stage === 'ready').sort(byIdle)[0];
        const fl = [];
        if (soft) fl.push('可以在场景细节里自然带出「' + soft.title + '」' + (soft.stage === 'build' ? '（可进一步铺垫）' : '（轻轻带过即可）') + (soft.nextHint ? '：' + soft.nextHint : ''));
        if (ready) fl.push('「' + ready.title + '」时机已经成熟，可以创造让它浮出水面的契机' + (ready.revealWhen ? '（条件：' + ready.revealWhen + '）' : ''));
        if (fl.length) {
            lines.push('伏笔安排：' + fl.join('；'));
            lines.push('伏笔只能暗示，不要直接说破或一次性揭晓；回收若需要 {{user}} 的选择或行动，只提供契机，不替 {{user}} 完成。');
        }
    }
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
        if (settings.planner.enabled && settings.planner.mode === 'assisted' && cd) text = buildPlanBlock(cd.directorState, cd);
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
        plotThreads: clone(s.threads),
        emotionalArcs: clone(s.emotionalArcs),
        knowledgeState: clone(s.knowledge),
        foreshadowPlan: clone(s.foreshadowPlan),
        inspection: () => inspectStory(cd),
        storyHealth: () => storyHealth(cd),
    };
    const include = opts && Array.isArray(opts.include) ? opts.include : null;
    const out = { revision: clone(cd.revision) };
    for (const k of Object.keys(all)) if (!include || include.includes(k)) out[k] = typeof all[k] === 'function' ? all[k]() : all[k];
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
          <div class="amor__label">故事健康度（由下方诊断推算的参考分，不是对故事好坏的评价）</div>
          <div class="amor__p-health"></div>
        </div>

        <div class="amor__section">
          <div class="amor__label">故事诊断（规则检测，不调用模型，只提示不改动）</div>
          <div class="amor__p-inspect"></div>
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
          <div class="amor__label">剧情线（Amor 对故事脉络的归纳，不是事实）</div>
          <div class="amor__p-threads"></div>
          <button type="button" class="amor__p-reset amor__p-th-add">+ 添加剧情线</button>
        </div>

        <div class="amor__section">
          <div class="amor__label">人物情绪弧线（Amor 的归纳，不是事实）</div>
          <div class="amor__p-arcs"></div>
          <button type="button" class="amor__p-reset amor__p-ea-add">+ 添加人物情绪</button>
        </div>

        <div class="amor__section">
          <div class="amor__label">信息分布：谁知道什么（Amor 的判断，不是事实）</div>
          <div class="amor__p-know"></div>
          <button type="button" class="amor__p-reset amor__p-ka-add">+ 添加信息</button>
        </div>

        <div class="amor__section">
          <div class="amor__label">伏笔安排（伏笔本身记录在 Serendipity，这里只规划何时、怎样铺垫与回收）</div>
          <div class="amor__p-fore"></div>
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
    // 剧情线：手动增删改，同步到最新快照，避免回滚时被冲掉
    const syncExtrasToSnapshot = (cd) => {
        const last = cd.snapshots[cd.snapshots.length - 1];
        if (last) {
            last.state.threads = clone(cd.directorState.threads);
            last.state.beatThread = cd.directorState.beatThread;
            last.state.emotionalArcs = clone(cd.directorState.emotionalArcs);
            last.state.knowledge = clone(cd.directorState.knowledge);
            last.state.foreshadowPlan = clone(cd.directorState.foreshadowPlan);
        }
        cd.meta.updatedAt = Date.now();
        saveSettings();
        updatePlannerInjection();
    };
    panel.on('click', '.amor__p-th-add', () => {
        const cd = plannerEnsureChat();
        if (!cd) { toastr.warning('请先打开一个聊天'); return; }
        const th = cd.directorState.threads;
        if (th.length >= MAX_THREADS) { toastr.warning('剧情线最多 ' + MAX_THREADS + ' 条，请先删除或完结一条'); return; }
        th.push(makeThread(th, cd.revision.amorRevision, {}));
        syncExtrasToSnapshot(cd);
        renderThreads(cd);
    });
    panel.on('click', '.amor__p-th-del', function () {
        const cd = plannerChatData();
        if (!cd) return;
        const id = $(this).closest('.amor__p-thread').data('id');
        cd.directorState.threads = cd.directorState.threads.filter(t => t.id !== id);
        if (cd.directorState.beatThread === id) cd.directorState.beatThread = '';
        syncExtrasToSnapshot(cd);
        renderThreads(cd);
    });
    panel.on('click', '.amor__p-ea-add', () => {
        const cd = plannerEnsureChat();
        if (!cd) { toastr.warning('请先打开一个聊天'); return; }
        const arcs = cd.directorState.emotionalArcs;
        if (arcs.length >= MAX_ARCS) { toastr.warning('最多记录 ' + MAX_ARCS + ' 位人物，请先删除一位'); return; }
        arcs.push({ id: newThreadId(arcs), character: '', current: '', direction: '', history: [], lastChangedAt: cd.revision.amorRevision });
        syncExtrasToSnapshot(cd);
        renderArcs(cd);
    });
    panel.on('click', '.amor__p-ea-del', function () {
        const cd = plannerChatData();
        if (!cd) return;
        const id = $(this).closest('.amor__p-arc').data('id');
        cd.directorState.emotionalArcs = cd.directorState.emotionalArcs.filter(a => a.id !== id);
        syncExtrasToSnapshot(cd);
        renderArcs(cd);
    });
    panel.on('change', '.amor__p-ea', function () {
        const cd = plannerChatData();
        if (!cd) return;
        const a = cd.directorState.emotionalArcs.find(x => x.id === $(this).closest('.amor__p-arc').data('id'));
        if (!a) return;
        const f = $(this).data('f');
        a[f] = cleanStr($(this).val(), f === 'character' ? 20 : (f === 'current' ? 30 : 60));
        if (f === 'direction' && isPlayerName(a.character)) a.direction = '';
        $(this).val(a[f]);
        syncExtrasToSnapshot(cd);
    });
    panel.on('click', '.amor__p-ka-add', () => {
        const cd = plannerEnsureChat();
        if (!cd) { toastr.warning('请先打开一个聊天'); return; }
        const ks = cd.directorState.knowledge;
        if (ks.length >= MAX_KNOWLEDGE) { toastr.warning('最多记录 ' + MAX_KNOWLEDGE + ' 条，请先删除一条'); return; }
        ks.push({ id: newThreadId(ks), subject: '', fact: '', knownBy: [], suspectedBy: [], unknownBy: [], confidence: 'mid', lastChangedAt: cd.revision.amorRevision });
        syncExtrasToSnapshot(cd);
        renderKnowledge(cd);
    });
    panel.on('click', '.amor__p-ka-del', function () {
        const cd = plannerChatData();
        if (!cd) return;
        const id = $(this).closest('.amor__p-kcard').data('id');
        cd.directorState.knowledge = cd.directorState.knowledge.filter(k => k.id !== id);
        syncExtrasToSnapshot(cd);
        renderKnowledge(cd);
    });
    panel.on('change', '.amor__p-ka', function () {
        const cd = plannerChatData();
        if (!cd) return;
        const k = cd.directorState.knowledge.find(x => x.id === $(this).closest('.amor__p-kcard').data('id'));
        if (!k) return;
        const f = $(this).data('f');
        const v = $(this).val();
        if (f === 'subject') k.subject = cleanStr(v, 40);
        else if (f === 'fact') k.fact = cleanStr(v, 120);
        else if (f === 'confidence') k.confidence = pickKey(v, KNOW_CONFIDENCE, k.confidence);
        else k[f] = splitNames(v);
        k.lastChangedAt = cd.revision.amorRevision;
        normalizeKnowledge(k);
        syncExtrasToSnapshot(cd);
        const card = $(this).closest('.amor__p-kcard');
        for (const key of ['knownBy', 'suspectedBy', 'unknownBy']) card.find(`[data-f="${key}"]`).val(k[key].join('、'));
        if (f === 'subject') $(this).val(k.subject);
        if (f === 'fact') $(this).val(k.fact);
    });
    panel.on('change', '.amor__p-fa', function () {
        const cd = plannerEnsureChat();
        if (!cd) return;
        syncForeshadowPlan(cd);
        const p = cd.directorState.foreshadowPlan.find(x => String(x.id) === String($(this).closest('.amor__p-fcard').attr('data-id')));
        if (!p) return;
        const f = $(this).data('f');
        const v = $(this).val();
        if (f === 'stage') p.stage = pickKey(v, FORE_STAGE, p.stage);
        else { p[f] = cleanStr(v, 80); $(this).val(p[f]); }
        syncExtrasToSnapshot(cd);
    });
    panel.on('change', '.amor__p-th', function () {
        const cd = plannerChatData();
        if (!cd) return;
        const row = $(this).closest('.amor__p-thread');
        const t = cd.directorState.threads.find(x => x.id === row.data('id'));
        if (!t) return;
        const f = $(this).data('f');
        const v = $(this).val();
        if (f === 'title') t.title = cleanStr(v, 40) || t.title;
        else if (f === 'kind') t.kind = pickKey(v, THREAD_KINDS, t.kind);
        else if (f === 'status') t.status = pickKey(v, THREAD_STATUS, t.status);
        else if (f === 'importance') t.importance = pickKey(v, THREAD_IMPORTANCE, t.importance);
        else if (f === 'progress') { t.progress = clampPct(v, t.progress); $(this).val(t.progress); }
        syncExtrasToSnapshot(cd);
        if (f === 'title') $(this).val(t.title);
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

function renderKnowledge(cd) {
    const box = $('#st-amor .amor__p-know').empty();
    if (!cd || !cd.directorState.knowledge.length) {
        box.append($('<div class="amor__p-empty">').text(cd ? '还没有记录。出现秘密、隐瞒或信息差时会自动归纳，也可以手动添加。' : '请先打开一个聊天。'));
        return;
    }
    const lab = (text, input) => $('<label class="amor__p-ka-l">').append($('<span>').text(text), input);
    const list = (f, arr) => $('<input type="text" class="amor__p-ka" spellcheck="false" placeholder="用顿号或逗号分隔">').attr('data-f', f).val(arr.join('、'));
    for (const k of cd.directorState.knowledge) {
        const sel = $('<select class="amor__p-ka" data-f="confidence">');
        for (const key of Object.keys(KNOW_CONFIDENCE)) sel.append($('<option>').val(key).text(KNOW_CONFIDENCE[key]));
        sel.val(k.confidence);
        const row = $('<div class="amor__p-thread amor__p-kcard">').attr('data-id', k.id);
        row.append($('<div class="amor__p-th-row amor__p-ea-top">').append(
            $('<input type="text" class="amor__p-ka" data-f="subject" maxlength="40" placeholder="信息主题" spellcheck="false">').val(k.subject),
            sel,
            $('<button type="button" class="amor__p-th-del amor__p-ka-del" title="删除">×</button>')));
        row.append($('<input type="text" class="amor__p-ka amor__p-ea-dir" data-f="fact" maxlength="120" placeholder="信息内容（一句话）" spellcheck="false">').val(k.fact));
        row.append(lab('知情', list('knownBy', k.knownBy)), lab('怀疑', list('suspectedBy', k.suspectedBy)), lab('不知情', list('unknownBy', k.unknownBy)));
        box.append(row);
    }
}

function renderForeshadows(cd) {
    const box = $('#st-amor .amor__p-fore').empty();
    if (!cd) { box.append($('<div class="amor__p-empty">').text('请先打开一个聊天。')); return; }
    const live = liveForeshadowMap();
    if (!live) { box.append($('<div class="amor__p-empty">').text('需要 Serendipity 2.3.7 或更高版本。')); return; }
    syncForeshadowPlan(cd);
    const rows = cd.directorState.foreshadowPlan;
    if (!rows.length) { box.append($('<div class="amor__p-empty">').text('Serendipity 里还没有未回收的伏笔。在那边添加后，这里会出现对应的安排。')); return; }
    for (const p of rows) {
        const x = live.get(String(p.id));
        const sel = $('<select class="amor__p-fa" data-f="stage">');
        for (const k of Object.keys(FORE_STAGE)) sel.append($('<option>').val(k).text(FORE_STAGE[k]));
        sel.val(p.stage);
        const idle = foreIdle(cd, p);
        const meta = (x ? x.status : '') + ' · 已带出 ' + (p.hints || 0) + ' 次' + (p.stage !== 'sleep' && idle >= FORE_IDLE_WARN ? ' · ' + idle + ' 次规划没有带出' : '');
        const lab = (text, input) => $('<label class="amor__p-ka-l">').append($('<span>').text(text), input);
        const row = $('<div class="amor__p-thread amor__p-fcard">').attr('data-id', p.id).toggleClass('is-idle', p.stage !== 'sleep' && idle >= FORE_IDLE_WARN);
        row.append($('<div class="amor__p-th-row amor__p-ea-top">').append($('<div class="amor__p-fa-title">').text(p.title), sel));
        row.append(lab('带出', $('<input type="text" class="amor__p-fa" data-f="nextHint" maxlength="80" placeholder="怎样在场景里自然带出" spellcheck="false">').val(p.nextHint)));
        row.append(lab('回收', $('<input type="text" class="amor__p-fa" data-f="revealWhen" maxlength="80" placeholder="什么条件下可以回收" spellcheck="false">').val(p.revealWhen)));
        row.append($('<div class="amor__p-th-meta">').text(meta));
        box.append(row);
    }
}

function renderHealth(cd, list) {
    const box = $('#st-amor .amor__p-health').empty();
    const h = cd ? storyHealth(cd, list) : null;
    if (!h) { box.append($('<div class="amor__p-empty">').text(cd ? '规划次数还太少，暂时不评估。' : '请先打开一个聊天。')); return; }
    const hist = cd.snapshots.map(sn => sn.health).filter(Number.isFinite);
    let trend = '';
    if (hist.length >= 2) {
        const d = hist[hist.length - 1] - hist[hist.length - 2];
        trend = d > 0 ? '较上次 ↑' + d : (d < 0 ? '较上次 ↓' + (-d) : '与上次持平');
    }
    box.append($('<div class="amor__p-hscore">').addClass('lv-' + h.level).append(
        $('<b>').text(h.score), $('<span>').text(h.label), $('<em>').text(trend)));
    if (hist.length >= 2) {
        const spark = $('<div class="amor__p-spark">');
        for (const v of hist.slice(-12)) spark.append($('<i>').css('height', Math.max(4, Math.round(v * 0.28)) + 'px').attr('title', v));
        box.append(spark);
    }
    for (const a of h.areas) {
        box.append($('<div class="amor__p-harea">').addClass(a.score < 60 ? 'lv-poor' : (a.score < 80 ? 'lv-fair' : 'lv-good')).append(
            $('<span>').text(a.label), $('<div class="amor__p-bar">').append($('<i>').css('width', a.score + '%')), $('<b>').text(a.score)));
    }
}

function renderInspection(cd) {
    const box = $('#st-amor .amor__p-inspect').empty();
    if (!cd) { renderHealth(null); box.append($('<div class="amor__p-empty">').text('请先打开一个聊天。')); return; }
    if (cd.revision.amorRevision < INSPECT_MIN_REV) { renderHealth(cd); box.append($('<div class="amor__p-empty">').text('规划次数还太少，暂时不做诊断。')); return; }
    const list = inspectStory(cd);
    renderHealth(cd, list);
    if (!list.length) { box.append($('<div class="amor__p-empty">').text('目前没有发现需要留意的问题。')); return; }
    for (const f of list) {
        box.append($('<div class="amor__p-find">').addClass('sev-' + f.sev).append(
            $('<span class="amor__p-find-tag">').text(INSPECT_SEV[f.sev] + ' · ' + INSPECT_AREAS[f.area]),
            $('<span>').text(f.text)));
    }
}

function renderArcs(cd) {
    const box = $('#st-amor .amor__p-arcs').empty();
    if (!cd || !cd.directorState.emotionalArcs.length) {
        box.append($('<div class="amor__p-empty">').text(cd ? '还没有记录。规划几轮后会自动归纳，也可以手动添加。' : '请先打开一个聊天。'));
        return;
    }
    for (const a of cd.directorState.emotionalArcs) {
        const row = $('<div class="amor__p-thread amor__p-arc">').attr('data-id', a.id);
        row.append($('<div class="amor__p-th-row amor__p-ea-top">').append(
            $('<input type="text" class="amor__p-ea" data-f="character" maxlength="20" placeholder="人物" spellcheck="false">').val(a.character),
            $('<input type="text" class="amor__p-ea" data-f="current" maxlength="30" placeholder="当前情绪" spellcheck="false">').val(a.current),
            $('<button type="button" class="amor__p-th-del amor__p-ea-del" title="删除">×</button>')));
        row.append($('<input type="text" class="amor__p-ea amor__p-ea-dir" data-f="direction" maxlength="60" spellcheck="false">')
            .attr('placeholder', isPlayerName(a.character) ? '玩家角色不规划内心走向' : '情绪倾向（可留空）').val(a.direction));
        if (a.history.length) {
            const chain = a.history.map(h => h.from + ' → ' + h.to).join('，');
            const last = a.history[a.history.length - 1];
            row.append($('<div class="amor__p-th-meta">').text(chain + (last.cause ? '（最近：' + last.cause + '）' : '')));
        }
        box.append(row);
    }
}

function renderThreads(cd) {
    const box = $('#st-amor .amor__p-threads').empty();
    if (!cd || !cd.directorState.threads.length) {
        box.append($('<div class="amor__p-empty">').text(cd ? '还没有剧情线。规划几轮后会自动归纳，也可以手动添加。' : '请先打开一个聊天。'));
        return;
    }
    const sel = (f, map, cur) => {
        const el = $('<select class="amor__p-th">').attr('data-f', f);
        for (const k of Object.keys(map)) el.append($('<option>').val(k).text(map[k]));
        return el.val(cur);
    };
    for (const t of cd.directorState.threads) {
        const idle = threadIdle(cd, t);
        const meta = t.status !== 'active' ? '' : (idle >= THREAD_IDLE_WARN && t.importance !== 'low' ? idle + ' 次规划没有推进' : (idle ? idle + ' 次规划前推进过' : '刚推进过'));
        const row = $('<div class="amor__p-thread">').attr('data-id', t.id).toggleClass('is-idle', !!meta && idle >= THREAD_IDLE_WARN && t.importance !== 'low');
        row.append($('<input type="text" class="amor__p-th amor__p-th-title" data-f="title" maxlength="40" spellcheck="false">').val(t.title));
        row.append($('<div class="amor__p-th-row">').append(
            sel('kind', THREAD_KINDS, t.kind), sel('status', THREAD_STATUS, t.status), sel('importance', THREAD_IMPORTANCE, t.importance),
            $('<input type="number" class="amor__p-th amor__p-th-pct" data-f="progress" min="0" max="100">').val(t.progress),
            $('<span class="amor__p-th-unit">%</span>'),
            $('<button type="button" class="amor__p-th-del" title="删除">×</button>')));
        if (meta) row.append($('<div class="amor__p-th-meta">').text(meta + (t.characters ? ' · ' + t.characters : '')));
        else if (t.characters) row.append($('<div class="amor__p-th-meta">').text(t.characters));
        box.append(row);
    }
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
        renderThreads(null);
        renderArcs(null);
        renderKnowledge(null);
        renderForeshadows(null);
        renderInspection(null);
        panel.find('.amor__p-input').val('').prop('disabled', true);
        panel.find('.amor__p-outcomes').empty();
        panel.find('.amor__p-decision').text('请先打开一个聊天。');
        return;
    }
    const s = cd.directorState;
    renderThreads(cd);
    renderArcs(cd);
    renderKnowledge(cd);
    renderForeshadows(cd);
    renderInspection(cd);
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

// ST 自动更新扩展后会调用 manifest.hooks.update 指向的这个函数（此时新代码已 git pull 到磁盘），
// 在这里刷新页面以加载新版本，无需手动刷新。
export function reloadOnUpdate() {
    toastr.info('Amor 已更新，正在刷新页面以应用新版本...', undefined, { timeOut: 1500 });
    setTimeout(() => location.reload(), 1500);
}
