// ============================================================
//  main.js —— E-mote 交互主程序
//
//  架构：
//    ModelLoader            模型下载 / 解压 / 初始化
//    LipSyncPlayer          音频播放 + 口型同步
//    ResponsiveLayout       显示/缓冲尺寸解耦 + resize 自适应
//    TransformController    滚轮缩放 + 拖动
//    InteractionManager     命中判定 → 触发动作 → 恢复
//    start()                组装配置、加载模型、串联各层
//
//  尺寸模型：
//    显示尺寸(CSS) = 整屏 100vw×100vh（随 resize 变化）
//    缓冲尺寸(buffer) = 视口×DPR（仅首次设定，受 8192 约束，绝不改）
//    resize 只更新 CSS + 模型缩放/居中
//
//  坐标系：所有交互统一使用「content 内显示像素」（剔除 contain 黑边）
// ============================================================

const DEFAULT_FADE_TIME = 300;
const DEFAULT_HOLD_MS = 1000;
const MAX_TEXTURE_SIZE = 8192;

// SDK 3.9.8 不支持 4.0 的 customPartsList / emote.extension.command.insert，
// 会把两套互斥手臂同时画出来（4 个袖子）。
// 修复在 GPU 纹理层：gl-arm-pose.js 在 atlas 经 texImage2D 上传时，
// 按互斥组矩形把其中一套写 0 / 另一套还原。配置由 model-loader.js
// 直接从模型 zip 的 PSB 字节里算出，换模型只要换 zip；模型本来只有
// 一套手臂时自动跳过补丁、正常显示。setArmPose() 只改纹理，不重建
// 模型实例，动画与物理连续，单次约 0.1s。
// 模型由页面顶部的「角色 → 造型」tab 决定：优先 URL ?model=<角色/文件名>，
// 其次本地记忆（上次点过哪个造型），都没有时取 data/ 扫描结果里的**第一个可用模型**
// （顺序与 tab 完全一致），代码里不再硬编码任何模型路径。
// 只接受「角色名/文件名」或纯文件名（旧链接兼容）；data/ 里的 .zip 与裸 .psb 都认，
// 杜绝路径穿越。
const MODEL_INDEX_KEY = 'sg-model-index-v1';

function readModelIndex() {
    try {
        var idx = JSON.parse(localStorage.getItem(MODEL_INDEX_KEY) || 'null');
        return (idx && typeof idx === 'object' && !Array.isArray(idx)) ? idx : null;
    } catch (_) { return null; }
}
/* 纯文件名 → 「角色/文件名」。索引由 scene-ui.js 每次扫描后写入，
   新加角色文件夹无需改这里。 */
function resolveModelPath(file) {
    var idx = readModelIndex();
    var p = idx && idx[file];
    if (typeof p === 'string' && p && p.indexOf('..') < 0) return p;
    return '';
}
/* 索引的第一条＝tab 里第一个角色的第一个造型（写入顺序与 tab 排序一致） */
function firstIndexedPath() {
    var idx = readModelIndex();
    if (!idx) return '';
    var keys = Object.keys(idx);
    for (var i = 0; i < keys.length; i++) {
        var p = idx[keys[i]];
        if (typeof p === 'string' && p && p.indexOf('..') < 0) return p;
    }
    return '';
}
function toModelUrl(path) { return path ? '../data/' + path : ''; }

