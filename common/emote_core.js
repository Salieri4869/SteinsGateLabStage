// ============================================================
//  emote_core.js —— E-mote 渲染内核（与页面 UI 无关）
//
//  依赖（必须在这些脚本之后加载）：
//    emote_config.js / emotedriver.js / emoteplayer.js
//    model_loader.js / action_config.js
//  输出：window.SGEmoteCore
//
//  create() 只做 SDK 启动必需的步骤，不碰 DOM 面板、不碰 loading、
//  不装触摸与缩放；调用方拿到 { player, config } 后自行装配页面。
//  加载顺序是 SDK 硬契约，不能由 JSON 配置改变。
// ============================================================
(function (root) {
    'use strict';

    var MAX_TEXTURE_SIZE = 8192;

    /* 动画主循环：emote_config.js 的 onStartEmoteAnimation 会转发到这里 */
    function EmoteAnimationController() {
        this.device = null;
        this.requestId = null;
    }
    EmoteAnimationController.prototype.onStartEmoteAnimation = function (device) {
        this.device = device;
        this.requestId = root.requestAnimationFrame(this.drawAnimation.bind(this));
    };
    EmoteAnimationController.prototype.onStopEmoteAnimation = function () {
        if (this.requestId !== null) {
            root.cancelAnimationFrame(this.requestId);
            this.requestId = null;
        }
    };
    EmoteAnimationController.prototype.drawAnimation = function (ts) {
        if (!this.device) return;
        this.device.drawAnimation(ts);
        this.requestId = root.requestAnimationFrame(this.drawAnimation.bind(this));
    };
    if (!root.emoteAnimationController) {
        root.emoteAnimationController = new EmoteAnimationController();
    }

    /* 库存对齐用：按 charaProfile 判断部位能否定位（与 main.js 同源） */
    function rectOf(prof, key) {
        var xs = [], ys = [], found = 0;
        Object.keys(prof).forEach(function (k) {
            if (!k.startsWith(key)) return;
            var suffix = k.slice(key.length).toLowerCase();
            if (suffix.length !== 2) return;
            var v = prof[k];
            if (!Number.isFinite(v)) return;
            found++;
            if (suffix.includes('x')) xs.push(v);
            else if (suffix.includes('y')) ys.push(v);
        });
        if (found !== 4 || xs.length !== 2 || ys.length !== 2) return null;
        return { ax: Math.min.apply(null, xs), ay: Math.min.apply(null, ys),
                 bx: Math.max.apply(null, xs), by: Math.max.apply(null, ys) };
    }
    function canPlacePart(player, key) {
        var prof = (player && player.charaProfile) || {};
        return !!rectOf(prof, key) || Number.isFinite(prof[key])
            || (key === 'bust' && Number.isFinite(prof.top) && Number.isFinite(prof.bottom));
    }

    /* 基础配置：页面专属字段（transform / eyeTrack 等）由调用方自己组装覆盖 */
    function buildConfig(actionsConfig, modelUrl, overrides) {
        var cfg = {
            debug: actionsConfig.debug !== false,
            model: { url: modelUrl, scale: 0.8 },
            armPose: 'crossed',
            lipsync: { enabled: true, gain: 3.0, smoothMs: 30, updateFps: 30 },
            reactions: actionsConfig.reactions || {},
            defaultState: actionsConfig.defaultState || null
        };
        if (overrides) Object.keys(overrides).forEach(function (k) { cfg[k] = overrides[k]; });
        return cfg;
    }

    /* opts: { canvas, modelUrl, config?, configSource?, configOverrides?,
              canPlacePart?, autoDestroy? } → Promise<ctx> */
    async function create(opts) {
        opts = opts || {};
        var canvas = opts.canvas || root.document.getElementById('canvas');
        if (!canvas) throw new Error('canvas 不存在');
        var modelUrl = opts.modelUrl || (opts.config && opts.config.model && opts.config.model.url);
        if (!modelUrl) throw new Error('缺少 modelUrl');

        var config = opts.config;
        var configSource = opts.configSource || '';
        if (!config) {
            var loaded = await root.SGActionsConfig.load(modelUrl);
            if (!loaded || !loaded.config) throw new Error('动作配置缺失');
            config = buildConfig(loaded.config, modelUrl, opts.configOverrides);
            configSource = loaded.source || '';
        }

        /* emoteplayer.js 是 class 声明，属于全局词法绑定而非 window 属性，
           所以这里必须用裸标识符，不能写 root.EmotePlayer */
        if (typeof EmotePlayer === 'undefined') throw new Error('EmotePlayer 未加载');
        var dpr = root.devicePixelRatio || 1;
        var bufW = Math.min(Math.round(root.innerWidth * dpr), MAX_TEXTURE_SIZE);
        var bufH = Math.min(Math.round(root.innerHeight * dpr), MAX_TEXTURE_SIZE);
        EmotePlayer.createRenderCanvas(bufW, bufH);

        var player = new EmotePlayer(canvas);
        player.scale = config.model.scale != null ? config.model.scale : 0.8;
        player.convolveCanvasMovementToPhysics = true;

        /* 切模型走整页重载；bfcache 恢复时不能销毁 */
        if (opts.autoDestroy !== false) {
            root.addEventListener('pagehide', function (evt) {
                if (evt.persisted) return;
                try { player.destroy(); } catch (_) { /* 卸载阶段 wasm 可能已拆除 */ }
            }, { once: true });
        }

        var pose = await ModelLoader.attach(player, config.model.url, config.armPose);
        player.diffTimelineSlot3 = '';
        player.diffTimelineSlot4 = '';

        if (root.SGActionsConfig && typeof root.SGActionsConfig.reconcile === 'function') {
            try {
                var place = opts.canPlacePart || canPlacePart;
                root.SGActionsConfig.reconcile(config, player, configSource,
                    function (key) { return place(player, key); });
            } catch (err) {
                console.warn('[EmoteCore] 库存对齐失败，配置按原样使用', err);
            }
        }
        if (config.debug) root.player = player;

        return { player: player, config: config, configSource: configSource,
                 armPose: pose, canvas: canvas };
    }

    /* 响应式布局：视口高度 → 缩放（600px 0.3 / 1600px 0.9 线性），
       再用 coord 做垂直居中。缓冲层只初始化一次，之后不再改 canvas.width/height。
       opts: {
         verticalOffsetRatio —— 0.5 居中，小于 0.5 上移（默认 0.5）
         debug               —— 打印缓冲层/尺寸日志（播放页与剧情页默认关）
       } */
    function createLayout(player, canvas, opts) {
        opts = opts || {};
        var baseCoord = [player.coord[0], player.coord[1]];
        var offsetRatio = opts.verticalOffsetRatio != null ? opts.verticalOffsetRatio : 0.5;
        var debug = !!opts.debug;
        var initialized = false;
        var frame = null;

        function heightRatio(height) {
            var h1 = 600, r1 = 0.3, h2 = 1600, r2 = 0.9;
            var m = (r2 - r1) / (h2 - h1);
            return Math.max(0.05, m * height + r1 - m * h1);
        }

        function apply() {
            var body = root.document && root.document.body;
            var w = root.innerWidth || (body && body.clientWidth) || 1;
            var h = root.innerHeight || (body && body.clientHeight) || 1;
            var dpr = root.devicePixelRatio || 1;
            var bw = Math.round(w * dpr);
            var bh = Math.round(h * dpr);
            if (bw > MAX_TEXTURE_SIZE || bh > MAX_TEXTURE_SIZE) {
                var k = Math.min(MAX_TEXTURE_SIZE / bw, MAX_TEXTURE_SIZE / bh);
                bw = Math.round(bw * k);
                bh = Math.round(bh * k);
            }
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
            if (!initialized) {
                canvas.width = bw;
                canvas.height = bh;
                initialized = true;
                if (debug) console.log('🖼 缓冲层: ' + bw + '×' + bh + '（此后不变）');
            }
            player.scale = heightRatio(h);
            var c = player.coord;
            c[0] = baseCoord[0];
            c[1] = baseCoord[1] - (0.5 - offsetRatio) * bh;
            player.coord = c;
            if (typeof EmotePlayer !== 'undefined' && EmotePlayer.device) {
                EmotePlayer.device.invalidateAnimation();
            }
            if (debug) {
                console.log('📐 display=' + w + '×' + h + ' buf=' + bw + '×' + bh
                    + ' scale=' + player.scale.toFixed(3));
            }
        }

        apply();
        root.addEventListener('resize', function () {
            if (frame !== null) root.cancelAnimationFrame(frame);
            frame = root.requestAnimationFrame(function () { frame = null; apply(); });
        });
        return { apply: apply, heightRatio: heightRatio };
    }

    root.SGEmoteCore = {
        create: create,
        createLayout: createLayout,
        buildConfig: buildConfig,
        rectOf: rectOf,
        canPlacePart: canPlacePart,
        MAX_TEXTURE_SIZE: MAX_TEXTURE_SIZE
    };
})(typeof window !== 'undefined' ? window : globalThis);
