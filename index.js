import { extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    saveSettingsDebounced,
} from '../../../../script.js';

const extensionName = 'amor';
const VERSION = '1.0.0';

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

        <div class="amor__hint">导演模式开启后，每次生成都会在角色设定之前注入一段「导演指令」，控制 AI 的节奏 / 镜头 / 叙事重点 / 角色主动性 / 推进速度。指令优先级最高，AI 会照着演。</div>
      </div>
    </div>`;
    $('body').append(html);
    bindPanelEvents();
}

function renderPanel() {
    const panel = $('#st-amor');
    if (!panel.length) return;
    panel.find('.amor__enabled').prop('checked', settings.enabled);
    panel.toggleClass('amor__on', settings.enabled);

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
        saveSettings();
        updatePromptInjection();
        panel.toggleClass('amor__on', settings.enabled);
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

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => { updatePromptInjection(); }, 100);
    });
});