// 显式指定（URL / 本地记忆）能同步定下来；都没有时留空，交给 start() 问扫描结果
const INITIAL_MODEL_URL = (function () {
    let name = '';
    try {
        name = new URLSearchParams(location.search).get('model')
            || localStorage.getItem('sg-model') || '';
    } catch (_) { /* 隐私模式 / file:// 下没有记忆 */ }
    if (!name || name.indexOf('..') !== -1 || /[\\]/.test(name)
        || /[\x00-\x1f?#]/.test(name)
        || !/\.(?:zip|psb)$/i.test(name)) return '';
    var seg = name.split('/');
    if (seg.length > 2 || seg.some(function (s) { return !s; })) return '';
    if (seg.length === 1) name = resolveModelPath(seg[0]);   // 纯文件名 → 补角色文件夹
    return name ? toModelUrl(name) : '';
})();
const MODEL_PSB = INITIAL_MODEL_URL;   // 显式指定时有值；自动模式由 start() 补上
if (typeof window !== 'undefined') {
    window.SG_CURRENT_MODEL = MODEL_PSB ? MODEL_PSB.slice(MODEL_PSB.lastIndexOf('/') + 1) : '';
}

/* 自动模式：取扫描结果里的第一个可用模型。
   首次访问本地还没有索引，就等这一轮真实扫描（最多 2.5s），
   保证「data/ 里放着什么就默认显示什么」。 */
async function resolveModelUrl() {
    if (MODEL_PSB) return MODEL_PSB;
    const api = (typeof window !== 'undefined') ? window.SGSceneUI : null;
    if (api) {
        try {
            const pending = (api.ready && typeof api.ready.then === 'function')
                ? api.ready
                : (typeof api.refreshModels === 'function' ? api.refreshModels() : null);
            if (pending) {
                await Promise.race([pending, new Promise(function (r) { setTimeout(r, 2500); })]);
            }
        } catch (_) { /* 扫描失败 → 用上次索引兜底 */ }
        const list = (typeof api.modelList === 'function') ? (api.modelList() || []) : [];
        if (list.length && list[0].path) {
            window.SG_CURRENT_MODEL = list[0].file;
            if (typeof api.setCurrent === 'function') api.setCurrent(list[0].file);
            return toModelUrl(list[0].path);
        }
    }
    const p = firstIndexedPath();
    if (p) {
        window.SG_CURRENT_MODEL = p.slice(p.lastIndexOf('/') + 1);
        return toModelUrl(p);
    }
    return '';
}
const DEFAULT_ARM_POSE = 'crossed';   // 兼容旧 API 的别名；实际姿势名与按钮标签一律取模型自身的选项名

// ============================================================
//  动画主循环（官方 demo 写法）
// ============================================================
class EmoteAnimationController {
    constructor() { this.device = null; this.requestId = null; }
    onStartEmoteAnimation(device) {
        this.device = device;
        this.requestId = requestAnimationFrame(this.drawAnimation.bind(this));
    }
    onStopEmoteAnimation() {
        if (this.requestId !== null) { cancelAnimationFrame(this.requestId); this.requestId = null; }
    }
    drawAnimation(timeStamp) {
        if (!this.device) return;
        this.device.drawAnimation(timeStamp);
        this.requestId = requestAnimationFrame(this.drawAnimation.bind(this));
    }
}
window.emoteAnimationController = new EmoteAnimationController();

// ============================================================
//  ResponsiveLayout —— 响应式布局
// ============================================================
class ResponsiveLayout {
    constructor(player, canvas, config) {
        this.player = player;
        this.canvas = canvas;
        this.config = config;
        this.baseCoord = [player.coord[0], player.coord[1]];
        this._resizeFrame = null;
        this._onResize = this._onResize.bind(this);
        window.addEventListener('resize', this._onResize);
        this.apply();
    }

    /** 视口高度 → 模型缩放比例（线性插值，下限 0.05） */
    static getHeightRatio(height) {
        const h1 = 600, r1 = 0.3, h2 = 1600, r2 = 0.9;
        const m = (r2 - r1) / (h2 - h1);
        return Math.max(0.05, m * height + r1 - m * h1);
    }

    _displaySize() {
        const w = window.innerWidth || document.body.clientWidth || 1;
        const h = window.innerHeight || document.body.clientHeight || 1;
        return { width: w, height: h };
    }

    /** 缓冲尺寸 = 显示 × DPR，受 8192 约束 */
    _bufferSize(display) {
        const dpr = window.devicePixelRatio || 1;
        let w = Math.round(display.width * dpr);
        let h = Math.round(display.height * dpr);
        if (w > MAX_TEXTURE_SIZE || h > MAX_TEXTURE_SIZE) {
            const k = Math.min(MAX_TEXTURE_SIZE / w, MAX_TEXTURE_SIZE / h);
            w = Math.round(w * k); h = Math.round(h * k);
        }
        return { width: w, height: h };
    }

    apply() {
        const canvas = this.canvas;
        const display = this._displaySize();
        const buf = this._bufferSize(display);

        Object.assign(canvas.style, {
            position: 'fixed', top: '0', left: '0',
            width: `${display.width}px`, height: `${display.height}px`,
            objectFit: 'contain', display: 'block', touchAction: 'none',
            background: 'transparent', zIndex: '1', pointerEvents: 'auto',
        });

        // 缓冲层仅首次初始化，此后绝不改 canvas.width/height（避免黑屏）
        if (!this._bufferInitialized) {
            canvas.width = buf.width;
            canvas.height = buf.height;
            this._bufferInitialized = true;
            this._log(`🖼 缓冲层: ${buf.width}×${buf.height}（此后不变）`);
        }

        // 模型缩放（逻辑缩放，不乘 DPR）
        this.player.scale = ResponsiveLayout.getHeightRatio(display.height);

        // 垂直居中
        const offsetRatio = this.config.transform?.verticalOffsetRatio ?? 0.5;
        const c = this.player.coord;
        c[0] = this.baseCoord[0];
        c[1] = this.baseCoord[1] - (0.5 - offsetRatio) * buf.height;
        this.player.coord = c;

        if (EmotePlayer.device) EmotePlayer.device.invalidateAnimation();
        this._log(`📐 display=${display.width}×${display.height} buf=${buf.width}×${buf.height} scale=${this.player.scale.toFixed(3)}`);
    }

    _onResize() {
        if (this._resizeFrame !== null) cancelAnimationFrame(this._resizeFrame);
        this._resizeFrame = requestAnimationFrame(() => { this._resizeFrame = null; this.apply(); });
    }

    _log(...args) { if (this.config.debug) console.log(...args); }
}

// ============================================================
//  TransformController —— 滚轮缩放 + 拖动
// ============================================================
class TransformController {
    constructor(player, canvas, config) {
        this.player = player;
        this.canvas = canvas;
        this.baseScale = player.scale;

        const t = (config && config.transform) || {};
        this.minScale = (t.minScaleFactor || 0.5) * this.baseScale;
        this.maxScale = (t.maxScaleFactor || 2.0) * this.baseScale;
        this.zoomStep = t.zoomStep || 0.1;
        this.currentScale = this.baseScale;

        this._dragging = false;
        this._pointerId = null;
        this._coordStart = [0, 0];
        this._pointerStart = { x: 0, y: 0 };

        this._onWheel = this._onWheel.bind(this);
        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);

        canvas.addEventListener('wheel', this._onWheel, { passive: false });
        canvas.addEventListener('pointerdown', this._onPointerDown);
    }

    _onWheel(e) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1 : -1;
        const factor = this.currentScale / this.baseScale;
        const next = Math.min(this.maxScale, Math.max(this.minScale,
            this.baseScale * (factor + delta * this.zoomStep)));
        if (next !== this.currentScale) { this.currentScale = next; this.player.scale = next; }
    }

    _onPointerDown(e) {
        if (e.button !== 0) return;
        this._dragging = true;
        this._pointerId = e.pointerId;
        this._coordStart = [this.player.coord[0], this.player.coord[1]];
        this._pointerStart = { x: e.clientX, y: e.clientY };
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.addEventListener('pointermove', this._onPointerMove);
        this.canvas.addEventListener('pointerup', this._onPointerUp);
        this.canvas.addEventListener('pointercancel', this._onPointerUp);
    }

    _onPointerMove(e) {
        if (!this._dragging) return;
        const rect = this.canvas.getBoundingClientRect();
        const sx = this.canvas.width / rect.width;
        const sy = this.canvas.height / rect.height;
        const dx = (e.clientX - this._pointerStart.x) * sx;
        const dy = (e.clientY - this._pointerStart.y) * sy;
        this.player.coord = [this._coordStart[0] + dx, this._coordStart[1] + dy];
    }

    _onPointerUp() {
        this._dragging = false;
        try { this.canvas.releasePointerCapture(this._pointerId); } catch (_) {}
        this.canvas.removeEventListener('pointermove', this._onPointerMove);
        this.canvas.removeEventListener('pointerup', this._onPointerUp);
        this.canvas.removeEventListener('pointercancel', this._onPointerUp);
    }
}

// ============================================================
//  InteractionManager —— 命中判定 + 触发 + 恢复
// ============================================================
class InteractionManager {
    constructor(player, canvas, config) {
        this.player = player;
        this.canvas = canvas;
        this.config = config;
        this.busy = false;
        this.audio = new AudioPlayer(config, () => this.player);
        this.debug = config.debug !== false;
        this.eyeTrack = config.eyeTrack;
        this._validVariables = new Set([
            ...(player.variableList || []).map((v) => v.label || v.name || v),
        ]);
        this._baseScale = player.scale;
        this._bindEvents();
        requestAnimationFrame(() => this._logMarkers());
    }

    _log(...args) { if (this.debug) console.log(...args); }
    _warn(...args) { if (this.debug) console.warn(...args); }

    // ---- 坐标系 ----

