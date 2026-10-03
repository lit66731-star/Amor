import { extension_settings } from '../../../extensions.js';
import {
    chat,
    generateRaw,
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    saveSettingsDebounced,
} from '../../../../script.js';

const extensionName = 'amor';
const VERSION = '1.2.0';

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
function getStoryContext() {
    try {
        if (typeof window.Serendipity === 'object' && typeof window.Serendipity.getDirectorContext === 'function') {
            const c = window.Serendipity.getDirectorContext();
            if (c && c.trim()) return c;
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
        const result = await generateRaw({ prompt, systemPrompt: '你是一位专业的剧情导演，只负责决定下一段剧情怎么导。' });
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
          <span class="amor__subtitle">导演台</span>
          <span class="amor__version">v${VERSION}</span>
        </div>
        <button type="button" class="amor__close" title="关闭">×</button>
      </div>
      <div class="amor__body">
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
    </div>`;
    $('body').append(html);
    bindPanelEvents();
}

function renderPanel() {
    const panel = $('#st-amor');
    if (!panel.length) return;
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
    syncAutoRefreshTimer();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => { updatePromptInjection(); }, 100);
    });

    // 每轮生成结束后，自动导演分析剧情并调整下一轮的导演指令
    eventSource.on(event_types.GENERATION_ENDED, () => {
        setTimeout(() => autoDirect(), 300);
    });
});
