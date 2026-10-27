/*
 * 字体管理器 Font Manager —— SillyTavern 第三方扩展
 * 功能：全局字体覆盖、远程 CSS / @import 注入、本地字体上传 (@font-face)、按语言分组分配字体、实时预览。
 */

// ============================ 常量 ============================
const MODULE_NAME = 'font_manager';
const FORAGE_KEY = 'fm_font_data';

function detectExtensionName() {
    let src = '';
    try { src = import.meta.url || ''; } catch { src = ''; }
    if (!src) src = document.currentScript?.src || '';
    if (!src) {
        const hit = Array.from(document.querySelectorAll('script[type="module"][src]')).find((s) =>
            /\/scripts\/extensions\.+?\/index\.js(?:\?|#|$)/.test(s.src)
        );
        src = hit?.src || '';
    }
    const m = src.match(/\/scripts\/extensions\/(.+?)\/index\.js(?:\?|#|$)/);
    return m ? m[1] : 'third-party/FontManager';
}
const EXT_NAME = detectExtensionName();

const STYLE_ID = {
    remote: 'fm-remote-style',
    face: 'fm-font-face-style',
    apply: 'fm-apply-style',
};

const defaultSettings = Object.freeze({
    enabled: true,
    remoteCss: '',
    latinFont: 'Times New Roman',
    cjkFont: '',
    otherFont: '__follow__',
    codeFont: 'Consolas, "Courier New", monospace',
    applyCode: true,
    weight: '400',
    fonts: [],
});

const SYSTEM_LATIN = ['Times New Roman', 'Georgia', 'Arial', 'Helvetica', 'Verdana', 'Calibri', 'Cambria', 'system-ui'];
const SYSTEM_CJK = ['Noto Sans CJK SC', 'Noto Serif CJK SC', 'Microsoft YaHei', 'PingFang SC', 'SimSun', 'KaiTi'];
const CODE_PRESETS = [
    'Consolas, "Courier New", monospace',
    '"JetBrains Mono", Consolas, monospace',
    '"Cascadia Code", Consolas, monospace',
    'Menlo, Monaco, monospace',
    'monospace',
];
const FONT_EXT = ['ttf', 'otf', 'woff', 'woff2'];

let ctx = {};
let localforageApi = null;
let cachedFontData = {};
let pendingFiles = [];
let remoteTimer = null;

function getSettings() {
    let es = ctx.extensionSettings || ctx.extension_settings;
    if (!es) { es = {}; ctx.extensionSettings = es; }
    if (!es[MODULE_NAME]) es[MODULE_NAME] = structuredClone(defaultSettings);
    const s = es[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(defaultSettings[key]);
    }
    if (!Array.isArray(s.fonts)) s.fonts = [];
    return s;
}

function genId() {
    return 'fm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function baseName(fileName) {
    const dot = fileName.lastIndexOf('.');
    return (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
}

function extOf(fileName) {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

function fontFormat(ext) {
    switch (ext) {
        case 'woff2': return 'woff2';
        case 'woff': return 'woff';
        case 'otf': return 'opentype';
        case 'ttf': return 'truetype';
        default: return 'truetype';
    }
}

function quoteCss(name) {
    if (!name) return '';
    let v = String(name).trim();
    if (!v) return '';
    v = v.replace(/^['"]|['"]$/g, '').replace(/["\\]/g, (c) => (c === '"' ? '\\"' : '\\\\'));
    return `"${v}"`;
}

function cleanFamily(name) {
    return String(name || '').trim();
}

function cssWeight(w) {
    if (w === 'normal' || w === 'bold' || w === 'lighter' || w === 'bolder') return w;
    if (/^\d{3}$/.test(String(w))) return w;
    return 'normal';
}

function weightToNumber(w) {
    const n = parseInt(String(w), 10);
    if (!Number.isNaN(n)) return Math.min(900, Math.max(100, n));
    return 400;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

async function loadFontData() {
    if (!localforageApi) return {};
    try { return (await localforageApi.getItem(FORAGE_KEY)) || {}; }
    catch (err) { console.error('[FontManager] 读取本地字体失败：', err); return {}; }
}

async function saveFontData() {
    if (!localforageApi) return;
    try { await localforageApi.setItem(FORAGE_KEY, cachedFontData); }
    catch (err) { console.error('[FontManager] 保存本地字体失败：', err); }
}

function buildStack(latin, cjk, other) {
    const stack = [];
    const push = (name) => {
        const q = quoteCss(name);
        if (q && !stack.includes(q)) stack.push(q);
    };
    push(latin);
    push(cjk);
    if (other && other !== '__follow__') push(other);
    stack.push('system-ui', '-apple-system', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif');
    return stack.join(', ');
}

function fontFaceCss() {
    const s = getSettings();
    return s.fonts.map((f) => {
        const data = cachedFontData[f.id];
        if (!data) return '';
        return [
            '@font-face {',
            `  font-family: ${quoteCss(f.family)};`,
            `  src: url("${data}") format("${fontFormat(f.format)}");`,
            `  font-weight: ${cssWeight(f.weight)};`,
            `  font-style: ${f.style === 'italic' ? 'italic' : 'normal'};`,
            '  font-display: swap;',
            '}',
        ].join('\n');
    }).filter(Boolean).join('\n');
}

function normalizeRemoteCss(raw) {
    if (!raw || !raw.trim()) return '';
    const imports = raw.match(/@import\s+[^;]+;/gi) || [];
    const rest = raw.replace(/@import\s+[^;]+;/gi, '').trim();
    return imports.join('\n') + (rest ? '\n' + rest : '');
}

function extractBodyFontFamily(text) {
    if (!text || !text.trim()) return '';
    const s = String(text);
    let out = '';
    let depth = 0;
    let blockStart = -1;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '{') { if (depth === 0) blockStart = i; depth++; }
        else if (ch === '}') {
            depth--;
            if (depth === 0 && blockStart >= 0) {
                const selector = s.slice(0, blockStart).split(/[;}\n]/).pop().trim();
                const block = s.slice(blockStart + 1, i);
                if (/\bbody\s*$/i.test(selector)) {
                    const fm = block.match(/font-family\s*:\s*([^;{}]+)/i);
                    if (fm) {
                        const name = fm[1].trim().replace(/^['"]|['"]$/g, '').trim();
                        if (name) { out = name; break; }
                    }
                }
                blockStart = -1;
            }
        }
    }
    return out;
}

function parseRemoteFamilies(text) {
    const out = new Set();
    if (!text) return [...out];
    const re = /font-family\s*:\s*([^;}]+)/gi;
    let m;
    while ((m = re.exec(text))) {
        m[1].split(',').forEach((f) => {
            const name = f.trim().replace(/^['"]|['"]$/g, '').trim();
            if (name && !/^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-|emoji|math)$/i.test(name)) {
                out.add(name);
            }
        });
    }
    return [...out];
}

const CODE_SELECTORS = [
    'body.fm-active code',
    'body.fm-active pre',
    'body.fm-active kbd',
    'body.fm-active samp',
    'body.fm-active .code',
    'body.fm-active .monospace',
];

const ICON_SELECTOR = '[class*="fa-"], [class*="fas "], [class*="far "], [class*="fab "], svg, [class*="material-icons"], [class*="svg-inline--fa"], [class*="icon-"], [class*="iconfont"], [class*="glyphicon"]';

function markIcons() {
    document.body.querySelectorAll(ICON_SELECTOR).forEach((el) => el.classList.add('fm-no-font'));
}

const GLOBAL_WILDCARD = 'body.fm-active :not(svg):not([class*="fa-"]):not([class*="fas "]):not([class*="far "]):not([class*="fab "]):not([class*="material-icons"]):not([class*="svg-inline--fa"]):not([class*="icon-"]):not([class*="iconfont"]):not([class*="glyphicon"]):not(.fm-no-font):not(code):not(pre):not(kbd):not(samp):not(.monospace):not(.code)';

let iconObserver = null;
let iconScanTimer = null;
function scheduleMarkIcons() {
    if (iconScanTimer) return;
    iconScanTimer = setTimeout(() => { iconScanTimer = null; markIcons(); }, 300);
}
function startIconObserver() {
    if (iconObserver || !document.body) return;
    iconObserver = new MutationObserver(() => scheduleMarkIcons());
    iconObserver.observe(document.body, { childList: true, subtree: true });
}

function applyCss() {
    const s = getSettings();
    let bodyStack = buildStack(s.latinFont, s.cjkFont, s.otherFont);
    const remoteBody = extractBodyFontFamily(s.remoteCss);
    if (remoteBody) {
        const rq = remoteBody.includes(',') ? remoteBody : quoteCss(remoteBody);
        bodyStack = rq + (bodyStack ? ', ' + bodyStack : '');
    }
    const codeStack = s.codeFont.trim() || 'monospace';
    const weightRule = `\n  font-weight: ${cssWeight(s.weight)} !important;`;

    let css = [
        'body.fm-active {',
        `  --fm-body-stack: ${bodyStack};`,
        `  --fm-code-stack: ${codeStack};`,
        '  font-family: var(--fm-body-stack);',
        '}',
        '',
        GLOBAL_WILDCARD + ' {',
        '  font-family: var(--fm-body-stack) !important;' + weightRule,
        '}',
        '',
    ].join('\n');

    if (s.applyCode) {
        css += [
            CODE_SELECTORS.join(',\n') + ' {',
            '  font-family: var(--fm-code-stack) !important;',
            '}',
            '',
        ].join('\n');
    }
    return css;
}

function removeStyle(id) {
    document.getElementById(id)?.remove();
}

function injectStyle(id, css) {
    removeStyle(id);
    if (!css || !css.trim()) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
}

function removeAllStyles() {
    Object.values(STYLE_ID).forEach(removeStyle);
    document.body.classList.remove('fm-active');
}

function applyFonts() {
    const s = getSettings();
    if (!s.enabled) { removeAllStyles(); refreshPreview(); return; }
    document.body.classList.add('fm-active');
    markIcons();
    startIconObserver();
    injectStyle(STYLE_ID.face, fontFaceCss());
    injectStyle(STYLE_ID.remote, normalizeRemoteCss(s.remoteCss));
    injectStyle(STYLE_ID.apply, applyCss());
    refreshPreview();
}

function allLocalFamilies() {
    return getSettings().fonts.map((f) => cleanFamily(f.family));
}

function renderFamilyDatalist() {
    const s = getSettings();
    const remote = parseRemoteFamilies(s.remoteCss);
    const local = allLocalFamilies();
    const latin = [...new Set([...SYSTEM_LATIN, ...local, ...remote])];
    const cjk = [...new Set([...SYSTEM_CJK, ...local, ...remote])];
    const latinDl = document.getElementById('fm-datalist-latin');
    const cjkDl = document.getElementById('fm-datalist-cjk');
    const codeDl = document.getElementById('fm-datalist-code');
    if (latinDl) latinDl.innerHTML = latin.map((n) => `<option value="${escapeHtml(n)}">`).join('');
    if (cjkDl) cjkDl.innerHTML = cjk.map((n) => `<option value="${escapeHtml(n)}">`).join('');
    if (codeDl) codeDl.innerHTML = [...new Set(CODE_PRESETS)].map((n) => `<option value="${escapeHtml(n)}">`).join('');
}

function renderFontList() {
    const s = getSettings();
    const list = document.getElementById('fm-local-font-list');
    if (!list) return;
    if (s.fonts.length === 0) {
        list.innerHTML = '<div class="fm-empty">尚未上传本地字体。点击下方「上传字体」选择 .ttf / .otf / .woff / .woff2 文件。</div>';
        return;
    }
    list.innerHTML = s.fonts.map((f) => `
        <div class="fm-font-row" data-id="${f.id}">
            <span class="fm-font-sample" style="font-family: ${quoteCss(f.family)}, serif;">Ag 永</span>
            <span class="fm-font-meta">
                <b>${escapeHtml(f.family)}</b>
                <small>${escapeHtml(f.fileName || '')} · ${escapeHtml(f.format.toUpperCase())} · ${escapeHtml(f.weight)}${f.style === 'italic' ? ' · 斜体' : ''}</small>
            </span>
            <button type="button" class="menu_button fm-del-font" data-id="${f.id}" title="删除该字体">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>`).join('');
}

function renderPendingList() {
    const box = document.getElementById('fm-pending-box');
    const list = document.getElementById('fm-pending-list');
    const importBtn = document.getElementById('fm-import-pending');
    if (!box || !list) return;
    if (pendingFiles.length === 0) {
        box.classList.add('fm-hidden');
        list.innerHTML = '';
        if (importBtn) importBtn.textContent = '确认导入（0）';
        return;
    }
    box.classList.remove('fm-hidden');
    list.innerHTML = pendingFiles.map((p, i) => `
        <div class="fm-pending-row" data-index="${i}">
            <input type="text" class="fm-pending-family text_pole" data-index="${i}" value="${escapeHtml(p.family)}" placeholder="字体名称（CSS family）">
            <select class="fm-pending-weight" data-index="${i}">
                <option value="100"${p.weight === '100' ? ' selected' : ''}>100</option>
                <option value="200"${p.weight === '200' ? ' selected' : ''}>200</option>
                <option value="300"${p.weight === '300' ? ' selected' : ''}>300</option>
                <option value="normal"${p.weight === 'normal' ? ' selected' : ''}>normal</option>
                <option value="500"${p.weight === '500' ? ' selected' : ''}>500</option>
                <option value="600"${p.weight === '600' ? ' selected' : ''}>600</option>
                <option value="bold"${p.weight === 'bold' ? ' selected' : ''}>bold</option>
                <option value="800"${p.weight === '800' ? ' selected' : ''}>800</option>
                <option value="900"${p.weight === '900' ? ' selected' : ''}>900</option>
            </select>
            <select class="fm-pending-style" data-index="${i}">
                <option value="normal"${p.style === 'normal' ? ' selected' : ''}>正常</option>
                <option value="italic"${p.style === 'italic' ? ' selected' : ''}>斜体</option>
            </select>
            <button type="button" class="menu_button fm-del-pending" data-index="${i}" title="移除">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>`).join('');
    if (importBtn) importBtn.textContent = `确认导入（${pendingFiles.length}）`;
}

function refreshPreview() {
    const s = getSettings();
    const latinEl = document.getElementById('fm-preview-latin');
    const cjkEl = document.getElementById('fm-preview-cjk');
    const otherEl = document.getElementById('fm-preview-other');
    const codeEl = document.getElementById('fm-preview-code');
    if (latinEl) latinEl.style.fontFamily = `${quoteCss(s.latinFont) || 'Times New Roman'}, Georgia, serif`;
    if (cjkEl) cjkEl.style.fontFamily = s.cjkFont ? `${quoteCss(s.cjkFont)}, sans-serif` : 'system-ui, sans-serif';
    const otherTarget = s.otherFont && s.otherFont !== '__follow__' ? s.otherFont : s.cjkFont;
    if (otherEl) otherEl.style.fontFamily = otherTarget ? `${quoteCss(otherTarget)}, sans-serif` : 'system-ui, sans-serif';
    if (codeEl) codeEl.style.fontFamily = s.codeFont.trim() || 'monospace';
    const setLabel = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setLabel('fm-preview-latin-label', s.latinFont || 'Times New Roman');
    setLabel('fm-preview-cjk-label', s.cjkFont || '未指定（跟随系统）');
    setLabel('fm-preview-other-label', !otherTarget ? '跟随中文 / 系统' : otherTarget);
    setLabel('fm-preview-code-label', s.codeFont.trim() || 'monospace');
    const codeBlock = document.getElementById('fm-preview-code-block');
    if (codeBlock) codeBlock.style.display = s.applyCode ? '' : 'none';
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`读取失败：${file.name}`));
        reader.readAsDataURL(file);
    });
}

async function handleFiles(files) {
    const arr = Array.from(files || []);
    if (arr.length === 0) return;
    for (const file of arr) {
        const ext = extOf(file.name);
        if (!FONT_EXT.includes(ext)) {
            toastr.warning(`不支持的字体格式：${file.name}（支持 ${FONT_EXT.join('/')}）`);
            continue;
        }
        try {
            const dataUrl = await readFileAsDataUrl(file);
            pendingFiles.push({ file, dataUrl, family: baseName(file.name), weight: 'normal', style: 'normal', ext });
        } catch (err) {
            toastr.error(err.message);
            console.error('[FontManager]', err);
        }
    }
    renderPendingList();
}

async function importPending() {
    const s = getSettings();
    let count = 0;
    for (const p of pendingFiles) {
        const family = cleanFamily(p.family) || baseName(p.file.name);
        const id = genId();
        cachedFontData[id] = p.dataUrl;
        s.fonts.push({ id, family, weight: p.weight, style: p.style, format: p.ext, source: 'local', fileName: p.file.name });
        count++;
    }
    pendingFiles = [];
    await saveFontData();
    ctx.saveSettingsDebounced();
    renderFamilyDatalist();
    renderFontList();
    renderPendingList();
    applyFonts();
    if (count > 0) toastr.success(`成功导入 ${count} 个本地字体`);
}

async function deleteFont(id) {
    const s = getSettings();
    s.fonts = s.fonts.filter((f) => f.id !== id);
    delete cachedFontData[id];
    await saveFontData();
    const remaining = new Set(s.fonts.map((f) => cleanFamily(f.family)));
    if (s.latinFont && !remaining.has(cleanFamily(s.latinFont))) s.latinFont = defaultSettings.latinFont;
    if (s.cjkFont && !remaining.has(cleanFamily(s.cjkFont))) s.cjkFont = '';
    if (s.otherFont !== '__follow__' && s.otherFont && !remaining.has(cleanFamily(s.otherFont))) s.otherFont = '__follow__';
    ctx.saveSettingsDebounced();
    renderFamilyDatalist();
    renderFontList();
    applyFonts();
    toastr.info('已删除该字体');
}

async function clearAllFonts() {
    const { Popup, POPUP_RESULT, POPUP_TYPE } = ctx;
    const popup = new Popup('确认删除全部本地已上传字体？此操作不可恢复。', POPUP_TYPE.CONFIRM, '', { okButton: '删除全部', cancelButton: '取消' });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    const s = getSettings();
    s.fonts = [];
    cachedFontData = {};
    await saveFontData();
    if (s.cjkFont) s.cjkFont = '';
    if (s.otherFont !== '__follow__') s.otherFont = '__follow__';
    ctx.saveSettingsDebounced();
    renderFamilyDatalist();
    renderFontList();
    applyFonts();
    toastr.success('已清空本地字体库');
}

function resetDisplayDefaults() {
    const s = getSettings();
    s.latinFont = defaultSettings.latinFont;
    s.cjkFont = defaultSettings.cjkFont;
    s.otherFont = defaultSettings.otherFont;
    s.codeFont = defaultSettings.codeFont;
    s.applyCode = defaultSettings.applyCode;
    s.weight = defaultSettings.weight;
    syncControls();
    ctx.saveSettingsDebounced();
    renderFamilyDatalist();
    applyFonts();
    toastr.info('显示选项已恢复默认（本地字体保留）');
}

function syncControls() {
    const s = getSettings();
    $('#fm-enabled').prop('checked', s.enabled);
    $('#fm-latin-font').val(s.latinFont);
    $('#fm-cjk-font').val(s.cjkFont);
    const follow = s.otherFont === '__follow__';
    $('#fm-other-font').val(follow ? '' : s.otherFont);
    $('#fm-other-follow').prop('checked', follow);
    $('#fm-other-font').prop('disabled', follow);
    $('#fm-code-font').val(s.codeFont);
    $('#fm-apply-code').prop('checked', s.applyCode);
    syncWeightSlider();
    $('#fm-remote-css').val(s.remoteCss);
}

function syncWeightSlider() {
    const n = weightToNumber(getSettings().weight);
    $('#fm-weight-range').val(n);
    $('#fm-weight-value').text(n);
}

function bindEvents() {
    $('#fm-enabled').on('input', function () { getSettings().enabled = this.checked; ctx.saveSettingsDebounced(); applyFonts(); });
    bindFontInput('#fm-latin-font', 'latinFont');
    bindFontInput('#fm-cjk-font', 'cjkFont');
    bindFontInput('#fm-code-font', 'codeFont');
    $('#fm-other-follow').on('input', function () {
        const s = getSettings();
        s.otherFont = this.checked ? '__follow__' : '';
        $('#fm-other-font').prop('disabled', this.checked);
        ctx.saveSettingsDebounced();
        renderFamilyDatalist();
        applyFonts();
    });
    $('#fm-other-font').on('input', function () {
        getSettings().otherFont = this.value.trim();
        ctx.saveSettingsDebounced();
        renderFamilyDatalist();
        applyFonts();
    });
    $('#fm-weight-range').on('input', function () {
        const v = this.value;
        $('#fm-weight-value').text(v);
        getSettings().weight = String(v);
        ctx.saveSettingsDebounced();
        applyFonts();
    });
    $('#fm-apply-code').on('input', function () { getSettings().applyCode = this.checked; ctx.saveSettingsDebounced(); applyFonts(); });
    $('#fm-remote-css').on('input', function () {
        getSettings().remoteCss = this.value;
        clearTimeout(remoteTimer);
        remoteTimer = setTimeout(() => { ctx.saveSettingsDebounced(); renderFamilyDatalist(); syncOtherFollowState(); applyFonts(); }, 400);
    });
    $('#fm-apply-remote').on('click', () => { ctx.saveSettingsDebounced(); renderFamilyDatalist(); applyFonts(); toastr.success('远程字体样式已应用'); });
    $('#fm-load-example').on('click', () => {
        const example = '@import url("https://fontsapi.zeoseven.com/285/main/result.css");\nbody {\n    font-family: "Noto Serif CJK";\n    font-weight: normal;\n}';
        $('#fm-remote-css').val(example).trigger('input');
        toastr.info('已填入示例远程 CSS，可按需修改后应用');
    });
    $('#fm-upload-btn').on('click', () => $('#fm-font-file').trigger('click'));
    $('#fm-font-file').on('change', function () { handleFiles(this.files); this.value = ''; });
    $('#fm-import-pending').on('click', importPending);
    $('#fm-local-font-list').on('click', '.fm-del-font', function () { deleteFont(this.dataset.id); });
    $('#fm-pending-list').on('input', '.fm-pending-family', function () { pendingFiles[Number(this.dataset.index)].family = this.value; });
    $('#fm-pending-list').on('change', '.fm-pending-weight', function () { pendingFiles[Number(this.dataset.index)].weight = this.value; });
    $('#fm-pending-list').on('change', '.fm-pending-style', function () { pendingFiles[Number(this.dataset.index)].style = this.value; });
    $('#fm-pending-list').on('click', '.fm-del-pending', function () { pendingFiles.splice(Number(this.dataset.index), 1); renderPendingList(); });
    $('#fm-clear-fonts').on('click', clearAllFonts);
    $('#fm-reset-defaults').on('click', resetDisplayDefaults);
}

function bindFontInput(selector, key) {
    $(selector).on('input', function () {
        getSettings()[key] = this.value.trim();
        ctx.saveSettingsDebounced();
        renderFamilyDatalist();
        applyFonts();
    });
}

function syncOtherFollowState() {
    const follow = getSettings().otherFont === '__follow__';
    $('#fm-other-font').prop('disabled', follow);
}

export function onActivate() { initCore(); applyFonts(); }
export function onEnable() { initCore(); const s = getSettings(); s.enabled = true; ctx.saveSettingsDebounced(); applyFonts(); }
export function onDisable() { initCore(); const s = getSettings(); s.enabled = false; ctx.saveSettingsDebounced(); removeAllStyles(); }
export async function onDelete() {
    initCore();
    if (localforageApi) { try { await localforageApi.removeItem(FORAGE_KEY); } catch (err) { console.error('[FontManager] 清理失败：', err); } }
}

function initCore() {
    ctx = SillyTavern.getContext();
    localforageApi = SillyTavern.libs?.localforage || window.localforage || null;
}

jQuery(async () => {
    initCore();
    cachedFontData = await loadFontData();
    let settingsHtml = '';
    try {
        if (typeof ctx.renderExtensionTemplateAsync === 'function') {
            settingsHtml = await ctx.renderExtensionTemplateAsync(EXT_NAME, 'settings', {});
        }
    } catch (err) {
        console.error('[FontManager] 模板渲染失败，改用直接拉取：', err);
        settingsHtml = '';
    }
    if (!settingsHtml) {
        try { settingsHtml = await $.get(`scripts/extensions/${EXT_NAME}/settings.html`); }
        catch (err) {
            console.error('[FontManager] 设置面板拉取失败：', err);
            settingsHtml = '<div class="fm-manager"><div class="inline-drawer"><div class="inline-drawer-content"><b>字体管理器</b><p>设置面板加载失败：未找到 settings.html，请确认它位于当前扩展目录内。</p></div></div></div>';
        }
    }
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (container) container.insertAdjacentHTML('beforeend', settingsHtml);
    else console.warn('[FontManager] 未找到扩展设置容器，面板未挂载');
    bindEvents();
    syncControls();
    renderFamilyDatalist();
    renderFontList();
    renderPendingList();
    applyFonts();
    console.log('[FontManager] 扩展已加载');
});