    /** DPR = canvas 缓冲宽 / 显示宽 */
    _dpr() {
        const rect = this.canvas.getBoundingClientRect();
        return rect.width > 0 ? this.canvas.width / rect.width : (window.devicePixelRatio || 1);
    }

    /** object-fit: contain 实际绘制区（剔除黑边），单位 = 显示像素 */
    _contentRect() {
        const rect = this.canvas.getBoundingClientRect();
        const bufRatio = (this.canvas.width || 1) / (this.canvas.height || 1);
        const dispRatio = rect.width / (rect.height || 1);
        let w, h, x, y;
        if (dispRatio > bufRatio) {
            h = rect.height; w = h * bufRatio; x = (rect.width - w) / 2; y = 0;
        } else {
            w = rect.width; h = w / bufRatio; x = 0; y = (rect.height - h) / 2;
        }
        return { x, y, width: w, height: h };
    }

    /** client 坐标 → content 内显示像素 */
    _pointerPos(pointer) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: pointer.clientX - rect.left, y: pointer.clientY - rect.top };
    }

    // ---- Marker ----

    _markerPos(name) {
        const raw = this.player && this.player.getMarkerPosition(name);
        if (!raw) return null;
        if (typeof raw.offsetX === 'number') return { x: raw.offsetX, y: raw.offsetY };
        if (typeof raw.clientX === 'number') return { x: raw.clientX, y: raw.clientY };
        return null;
    }

    /** marker 坐标 → 显示像素（除以 DPR） */
    _markerPosScreen(name) {
        const raw = this._markerPos(name);
        if (!raw) return null;
        const dpr = this._dpr();
        return { x: raw.x / dpr, y: raw.y / dpr };
    }

    /** 命中判定半径（显示像素），随缩放 factor 放大 */
    _effectiveRadius(part) {
        const factor = this._currentFactor();
        const displayH = this._contentRect().height || (this.canvas.height / this._dpr());
        const ratio = part && part.radius;
        if (typeof ratio === 'number' && ratio > 0) return ratio * displayH * factor;
        return ((part && part.radiusPx) || 80) * factor;
    }

    _currentFactor() {
        const base = this._baseScale != null ? this._baseScale : (this.player && this.player.scale) || 1;
        const cur = this.player && this.player.scale;
        return (cur && base > 0) ? (cur / base) : 1;
    }

    // ---- 事件 ----

    _bindEvents() {
        this.canvas.addEventListener('mousemove', (e) => this._onPointerMove(e));
        this.canvas.addEventListener('click', (e) => this._onClick(e));
        this.canvas.addEventListener('touchmove', (e) => {
            this._onPointerMove(e.touches[0]); e.preventDefault();
        }, { passive: false });
        this.canvas.addEventListener('touchstart', (e) => {
            this._onClick(e.touches[0]); e.preventDefault();
        }, { passive: false });
        this.canvas.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
    }

    // ---- 调试：marker 对齐检查 ----
    _logMarkers() {
        if (!this.debug) return;
        const profile = this.player && this.player.charaProfile;
        const profileKeys = profile && typeof profile === 'object' ? Object.keys(profile) : [];
        this._log('📐 charaProfile keys:', profileKeys.join(', ') || '(无)');

        Object.keys(this.config.reactions).forEach((key) => {
            if (profileKeys.length > 0 && !profile.hasOwnProperty(key)) {
                this._warn(`⚠️ "${key}" 不在 charaProfile 中，将无法命中`);
                return;
            }
            const pos = this._markerPosScreen(key);
            if (pos) this._log(`📍 ${key}: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`);
            else this._warn(`⚠️ "${key}" 无坐标`);
        });
    }

    // ---- 眼神追踪 ----
    _onPointerMove(pointer) {
        const eye = this._markerPosScreen('eye');
        if (!eye) return;
        const p = this._pointerPos(pointer);
        const dx = p.x - eye.x, dy = p.y - eye.y;
        const len = Math.hypot(dx, dy);
        const { fadeTime } = this.eyeTrack;
        const c = dx / (len || 1), s = dy / (len || 1);

        // eyeTrackMap：默认映射表（可通过 charaProfile.eyeTrackMap 覆盖）
        const map = (this.player.charaProfile && this.player.charaProfile.eyeTrackMap)
            || this._defaultEyeTrackMap();

        for (const [varName, factorKey, axis, thresholdKey] of map) {
            if (thresholdKey && len <= this.eyeTrack[thresholdKey]) continue;
            const factor = this.eyeTrack[factorKey];
            if (typeof factor !== 'number') { this._warn(`⚠️ eyeTrack 缺系数: ${factorKey}`); continue; }
            const dir = axis === 'c' ? c : s;
            this.player.setVariableDiff('eyetrack', varName, len * factor * dir, fadeTime, -1);
        }
    }

    _defaultEyeTrackMap() {
        return [
            ['face_eye_LR',    'eyeLRFactor',     'c', null],
            ['face_eye_UD',    'eyeUDFactor',     's', null],
            ['head_slant',     'headSlantFactor', 'c', 'headThreshold'],
            ['head_LR',        'headLRFactor',    'c', 'headThreshold'],
            ['head_UD',        'headUDFactor',     's', 'headThreshold'],
            ['body_slant',     'bodySlantFactor', 'c', 'bodyThreshold'],
            ['body_LR',        'bodyLRFactor',    'c', 'bodyThreshold'],
            ['body_UD',        'bodyUDFactor',     's', 'bodyThreshold'],
        ];
    }

    // ---- 点击命中 ----

    _onClick(pointer) {
        if (this.busy) return;
        const p = this._pointerPos(pointer);

        // 方案 B（治本）：区域重叠时，选「归一化距离 dist/radius 最小」的部位，
        // 即离该部位判定中心「相对最近」的那一个，消除遍历顺序依赖。
        // （eye 圆与 mouth 圆重叠时，点在嘴附近会因更靠近 mouth 中心而归 mouth）
        let best = null; // { key, part, dist, radius, score }
        for (const key of Object.keys(this.config.reactions)) {
            const part = this.config.reactions[key];
            const center = this._markerPosScreen(key);
            if (!center) continue;
            const dist = Math.hypot(p.x - center.x, p.y - center.y);
            const radius = this._effectiveRadius(part);
            if (dist < radius) {
                const score = radius > 0 ? dist / radius : Infinity; // 归一化：越靠近中心越小
                if (!best || score < best.score) {
                    best = { key, part, dist, radius, score };
                }
            }
        }

        if (best && best.part.pool && best.part.pool.length > 0) {
            const action = this._pickAction(best.part.pool);
            if (action) {
                this._log(`🎯 命中 ${best.key} (${best.dist.toFixed(1)} < ${best.radius.toFixed(1)}, 归一化=${best.score.toFixed(2)})`);
                this._trigger(action);
                return;
            }
        }
        this._log('❌ 未命中');
    }

    _pickAction(pool) {
        if (!Array.isArray(pool) || pool.length === 0) return null;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    // ---- 触发 + 恢复 ----

    _trigger(action) {
        if (this.busy) return;
        this.busy = true;
        this._applyAction(action);

        const audioPromise = action.audio
            ? this.audio.loadAndPlay(action.audio)
            : Promise.resolve(null);

        audioPromise.then((buffer) => {
            const audioMs = buffer && buffer.duration ? buffer.duration * 1000 : 0;
            const holdMs = Math.max(action.duration || 0, audioMs, DEFAULT_HOLD_MS);
            this._log(`  保持 ${holdMs.toFixed(0)}ms 后恢复`);
            setTimeout(() => this._restore(action), holdMs);
        }).catch((err) => {
            console.error('动作执行出错:', err);
            this.busy = false;
        });
    }

    /** 应用动作：时间线 + 差分槽 + 变量（对齐 readme: setVariable(label, value, ms)） */
    _applyAction(action) {
        const { player } = this;
        if (action.timeline) player.mainTimelineLabel = action.timeline;
        if (action.diffSlot1 !== undefined) player.diffTimelineSlot1 = action.diffSlot1 || '';
        if (action.diffSlot2 !== undefined) player.diffTimelineSlot2 = action.diffSlot2 || '';

        (action.variables || []).forEach((item) => {
            const apply = () => {
                if (this._validVariables.size > 0 && !this._validVariables.has(item.name)) {
                    this._warn(`⚠️ 变量 "${item.name}" 不在模型中，跳过`); return;
                }
                // ★ 对齐 readme setVariable(label, value, ms = 0, easing = 0)
                player.setVariable(item.name, item.value, item.duration || DEFAULT_FADE_TIME);
                this._log(`  ${item.name} = ${item.value} (${item.duration || DEFAULT_FADE_TIME}ms)`);
            };
            if (item.delay > 0) setTimeout(apply, item.delay); else apply();
        });
    }

    /**
     * 恢复：defaultState 兜底 + recovery 覆盖
     * recovery 特殊控制名：__timeline / __diffSlot1 / __diffSlot2
     */
    _restore(action) {
        const { player } = this;
        const def = this.config.defaultState;
        const recovery = (action && action.recovery) || [];

        // ---- 时间线 / 差分槽复位 ----
        const recTimeline = recovery.find((v) => v && v.name === '__timeline');
        const recSlot1 = recovery.find((v) => v && v.name === '__diffSlot1');
        const recSlot2 = recovery.find((v) => v && v.name === '__diffSlot2');

        player.mainTimelineLabel = recTimeline && recTimeline.value != null
            ? recTimeline.value : (def && def.timeline) || '';
        player.diffTimelineSlot1 = recSlot1 && recSlot1.value != null
            ? recSlot1.value : (def && def.diffSlot1) || '';
        player.diffTimelineSlot2 = recSlot2 && recSlot2.value != null
            ? recSlot2.value : (def && def.diffSlot2) || '';

        // ---- 变量复位：recovery 优先，否则 defaultState ----
        const recoveryMap = new Map(
            recovery.filter((v) => v && v.name && !v.name.startsWith('__'))
                .map((v) => [v.name, v])
        );
        const changedNames = new Set((action && action.variables || []).map((v) => v.name));

        changedNames.forEach((name) => {
            const source = recoveryMap.get(name)
                || (def && def.variables || []).find((v) => v.name === name);
            if (!source) return;
            if (this._validVariables.size > 0 && !this._validVariables.has(name)) return;
            // ★ 对齐 readme: setVariable(label, value, ms)
            player.setVariable(name, source.value, source.duration || DEFAULT_FADE_TIME);
            this._log(`  ↺ ${name} = ${source.value} (${source.duration || DEFAULT_FADE_TIME}ms)`);
        });

        this._log('🔄 已恢复');
        this.audio.stop();
        this.busy = false;
    }
}

// ============================================================
//  手臂姿势切换器（右下角小面板 + 全局 API）
// ============================================================
function installArmPoseSwitcher(player, config, host) {
    // ① 区按「互斥选择器」分组：一行一个 selector，按钮直接用模型自己的选项名。
    // 不再把多个组的选项拍平成一排、也不再套「抱臂 / 垂手」这种自造语义
    // （椎名まゆりac 同时有 hat_type 和 arm_type，拍平后按钮会切到帽子上）。
    // host 传入时挂进侧面板（默认收起的控制台），否则仍是右下角浮层。
    const SELS = (ModelLoader.getSelectorInfo && ModelLoader.getSelectorInfo()) || [];
    const shortOpt = (o) => String(o || '').replace(/^fade_/, '')
        .replace(/^arm_type_/, '').replace(/_type_/, '_') || '默认';
    const POSES = [];
    SELS.forEach((s) => (s.options || []).forEach((o) =>
        POSES.push({ selector: s.label, option: o, label: shortOpt(o) })));

    // 模型没有任何互斥追加部件组：不显示切换面板，
    // 但仍保留全局 API，调用时给出明确错误而不是静默失败。
    if (!ModelLoader.getArmPose() || !POSES.length) {
        window.setArmPose = async () => {
            throw new Error('当前模型没有互斥追加部件组，无法切换姿势');
        };
        window.getArmPose = () => null;
        window.setOption = async () => {
            throw new Error('当前模型没有互斥追加部件组，无法切换选项');
        };
        window.getSelectors = () => [];
        console.info('[E-mote] 当前模型没有互斥追加部件组，已跳过姿势切换器');
        return null;
    }

    const box = document.createElement('div');
    box.id = 'arm-pose-switcher';
    box.style.cssText = host
        ? ['display:flex', 'flex-wrap:wrap', 'gap:6px', 'padding:0',
           'font:12px/1.2 system-ui,-apple-system,sans-serif', 'user-select:none'].join(';')
        : ['position:fixed', 'right:18px', 'bottom:18px', 'z-index:20',
           'display:flex', 'flex-wrap:wrap', 'gap:8px', 'padding:8px',
           'background:rgba(18,20,26,.62)', 'border:1px solid rgba(255,255,255,.18)',
           'border-radius:10px', 'backdrop-filter:blur(6px)',
           'font:13px/1.2 system-ui,-apple-system,sans-serif',
           'user-select:none'].join(';');

    const keyOf = (p) => p.selector + '\u0000' + p.option;
    const buttons = {};
    const sync = () => {
        const st = (window.ArmPoseGL && window.ArmPoseGL.getState()) || {};
        POSES.forEach((p) => {
            const b = buttons[keyOf(p)];
            if (!b) return;
            const active = st[p.selector] === p.option;
            b.style.background = active ? '#d9603b' : 'rgba(255,255,255,.10)';
            b.style.color = active ? '#fff' : 'rgba(255,255,255,.82)';
            b.style.borderColor = active ? '#d9603b' : 'rgba(255,255,255,.22)';
            b.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    };
    // 时间线桥改 GPU 状态时按钮高亮跟着走：侧边栏「差分槽」播放
    // 「携帯入力」时，① 区会显示当前生效的拇指，而不只是画面在动。
    window.addEventListener('emote-selector-change', () => sync());

    SELS.forEach((s) => {
        const row = document.createElement('div');
        row.style.cssText = ['display:flex', 'flex-wrap:wrap', 'align-items:center',
            'gap:6px', 'width:100%'].join(';');
        if (SELS.length > 1) {
            const tag = document.createElement('span');
            tag.textContent = s.label;
            tag.title = s.label + '（' + (s.options || []).length + ' 个互斥选项）';
            tag.style.cssText = ['min-width:78px', 'font-size:11px', 'opacity:.7',
                'font-family:ui-monospace,SFMono-Regular,monospace'].join(';');
            row.appendChild(tag);
        }
        (s.options || []).forEach((o) => {
            const p = { selector: s.label, option: o, label: shortOpt(o) };
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = p.label;
            btn.title = s.label + ' = ' + o;
            btn.dataset.pose = o;
            btn.dataset.selector = s.label;
            btn.style.cssText = [
                'padding:7px 14px', 'border:1px solid', 'border-radius:7px',
                'cursor:pointer', 'font:inherit', 'transition:background .15s,color .15s',
            ].join(';');
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const st = (window.ArmPoseGL && window.ArmPoseGL.getState()) || {};
                if (st[s.label] === o) return;
                btn.disabled = true;
                try {
                    await ModelLoader.setOption(s.label, o);
                    sync();
                    if (config.debug) console.log('互斥选项 →', s.label, o);
                } catch (err) {
                    console.error('互斥选项切换失败:', err);
                } finally {
                    btn.disabled = false;
                }
            });
            row.appendChild(btn);
            buttons[keyOf(p)] = btn;
        });
        box.appendChild(row);
    });
    (host || document.body).appendChild(box);
    sync();

    // 控制台 / 外部脚本也能切：await setArmPose('fade_arm_c')，旧别名 crossed 仍兼容
    window.setArmPose = async (pose) => {
        const p = await ModelLoader.setArmPose(pose);
        sync();
        return p;
    };
    window.getArmPose = () => ModelLoader.getArmPose();
    // 通用 API：直接给任意互斥选择器指定选项
    window.setOption = async (selector, option) => {
        const r = await ModelLoader.setOption(selector, option);
        sync();
        return r;
    };
    window.getSelectors = () => ModelLoader.getSelectorInfo();
    window.getPoseList = () => ModelLoader.getPoseList();
    window.getArmPoseGL = () => window.ArmPoseGL && window.ArmPoseGL.info();
    sync();
    return box;
}

// ============================================================
//  侧边控制台：默认收起，展开后控制模型全部差分 / 变量 / 部件 / 时间线
// ------------------------------------------------------------
//  数据源：
//   ① ModelLoader.getModelInventory() —— 从模型 zip 的 PSB 结构区读出
//      「全部」customSelectorList（含 optionList 的 on/offValue）与 customPartsList
//   ② ModelLoader.getSelectorInfo()  —— GPU 纹理补丁接管的互斥追加部件组
//   ③ player.variableList / *TimelineLabels —— 3.9.8 SDK 自己认识的变量与时间线
//  GPU 组用 setSelector（绝不写 fade 变量，否则会出现底层差分叠影）；
//  原生组按 4.0 选择器语义，把选中项写 onValue、其它项写 offValue。
// ============================================================
function installDevPanel(player, config) {
    const inv = (ModelLoader.getModelInventory && ModelLoader.getModelInventory()) || null;
    const gpuSels = (ModelLoader.getSelectorInfo && ModelLoader.getSelectorInfo()) || [];
    const gpuLabels = new Set(gpuSels.map((s) => s.label));
    const gpuVars = new Set();
    gpuSels.forEach((s) => (s.options || []).forEach((o) => gpuVars.add(o)));

    const shortName = (v) => {
        const s = String(v || '').replace(/^fade_/, '').replace(/^arm_type_/, '')
            .replace(/_type_/, '_');
        return s || '默认';
    };
    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    };
    const btn = (text) => {
        const b = el('button', 'ed-btn', text);
        b.type = 'button';
        return b;
    };
    const section = (title, hint, fold) => {
        const wrap = el(fold ? 'details' : 'section', fold ? 'ed-sec ed-fold' : 'ed-sec');
        wrap.appendChild(el(fold ? 'summary' : 'h3', 'ed-title', title));
        const body = el('div', 'ed-body');
        if (hint) body.appendChild(el('p', 'ed-hint', hint));
        wrap.appendChild(body);
        return { wrap, body };
    };

    // ---- 样式（只在第一次注入）----
    if (!document.getElementById('emote-dev-style')) {
        const st = document.createElement('style');
        st.id = 'emote-dev-style';
        st.textContent = `
/* 顶部 56px 留给 scene-ui.js 的角色 tab 控制条（含常驻「主页」与 hover 滑出的按钮），
   否则展开控制台时标题栏与「收起 ›」会被控制条完全盖住、点不到。 */
#emote-dev-panel{position:fixed;top:56px;right:0;height:calc(100vh - 56px);width:340px;max-width:92vw;
 z-index:60;display:flex;flex-direction:column;color:#eceff4;
 background:rgba(17,19,26,.95);border-left:1px solid rgba(255,255,255,.14);
 box-shadow:-14px 0 36px rgba(0,0,0,.38);backdrop-filter:blur(12px);
 font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
 transform:translateX(100%);transition:transform .28s cubic-bezier(.2,.8,.2,1)}
#emote-dev-panel.open{transform:translateX(0)}
#emote-dev-tab{position:absolute;left:-38px;top:38%;width:38px;height:118px;
 border:1px solid rgba(255,255,255,.18);border-right:0;border-radius:10px 0 0 10px;
 background:rgba(17,19,26,.92);color:#eceff4;cursor:pointer;
 writing-mode:vertical-rl;text-orientation:mixed;letter-spacing:2px;
 font:12px/1 system-ui,sans-serif;box-shadow:-6px 0 18px rgba(0,0,0,.3)}
#emote-dev-tab:hover{background:#2a2f3d}
#emote-dev-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
 padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.12)}
#emote-dev-head b{font-size:14px}
#ed-model{display:block;font-size:11px;opacity:.6;margin-top:2px;word-break:break-all}
#ed-close{flex:none}
#emote-dev-body{flex:1;overflow:auto;padding:12px 14px 32px}
.ed-sec{margin-bottom:12px;border:1px solid rgba(255,255,255,.1);border-radius:10px;
 background:rgba(255,255,255,.035);padding:10px}
.ed-title{font-size:12px;font-weight:600;letter-spacing:.3px;margin:0 0 6px}
.ed-hint{font-size:11px;opacity:.6;margin:0 0 8px}
.ed-note{font-size:11px;opacity:.65;margin:6px 0}
.ed-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}
.ed-label{min-width:92px;font-size:11px;opacity:.72}
.ed-btn{padding:5px 10px;border:1px solid rgba(255,255,255,.2);border-radius:6px;
 background:rgba(255,255,255,.08);color:#eceff4;cursor:pointer;
 font:12px/1.2 system-ui,sans-serif;transition:background .15s}
.ed-btn:hover{background:rgba(255,255,255,.16)}
.ed-btn.active{background:#d9603b;border-color:#d9603b;color:#fff}
.ed-slider{flex:1;min-width:80px;accent-color:#d9603b}
.ed-val{width:30px;text-align:right;font-size:11px;opacity:.8;font-variant-numeric:tabular-nums}
.ed-select{max-width:150px;padding:3px 6px;border:1px solid rgba(255,255,255,.18);
 border-radius:6px;background:rgba(0,0,0,.3);color:#eceff4;font:11px system-ui,sans-serif}
/* ④ 时间线：每行「标签 + 一个下拉」，三个下拉左 / 右边缘严格对齐，
   不允许换行（换行会把第二个差分槽甩到下一行左侧、且没有标签）。
   flex-basis:0 让不同选项长度的 select 也得到完全相同的宽度。 */
.ed-row.ed-row-tl{flex-wrap:nowrap}
.ed-row-tl .ed-label{flex:0 0 92px;min-width:92px}
.ed-row-tl .ed-select{flex:1 1 0;width:auto;max-width:none;min-width:0}
.ed-search{width:100%;box-sizing:border-box;padding:5px 8px;margin-bottom:6px;
 border:1px solid rgba(255,255,255,.18);border-radius:6px;
 background:rgba(0,0,0,.25);color:#eceff4;font:12px system-ui,sans-serif}
.ed-parts{max-height:220px;overflow:auto}
.ed-part{padding:3px 4px;border-bottom:1px dashed rgba(255,255,255,.08);
 font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-foot{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
details.ed-fold>summary{cursor:pointer;list-style:none}
details.ed-fold>summary::-webkit-details-marker{display:none}
details.ed-fold>summary::before{content:'\\25B8 ';opacity:.7}
details.ed-fold[open]>summary::before{content:'\\25BE '}
`;
        document.head.appendChild(st);
    }

    // ---- 骨架 ----
    const panel = el('aside');
    panel.id = 'emote-dev-panel';
    panel.setAttribute('aria-hidden', 'true');
    const tab = el('button', '', '控制台');
    tab.id = 'emote-dev-tab';
    tab.type = 'button';
    tab.title = '展开 / 收起控制台';
    tab.setAttribute('aria-expanded', 'false');
    const head = el('div');
    head.id = 'emote-dev-head';
    const titleBox = el('div');
    titleBox.appendChild(el('b', '', '控制台'));
    const modelLine = el('span', '', (inv && inv.model) || '—');
    modelLine.id = 'ed-model';
    titleBox.appendChild(modelLine);
    const close = btn('收起 ›');
    close.id = 'ed-close';
    head.appendChild(titleBox);
    head.appendChild(close);
    const body = el('div');
    body.id = 'emote-dev-body';
    panel.appendChild(tab);
    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);

    // ---- ① 互斥追加部件（GPU 补丁）----
    const secGpu = section('① 互斥部件 · GPU 补丁',
        gpuSels.length
            ? gpuSels.map((s) => s.label + '（' + (s.options || []).length + ' 选项）').join(' / ')
              + '：由纹理补丁接管'
            : '本模型没有互斥追加部件组');
    const gpuHost = el('div');
    gpuHost.id = 'ed-gpu-host';
    secGpu.body.appendChild(gpuHost);
    if (!gpuSels.length) {
        secGpu.body.appendChild(el('p', 'ed-note', '原生差分与变量仍可在下方控制。'));
    }
    secGpu.wrap.id = 'ed-sec-gpu';
    body.appendChild(secGpu.wrap);

    // ---- ② 3.9.8 原生差分（全部 customSelectorList）----
    const nativeSels = inv
        ? inv.selectors.filter((s) => !gpuLabels.has(s.label) && s.options.length)
        : [];
    const secNative = section('② 原生差分 · 3.9.8',
        nativeSels.length + ' 组：按 4.0 选择器的 on/off 值写 SDK 变量');
    const nativeReset = [];
    nativeSels.forEach((sel) => {
        const row = el('div', 'ed-row');
        row.appendChild(el('span', 'ed-label', sel.label));
        const btns = [];
        sel.options.forEach((o, i) => {
            const b = btn(shortName(o.label));
            b.title = o.label || '(无变量名：关闭该组附加差分)';
            b.addEventListener('click', () => {
                sel.options.forEach((x, j) => {
                    if (!x.label) return;
                    player.setVariable(x.label, j === i ? x.on : x.off, 0);
                });
                btns.forEach((x, k) => x.classList.toggle('active', k === i));
                if (config.debug) {
                    console.log('[DevPanel]', sel.label, '→', o.label || '(默认)');
                }
            });
            btns.push(b);
            row.appendChild(b);
        });
        // 初始高亮：用 SDK 当前变量值反推选中项
        let active = 0;
        sel.options.forEach((o, i) => {
            if (o.label && Math.abs(Number(player.getVariable(o.label)) - o.on) < 0.5) active = i;
        });
        if (btns[active]) btns[active].classList.add('active');
        nativeReset.push(() => btns[0] && btns[0].click());
        secNative.body.appendChild(row);
    });
    if (!nativeSels.length) {
        secNative.body.appendChild(el('p', 'ed-note', '没有额外的原生差分组。'));
    }
    secNative.wrap.id = 'ed-sec-native';
    body.appendChild(secNative.wrap);

    // ---- ③ 3.9.8 变量微调 ----
    const vars = (player.variableList || []).filter((v) => !gpuVars.has(v.label));
    const secVars = section('③ 变量微调 · 3.9.8',
        vars.length + ' 个变量（互斥组变量已排除，避免叠影）', true);
    const sliders = [];
    vars.forEach((v) => {
        const row = el('div', 'ed-row');
        row.appendChild(el('span', 'ed-label', shortName(v.label)));
        const range = el('input', 'ed-slider');
        range.type = 'range';
        range.min = '0';
        range.max = '100';
        range.step = '1';
        let cur = Number(player.getVariable(v.label));
        if (!isFinite(cur)) cur = 0;
        range.value = String(Math.max(0, Math.min(100, Math.round(cur))));
        const val = el('span', 'ed-val', range.value);
        range.title = v.label;
        range.addEventListener('input', () => {
            val.textContent = range.value;
            player.setVariable(v.label, Number(range.value), 0);
        });
        row.appendChild(range);
        row.appendChild(val);
        secVars.body.appendChild(row);
        sliders.push({ v, range, val });
    });
    const refresh = btn('读取当前值');
    refresh.addEventListener('click', () => sliders.forEach((s) => {
        const x = Number(player.getVariable(s.v.label));
        if (isFinite(x)) {
            s.range.value = String(Math.max(0, Math.min(100, Math.round(x))));
            s.val.textContent = s.range.value;
        }
    }));
    const zero = btn('全部归零');
    zero.addEventListener('click', () => sliders.forEach((s) => {
        s.range.value = '0';
        s.val.textContent = '0';
        player.setVariable(s.v.label, 0, 0);
    }));
    const varFoot = el('div', 'ed-foot');
    varFoot.appendChild(refresh);
    varFoot.appendChild(zero);
    secVars.body.appendChild(varFoot);
    secVars.wrap.id = 'ed-sec-vars';
    body.appendChild(secVars.wrap);

    // ---- ④ 时间线 ----
    const mains = (player.mainTimelineLabels || []).slice();
    const diffs = (player.diffTimelineLabels || []).slice();
    const secTl = section('④ 时间线',
        mains.length + ' 条主时间线 / ' + diffs.length + ' 条差分', true);
    const mkSelect = (labels, current, onPick) => {
        const sel = el('select', 'ed-select');
        const empty = el('option', '', '（无）');
        empty.value = '';
        sel.appendChild(empty);
        labels.forEach((l) => {
            const o = el('option', '', l);
            o.value = l;
            sel.appendChild(o);
        });
        sel.value = current || '';
        sel.addEventListener('change', () => onPick(sel.value));
        return sel;
    };
    // 一个槽一行：各自带名称，且三个下拉共用同一列，避免换行后第二个槽跑到左侧无名状态。
    const addTlRow = (label, tip, labels, current, onPick) => {
        const row = el('div', 'ed-row ed-row-tl');
        const lab = el('span', 'ed-label', label);
        lab.title = tip;
        row.appendChild(lab);
        row.appendChild(mkSelect(labels, current, onPick));
        secTl.body.appendChild(row);
        return row;
    };
    addTlRow('主时间线', '模型的主时间线（待机 / 呼吸等）', mains, player.mainTimelineLabel,
        (v) => { player.mainTimelineLabel = v; });
    addTlRow('差分槽 1', '与主时间线同时播放的第一条差分时间线', diffs, player.diffTimelineSlot1,
        (v) => { player.diffTimelineSlot1 = v; });
    addTlRow('差分槽 2', '与主时间线同时播放的第二条差分时间线（与槽 1 相互独立）',
        diffs, player.diffTimelineSlot2, (v) => { player.diffTimelineSlot2 = v; });
    secTl.wrap.id = 'ed-sec-timeline';
    body.appendChild(secTl.wrap);

    // ---- ⑤ 全部部件清单（只读 + 过滤）----
    const parts = inv ? inv.parts : [];
    const secParts = section('⑤ 部件清单 · 全部',
        parts.length + ' 个 customPartsList 部件（只读，显示变量锚点）', true);
    const search = el('input', 'ed-search');
    search.type = 'search';
    search.placeholder = '过滤部件名 / 变量名';
    const list = el('div', 'ed-parts');
    const rows = parts.map((p) => {
        const d = el('div', 'ed-part',
            '#' + (p.id == null ? '?' : p.id) + '  ' + (p.label || '(无名称)')
            + (p.variables.length ? '  ·  ' + p.variables.join(', ') : ''));
        d.dataset.key = ((p.label || '') + ' ' + p.variables.join(' ')).toLowerCase();
        list.appendChild(d);
        return d;
    });
    search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        rows.forEach((d) => {
            d.style.display = (!q || d.dataset.key.indexOf(q) >= 0) ? '' : 'none';
        });
    });
    secParts.body.appendChild(search);
    secParts.body.appendChild(list);
    secParts.wrap.id = 'ed-sec-parts';
    body.appendChild(secParts.wrap);

    // ---- 底部：恢复默认 ----
    const reset = btn('恢复默认差分');
    reset.addEventListener('click', async () => {
        try {
            const poses = ModelLoader.getPoseList();
            if (poses.length && window.setArmPose) await window.setArmPose(poses[0].name);
        } catch (e) {
            console.warn('[DevPanel] 互斥组恢复失败（可能本模型没有该组）', e);
        }
        nativeReset.forEach((f) => f());
    });
    const footAll = el('div', 'ed-foot');
    footAll.appendChild(reset);
    body.appendChild(footAll);

    // ---- 展开 / 收起 ----
    function setOpen(v) {
        panel.classList.toggle('open', v);
        panel.setAttribute('aria-hidden', v ? 'false' : 'true');
        tab.setAttribute('aria-expanded', String(v));
    }
    tab.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
    close.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setOpen(false);
    });
    // 面板内的交互不要冒泡到角色点击/拖拽逻辑
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    panel.addEventListener('click', (e) => e.stopPropagation());

    window.openDevPanel = () => setOpen(true);
    window.closeDevPanel = () => setOpen(false);
    window.toggleDevPanel = () => setOpen(!panel.classList.contains('open'));
    window.getDevPanel = () => ({
        open: panel.classList.contains('open'),
        model: inv && inv.model,
        selectorCount: inv && inv.selectorCount,
        gpuSelectors: gpuSels.map((s) => s.label),
        nativeSelectors: nativeSels.map((s) => s.label),
        variableCount: vars.length,
        partCount: parts.length,
        timelineCount: mains.length + diffs.length,
    });
    console.info('[DevPanel] 侧边控制台已就位（默认收起）：'
        + (inv ? inv.partCount + ' 部件 / ' + inv.selectorCount + ' 差分组' : '无部件清单'));
    return { panel, tab, gpuHost, setOpen };
}

// ============================================================
//  配置组装
// ============================================================
function createConfig(actionsConfig, modelUrl) {
    return {
        debug: actionsConfig.debug !== false,
        model: { url: modelUrl || MODEL_PSB, scale: 0.8 },
        armPose: DEFAULT_ARM_POSE,
        transform: {
            minScaleFactor: 0.5,
            maxScaleFactor: 2.0,
            zoomStep: 0.1,
            verticalOffsetRatio: 0.42,
        },
        eyeTrack: {
            eyeLRFactor: 1 / 3, eyeUDFactor: 1 / 3,
            headThreshold: 60, headLRFactor: 1 / 6, headUDFactor: 1 / 6, headSlantFactor: 1 / 12,
            bodyThreshold: 120, bodyLRFactor: 1 / 9, bodyUDFactor: 1 / 9, bodySlantFactor: 1 / 18,
            fadeTime: 500,
        },
        lipsync: { enabled: true, gain: 3.0, smoothMs: 30, updateFps: 30 },
        reactions: actionsConfig.reactions || {},
        defaultState: actionsConfig.defaultState || null,
    };
}

// ============================================================
//  启动（严格遵循 SDK 三步契约）
// ============================================================
async function start() {
    const hideLoading = () => { if (window.SG_LOADING) window.SG_LOADING.hide(); };
    const actionsConfig = resolveActionsConfig();
    if (!actionsConfig) { hideLoading(); return; }
    if (!validateActionsConfigSafe(actionsConfig)) { hideLoading(); return; }

    // 没指定模型时先问 data/ 的扫描结果：用第一个可用模型，不依赖任何写死的路径
    const modelUrl = await resolveModelUrl();
    if (!modelUrl) {
        hideLoading();
        console.error('❌ data/ 目录里没有找到可用的模型文件');
        alert('没有找到可用的模型：请检查 data/<角色>/ 下是否有模型文件');
        return;
    }

    const config = createConfig(actionsConfig, modelUrl);
    const canvas = document.getElementById('canvas');
    if (!canvas) { console.error('Canvas 不存在'); hideLoading(); return; }

    // ① createRenderCanvas（固定缓冲尺寸，DPR 缩放受 8192 约束）
    const dpr = window.devicePixelRatio || 1;
    const BUF_W = Math.min(Math.round(window.innerWidth * dpr), MAX_TEXTURE_SIZE);
    const BUF_H = Math.min(Math.round(window.innerHeight * dpr), MAX_TEXTURE_SIZE);
    EmotePlayer.createRenderCanvas(BUF_W, BUF_H);

    // ② new EmotePlayer
    const player = new EmotePlayer(canvas);
    player.scale = config.model.scale != null ? config.model.scale : 0.8;
    player.convolveCanvasMovementToPhysics = true;

    // 切换模型走整页重载，浏览器会销毁整个文档；这里再显式走一遍 SDK 释放链
    // （EmotePlayer_Finish → EmoteDevice_Finish → GL.deleteContext），
    // 让 wasm 模型数据与 WebGL 纹理在导航前就归还，避免新旧页面短暂共存时的峰值。
    // persisted=true 表示页面进入 bfcache（按后退还能恢复），此时绝不能销毁。
    window.addEventListener('pagehide', function (evt) {
        if (evt.persisted) return;
        try { player.destroy(); } catch (_) { /* 卸载阶段 wasm 可能已拆除 */ }
    }, { once: true });

    // ③ loadData（原始模型）+ GPU 纹理层手臂补丁
    ModelLoader.attach(player, config.model.url, config.armPose)
        .then((pose) => {
            // 3.9.8 无法真正插入/删除部件，追加部件的显隐由纹理补丁接管。
            // 差分时间线若写的是 GPU 接管的选择器索引变量（arm_type / yubi_type），
            // SelectorAPI 的时间线桥会逐帧把值同步到 GPU 状态，可以正常播放。
            player.diffTimelineSlot3 = '';
            player.diffTimelineSlot4 = '';

            if (config.debug) window.player = player;
            console.log('armPose:', pose, '| armGL:', window.ArmPoseGL && window.ArmPoseGL.info());
            console.log('charaBounds:', player.charaBounds);
            console.log('charaHeight:', player.charaHeight);

            new ResponsiveLayout(player, canvas, config);
            new InteractionManager(player, canvas, config);
            new TransformController(player, canvas, config);
            // 侧边控制台默认收起；互斥部件按钮直接挂进面板，不再单独放右下角
            const dev = installDevPanel(player, config);
            installArmPoseSwitcher(player, config, dev.gpuHost);

            if (config.debug) {
                console.log('✅ 启动完成');
                console.log('💡 可点击部位：' + Object.keys(config.reactions).join('、'));
                if (ModelLoader.getArmPose()) {
                    const sels = ModelLoader.getSelectorInfo();
                    const desc = sels.map((s) => s.label + ': '
                        + (s.options || []).map((o) => JSON.stringify(o)).join(' / ')).join(' | ');
                    console.log('💡 互斥选项：' + desc
                        + '；可用 await setOption(选择器, 选项)，或展开右侧「控制台」面板');
                    console.log('💡 自动识别到的互斥选择器：', sels);
                }
            }

            // 模型与交互全部就位后淡出中央 loading：前台等两帧首帧；
            // 后台标签页 rAF 会被节流甚至暂停，故加一条定时兜底保证一定能收起
            let loadingDone = false;
            const finishLoading = () => {
                if (loadingDone) return;
                loadingDone = true;
                hideLoading();
            };
            requestAnimationFrame(function () { requestAnimationFrame(finishLoading); });
            setTimeout(finishLoading, 320);
        })
        .catch((err) => {
            hideLoading();
            console.error('❌ 模型加载失败:', err);
            alert('模型加载失败，请检查路径、fflate.js 与模型文件');
        });
}

/** 读取 ACTIONS_CONFIG（浏览器全局 / Node require） */
function resolveActionsConfig() {
    const cfg = (typeof window !== 'undefined' && window.ACTIONS_CONFIG)
        || (typeof require !== 'undefined' && require('./actions-config.js').ACTIONS_CONFIG);
    if (!cfg) {
        console.error('❌ 未找到 ACTIONS_CONFIG');
        alert('动作配置缺失，请检查 actions-config.js 是否引入');
    }
    return cfg || null;
}

/** 安全校验（失败弹窗，不抛崩） */
function validateActionsConfigSafe(config) {
    try {
        validateActionsConfig(config);
        if (config.debug !== false) console.log('✅ 配置校验通过');
        return true;
    } catch (err) {
        console.error(err);
        alert('配置校验失败：' + err.message);
        return false;
    }
}

if (typeof window !== 'undefined') window.start = start;
