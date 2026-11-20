// ============================================================
//  story.js —— 剧情模式：场景读取、播放器、可视化编辑与保存
//
//  依赖（顺序见 index.html）：common/ 下 SDK 脚本 + emote_core.js
//
//  播放：按行渲染 role / text / voice / action，背景取场景级 background；
//        行内写 background 可临时覆盖，下一行自动回到场景背景。
//        一场可有多名角色同时在台：scene.stage 声明登场角色与横向位置，
//        每行的 role/action/voice 路由到对应角色的 player。
//  编辑：左列表选行、右面板改字段，点「保存」写盘（PUT /api/story）。
//        角色 / 背景 / 语音 / 动作全部由目录索引与 cast.json 生成下拉，
//        手打的地方只剩正文与自建动作的 timeline 名。
//        cast.json 不再是一个要去的页面：模型与语音目录在角色卡的「绑定」里改，
//        默认名在「第 N 行 · 设默认」里改，动作宏在「自定义…」里「存为宏」长出来；
//        左栏「剧本 / 角色表」两个页签，角色表用于全景核对、重命名与删除。
//        只有一个「保存」，场景与 cast.json 一次写完。
//
//  场景字段：
//    stage   [{ role, x, scale, z }]，可省略；x 为画布宽度比例（-1 左 / +1 右），
//            scale 为相对缩放，z 为叠放次序。写过 enter 的角色算中途登场、开场隐藏；
//            其余角色开场在台；之后谁上/下场由每行的 enter/exit 决定。
//            省略时按台词里出现的角色自动均分站位（兼容旧场景）。
//
//  行字段：
//    role    cast.json 的键（说话者：身份，不是显示名）——剧本、语音、模型都靠它
//    text    正文
//    name    这一句起对话框上显示的名字；省略＝沿用上一句，写空串＝回到角色默认名。
//            用来做「？？？」，改它不动 role 与任何绑定（编辑面板「第 N 行 · 显示名」）
//    voice   说话者的语音：cast[role].voiceDir 下的文件名，空/省略则不播
//    action  说话者的动作：cast[role].actions 的键，或动作对象
//            { timeline, diffSlot1, diffSlot2 } —— 字段省略＝不动它，空串＝显式清空
//    cues    同台其他角色各自的演出：{ 角色: { action, voice } }；同名条目优先于行级
//            voice/action（说话者的也适用），编辑面板「登台角色」按角色逐卡填写
//    enter   本行登场的角色名或数组（编辑面板「登台角色」卡上点「登场」，不用手打）
//    exit    本行退场的角色名或数组
//    move    本行站位调整 { 角色: x | { x, scale, z } }；省略则沿用上一句，
//            写了就持续到下一次调整（编辑面板卡里第二排：第 1 行即全场默认，灰色数字是沿用值）
//    wait    这一句在 AUTO 模式下额外停顿的毫秒（省略＝1200）；自动推进是否开启
//            由对话框上的 AUTO 开关决定，不写在台词里（旧数据的 auto 字段已废弃，读取时忽略）
// ============================================================
(function () {
    'use strict';

    var root = document.documentElement;
    var TYPE_MS = 28;             // 打字机每字间隔
    var AUTO_DEFAULT_MS = 1200;   // AUTO 开着、本行又没写 wait 时的停顿
    var AUTO_KEY = 'emote_story_auto';   // 记住上次的 AUTO 开关

    var state = {
        scenes: [], cast: null, scene: null, file: '', model: '',
        ctx: null, idx: 0, mode: 'play', ended: false, stale: false,
        sel: 0, typing: false, typeTimer: null, autoTimer: null,
        // autoOn 是播放界面的总开关（对话框右下角 AUTO），与台词无关
        autoOn: false, autoReady: false, lineVoice: null,
        introPending: false,   // 开场动画还没放完、首句尚未落字：此时 AUTO 不许抢跑
        typeDone: null, seq: 0, lineStart: 0,
        bg: null, models: null, voices: {},
        soundFolders: [], soundFiles: {},
        liveOpen: false, liveSrc: 'file', liveBusy: false, liveRole: '', blobUrl: '',
        // 多角色：actors[role] = { player, config, ... }；casting 由 scene.stage 决定
        // baseStage 是场景默认站位（只读基准），stage 是当前生效站位（会被行内 move 改写）
        actors: {}, baseStage: [], stage: [], layout: null, speaker: '', stageRaf: 0,
        voiceSeq: 0,           // 语音令牌：翻页/停播就 +1，解码晚到的旧语音据此丢弃
        // 角色表页签：当前选中的角色 / 宏；bindOpen 记哪些角色卡展开了「绑定」
        castSel: '', castAct: null, bindOpen: {}, tab: 'script',
        // 对话框（MSG WIN）实例：init 之后才有，重播开场要用
        dialog: null
    };
    // 每个角色一台音频播放器：各自解码、各自驱动自己的口型，台词里的多人语音不会互相打断
    var audioPool = {};

    // 变量缺省时长（ms）：新建变量、粘贴导入缺 duration、演出兜底都用它，
    // 与 stage 的 DEFAULT_FADE_TIME 保持一致，避免 0 导致瞬间跳变。
    var DEFAULT_VAR_DURATION = 300;

    /* 眨眼：只做「跟随 + 补眼皮」，节奏全交给 wasm 自带的自动眨眼。
       实测（2026-11-20）：
         · SDK 每 1.3–3s 以 10 帧一组的曲线把 face_eye_open 从**基线**抬到 10 再落回基线
           （基线不一定是 0：表情会把它抬高，鈴羽「生气」=2、紅莉栖「吃惊」=8），
           红莉栖和鈴羽**都会**被推（此前「鈴羽不动」是测在 hide=true 上，假象）。
         · 这一路只驱动单数 face_eye_open（眼内阴影/瞳线/高光）；
           真正闭眼的是 face_eye_open_l / _r（左右眼睑线，0 睁 / 10 閉じ / 55 全闭）。
       实现用 setVariableDiff（module = BLINK_MODULE）：diff 叠加在「当前基准」上，
       所以动作 variables 正在渐变、dev panel 手动调表情这两个写入方都不用避让，
       停手时把 diff 写回 0，当前基准自己就露出来了，不需要快照、也不需要还原 base。
         · 唯一纪律：diff 常驻、没有 remove 接口 → 每个退出路径都必须显式写 0
           （stopBlink / 动作换掉眼皮变量 / 关闭眨眼），漏一处就永久带偏移量。
         · 绝不与 setVariable 混写同一个 label：两者相加，会重复计入。
       gate 只回答「这个动作结束时眼皮本来闭着吗」，用作模型未就绪时的兜底；
       数值计算一律读实时基准。眼皮本来就已经闭着（基准 ≥ closeValue，如 閉じ / 笑閉じ）
       就不跟，等于自然不眨。 */
    var DEFAULT_BLINK = {
        closeValue: 10      // 满闭值：閉じ = 10（frameList：0 睁 / 5 半闭 / 10 全闭 / 20 笑闭）
    };
    var BLINK_KEYS = ['closeValue'];
    var BLINK_MODULE = 'blink';                              // diff 的 module 名：读写必须一致
    var BLINK_TRACK = 'face_eye_open';                       // SDK 自动眨眼驱动的那个变量
    var BLINK_VARS = ['face_eye_open_l', 'face_eye_open_r']; // 眼皮线那一对
    var BLINK_FULL = 10;            // track 抬到 10 视为完全闭上（模型 frameList 的「閉じ」）
    var BLINK_EPS = 0.05;           // diff 变化小于这个值就不写，避免逐帧抖动
    var BLINK_TOP_MS = 250;         // 顶着满闭超过这个时长 → 不是眨眼，是动作把 track 压住了；同时兼作快变后的「不认漂移」静默期
    var BLINK_DRIFT_RATE = 0.015;   // 位移慢于这个速率(单位/ms)=表情渐变,算基线漂移,不算眨眼
    var BLINK_MIN_SPAN = 1.2;       // 基线离满闭不到这么多 → 没有可眨的行程，不补 diff

    function $(id) { return document.getElementById(id); }
    function apiUrl(name) {
        return '/api/story' + (name ? '?name=' + encodeURIComponent(name) : '');
    }
    function msg(text) {
        $('st-msg').textContent = text || '';
        if (text) {
            setTimeout(function () {
                if ($('st-msg').textContent === text) $('st-msg').textContent = '';
            }, 4000);
        }
    }
    function firstRole(cast) {
        return Object.keys(cast || {}).filter(function (k) {
            return k !== 'doc' && k.charAt(0) !== '_';
        })[0] || '';
    }
    function modelOf(scene, cast) {
        var role = (scene.lines && scene.lines[0] && scene.lines[0].role) || firstRole(cast);
        return (cast[role] && cast[role].model) || '';
    }

    /* ---------- 多角色登场 ---------- */

    /* 把 scene.stage 归一化；缺省则从台词里出现的角色按先后均分站位，兼容旧场景。
       每项：{ role, x(-1..1), scale, z }；旧数据的 show 字段忽略 */
    function stageOf(scene, cast) {
        var declared = scene && scene.stage;
        var out = [];
        if (Array.isArray(declared) && declared.length) {
            declared.forEach(function (s, i) {
                if (!s || !s.role || !(cast && cast[s.role] && cast[s.role].model)) return;
                out.push({
                    role: s.role,
                    x: Number.isFinite(s.x) ? s.x : 0,
                    scale: Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1,
                    z: Number.isFinite(s.z) ? s.z : 0
                });
            });
        }
        if (!out.length) {
            var seen = {}, roles = [];
            (((scene && scene.lines) || [])).forEach(function (l) {
                var r = l.role || firstRole(cast);
                if (r && cast && cast[r] && cast[r].model && !seen[r]) { seen[r] = 1; roles.push(r); }
            });
            roles.forEach(function (r, i) {
                out.push({ role: r,
                    x: roles.length > 1 ? (i / (roles.length - 1)) * 1.2 - 0.6 : 0,
                    scale: 1, z: 0 });
            });
        }
        return out;
    }

    function cloneStage(list) {
        return (list || []).map(function (s) {
            return { role: s.role, x: s.x, scale: s.scale, z: s.z };
        });
    }
    function slotOf(role) {
        for (var i = 0; i < state.stage.length; i++) {
            if (state.stage[i].role === role) return state.stage[i];
        }
        return null;
    }
    function baseSlotOf(role) {
        for (var i = 0; i < state.baseStage.length; i++) {
            if (state.baseStage[i].role === role) return state.baseStage[i];
        }
        return null;
    }
    /* 行内站位写法：数字 = 只改 x；对象 = { x, scale, z }，只写要改的字段 */
    function moveOf(v) {
        if (typeof v === 'number' && isFinite(v)) return { x: v };
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        return null;
    }
    function cancelStageTween() {
        if (state.stageRaf) {
            window.cancelAnimationFrame(state.stageRaf);
            state.stageRaf = 0;
        }
    }

    /* 一台 device 上的 wasm 不能整体重建；场景需要「没加载过的模型」时整页重载。
       castingKey 只描述本场用到的 角色→模型 绑定，与位置/显隐无关。 */    function castingKey(stage, cast) {
        return stage.map(function (s) {
            return s.role + '=' + ((cast[s.role] && cast[s.role].model) || '');
        }).sort().join('|');
    }

    /* cast.json 里所有绑定了模型的可登场角色（编辑登场阵容用，不限于当前已加载的） */
    function castRoles() {
        return Object.keys(state.cast || {}).filter(function (r) {
            return r !== 'doc' && !!(state.cast[r] && state.cast[r].model);
        });
    }
    /* 当前已经加载了模型、可安全用于「说话/动作/语音」的角色 id */
    function liveRoles() {
        return Object.keys(state.actors).filter(function (r) { return !!state.actors[r].player; });
    }
    function playerOf(role) {
        var a = state.actors[role];
        return a && a.player;
    }
    /* ---- 每个角色一台播放器：语音与口型都落到他自己身上 ---- */
    function audioFor(role) {
        if (!role || !window.AudioPlayer) return null;
        if (!audioPool[role]) {
            audioPool[role] = new window.AudioPlayer(
                { lipsync: { enabled: true, gain: 3.0, smoothMs: 30, updateFps: 30 } },
                function () { return playerOf(role); });
        }
        return audioPool[role];
    }
    /* 停掉所有语音，并把「当前该播哪一句」的令牌推进一步：
       解码是异步的，翻页后旧语音可能才解码完，凭令牌在开腔前把它拦下来（galgame 语义）。 */
    function stopVoices() {
        state.voiceSeq++;
        Object.keys(audioPool).forEach(function (r) {
            try { audioPool[r].stop(); } catch (_) { /* 已结束 */ }
        });
    }
    /* 立刻闭嘴：0ms 归零。隐藏中的 player 会忽略变量写入，
       所以只在可见时有效（隐藏/显示时会各补一次，见 applyVisible） */
    function hush(role) {
        var p = playerOf(role);
        if (p && !p.hide) p.setVariable('face_talk', 0, 0);
    }
    function eachAudio(fn) {
        Object.keys(audioPool).forEach(function (r) {
            try { fn(audioPool[r], r); } catch (_) { /* 忽略单台失败 */ }
        });
    }

    /* ---- 每行每角色的演出指令 ----------
       说话者沿用它自己的行级 action / voice；同台其他人的写在 line.cues[角色]。
       cues 里显式写了的角色（含说话者）以 cues 为准。 */
    function speakerOf(line) {
        return (line && line.role) || firstRole(state.cast);
    }

    /* ---- 名字的三层：角色键名＝内部 id，cast.name＝默认显示名，line.name＝本行起的称呼 ----
       键名不能当显示名用：剧本的 role / enter / exit / move / cues、语音目录、模型绑定全挂在它上面，
       改一次就断一片引用。所以「舞台上叫什么」单独存，默认等于键名。 */
    function castName(role) {
        var item = state.cast && state.cast[role];
        var n = item && item.name;
        return (typeof n === 'string' && n.trim()) ? n.trim() : (role || '');
    }
    /* 第 idx 行之前（不含）这个角色已经生效的称呼，用于输入框里的「沿用」提示 */
    function inheritedName(role, idx) {
        var list = lines();
        var name = castName(role);
        var last = Math.min(idx, list.length);
        for (var i = 0; i < last; i++) {
            var l = list[i];
            if (!l || speakerOf(l) !== role) continue;
            if (typeof l.name !== 'string') continue;
            // 空串＝从这一句起回到默认名，继承链上也要照此执行
            name = l.name.trim() ? l.name.trim() : castName(role);
        }
        return name;
    }
    /* 第 idx 行生效的称呼：本行写过就覆盖，没写就沿用同一角色上一句的写法。
       中间别的角色插话不会打断这条链（按角色分别继承）。 */
    function displayNameAt(idx) {
        var list = lines();
        var line = list[idx];
        if (!line) return '';
        var role = speakerOf(line);
        var name = inheritedName(role, idx);
        if (typeof line.name === 'string') name = line.name.trim() ? line.name.trim() : castName(role);
        return name;
    }
    function cueOf(line, role) {
        if (!line || !role) return {};
        var c = (line.cues && line.cues[role]) || null;
        var mine = c && typeof c === 'object' && !Array.isArray(c) ? c : null;
        var isSpeaker = role === speakerOf(line);
        // 字段级回退：cues 只写了语音，不该把说话者的行级动作吃掉
        var action = mine && mine.action !== undefined ? mine.action
            : (isSpeaker ? line.action : undefined);
        var voice = mine && mine.voice !== undefined ? mine.voice
            : (isSpeaker ? line.voice : undefined);
        return { action: action, voice: voice };
    }
    /* 写到哪：已有 cues 条目就原地改；否则说话者写行级，其他角色新建 cues 条目 */
    function cueTarget(line, role, create) {
        if (!line || !role) return null;
        if (line.cues && line.cues[role] && typeof line.cues[role] === 'object') return line.cues[role];
        if (!create) return null;
        if (role === speakerOf(line)) return line;
        line.cues = line.cues || {};
        return (line.cues[role] = {});
    }
    function setCue(line, role, key, value) {
        var t = cueTarget(line, role, true);
        if (!t) return;
        if (value === undefined || value === null || value === '') delete t[key];
        else t[key] = value;
        if (line.cues && line.cues[role]) {
            if (!Object.keys(line.cues[role]).length) delete line.cues[role];
            if (!Object.keys(line.cues).length) delete line.cues;
        }
    }
    /* 本行出现的角色：说话者打头，其余按登场阵容顺序；cues 里多出来的补在末尾 */
    function cueRoles(line) {
        var out = [];
        var push = function (r) { if (r && out.indexOf(r) < 0) out.push(r); };
        push(speakerOf(line));
        state.stage.forEach(function (s) { push(s.role); });
        Object.keys((line && line.cues) || {}).forEach(push);
        return out;
    }

    function applyAction(act, role) {
        var player = playerOf(role);
        if (!player || !act) return;
        if (typeof act === 'string') {
            var bound = state.cast && state.cast[role] && state.cast[role].actions;
            act = bound && bound[act];
        }
        if (!act || typeof act !== 'object') return;
        if (act.timeline) player.mainTimelineLabel = act.timeline;
        if (act.diffSlot1 !== undefined) player.diffTimelineSlot1 = act.diffSlot1 || '';
        if (act.diffSlot2 !== undefined) player.diffTimelineSlot2 = act.diffSlot2 || '';
        var base = Number.isFinite(act.duration) ? act.duration : DEFAULT_VAR_DURATION;
        (act.variables || []).forEach(function (v) {
            if (!v || !v.name) return;
            player.setVariable(v.name, v.value, Number.isFinite(v.duration) ? v.duration : base);
        });
        startBlink(act, role);
    }

    /* ---------- 眨眼 ----------
       节奏不排：wasm 自带的自动眨眼每 1.3–3s 把 face_eye_open 沿 10 帧曲线从基线抬到
       10 再落回基线，红莉栖和鈴羽都会（此前「鈴羽不动」是测在 hide=true 上，假象）。
       这一路只驱动单数变量（眼内阴影 / 瞳线 / 高光），真正闭眼的是
       face_eye_open_l / _r。所以这里每帧跟随一次，用 diff 只写「增量」：
           k    = (track - 基线) / (10 - 基线)
           diff = (closeValue - 眼皮基准) * k
       基数是 wasm 自己维护的，我们既不读也不改，所以动作 variables 正在渐变、
       dev panel 手动调表情都不会被我们拍平；track 落回基线时 diff 写成 0 就收手。 */
    var blinkPool = {};        // role -> { cfg, sig, track, vars, gate, last, trBase, lastV, lastT, fastUntil, topAt }
    var blinkRaf = null;

    /* 角色级缺省：cast.json 里该角色的 blink。不写＝默认开。 */
    function blinkRole(role) {
        var r = (state.cast && state.cast[role]) || {};
        var g = (r.blink && typeof r.blink === 'object') ? r.blink : {};
        var out = { on: g.on !== false };
        BLINK_KEYS.forEach(function (k) {
            var v = Number(g[k]);
            out[k] = Number.isFinite(v) ? v : DEFAULT_BLINK[k];
        });
        if (typeof g.vars === 'string' && g.vars) out.vars = g.vars;
        if (typeof g.track === 'string' && g.track) out.track = g.track;
        return out;
    }
    function blinkNum(cfg, key) {
        var v = Number(cfg && cfg[key]);
        return Number.isFinite(v) ? v : DEFAULT_BLINK[key];
    }
    /* 补眼皮推哪两个变量：显式 vars 优先，否则默认左右眼睑线 */
    function blinkVars(cfg) {
        var raw = cfg && cfg.vars;
        if (typeof raw === 'string') {
            var list = raw.split(/[,;\s]+/).filter(Boolean);
            if (list.length) return list;
        } else if (raw && raw.length) {
            return Array.prototype.slice.call(raw).filter(Boolean);
        }
        return BLINK_VARS.slice();
    }
    /* 这个模型真的声明了哪些眼皮变量（没声明的写了 wasm 也不认） */
    function blinkRealVars(role, vars) {
        var p = playerOf(role);
        var labels = [];
        try { labels = (p.variableList || []).map(function (v) { return v.label || v.name || v; }); } catch (_) { }
        if (!labels.length) return vars;
        return vars.filter(function (n) { return labels.indexOf(n) >= 0; });
    }
    /* 眼皮基准的「决策快照」：只回答一个问题——这个动作结束时眼皮本来就闭着吗。
       优先 act.variables 的目标值；该动作没写这个变量就沿用上次的判断；
       首次上场才读一次当前值。这个值不参与任何数值计算，读偏了最多多眨/少眨一次。 */
    function blinkGateOf(role, act, vars, prev) {
        var fromAct = {};
        ((act && act.variables) || []).forEach(function (v) {
            if (v && v.name) fromAct[v.name] = Number(v.value);
        });
        var p = playerOf(role), out = {};
        vars.forEach(function (n) {
            var v = fromAct[n];
            if (!Number.isFinite(v) && prev) v = prev[n];
            if (!Number.isFinite(v) && p) v = Number(p.getVariable(n));
            out[n] = Number.isFinite(v) ? v : 0;
        });
        return out;
    }

    /* 把这一路 diff 归零：diff 是常驻叠加，没有 remove 接口，
       必须显式写 0 才能把「当前基准」露出来。写 0 本身是幂等的，重复调用无害。 */
    function blinkClear(role, b) {
        var p = playerOf(role);
        b = b || blinkPool[role];
        if (!p || !b) return;
        b.vars.forEach(function (n) {
            try { p.setVariableDiff(BLINK_MODULE, n, 0, 0); } catch (_) { /* 变量不在这个模型里 */ }
        });
        b.last = {};
    }
    function stopBlink(role) {
        var b = blinkPool[role];
        if (!b) return;
        blinkClear(role, b);
        delete blinkPool[role];
        if (!Object.keys(blinkPool).length && blinkRaf !== null) {
            cancelAnimationFrame(blinkRaf);
            blinkRaf = null;
        }
    }
    function stopAllBlinks() {
        Object.keys(blinkPool).forEach(function (r) { stopBlink(r); });
    }
    /* 全员起眨眼：不等某句台词才生效，不开口的角色也要眨 */
    function startSceneBlinks() {
        state.stage.forEach(function (s) { startBlink(null, s.role); });
    }

    /* 一帧：只跟随，不排任何定时器。v 是 SDK 当前推到的值（0..10）。
       写的永远是「增量」：睁着 → 0（幂等于不干预），眨 → 补到满闭还差的那一段。
       diff 由 wasm 叠加在当前基准上，所以动作 variables 的渐变不会被我们拍平。

       **为什么要「相对基线」而不是 v / 10**：face_eye_open 不是只有 SDK 在写，
       动作/表情也会把它推到一个新的静止值，而且就停在那儿：
         红莉栖「吃惊」= 8、铃羽「生气」= 2、铃羽「摇头」(困る01) 直接顶到 10。
       拿绝对值当比例的话：
         · 吃惊时 k 常驻 0.8 → 眼皮平时就半闭，眨眼只剩 8→10 这 2 个单位 = 「只眨一点点」；
         · 摇头时 track 顶在 10 不动 → k 恒为 1 → diff 恒为 close → 一直闭着眼，
           而且 diff 是常驻的，下一句、重播都还带着它（「SERN在2036年」也闭眼就是这么来的）。
       所以这里维护一条「静止基线」trBase：只有相对基线的抬升才算眨眼，
       顶在满闭超过 BLINK_TOP_MS 还不落 = 动作把眼睛压住了，改认作基线（不再叠加）。

       **补多少**：眼皮基准不是 0（吃惊 -5 / 生气 4），直接 +close 会闭不满或闭过头
       （生气 4+10=14 早就越界）。按「补到 close 还差多少」算：
           眼皮 = 基准 + (close - 基准) * k
       k=1 时正好落在 close（全闭），k=0 时 diff=0（露出表情原本的睁眼度）。 */
    function blinkStep(role) {
        var b = blinkPool[role];
        var p = playerOf(role);
        if (!b || !p) return;
        // 隐藏时 wasm 直接丢弃写入：此时 last 与画面上的实际 diff 仍然一致
        // （丢弃＝没改），所以什么都不用做，露出来后差值自会补齐。
        if (p.hide) return;
        // 调试/验收：window.ST_BLINK_FREEZE = true 时停在当前状态，便于截图确认
        if (window.ST_BLINK_FREEZE) return;
        var v = Number(p.getVariable(b.track));
        if (!Number.isFinite(v)) return;  // 模型没这个变量 → 没有节奏可跟

        // 基线 trBase：SDK 眨眼是「基线 → 10 → 基线」，只有相对基线的抬升才算眨眼。
        var now = performance.now();
        if (!Number.isFinite(b.trBase)) { b.trBase = v; b.lastV = v; b.lastT = now; b.topAt = 0; }
        // 变化速率（单位/毫秒）：区分「表情渐变」和「眨眼」最稳的判据，而且与帧率无关。
        //   表情渐变：吃惊 0→8 用 1000ms ≈ 0.008/ms
        //   眨眼：SDK 约 80ms 从基线抬到 10 ≈ 0.1/ms（跨度小的（基线 8）也有 0.025/ms 以上）
        var dt = Math.max(1, now - (b.lastT || now));
        var rate = Math.abs(v - b.lastV) / dt;
        b.lastT = now;
        // 快变的这段时间不认漂移：否则眨眼顶到峰值稍有停顿（rate≈0）就会把峰值当成基线，
        // k 立刻掉到 0，眼睛「睁一下又闭」地闪。
        if (rate >= BLINK_DRIFT_RATE) b.fastUntil = now + BLINK_TOP_MS;
        // 慢变跟随：不快的位移直接算基线漂移，否则渐变那一秒会被当成「抬到 8」→ k=1 → 闭一下
        if (rate < BLINK_DRIFT_RATE && now > (b.fastUntil || 0)) b.trBase = v;
        b.lastV = v;
        // 顶在满闭不落（> BLINK_TOP_MS）：不是眨眼，是动作/表情把 track 压死了
        if (v >= BLINK_FULL - 0.6) {
            if (!b.topAt) b.topAt = now;
            else if (now - b.topAt > BLINK_TOP_MS) { b.trBase = v; b.topAt = 0; }
        } else {
            b.topAt = 0;
        }
        // 掉到基线下方一大截：基线过期了（上一句留下的），直接跟下去
        if (v < b.trBase - 1) { b.trBase = v; b.topAt = 0; }

        var span = BLINK_FULL - b.trBase;
        var k = span < BLINK_MIN_SPAN ? 0 : Math.max(0, Math.min(1, (v - b.trBase) / span));
        var close = blinkNum(b.cfg, 'closeValue');
        b.vars.forEach(function (n) {
            // 基准取「实时值」：动作换掉之后 wasm 里真正躺着的那一个。
            // gate 只是模型还没就绪时的兜底（决策快照会过期，例如重播后还带着上一句的 4）。
            var base = Number(p.getVariable(n));
            if (!Number.isFinite(base)) base = Number(b.gate[n]);
            if (!Number.isFinite(base)) base = 0;
            var target = (k <= 0.02 || base >= close) ? 0 : (close - base) * k;
            if (Math.abs((b.last[n] || 0) - target) < BLINK_EPS) return;
            try { p.setVariableDiff(BLINK_MODULE, n, target, 0); } catch (_) { return; }
            b.last[n] = target;
        });
    }

    function blinkFrame() {
        blinkRaf = null;
        Object.keys(blinkPool).forEach(blinkStep);
        if (Object.keys(blinkPool).length) blinkRaf = requestAnimationFrame(blinkFrame);
    }

    /* 眨眼配置一律取角色级（cast.json 的 blink）：动作不再单独覆盖。
       act 只用来取「眼皮基准快照」——动作 variables 可能本来就把它压到满闭。 */
    function startBlink(act, role) {
        var cfg = blinkRole(role);
        if (!cfg.on) { stopBlink(role); return; }
        var p = playerOf(role);
        if (!p || typeof p.setVariableDiff !== 'function') return;
        var vars = blinkRealVars(role, blinkVars(cfg));
        if (!vars.length) { stopBlink(role); return; }   // 新模型没有眼皮变量：先把旧 diff 清掉
        var cur = blinkPool[role];
        var gate = blinkGateOf(role, act, vars, cur && cur.gate);
        var sig = JSON.stringify(cfg) + '|' + JSON.stringify(gate);
        if (cur && cur.sig === sig) return;      // 同一套配置与基准，别重排
        // 换动作时 diff 要连同「已写出去的值」一起带过去：last 是账本，
        // 丢了它就会以为画面上是 0，该归零的时候反而不写。
        var last = (cur && cur.last) || {};
        blinkPool[role] = {
            cfg: cfg, sig: sig, last: last,
            track: cfg.track || BLINK_TRACK,
            vars: vars,
            gate: gate,
            // 换了动作就重新认基线：新表情/动作会把 face_eye_open 拉到它自己的静止值
            trBase: NaN, lastV: NaN, lastT: 0, fastUntil: 0, topAt: 0
        };
        if (cur && cur.vars) {                   // 旧动作盯的变量不在新列表里：先把它们归零
            cur.vars.forEach(function (n) {
                if (vars.indexOf(n) >= 0) return;
                try { p.setVariableDiff(BLINK_MODULE, n, 0, 0); } catch (_) { }
                delete last[n];
            });
        }
        if (blinkRaf === null) blinkRaf = requestAnimationFrame(blinkFrame);
    }
    function applyVisible(slot, visible) {
        var p = playerOf(slot.role);
        if (!p) return;
        var next = !visible;
        if (p.hide !== next) {
            // 隐藏期间 wasm 不接收变量写入，嘴会停在最后一张张开的形状上：
            // 藏之前归零、露之前再归零，重新登场时是闭着嘴的
            if (!p.hide) p.setVariable('face_talk', 0, 0);
            p.hide = next;
            if (!p.hide) p.setVariable('face_talk', 0, 0);
        }
        p.convolveCanvasMovementToPhysics = false;   // 固定站位，移动物理会把它推走
    }
    function applyStageEvents(line) {
        if (!line) return;
        // 同一行同时勾了上/下场时，先退后进，最终以「登场」为准
        [].concat(line.exit || []).forEach(function (r) { if (r) applyVisible({ role: r }, false); });
        [].concat(line.enter || []).forEach(function (r) { if (r) applyVisible({ role: r }, true); });
    }
    function resetPositions() {
        state.stage.forEach(function (slot) {
            var b = baseSlotOf(slot.role);
            if (!b) return;
            slot.x = b.x; slot.scale = b.scale; slot.z = b.z;
        });
    }
    function resetStage() {
        resetPositions();
        // 台词里写过「登场」的角色视为中途登场：开场先隐藏，等 enter 那一句再上场。
        // 没有任何 enter 的角色（含只写退场的）开场都在台。
        var late = {};
        lines().forEach(function (l) {
            [].concat((l && l.enter) || []).forEach(function (r) { if (r) late[r] = true; });
        });
        state.stage.forEach(function (slot) { applyVisible(slot, !late[slot.role]); });
    }
    function syncLayout() {
        var members = state.stage.map(function (slot) {
            return { player: playerOf(slot.role), x: slot.x, scale: slot.scale };
        }).filter(function (m) { return !!m.player; });
        if (!members.length) return;
        if (!state.layout) {
            state.layout = window.SGEmoteCore.createCastLayout(members,
                { canvas: $('canvas'), verticalOffsetRatio: 0.45 });
        } else {
            // 复用同一条 resize 监听：把成员数组原地替换
            var arr = state.layout.members;
            if (!arr) { state.layout.members = arr = members; }
            else {
                arr.length = 0;
                members.forEach(function (m) { arr.push(m); });
            }
            state.layout.apply();
        }
        state.stage.forEach(function (slot) {
            var p = playerOf(slot.role);
            if (p) p.zIndex = slot.z;
        });
    }

    /* 把 line.move 写进当前站位。collect 给了就只收集插值任务，不直接落值。 */
    function applyMoveToSlots(move, collect) {
        if (!move) return;
        Object.keys(move).forEach(function (role) {
            var slot = slotOf(role);
            var d = moveOf(move[role]);
            if (!slot || !d) return;
            ['x', 'scale', 'z'].forEach(function (k) {
                if (!Number.isFinite(Number(d[k]))) return;
                var to = Number(d[k]);
                if (collect) collect.push({ slot: slot, key: k, from: slot[k], to: to });
                else slot[k] = to;
            });
        });
    }

    /* 行内站位：只写改动的角色，其余沿用上一句。animate 时 x/scale 缓动过去，
       z 直接落值（叠放次序插值没有意义）。 */
    var MOVE_MS = 360;
    function applyMoves(line, animate) {
        var move = line && line.move;
        if (!move) return;
        cancelStageTween();
        if (!animate) {
            applyMoveToSlots(move);
            syncLayout();
            return;
        }
        var jobs = [];
        applyMoveToSlots(move, jobs);
        jobs = jobs.filter(function (j) {
            if (j.key !== 'z') return true;
            j.slot.z = j.to;
            return false;
        });
        if (!jobs.length) { syncLayout(); return; }
        var t0 = window.performance.now();
        (function frame(now) {
            var k = Math.min(1, (now - t0) / MOVE_MS);
            var e = 1 - Math.pow(1 - k, 3);
            jobs.forEach(function (j) {
                j.slot[j.key] = k >= 1 ? j.to : j.from + (j.to - j.from) * e;
            });
            syncLayout();
            state.stageRaf = k < 1 ? window.requestAnimationFrame(frame) : 0;
        })(t0);
    }

    /* 从开场重放到第 upto 行：站位与上下场都按台词恢复。
       upto < 0 表示只回到开场（场景默认站位）。编辑模式用它做「选中哪句就看哪句」。 */
    function rebuildStaging(upto) {
        cancelStageTween();
        state.stage = cloneStage(state.baseStage);
        resetStage();
        var list = lines();
        var last = Math.min(upto, list.length - 1);
        for (var i = 0; i <= last; i++) {
            applyStageEvents(list[i]);
            applyMoveToSlots(list[i].move);
        }
        syncLayout();
        startSceneBlinks();     // 站位一定下来就给全员起眨眼，不等谁开口
    }
    async function getJson(name) {
        var r = await fetch(apiUrl(name), { cache: 'no-store' });
        if (!r.ok) throw new Error(name + ' 读取失败：' + r.status);
        return r.json();
    }
    async function putJson(name, data) {
        var r = await fetch(apiUrl(name), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(j.error || ('写入失败 ' + r.status));
        return j;
    }

    /* ---------- 目录索引（与 scene_ui.js 的 parseIndex 同源） ---------- */

    function parseIndex(text) {
        var links = [], m;
        var re = /href\s*=\s*["']([^"']+)["']/gi;
        while ((m = re.exec(text))) {
            var raw = m[1].split(/[?#]/)[0];
            if (!raw) continue;
            var name;
            try { name = decodeURIComponent(raw); } catch (_) { name = raw; }
            var isDir = /\/$/.test(raw);
            name = name.replace(/\/+$/, '').replace(/^.*\//, '');
            if (!name || name === '.' || name === '..') continue;
            links.push({ name: name, isDir: isDir });
        }
        return links;
    }
    async function listDir(url) {
        try {
            var r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) return [];
            return parseIndex(await r.text());
        } catch (_) { return []; }
    }

    var IMG_RE = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;
    var AUDIO_RE = /\.(opus|ogg|wav|mp3|m4a|flac|webm)$/i;
    var MODEL_RE = /(\.zip|\.psb|\.psb\.m)$/i;

    async function loadBackgrounds() {
        var items = await listDir('../../static/background/');
        state.bg = items.filter(function (x) { return !x.isDir && IMG_RE.test(x.name); })
            .map(function (x) { return x.name; });
        if (state.scene && state.mode === 'edit') renderProps();
    }
    async function loadVoices(role) {
        var item = state.cast && state.cast[role];
        var dir = item && item.voiceDir;
        if (!dir) return;
        if (state.voices[dir]) return;
        var items = await listDir(dir);
        state.voices[dir] = items.filter(function (x) { return !x.isDir && AUDIO_RE.test(x.name); })
            .map(function (x) { return x.name; });
        if (state.mode === 'edit') renderProps();
    }
    /* character/data/ 是两级结构：角色文件夹 → 模型文件。cast 的键是昵称（红莉栖），
       文件夹名是完整姓名（牧瀬紅莉栖），两者对不上，所以这里返回全部分组，
       由下拉里的 optgroup 呈现，用户直接按文件夹找人。 */
    async function loadModels() {
        var roots = (await listDir('../../character/data/')).filter(function (x) { return x.isDir; });
        var groups = await Promise.all(roots.map(async function (d) {
            var files = await listDir('../../character/data/' + encodeURIComponent(d.name) + '/');
            return {
                folder: d.name,
                models: files.filter(function (f) { return !f.isDir && MODEL_RE.test(f.name); })
                    .map(function (f) { return d.name + '/' + f.name; })
            };
        }));
        state.models = groups.filter(function (g) { return g.models.length; });
        if (state.mode === 'edit') renderDrawer();
    }

    /* ---------- 播放器 ---------- */

    function lines() { return (state.scene && state.scene.lines) || []; }
    function currentLine() { return lines()[state.idx] || null; }

    function clearTimers() {
        if (state.typeTimer) { clearTimeout(state.typeTimer); state.typeTimer = null; }
        if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
        state.seq++;
    }

    function setHint(text) { $('st-hint').textContent = text; }
    /* 有无播放器还在等首次手势才能出声（浏览器自动播放策略）。
       有语音的那一句会 pending，AUTO 因此停在首句 —— 此时要提示用户点一下，
       否则看起来像「AUTO 开了却不说话」。 */
    function audioNeedsGesture() {
        var wanted = false;
        Object.keys(audioPool).forEach(function (r) {
            if (audioPool[r].needsGesture && audioPool[r].needsGesture()) wanted = true;
        });
        return wanted;
    }
    /* 这一下点击是不是「刚把音频解锁」的那一下。是的话它只用来解锁、不推进剧情，
       否则刚解锁的首句会被下一句的 stop() 当场掐掉 —— 表现就是「第一句永远没声音，
       从第二句起才正常」。 */
    function consumeAudioUnlock() {
        var hit = false;
        Object.keys(audioPool).forEach(function (r) {
            var ap = audioPool[r];
            if (ap && ap.consumeGestureUnlock && ap.consumeGestureUnlock()) hit = true;
        });
        return hit;
    }
    function setProgress() {
        var total = lines().length;
        var at = state.ended ? total : state.idx + 1;
        $('st-progress').textContent = total ? at + ' / ' + total : '';
    }

    function applyBackground(name) {
        document.body.style.backgroundImage = name
            ? 'url("../../static/background/' + encodeURIComponent(name) + '")'
            : '';
    }

    /* 返回 Promise<语音时长 ms>；失败或没写 voice 都 resolve(0)。
       每个角色一台播放器，口型由该播放器的 getPlayer 直接定位，不会串到别人身上。
       token 是这段语音所属的那一句：解码回来时若已经翻页，立刻掐掉，别在新台词里开腔。
       gen 是该角色这条语音的序号——同一角色又被派了新语音时，旧的那条不许去 stop 掉新的。 */
    var voiceGen = {};
    function playVoiceFor(role, file, token) {
        var item = state.cast && state.cast[role];
        var ap = audioFor(role);
        if (!file || !ap) return Promise.resolve(0);
        var gen = voiceGen[role] = (voiceGen[role] || 0) + 1;
        var url = ((item && item.voiceDir) || '') + file;
        return ap.loadAndPlay(url).then(function (buf) {
            if (token !== undefined && token !== state.voiceSeq && gen === voiceGen[role]) {
                ap.stop();
                hush(role);
                return 0;
            }
            return buf && buf.duration ? buf.duration * 1000 : 0;
        }).catch(function () { return 0; });
    }

    /* 按固定速度打字；语音各走各的播放器，不必互相等待 */
    function typeText(text, done) {
        var el = $('st-text');
        el.textContent = '';
        if (window.SGDialog) window.SGDialog.setCaret(false);   // 打字中先不亮 ▼
        state.typing = true;
        state.typeDone = done;
        state.seq++;
        var mySeq = state.seq;
        var i = 0;
        (function tick() {
            if (mySeq !== state.seq) return;
            if (i >= text.length) {
                state.typing = false;
                var cb = state.typeDone;
                state.typeDone = null;
                if (cb) cb();
                return;
            }
            el.textContent += text.charAt(i++);
            state.typeTimer = setTimeout(tick, TYPE_MS);
        })();
    }

    /* 打字未完时立刻补全；返回是否真的补全了 */
    function skipTyping() {
        if (!state.typing) return false;
        state.seq++;
        if (state.typeTimer) { clearTimeout(state.typeTimer); state.typeTimer = null; }
        state.typing = false;
        var line = currentLine();
        $('st-text').textContent = (line && line.text) || '';
        var cb = state.typeDone;
        state.typeDone = null;
        if (cb) cb();
        return true;
    }

    /* 自动推进是播放界面的开关（对话框右下角 AUTO），不写在台词里：
       开了就等这句的语音放完、再停 wait（本行没写用默认）就前进；关着就等点击。
       打字还没完就先不动，补全后 onTyped 会再调一次。 */
    function armAuto(voiceMs) {
        if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
        if (state.mode !== 'play' || state.introPending) return;
        if (!state.autoOn) {
            setHint(audioNeedsGesture() ? '点击画面开启语音 ▸' : (state.ended ? '点击重新开始' : '点击继续 ▸'));
            return;
        }
        if (state.ended) { setHint('点击重新开始'); return; }
        if (state.typing) return;
        var line = currentLine();
        if (!line) return;
        var mySeq = state.seq;
        var wait = Math.max(0, Number(line.wait) || 0);
        var needGesture = audioNeedsGesture();
        setHint(needGesture ? '点击画面开启语音 · 之后自动播放 ▸' : '自动推进中 · 点击立即继续');
        // 无手势时语音 Promise 永久 pending：别让它把 AUTO 卡死，按默认间隔推进；
        // 有手势时等 speaking 角色语音播完（ms）再推进，保持音画同步。
        var waitVoice = needGesture ? Promise.resolve(0) : Promise.resolve(voiceMs || 0);
        waitVoice.then(function (ms) {
            if (mySeq !== state.seq || !state.autoOn || state.mode !== 'play') return;
            if (!audioNeedsGesture()) setHint('自动推进中 · 点击立即继续');
            var elapsed = performance.now() - state.lineStart;
            var delay = ms > 0
                ? Math.max(0, ms - elapsed) + wait
                : (wait || AUTO_DEFAULT_MS);
            state.autoTimer = setTimeout(function () {
                if (mySeq !== state.seq || !state.autoOn || state.mode !== 'play') return;
                step();
            }, delay);
        });
    }

    function onTyped(line, voiceMs) {
        if (window.SGDialog) window.SGDialog.setCaret(state.mode === 'play' && !state.autoOn);
        if (state.mode !== 'play') { setHint(''); return; }
        state.autoReady = true;
        armAuto(voiceMs);
    }

    /* AUTO 开关：改状态 + 记到 localStorage；开着立刻对当前这句续上计时 */
    /* AUTO 芯片：换成图集里的原生切片，而不是切换 CSS 样式 */
    function paintAutoBtn() {
        var img = $('st-auto-img');
        if (!img) return;
        var src = 'ui/auto_' + (state.autoOn ? 'on' : 'off') + '.webp';
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
        // 右下角的 »AUTO 提示牌：开则出，关则收
        var plate = $('st-autoplate');
        if (plate) plate.classList.toggle('is-on', state.autoOn);
    }

    function setAuto(on) {
        state.autoOn = !!on;
        var btn = $('st-auto');
        if (btn) {
            btn.classList.toggle('is-on', state.autoOn);
            btn.setAttribute('aria-pressed', state.autoOn ? 'true' : 'false');
        }
        paintAutoBtn();
        // 装饰线的「充能」只在 AUTO 下跑，其余时候只有一层静态暗描边
        if (window.SGDialog) window.SGDialog.setAuto(state.autoOn);
        // 自动推进时不需要「点击继续」的提示符
        if (window.SGDialog) window.SGDialog.setCaret(!state.autoOn && !state.typing);
        try { localStorage.setItem(AUTO_KEY, state.autoOn ? '1' : '0'); } catch (_) { /* 隐私模式 */ }
        if (state.mode !== 'play') { setHint(''); return; }
        if (!state.autoOn && state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
        armAuto(state.autoReady ? state.lineVoice : null);
    }

    /* 恢复上次的 AUTO 开关（开关在对话框里，任何时候都能点） */
    function initAuto() {
        var saved = '0';
        try { saved = localStorage.getItem(AUTO_KEY) || '0'; } catch (_) { /* 隐私模式 */ }
        setAuto(saved === '1');
    }

    function showEnd() {
        clearTimers();
        stopAllBlinks();
        state.ended = true;
        state.typing = false;
        $('st-text').textContent = '— 完 —';
        setHint('点击重新开始');
        if (window.SGDialog) window.SGDialog.setCaret(true);
        setProgress();
    }

    /* 从第一行重播：把上/下场与站位状态复位，否则二周目人物会停在退场/走位后的状态 */
    function restart() {
        rebuildStaging(-1);
        renderLine(0);
    }

    /* 只把一行的舞台落到画面：背景、上/下场、站位、动作表情。
       与台词（名牌/打字/语音）分开，开场时先铺好它，等对话框动画结束再出词。
       全是幂等落值：动画前铺一次、renderLine 里再走一次不会叠加。 */
    function applyLineStage(line, animate) {
        applyStageEvents(line);
        applyMoves(line, animate);
        applyBackground(line.background || (state.scene && state.scene.background));
        cueRoles(line).forEach(function (r) {
            var cue = cueOf(line, r);
            if (cue.action) applyAction(cue.action, r);
        });
    }

    /* 对话框擦入动画开始前，先把首句的背景、登场角色、动作铺到画面上。
       模型此时已加载完，动画期间用户看到的是完整场景，只差台词。 */
    function primeStageForIntro() {
        var first = lines()[0];
        if (!first) return;
        rebuildStaging(-1);          // 编辑态可能预览过别处，先复位到开场站位
        applyLineStage(first, false);
    }

    function renderLine(i) {
        var list = lines();
        if (i >= list.length) { showEnd(); return; }
        clearTimers();
        stopVoices();          // 上一句没放完的语音（可能是别人的）别盖到这一句上
        state.ended = false;
        state.idx = Math.max(0, i);
        state.lineStart = performance.now();

        var line = list[state.idx];
        var role = speakerOf(line);

        applyLineStage(line, state.mode === 'play' && state.idx > 0);
        state.speaker = role;
        var shownName = displayNameAt(state.idx);
        $('st-name').classList.toggle('is-alias', shownName !== castName(role));   // 用的是别名/未知名时淡一点
        if (window.SGDialog) window.SGDialog.setName(shownName);   // 名牌按名字长度选档并重擦
        setProgress();
        setHint(state.autoOn && state.mode === 'play' ? '自动推进中…' : '');

        // 逐角色演出：语音各走各的播放器与口型；动作已在 applyLineStage 里落过
        var token = state.voiceSeq;    // stopVoices 刚推进过，这句的语音只认这个令牌
        var speakerVoice = Promise.resolve(0);
        cueRoles(line).forEach(function (r) {
            var cue = cueOf(line, r);
            if (cue.voice) {
                var p = playVoiceFor(r, cue.voice, token);
                if (r === role) speakerVoice = p;      // 自动推进只等说话者的语音
            }
        });

        state.autoReady = false;       // 这一句还没打完：AUTO 等 onTyped 再起计时
        state.lineVoice = speakerVoice;
        typeText(line.text || '', function () { onTyped(line, speakerVoice); });
    }

    /* 前进一步：打字中先补全，否则下一行 / 结束 / 重播。
       推进时当前语音还在播就直接掐掉、播下一句的——这正是点击推进的语义。 */
    function step() {
        if (state.mode !== 'play') return;
        if (state.introPending) return;   // 开场动画还在铺：这一下不抢台词
        /* 这一下刚把音频解锁：只补完打字，不推进台词 —— 否则刚解锁的首句会被下一句的 stop() 当场掐掉 */
        if (consumeAudioUnlock()) { skipTyping(); return; }
        if (skipTyping()) return;
        if (state.ended) { restart(); return; }
        if (state.idx + 1 >= lines().length) { showEnd(); return; }
        renderLine(state.idx + 1);
    }

    /* ---------- 即时台词（独立于剧本，让当前立绘开口） ----------
       语音来源三种：
         ① 选择音频——本地文件在浏览器内生成临时 blob URL 直接播，不落盘、不上传；
         ② 音频列表——列出 character/sounds/ 下的文件夹 + 文件，选中的静态路径直接播，不落盘；
         ③ 文字合成——POST /api/voice 走服务端 TTS，未配引擎返回 501，前端提示降级。
       三个来源都不写 story/voices/；只有文字合成的 TTS 落盘到那里。
       当前立绘由场景加载，角色下拉只决定动作宏集合——换造型仍走场景/剧本。 */

    function liveMsg(text, isErr) {
        var el = $('st-live-msg');
        el.textContent = text || '';
        el.classList.toggle('err', !!isErr);
    }

    /* 只刷新「即时台词」的角色下拉，不重复绑定事件（切换场景时调用） */
    function refreshLiveRoles() {
        var roles = liveRoles();
        var current = state.liveRole;
        if (roles.indexOf(current) < 0) {
            current = lines()[0] && roles.indexOf(lines()[0].role) >= 0
                ? lines()[0].role : (roles[0] || '');
        }
        state.liveRole = current;
        fillSelect($('st-live-role'), roles, current, '');
        renderLiveActions();
    }

    function initLive() {
        refreshLiveRoles();
        // 动作下拉（来自所选角色的 actions）
        $('st-live-role').addEventListener('change', function () {
            state.liveRole = this.value;
            renderLiveActions();
        });
        // 三个来源 tab
        var tabs = document.querySelectorAll('#st-live .st-live-tabs button');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].addEventListener('click', function () {
                setLiveSrc(this.getAttribute('data-src'));
            });
        }
        $('st-live-toggle').addEventListener('click', toggleLive);
        $('st-live-close').addEventListener('click', closeLive);
        $('st-live-say').addEventListener('click', liveSay);
        $('st-live-stop').addEventListener('click', liveStop);
        // 全屏：进/出都切一次，切完让对话框层重新按视口算缩放
        var fullBtn = $('st-full');
        if (fullBtn) {
            var syncFull = function () {
                fullBtn.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
            };
            fullBtn.addEventListener('click', function () {
                if (document.fullscreenElement) {
                    if (document.exitFullscreen) document.exitFullscreen();
                } else {
                    var de = document.documentElement;
                    if (de.requestFullscreen) de.requestFullscreen();
                }
            });
            document.addEventListener('fullscreenchange', function () {
                syncFull();
                if (window.SGDialog) window.SGDialog.fit();
            });
            // 无头 / 不支持全屏的浏览器：按钮直接置灰，别留个假开关
            if (!document.documentElement.requestFullscreen) fullBtn.disabled = true;
            var exitBtn = $('st-full-exit');
            if (exitBtn) {
                exitBtn.addEventListener('click', function () {
                    if (document.exitFullscreen) document.exitFullscreen();
                });
            }
        }
        $('st-live-file').addEventListener('change', function () {
            var f = this.files && this.files[0];
            var nameEl = $('st-live-file-name');
            nameEl.textContent = f ? f.name : '未选择文件';
            nameEl.classList.toggle('has-file', !!f);
            liveMsg(f ? '已选：' + f.name : '');
        });
        // 音频列表：文件夹决定文件下拉
        $('st-live-sound-folder').addEventListener('change', function () {
            loadSoundFiles(this.value);
        });
        loadSoundFolders();
    }

    function renderLiveActions() {
        var item = state.cast && state.cast[state.liveRole];
        var acts = (item && item.actions) ? Object.keys(item.actions) : [];
        fillSelect($('st-live-action'), acts, '', '（无动作）');
    }

    function setLiveSrc(src) {
        state.liveSrc = src;
        var tabs = document.querySelectorAll('#st-live .st-live-tabs button');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-src') === src);
        }
        var panes = document.querySelectorAll('#st-live [data-src-pane]');
        for (var j = 0; j < panes.length; j++) {
            panes[j].hidden = panes[j].getAttribute('data-src-pane') !== src;
        }
        liveMsg('');
    }

    function toggleLive() {
        if (state.liveOpen) closeLive(); else openLive();
    }
    function openLive() {
        if (state.mode === 'edit') setMode('play');
        state.liveOpen = true;
        $('st-live').hidden = false;
        $('st-live-toggle').classList.add('is-active');
        // 打开时冻结剧本当前行，避免打字机把台词覆盖
        clearTimers();
        if (state.ctx) stopVoices();
        $('st-name').classList.remove('is-alias');
        if (window.SGDialog) window.SGDialog.setName(castName(state.liveRole));
        $('st-text').textContent = '';
        setHint('即时台词模式');
        liveMsg('');
    }
    function closeLive() {
        state.liveOpen = false;
        state.liveBusy = false;
        $('st-live').hidden = true;
        $('st-live-toggle').classList.remove('is-active');
        stopVoices();
        releaseBlobUrl();
        // 回到剧本：重渲染当前行
        if (state.mode === 'play') renderLine(state.idx);
    }

    /* 释放上一次导入的临时音频：回收 blob URL，并清掉它的解码缓冲
       （bufferCache 以 URL 为键，blob 地址每次都不同，不清会一直累积） */
    function releaseBlobUrl() {
        if (state.blobUrl) {
            URL.revokeObjectURL(state.blobUrl);
            eachAudio(function (ap) { if (ap.bufferCache) ap.bufferCache.delete(state.blobUrl); });
            state.blobUrl = '';
        }
    }

    /* 把本地文件变成浏览器内的临时 URL 直接播放，不落盘、不上传服务端 */
    function importSelectedVoice() {
        var f = $('st-live-file').files && $('st-live-file').files[0];
        if (!f) return Promise.reject(new Error('请先选择一个音频文件'));
        releaseBlobUrl();
        state.blobUrl = URL.createObjectURL(f);
        return Promise.resolve(state.blobUrl);
    }

    /* 音频列表：character/sounds/ 两级目录（文件夹 → 音频文件）。
       复用已有的 listDir() 读目录索引，与背景/模型下拉同源；播放走静态路径，不落盘。 */
    async function loadSoundFolders() {
        var items = await listDir('../../character/sounds/');
        state.soundFolders = items.filter(function (x) { return x.isDir; })
            .map(function (x) { return x.name; }).sort();
        fillSelect($('st-live-sound-folder'), state.soundFolders,
            state.soundFolders[0] || '', '（无文件夹）');
        if (state.soundFolders.length) await loadSoundFiles(state.soundFolders[0]);
    }

    async function loadSoundFiles(folder) {
        var sel = $('st-live-sound-file');
        if (!folder) { fillSelect(sel, [], '', '（无音频）'); return; }
        if (!state.soundFiles[folder]) {
            var items = await listDir('../../character/sounds/' + encodeURIComponent(folder) + '/');
            state.soundFiles[folder] = items.filter(function (x) { return !x.isDir && AUDIO_RE.test(x.name); })
                .map(function (x) { return x.name; }).sort();
        }
        var files = state.soundFiles[folder];
        fillSelect(sel, files, files[0] || '', '（选择音频）');
    }

    function voiceUrlForPlay() {
        if (state.liveSrc === 'file') return importSelectedVoice();
        if (state.liveSrc === 'list') {
            var folder = $('st-live-sound-folder').value;
            var file = $('st-live-sound-file').value;
            if (!folder || !file) return Promise.reject(new Error('请先选择文件夹和音频'));
            return Promise.resolve('../../character/sounds/' + encodeURIComponent(folder) + '/' + encodeURIComponent(file));
        }
        // tts：POST 文字合成，拿返回的音频 URL
        var text = ($('st-live-text').value || '').trim();
        if (!text) return Promise.reject(new Error('请先输入文字'));
        return fetch('/api/voice', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text })
        }).then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
          .then(function (x) {
              if (x.r.status === 501) throw new Error(x.j.error || 'TTS 未配置');
              if (!x.r.ok || !x.j.ok) throw new Error(x.j.error || ('合成失败 ' + x.r.status));
              return x.j.url;
          });
    }

    async function liveSay() {
        if (!state.liveOpen) openLive();
        if (!audioFor(state.liveRole) || !playerOf(state.liveRole)) { liveMsg('立绘尚未就绪', true); return; }
        var text = $('st-live-text').value || '';
        liveStop();
        state.speaker = state.liveRole;   // 口型跟到所选角色

        // 语音 URL（可能是异步上传/合成）；任一来源失败就只打字、不说话
        var urlPromise;
        try { urlPromise = voiceUrlForPlay(); }
        catch (err) { urlPromise = Promise.reject(err); }

        // 打字机 + 显示名字（即时台词没有剧情上下文，用角色默认名）
        $('st-name').classList.remove('is-alias');
        if (window.SGDialog) window.SGDialog.setName(castName(state.liveRole));
        var mySeq = ++state.seq;
        state.liveBusy = true;
        $('st-live-say').disabled = true;
        $('st-live-stop').disabled = false;
        liveMsg('');

        Promise.resolve(urlPromise).then(function (url) {
            if (!url || mySeq !== state.seq) return;
            liveMsg('播放中…');
            return audioFor(state.liveRole).loadAndPlay(url).then(function () {
                if (mySeq === state.seq) liveMsg('播放完成');
            });
        }).catch(function (err) {
            if (mySeq === state.seq) liveMsg(err.message || '语音播放失败', true);
        });

        var el = $('st-text');
        el.textContent = '';
        var i = 0;
        (function tick() {
            if (mySeq !== state.seq) return;
            if (i >= text.length) { finishLive(); return; }
            el.textContent += text.charAt(i++);
            state.typeTimer = setTimeout(tick, TYPE_MS);
        })();
        // 动作宏
        var act = $('st-live-action').value;
        if (act) applyAction(act, state.liveRole);
    }

    function finishLive() {
        state.liveBusy = false;
        if (state.typeTimer) { clearTimeout(state.typeTimer); state.typeTimer = null; }
        $('st-live-say').disabled = false;
        $('st-live-stop').disabled = true;
        setHint('即时台词模式');
    }

    function liveStop() {
        state.seq++;
        finishLive();
        stopVoices();
        liveMsg('已停止');
    }

    /* ---------- 编辑器 ---------- */

    function markStale() { state.stale = true; }

    /* 重建面板时不要动正在输入的元素，否则光标会跳到末尾 */
    function setVal(el, value) {
        if (document.activeElement === el && el.value === value) return;
        el.value = value;
    }

    function fillSelect(el, values, current, emptyLabel, labelFn) {
        el.innerHTML = '';
        if (emptyLabel) addOption(el, '', emptyLabel);
        (values || []).forEach(function (v) { addOption(el, v, labelFn ? labelFn(v) : v); });
        var want = current || '';
        el.value = want;
        if (want && el.value !== want) {
            addOption(el, want, want + '（缺失）');
            el.value = want;
        }
    }

    function renderList() {
        var ol = $('st-lines');
        ol.innerHTML = '';
        lines().forEach(function (line, i) {
            var li = document.createElement('li');
            li.className = 'st-line' + (i === state.sel ? ' is-sel' : '');
            li.draggable = true;
            li.dataset.i = String(i);
            li.innerHTML = '<span class="st-grip"></span>'
                + '<span class="st-line-idx"></span>'
                + '<span class="st-line-role"></span>'
                + '<span class="st-line-flags"></span>'
                + '<span class="st-line-text"></span>'
                + '<span class="st-line-ops">'
                + '<button type="button" data-op="up" title="上移">▲</button>'
                + '<button type="button" data-op="down" title="下移">▼</button>'
                + '<button type="button" data-op="del" title="删除">✕</button>'
                + '</span>';
            li.querySelector('.st-line-idx').textContent = String(i + 1);
            li.querySelector('.st-line-role').textContent = line.role ? castName(line.role) : '旁白';
            li.querySelector('.st-line-role').title = line.role
                ? (castName(line.role) === line.role ? line.role
                    : castName(line.role) + '（' + line.role + '，cast 里的键名）')
                : '没有 role 字段的行按旁白处理';
            // 上/下场用小标标出来，比塞在正文前更好扫
            var flags = li.querySelector('.st-line-flags');
            [].concat(line.enter || []).forEach(function (r) {
                var s = document.createElement('span');
                s.className = 'st-chip is-in';
                s.textContent = '↑' + r;
                flags.appendChild(s);
            });
            [].concat(line.exit || []).forEach(function (r) {
                var s = document.createElement('span');
                s.className = 'st-chip is-out';
                s.textContent = '↓' + r;
                flags.appendChild(s);
            });
            // 本行改了称呼（「？？？」「助手」之类）时标出来
            if (typeof line.name === 'string') {
                var shown = line.name.trim() ? line.name.trim() : castName(speakerOf(line));
                var sn = document.createElement('span');
                sn.className = 'st-chip is-name';
                sn.textContent = '“' + shown + '”';
                sn.title = line.name.trim()
                    ? '本行起称呼为「' + shown + '」'
                    : '本行起恢复默认名「' + shown + '」';
                flags.appendChild(sn);
            }
            Object.keys(line.move || {}).forEach(function (r) {
                var d = moveOf(line.move[r]);
                if (!d) return;
                var s = document.createElement('span');
                s.className = 'st-chip is-move';
                s.textContent = '↔' + r + (Number.isFinite(Number(d.x)) ? ' ' + Number(d.x) : '');
                flags.appendChild(s);
            });
            // 同台其他角色本行也有演出（动作或语音）时标出来
            Object.keys(line.cues || {}).forEach(function (r) {
                if (r === speakerOf(line)) return;
                var c = cueOf(line, r);
                if (!c.action && !c.voice) return;
                var s = document.createElement('span');
                s.className = 'st-chip is-cue';
                s.textContent = '✧' + r;
                s.title = '本行演出：' + [c.action ? (typeof c.action === 'string' ? c.action : '自定义动作') : '',
                    c.voice || ''].filter(Boolean).join(' · ');
                flags.appendChild(s);
            });
            li.querySelector('.st-line-text').textContent = line.text || '';
            ol.appendChild(li);
        });
        if (state.sel >= lines().length) state.sel = Math.max(0, lines().length - 1);
        $('st-json-name').textContent = state.file;
        $('st-sel-idx').textContent = String(state.sel + 1);
    }

    /* 登场阵容：一行里同时管两件事——左边挑「这一场有谁」，右边三态定「这一句谁上/下场」。
       站位与缩放在下面的「站位」区块统一调，第 1 行写的就是本场默认（baseStage）。
       新增/移除模型需保存后刷新才生效 */
    function stageNumInput(cls, value, min, max, title) {
        var el = document.createElement('input');
        el.type = 'number'; el.className = cls;
        el.min = min; el.max = max; el.step = '0.05';
        el.value = String(value); el.title = title;
        return el;
    }

    /* 这一行里该角色的上下场态：'' 不变 / 'enter' 登场 / 'exit' 退场 */
    function flagOf(line, role) {
        if ([].concat((line && line.enter) || []).indexOf(role) >= 0) return 'enter';
        if ([].concat((line && line.exit) || []).indexOf(role) >= 0) return 'exit';
        return '';
    }

    /* 一个角色一张卡，三排写完这个角色在这一句里的全部事情：
         ① 角色（这一场有谁）＋ 不变/登场/退场（这一句上下场）＋ ✕
         ② 位置 / 缩放 —— 第 1 行写的是全场默认，之后的行写的是本行走位，不写就沿用
         ③ 本行 —— 动作 / 语音；说话者写行级 action/voice，其他角色写 cues
       对象动作就在卡片里接着展开时间线 / 差分 / 存为宏。 */
    function renderRoster() {
        var box = $('st-stage-list');
        if (!box) return;
        var line = lines()[state.sel];
        box.innerHTML = '';
        var roles = castRoles();
        var eff = effectiveStage();

        if (!state.baseStage.length) {
            box.textContent = '（这一场还没有角色：先在角色表里给角色绑定模型，再点「添加角色」）';
            return;
        }
        state.baseStage.forEach(function (slot, i) {
            box.appendChild(actorCard(slot, i, line, roles, eff));
        });
    }

    function actorCard(slot, i, line, roles, eff) {
        var role = slot.role;
        var atScene = state.sel === 0;
        var flag = flagOf(line, role);
        var isSpeaker = role === speakerOf(line);

        var card = document.createElement('div');
        card.className = 'st-stage-row'
            + (flag ? ' is-' + flag : '')
            + (atScene ? ' is-base' : '')
            + (isSpeaker ? ' is-speaker' : '');
        card.dataset.i = String(i);
        card.dataset.role = role;
        if (isSpeaker) card.title = '这一句的说话者';

        /* ① 角色 + 上下场 + 移除 */
        var top = document.createElement('div');
        top.className = 'st-actor-top';

        var roleSel = document.createElement('select');
        roleSel.className = 'st-stage-role';
        roles.forEach(function (r) {
            var o = document.createElement('option');
            o.value = r; o.textContent = roleLabel(r);
            roleSel.appendChild(o);
        });
        roleSel.value = role;
        roleSel.addEventListener('change', function () {
            slot.role = this.value; markStale();
            rebuildStaging(state.sel);
            renderRoster();            // 三排都跟着换角色
        });

        // 三态：点哪边就只留哪边，同一角色不会同时进 enter 和 exit
        var seg = document.createElement('span');
        seg.className = 'st-flag-seg';
        [['', '不变'], ['enter', '登场'], ['exit', '退场']].forEach(function (o) {
            var b = document.createElement('button');
            b.type = 'button';
            b.dataset.role = role;
            b.dataset.kind = o[0];
            b.textContent = o[1];
            if (o[0] === flag) b.className = 'is-on ' + (o[0] || 'none');
            seg.appendChild(b);
        });

        var del = document.createElement('button');
        del.type = 'button'; del.title = '从这一场移除'; del.textContent = '✕';
        del.className = 'st-stage-del';
        del.addEventListener('click', function () {
            state.baseStage.splice(i, 1); markStale();
            rebuildStaging(state.sel);
            renderRoster();
        });

        top.appendChild(roleSel); top.appendChild(seg); top.appendChild(del);
        card.appendChild(top);

        /* ② 位置 / 缩放 */
        var posRow = document.createElement('div');
        posRow.className = 'st-actor-row';
        var own = atScene ? null : lineMove(line, role);
        if (own) card.classList.add('is-own');      // 这一行自己改过站位
        var shown = slot;
        for (var k = 0; k < eff.length; k++) {
            if (eff[k].role === role) { shown = eff[k]; break; }
        }

        var posLbl = document.createElement('span');
        posLbl.className = 'lbl'; posLbl.textContent = '位置';
        var x = stageNumInput('st-stage-x', shown.x, '-1', '1',
            atScene ? '全场横向位置 -1..1' : (own ? '本行横向位置 -1..1' : '沿用上一句的水平位置'));
        var scLbl = document.createElement('span');
        scLbl.className = 'lbl'; scLbl.textContent = '缩放';
        var sc = stageNumInput('st-stage-scale', shown.scale, '0.2', '2',
            atScene ? '全场缩放' : (own ? '本行缩放' : '沿用上一句的缩放'));

        var reset = document.createElement('button');
        reset.type = 'button'; reset.className = 'st-stage-reset'; reset.textContent = '↺';
        reset.title = atScene ? '第 1 行就是全场默认，没有可恢复的上一句' : '恢复为上一句的位置';
        reset.disabled = atScene || !own;

        function bind(input, key) {
            input.addEventListener('input', function () {
                var v = parseFloat(this.value);
                if (!isFinite(v) || (key === 'scale' && v <= 0)) return;
                if (atScene) {
                    setBasePos(role, key, v);          // 第 1 行改的是场景默认
                } else {
                    setLineMove(role, key, v);
                    card.classList.remove('is-base');
                    card.classList.add('is-own');
                    reset.disabled = false;
                    x.title = sc.title = '本行已改站位';
                    renderList();                      // 行列表里的 ↔ 小标同步
                }
                rebuildStaging(state.sel);
            });
        }
        bind(x, 'x'); bind(sc, 'scale');

        reset.addEventListener('click', function () {
            clearLineMove(role);
            rebuildStaging(state.sel);
            renderRoster();
            renderList();
        });

        posRow.appendChild(posLbl); posRow.appendChild(x);
        posRow.appendChild(scLbl); posRow.appendChild(sc);
        posRow.appendChild(reset);
        card.appendChild(posRow);

        /* ③ 本行：动作 / 语音 */
        var cue = cueOf(line, role);
        var item = state.cast && state.cast[role];
        var dir = item && item.voiceDir;

        var actRow = document.createElement('div');
        actRow.className = 'st-actor-row';
        var actLbl = document.createElement('span');
        actLbl.className = 'lbl'; actLbl.textContent = '本行';
        actRow.appendChild(actLbl);

        var actSel = document.createElement('select');
        actSel.dataset.key = 'action';
        actSel.title = '这一句的动作：空着＝保持原来的表情';
        if (isSpeaker) actSel.id = 'st-action';
        addOption(actSel, '', '不改变');
        macroOptions(role).forEach(function (n) { addOption(actSel, n, n); });
        addOption(actSel, '__custom__', '自定义…');
        var actVal = typeof cue.action === 'string' ? cue.action
            : (cue.action ? '__custom__' : '');
        if (actVal && actVal !== '__custom__' && macroOptions(role).indexOf(actVal) < 0) {
            addOption(actSel, actVal, actVal + '（缺失）');
        }
        actSel.value = actVal;
        actRow.appendChild(actSel);

        var voiceSel = document.createElement('select');
        voiceSel.dataset.key = 'voice';
        voiceSel.title = '这一句的语音';
        if (isSpeaker) voiceSel.id = 'st-voice';
        addOption(voiceSel, '', '无语音');
        var files = (dir && state.voices[dir]) || [];
        files.forEach(function (f) { addOption(voiceSel, f, f); });
        if (cue.voice && files.indexOf(cue.voice) < 0) {
            addOption(voiceSel, cue.voice, cue.voice + '（缺失）');
        }
        voiceSel.value = cue.voice || '';
        if (dir && !state.voices[dir]) loadVoices(role);   // 载入后会重渲染
        actRow.appendChild(voiceSel);
        card.appendChild(actRow);

        // 对象动作：就地编辑 主时间线 / 差分槽 1 / 差分槽 2，三个都是下拉，随时能改选
        if (cue.action && typeof cue.action === 'object') {
            var custom = document.createElement('div');
            custom.className = 'st-cue-custom';

            var mains = optionsFor(role, 'mainTimelineLabels');
            var tlSel = mkLabelSelect('timeline', '主时间线', mains, cue.action.timeline, '（不改）');
            if (cue.action.timeline && mains.indexOf(cue.action.timeline) < 0) {
                tlSel.classList.add('is-missing');
                tlSel.title = '当前模型没有这个标签';
            }
            custom.appendChild(cueField('主时间线', tlSel));

            var diffs = optionsFor(role, 'diffTimelineLabels');
            custom.appendChild(cueField('差分槽 1',
                mkLabelSelect('diff1', '差分槽 1', diffs, cue.action.diffSlot1)));
            custom.appendChild(cueField('差分槽 2',
                mkLabelSelect('diff2', '差分槽 2', diffs, cue.action.diffSlot2)));

            var saveRow = document.createElement('div');
            saveRow.className = 'st-macro-save';
            var macro = document.createElement('input');
            macro.type = 'text';
            macro.dataset.key = 'macro-name';
            macro.placeholder = '给这套动作起个名字';
            var saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.dataset.macroSave = '1';
            saveBtn.textContent = '存为宏';
            saveBtn.title = '把上面这套 timeline / 差分存成这个角色的动作宏，之后下拉里直接选';
            saveRow.appendChild(macro);
            saveRow.appendChild(saveBtn);
            custom.appendChild(saveRow);

            card.appendChild(custom);
        }

        /* ④ 绑定：模型 / 语音目录。默认收成一行摘要，点开才展开——
              这两项是「这个角色用哪套皮、声音在哪」，属于角色本身，就近放在角色卡上 */
        var bindRow = document.createElement('div');
        bindRow.className = 'st-actor-row st-actor-bind';
        var bindOpen = !!state.bindOpen[role];

        var bindBtn = document.createElement('button');
        bindBtn.type = 'button';
        bindBtn.className = 'st-bind-toggle' + (bindOpen ? ' is-open' : '') + (item && item.model ? '' : ' is-warn');
        bindBtn.dataset.bind = '1';
        bindBtn.title = '这个角色用哪套模型、语音放在哪（保存后刷新生效）';
        var bindVal = document.createElement('span');
        bindVal.className = 'st-bind-val';
        bindVal.textContent = (item && item.model) ? modelShort(item.model) : '未绑模型';
        var bindCaret = document.createElement('span');
        bindCaret.className = 'st-bind-caret';
        bindCaret.textContent = bindOpen ? '▾' : '▸';
        bindBtn.appendChild(document.createTextNode('绑定'));
        bindBtn.appendChild(bindVal);
        bindBtn.appendChild(bindCaret);
        bindRow.appendChild(bindBtn);
        card.appendChild(bindRow);

        var bindBody = document.createElement('div');
        bindBody.className = 'st-bind-body' + (bindOpen ? ' is-open' : '');

        var mRow = document.createElement('div');
        mRow.className = 'st-actor-row';
        var mLbl = document.createElement('span');
        mLbl.className = 'lbl'; mLbl.textContent = '模型';
        var mSel = document.createElement('select');
        mSel.dataset.key = 'model';
        mSel.title = 'character/data/ 下的「角色/文件」';
        addOption(mSel, '', '（未绑定）');
        (state.models || []).forEach(function (g) {
            var og = document.createElement('optgroup');
            og.label = g.folder;
            g.models.forEach(function (m) {
                var o = document.createElement('option');
                o.value = m;
                o.textContent = m.slice(g.folder.length + 1);
                og.appendChild(o);
            });
            mSel.appendChild(og);
        });
        var curModel = (item && item.model) || '';
        mSel.value = curModel;
        if (curModel && mSel.value !== curModel) addOption(mSel, curModel, curModel + '（缺失）'), mSel.value = curModel;
        mRow.appendChild(mLbl); mRow.appendChild(mSel);
        bindBody.appendChild(mRow);

        var vRow = document.createElement('div');
        vRow.className = 'st-actor-row';
        var vLbl = document.createElement('span');
        vLbl.className = 'lbl'; vLbl.textContent = '语音';
        var vInput = document.createElement('input');
        vInput.type = 'text';
        vInput.dataset.key = 'voiceDir';
        vInput.value = (item && item.voiceDir) || '';
        vInput.placeholder = '../../character/sounds/krs/';
        vInput.title = '相对 /story/ 的语音目录；留空＝按默认规则找';
        vRow.appendChild(vLbl); vRow.appendChild(vInput);
        bindBody.appendChild(vRow);

        var bindNote = document.createElement('div');
        bindNote.className = 'st-bind-note';
        var vCount = (item && item.voiceDir && state.voices[item.voiceDir]) ? state.voices[item.voiceDir].length : null;
        bindNote.textContent = (item && item.model)
            ? (vCount != null ? '该目录下 ' + vCount + ' 个音频' : '改模型后需保存并刷新页面')
            : '还没绑模型，这个角色不会出现在登场阵容里';
        bindBody.appendChild(bindNote);

        card.appendChild(bindBody);

        return card;
    }

    /* 模型文件名很长，摘要里只留最后一段并掐掉扩展名 */
    function modelShort(m) {
        var seg = String(m).split('/').pop();
        var cut = seg.indexOf('.psb');
        return cut > 0 ? seg.slice(0, cut) : seg.replace(/\.zip$/i, '');
    }

    /* 下拉的通用构造：空值＝不改，其余是模型自带标签；当前值不在清单里时补一条「缺失」，
       否则手动改过的值会被静默清掉。 */
    function mkSelect(key, labels, current, emptyText) {
        var sel = document.createElement('select');
        sel.dataset.key = key;
        addOption(sel, '', emptyText || '（无）');
        labels.forEach(function (l) { addOption(sel, l, l); });
        var v = current || '';
        if (v && labels.indexOf(v) < 0) addOption(sel, v, v + '（缺失）');
        sel.value = v;
        return sel;
    }
    function mkLabelSelect(key, title, labels, current, emptyText) {
        var sel = mkSelect(key, labels, current, emptyText);
        sel.title = title;
        return sel;
    }

    /* 到当前行为止的生效站位：base 叠加 0..sel 行的 move，用来显示「沿用」的值 */
    function effectiveStage() {
        var eff = cloneStage(state.baseStage);
        var list = lines();
        var last = Math.min(state.sel, list.length - 1);
        for (var i = 0; i <= last; i++) {
            var mv = list[i] && list[i].move;
            if (!mv) continue;
            Object.keys(mv).forEach(function (role) {
                var d = moveOf(mv[role]);
                if (!d) return;
                eff.forEach(function (s) {
                    if (s.role !== role) return;
                    ['x', 'scale', 'z'].forEach(function (k) {
                        if (Number.isFinite(Number(d[k]))) s[k] = Number(d[k]);
                    });
                });
            });
        }
        return eff;
    }
    function lineMove(line, role) {
        return (line && line.move && moveOf(line.move[role])) || null;
    }
    function setLineMove(role, key, value) {
        var line = lines()[state.sel];
        if (!line) return;
        var cur = lineMove(line, role) || {};
        var next = { x: cur.x, scale: cur.scale, z: cur.z };
        next[key] = value;
        Object.keys(next).forEach(function (k) { if (next[k] === undefined) delete next[k]; });
        var mv = line.move || (line.move = {});
        mv[role] = next;
        markStale();
    }
    function clearLineMove(role) {
        var line = lines()[state.sel];
        if (!line || !line.move) return;
        delete line.move[role];
        if (!Object.keys(line.move).length) delete line.move;
        markStale();
    }

    /* 第 1 行的站位就是本场默认（写进 scene.stage）；第 2 行起才是行内 move 覆盖。
       于是「谁站在哪」只有「站位」这一处可改，登场阵容只管「有谁」与「这一句谁上下场」。 */
    function setBasePos(role, key, value) {
        var slot = baseSlotOf(role);
        if (!slot) return;
        slot[key] = value;
        /* 第 1 行若还留着手写的同名字段，会盖掉刚改的默认值，顺手清掉 */
        var line = lines()[0];
        var mv = line && line.move;
        if (mv && mv[role] !== undefined) {
            if (typeof mv[role] === 'number') {
                if (key === 'x') delete mv[role];
            } else {
                var d = moveOf(mv[role]);
                if (d) {
                    delete d[key];
                    if (!Object.keys(d).length) delete mv[role];
                }
            }
            if (!Object.keys(mv).length) delete line.move;
        }
        markStale();
    }

    // ============================================================
    //  角色表页签（cast.json）
    //  它不是「另一个页面」——叠在剧本上，剧本列表左侧仍可见可点。
    //  日常的模型 / 默认名 / 动作宏都在角色卡与「第 N 行」里就地完成；
    //  这里只做全景核对、重命名与删除。改动直接进 state.cast，
    //  和剧本共用顶栏那一枚「保存」（saveCurrent 会把两个文件一起写盘）。
    // ============================================================

    /* 角色表里真正的角色键：排除说明字段 doc 与下划线开头的内部键 */
    function castKeys() {
        return Object.keys(state.cast || {}).filter(function (k) {
            return k !== 'doc' && k.charAt(0) !== '_';
        });
    }

    /* 动作宏列顶部的眨眼条：读写「当前选中角色」的 blink，缺省即开 */
    function syncBlinkRole() {
        var role = state.castSel;
        var g = (state.cast && state.cast[role] && state.cast[role].blink) || {};
        var on = g.on !== false;
        var chk = $('st-blink-default');
        if (chk) chk.checked = on;
        var box = document.querySelector('.st-blink-global');
        if (box) box.classList.toggle('is-off', !on);
        BLINK_KEYS.forEach(function (k) {
            var el = $('st-blink-g-' + k);
            if (!el) return;
            var v = Number(g[k]);
            if (!Number.isFinite(v)) v = DEFAULT_BLINK[k];
            el.value = String(v);
        });
    }

    function onBlinkGlobalChange(evt) {
        var t = evt.target;
        if (!t || !t.id) return;
        var role = state.castSel;
        var entry = state.cast && state.cast[role];
        if (!entry) return;
        var g = (entry.blink && typeof entry.blink === 'object') ? entry.blink : (entry.blink = {});
        if (t.id === 'st-blink-default') {
            if (t.checked) { delete g.on; if (!Object.keys(g).length) delete entry.blink; }
            else g.on = false;                    // 缺省即开，只在关掉时落 false
        } else if (t.id.indexOf('st-blink-g-') === 0) {
            var key = t.id.slice('st-blink-g-'.length);
            var n = Number(t.value);
            if (t.value === '' || !Number.isFinite(n)) delete g[key];
            else g[key] = Math.max(0, n);
        } else return;
        if (entry.blink && !Object.keys(entry.blink).length) delete entry.blink;
        syncBlinkRole();
        markStale();
        renderDrawer();      // 动作摘要与参数 placeholder 跟着变
    }

    /* 两个页签：剧本 / 角色表。切页只改显示，不重建剧本列表，
       所以「去角色表改完再回来」仍然停在原来那一行。 */
    function setTab(tab) {
        if (tab === 'cast' && !state.cast) return;
        state.tab = (tab === 'cast') ? 'cast' : 'script';
        $('st-editor').dataset.tab = state.tab;
        $('st-view-script').hidden = (state.tab !== 'script');
        $('st-view-cast').hidden = (state.tab !== 'cast');
        [].forEach.call(document.querySelectorAll('.st-tab'), function (b) {
            b.classList.toggle('is-on', b.dataset.tab === state.tab);
        });
        if (state.tab === 'cast') {
            // 默认选中当前行的说话者（没有就选第一个），省掉「进来还要再点一下」
            if (castKeys().indexOf(state.castSel) < 0) {
                var keys = castKeys();
                var spk = speakerOf(lines()[state.sel] || {});
                state.castSel = keys.indexOf(spk) >= 0 ? spk : (keys[0] || '');
            }
            state.castAct = null;
            syncBlinkRole();
            renderDrawer();
        } else {
            $('st-cast-role-new').hidden = true;
            $('st-cast-act-new').hidden = true;
        }
    }

    function castTabOn() {
        return state.tab === 'cast';
    }

    function renderDrawer() {
        if (!castTabOn()) return;
        renderCastRoleList();
        renderCastActList();
        renderCastFields();
    }

    function castItemRow(dataKey, key, selected) {
        var row = document.createElement('div');
        row.className = 'st-cast-item' + (selected ? ' is-sel' : '');
        row.dataset[dataKey] = key;
        return row;
    }
    function castDelBtn(title) {
        var del = document.createElement('button');
        del.type = 'button'; del.dataset.op = 'del'; del.textContent = '×';
        del.title = title;
        var ops = document.createElement('span');
        ops.className = 'st-cast-item-ops';
        ops.appendChild(del);
        return ops;
    }

    /* ---- 左列：角色列表 ---- */
    function renderCastRoleList() {
        var box = $('st-cast-role-list');
        box.innerHTML = '';
        var keys = castKeys();
        if (!keys.length) {
            box.appendChild(edEmpty('还没有角色，点上方「＋」新增。'));
            return;
        }
        keys.forEach(function (role) {
            var item = state.cast[role] || {};
            var row = castItemRow('role', role, role === state.castSel);

            var name = document.createElement('span');
            name.className = 'st-cast-item-name';
            name.textContent = role + (item.model ? '' : ' · 未绑模型');
            name.title = role + (item.model ? '' : '（未绑定模型，不会出现在登场阵容）');
            row.appendChild(name);
            row.appendChild(castDelBtn('删除角色 ' + role + '（剧本里引用它的行会一起清掉相关字段，无法撤销）'));
            box.appendChild(row);
        });
    }

    /* 第 2 栏：当前角色的动作宏。名字旁边直接给出主时间线，
       不必逐个点开才知道「这个名字到底播什么」。 */
    function renderCastActList() {
        var box = $('st-cast-act-list');
        if (!box) return;
        box.innerHTML = '';
        var add = $('st-cast-act-add');
        var role = state.castSel;
        if (add) {
            var enabled = !!role;
            add.disabled = !enabled;
            add.style.opacity = enabled ? '1' : '.4';
        }
        if (!role) { box.appendChild(edEmpty('先在左边选一个角色。')); return; }
        var acts = (state.cast[role] && state.cast[role].actions) || {};
        var names = Object.keys(acts);
        if (!names.length) {
            box.appendChild(edEmpty('还没有动作宏。在角色卡里「自定义…」调好后点「存为宏」，宏就长在这里。'));
            return;
        }
        names.forEach(function (n) {
            var a = acts[n] || {};
            var row = castItemRow('act', n, n === state.castAct);

            var nm = document.createElement('span');
            nm.className = 'st-cast-item-name';
            nm.textContent = n;
            row.appendChild(nm);

            var meta = document.createElement('span');
            meta.className = 'st-cast-item-meta';
            meta.textContent = a.timeline || '（无）';
            meta.title = [a.timeline, a.diffSlot1, a.diffSlot2].filter(Boolean).join(' · ') || '没有填时间线';
            row.appendChild(meta);
            row.appendChild(castDelBtn('删除动作宏 ' + n));
            box.appendChild(row);
        });
    }

    function edEmpty(text) {
        var d = document.createElement('div');
        d.className = 'st-cast-empty';
        d.textContent = text;
        return d;
    }

    /* ---- 第 3 栏：属性（选中角色 → 角色属性；选中宏 → 宏属性）---- */
    function renderCastFields() {
        var box = $('st-cast-fields');
        box.innerHTML = '';
        var role = state.castSel;
        if (!role) {
            box.appendChild(edEmpty('选中角色后，在这里核对模型、语音目录与动作宏。'));
            return;
        }
        var wrap = document.createElement('div');
        wrap.className = 'st-cast-fields-inner';
        box.appendChild(wrap);

        if (state.castAct == null) renderCastRoleFields(wrap, role);
        else renderCastActFields(wrap, role, state.castAct);
    }

    /* 角色属性：显示名 / 模型 / 语音目录 */
    function renderCastRoleFields(wrap, role) {
        var item = state.cast[role] || {};
        var crumb = document.createElement('div');
        crumb.className = 'st-cast-breadcrumb';
        crumb.innerHTML = '角色 · <b></b>';
        crumb.querySelector('b').textContent = role;
        wrap.appendChild(crumb);

        // 角色键名（内部 id）可直接改，剧本引用同步迁移
        wrap.appendChild(edField('角色 id（剧本按此名引用）', edInput('text', role, 'cast-key', '改名会同步更新所有剧本引用')));

        var nameRow = document.createElement('label');
        nameRow.className = 'st-field';
        nameRow.appendChild(edSpan('显示名'));
        var name = edInput('text', (typeof item.name === 'string' ? item.name : ''), 'name', '留空＝用角色 id 当显示名');
        nameRow.appendChild(name);
        wrap.appendChild(nameRow);

        // 模型下拉（与 renderCast 同源的目录索引）
        var modelLabel = document.createElement('label');
        modelLabel.className = 'st-field';
        modelLabel.appendChild(edSpan('模型（character/data/ 下的「角色/文件」）'));
        var sel = document.createElement('select');
        sel.dataset.key = 'model';
        var blank = document.createElement('option');
        blank.value = ''; blank.textContent = '（未绑定）';
        sel.appendChild(blank);
        (state.models || []).forEach(function (g) {
            var og = document.createElement('optgroup');
            og.label = g.folder;
            g.models.forEach(function (m) {
                var o = document.createElement('option');
                o.value = m; o.textContent = m.slice(g.folder.length + 1);
                og.appendChild(o);
            });
            sel.appendChild(og);
        });
        var cur = item.model || '';
        sel.value = cur;
        if (cur && sel.value !== cur) {
            var miss = document.createElement('option');
            miss.value = cur; miss.textContent = cur + '（缺失）';
            sel.appendChild(miss); sel.value = cur;
        }
        modelLabel.appendChild(sel);
        wrap.appendChild(modelLabel);

        var voiceRow = document.createElement('label');
        voiceRow.className = 'st-field';
        voiceRow.appendChild(edSpan('语音目录（相对 /story/，如 ../../character/sounds/krs/）'));
        voiceRow.appendChild(edInput('text', item.voiceDir || '', 'voiceDir', '留空＝用默认规则'));
        wrap.appendChild(voiceRow);

        wrap.appendChild(edHint('角色是剧本引用的内部 id；模型、语音目录、动作宏都绑在它下面。换造型只改「模型」即可，不用动剧本。'));
    }

    /* 动作宏属性：timeline / diffSlot1 / diffSlot2 / duration / variables[]
       就地展开在所选那一行下面，所以不再需要面包屑。 */
    function renderCastActFields(wrap, role, actName) {
        var a = (((state.cast[role] || {}).actions || {})[actName]) || {};

        // 动作宏名（可改，剧本里引用同步迁移）
        wrap.appendChild(edField('宏名（台词里用它来触发）', edInput('text', actName, 'act-key', '改名会同步更新剧本引用')));

        var mains = optionsFor(role, 'mainTimelineLabels');
        var diffs = optionsFor(role, 'diffTimelineLabels');
        wrap.appendChild(edSelectField('主时间线', 'timeline', a.timeline || '', mains));
        wrap.appendChild(edSelectField('差分槽 1', 'diffSlot1', a.diffSlot1 || '', diffs));
        wrap.appendChild(edSelectField('差分槽 2', 'diffSlot2', a.diffSlot2 || '', diffs));

        var durRow = document.createElement('label');
        durRow.className = 'st-field';
        durRow.appendChild(edSpan('保持时长（ms，留空＝默认）'));
        durRow.appendChild(edInput('number', a.duration != null ? String(a.duration) : '', 'duration', '1000'));
        wrap.appendChild(durRow);

        // ---- variables[] ----
        var vHead = document.createElement('div');
        vHead.className = 'st-sub';
        vHead.innerHTML = '<h4>变量 variables</h4>';
        var vOps = document.createElement('div');
        vOps.style.cssText = 'display:flex;gap:6px';
        var vAdd = document.createElement('button');
        vAdd.type = 'button'; vAdd.id = 'st-cast-var-add';
        vAdd.className = 'st-var-tool';
        vAdd.textContent = '＋ 添加变量';
        vOps.appendChild(vAdd);
        var vPaste = document.createElement('button');
        vPaste.type = 'button'; vPaste.id = 'st-cast-var-paste';
        vPaste.className = 'st-var-tool';
        vPaste.textContent = '粘贴导入';
        vPaste.title = '把舞台页「变量微调」里复制的内容粘贴进来，一次添加多个变量';
        vOps.appendChild(vPaste);
        vHead.appendChild(vOps);
        wrap.appendChild(vHead);

        var colHead = document.createElement('div');
        colHead.className = 'st-var-head';
        ['变量名', '值', '时长', '延迟'].forEach(function (t) {
            var s = document.createElement('span'); s.textContent = t; colHead.appendChild(s);
        });
        var pad = document.createElement('span'); colHead.appendChild(pad);
        wrap.appendChild(colHead);

        var varBox = document.createElement('div');
        varBox.id = 'st-cast-var-list';
        wrap.appendChild(varBox);
        renderCastVars(varBox, role, a.variables || []);

        // 粘贴导入面板（默认隐藏），直接吃 stage「复制参数」导出的 JSON
        var pastePanel = document.createElement('div');
        pastePanel.className = 'st-var-paste';
        pastePanel.id = 'st-cast-var-paste-panel';
        pastePanel.hidden = true;
        var pasteTip = document.createElement('div');
        pasteTip.className = 'st-var-paste-tip';
        pasteTip.textContent = '把舞台页「变量微调」里复制的内容粘贴到这里，点「导入」即可追加到下方变量（Ctrl+Enter 快速导入）。';
        pastePanel.appendChild(pasteTip);
        var pasteText = document.createElement('textarea');
        pasteText.id = 'st-cast-var-paste-text';
        pasteText.rows = 5;
        pasteText.spellcheck = false;
        pasteText.placeholder = '[{"name":"fade_eyebrow_type_a","value":24,"duration":300}, ...]';
        pastePanel.appendChild(pasteText);
        var pasteOps = document.createElement('div');
        pasteOps.className = 'st-var-paste-ops';
        var pasteDo = document.createElement('button');
        pasteDo.type = 'button'; pasteDo.dataset.op = 'paste-do'; pasteDo.textContent = '导入';
        var pasteCancel = document.createElement('button');
        pasteCancel.type = 'button'; pasteCancel.dataset.op = 'paste-cancel'; pasteCancel.textContent = '取消';
        pasteOps.appendChild(pasteDo); pasteOps.appendChild(pasteCancel);
        var pasteMsg = document.createElement('span');
        pasteMsg.className = 'st-var-paste-tip';
        pasteMsg.id = 'st-cast-var-paste-msg';
        pasteOps.appendChild(pasteMsg);
        pastePanel.appendChild(pasteOps);
        wrap.appendChild(pastePanel);

        // ---- 眨眼不在这里配：节奏由 wasm 自动眨眼驱动，开关与眼皮值在角色表顶部 ----

        wrap.appendChild(edHint('变量名从下拉里选；列表里没有的选「自定义…」后直接输入，回车或点别处确认。值填数字，时长和延迟填毫秒（ms）。' +
            '想省事的话：先在舞台页控制台的「变量微调」里调好，点「复制参数」，再回到这里点「粘贴导入」，一次就能全部带进来。'));
    }

    /* 模型声明的变量名（label 优先，与 stage 面板一致） */
    function varNamesFor(role) {
        var p = playerOf(role);
        try {
            return ((p && p.variableList) || []).map(function (v) { return v.label || v.name || v; });
        } catch (_) { return []; }
    }

    /* 变量名那一格：选项 = 模型声明的变量 + 当前值（未声明时也并入）+「自定义…」 */
    function buildVarNameCell(role, v) {
        var cell = document.createElement('div');
        cell.className = 'v-name-cell';
        var name = document.createElement('select');
        name.className = 'v-name'; name.dataset.k = 'name';
        var opts = varNamesFor(role).slice();
        if (v.name && opts.indexOf(v.name) < 0) opts.push(v.name);
        opts.forEach(function (n) {
            var opt = document.createElement('option');
            opt.value = n; opt.textContent = n; name.appendChild(opt);
        });
        var customOpt = document.createElement('option');
        customOpt.value = '__custom__'; customOpt.textContent = '自定义…';
        name.appendChild(customOpt);
        name.value = v.name && opts.indexOf(v.name) >= 0 ? v.name : '__custom__';
        name.title = v.name || '变量名';
        cell.appendChild(name);
        return cell;
    }

    /* 选中「自定义…」时把 select 原地换成输入框：Enter / 失焦写回，Esc 还原。
       自定义名作为 option 直接并入下拉，所以每行只有 v.name 一个真值，
       没有 hidden 状态、没有第二个 dataset.k、也不需要 ▾ 按钮。 */
    function beginVarNameEdit(row, v) {
        var cell = row.querySelector('.v-name-cell');
        if (!cell) return;
        var sel = cell.querySelector('select.v-name');
        if (!sel || cell.querySelector('input.v-name')) return;
        var orig = v.name || '';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'v-name';
        input.value = orig;
        input.placeholder = '自定义变量名';
        input.title = orig || '自定义变量名';
        cell.replaceChild(input, sel);
        input.focus(); input.select();
        var finalized = false;
        function finish(restore) {
            if (finalized) return;
            finalized = true;
            v.name = restore ? orig : input.value.trim();
            markStale();
            // 只重建当前行这一格：用户若点「值」输入框来失焦，那个目标不会被移除
            cell.parentNode.replaceChild(buildVarNameCell(state.castSel, v), cell);
        }
        input.addEventListener('input', function () {
            v.name = input.value;
            markStale();
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); finish(false); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(true); }
        });
        input.addEventListener('blur', function () { finish(false); });
    }

    function renderCastVars(box, role, vars) {
        box.innerHTML = '';
        vars.forEach(function (v, i) {
            var row = document.createElement('div');
            row.className = 'st-var-row';
            row.dataset.i = String(i);
            row.appendChild(buildVarNameCell(role, v));
            var value = document.createElement('input');
            value.className = 'v-num'; value.type = 'number'; value.dataset.k = 'value';
            value.value = (v.value != null ? String(v.value) : '0'); value.title = '值';
            row.appendChild(value);
            var dur = document.createElement('input');
            dur.className = 'v-num'; dur.type = 'number'; dur.dataset.k = 'duration';
            dur.value = (v.duration != null ? String(v.duration) : '0'); dur.title = '时长 ms';
            row.appendChild(dur);
            var delay = document.createElement('input');
            delay.className = 'v-num'; delay.type = 'number'; delay.dataset.k = 'delay';
            delay.value = (v.delay != null ? String(v.delay) : '0'); delay.title = '延迟 ms';
            row.appendChild(delay);
            var del = document.createElement('button');
            del.type = 'button'; del.dataset.op = 'del-var'; del.textContent = '×';
            del.title = '删除这个变量';
            row.appendChild(del);
            box.appendChild(row);
        });
        if (!vars.length) box.appendChild(edEmpty('还没有变量，点上方「＋ 添加变量」。'));
    }

    /* 解析从 stage「复制参数」粘贴来的变量 JSON。
       标准 [{name,value,duration,delay}, ...] 直接可用；
       也容错用户示例里的 [{ {...}, {...} }] 这类多余包裹——
       统一用正则抠出每个最内层 {...} 对象逐个解析，跳过非法项。 */
    function parsePastedVars(text) {
        var out = [], m, re = /\{[^{}]*\}/g;
        if (!text || !text.trim()) return out;
        while ((m = re.exec(text)) !== null) {
            var obj;
            try { obj = JSON.parse(m[0]); } catch (e) { continue; }
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
            var name = obj.name != null ? String(obj.name).trim() : '';
            if (!name) continue;
            var val = Number(obj.value);
            var dur = Number(obj.duration);
            var dly = Number(obj.delay);
            out.push({
                name: name,
                value: isFinite(val) ? val : 0,
                duration: isFinite(dur) ? dur : DEFAULT_VAR_DURATION,
                delay: isFinite(dly) ? dly : 0
            });
        }
        return out;
    }

    function edSpan(text) {
        var s = document.createElement('span'); s.textContent = text; return s;
    }
    function edInput(type, value, key, placeholder) {
        var i = document.createElement('input');
        i.type = type; i.dataset.key = key; i.value = value;
        if (placeholder != null) i.placeholder = placeholder;
        return i;
    }
    function edField(label, input) {
        var l = document.createElement('label');
        l.className = 'st-field';
        l.appendChild(edSpan(label));
        l.appendChild(input);
        return l;
    }
    /* 下拉字段：空值＝不改，候选是该角色模型的标签。
       为什么不是 input + datalist：datalist 会拿输入框里的现有文本去过滤候选，
       一旦有过值，展开就只剩那一个匹配项，选不了别的（必须手动清空才行）。
       换成 select 后任何时候都能重新选，选完也不重绘输入框。 */
    function edSelectField(label, key, value, options, emptyText) {
        return edField(label, mkSelect(key, options || [], value || '', emptyText || '（不改）'));
    }
    function edHint(text) {
        var p = document.createElement('div');
        p.className = 'st-cast-hint'; p.textContent = text;
        return p;
    }

    /* 当前选中的动作对象引用 */
    function selCastAct() {
        if (!state.castSel || state.castAct == null) return null;
        var item = state.cast[state.castSel];
        if (!item || !item.actions) return null;
        return item.actions[state.castAct] || null;
    }

    /* 角色表没有自己的「保存」：改动落在 state.cast，顶栏那一枚保存会连剧本一起写盘 */

    function macroOptions(role) {
        var acts = (state.cast && state.cast[role] && state.cast[role].actions) || {};
        return Object.keys(acts);
    }

    function addOption(sel, value, text) {
        var o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        sel.appendChild(o);
    }

    /* 某个角色的模型能用的标签清单（主时间线 / 差分槽），两个差分槽共用同一份 */
    function optionsFor(role, key) {
        var p = playerOf(role);
        return (p && p[key]) ? p[key].slice() : [];
    }

    /* 下拉里怎么显示一个角色：有自定义显示名时带上内部 id，两个重名也分得开 */
    function roleLabel(role) {
        var n = castName(role);
        return n === role ? role : n + '（' + role + '）';
    }

    function cueField(label, control) {
        var wrap = document.createElement('label');
        wrap.className = 'st-cue-field';
        var cap = document.createElement('span');
        cap.textContent = label;
        wrap.appendChild(cap);
        wrap.appendChild(control);
        return wrap;
    }

    function renderProps() {
        if (!state.scene) return;
        setVal($('st-title'), state.scene.title || '');
        fillSelect($('st-bg'), state.bg || [], state.scene.background || '', '（跟随上一场景）');

        var line = lines()[state.sel];
        $('st-sel-idx').textContent = String(state.sel + 1);
        if (!line) {
            $('st-role').innerHTML = '';
            $('st-line-text').value = '';
            renderNameField(null);
            renderRoster();
            return;
        }
        var role = speakerOf(line);
        fillSelect($('st-role'), castKeys(),
            role, '', roleLabel);
        setVal($('st-line-text'), line.text || '');
        renderNameField(line);

        renderRoster();       // 角色卡：上下场、站位、本行动作与语音都跟着当前行走
        // AUTO 是播放界面的开关，不在行里；这里只剩「这一句多停多久」
        setVal($('st-wait'), Number.isFinite(line.wait) ? line.wait : '');
    }

    /* 「显示名」输入框：留空＝沿用上一句；placeholder 显示当前沿用到的称呼。
       ⟲ 把角色本名填进来，用来「从这一句起揭示真名」。 */
    function renderNameField(line) {
        var field = $('st-display-name');
        var btn = $('st-name-default');
        var mk = $('st-name-makedefault');
        if (!field) return;
        if (!line) {
            field.value = '';
            field.placeholder = '';
            field.disabled = true;
            if (btn) btn.disabled = true;
            if (mk) mk.disabled = true;
            return;
        }
        var role = speakerOf(line);
        var own = typeof line.name === 'string' ? line.name : '';
        field.disabled = false;
        field.value = own;
        field.placeholder = '沿用：' + inheritedName(role, state.sel);
        field.title = '这一句起对话框上显示的名字；留空＝沿用上一句。角色默认名「' + castName(role) + '」';
        if (btn) {
            btn.disabled = false;
            btn.title = '填入角色本名「' + castName(role) + '」（用来揭示真名）';
        }
        if (mk) {
            // 只有填了名字、且和当前默认名不同时才有意义
            var v = own.trim();
            mk.disabled = !v || v === castName(role);
            mk.title = v
                ? '把「' + v + '」写成「' + role + '」的默认名，之后所有没单独改过的行都显示它'
                : '先在左边填一个名字';
        }
    }

    function renderEditor() {
        renderList();
        renderProps();      // 里面会画角色卡
        renderDrawer();
        // 选中哪一句，画布就预览哪一句的站位与上下场
        if (state.mode === 'edit') rebuildStaging(state.sel);
    }

    function selectLine(i) {
        state.sel = i;
        if (state.mode === 'edit') rebuildStaging(i);
        renderList();
        renderProps();
    }

    function addLine() {
        var list = lines();
        var base = list[state.sel] || {};
        var line = { role: base.role || firstRole(state.cast), text: '' };
        var at = list.length ? state.sel + 1 : 0;
        list.splice(at, 0, line);
        state.sel = at;
        markStale();
        renderEditor();
        $('st-line-text').focus();
    }

    function shiftLine(i, delta) {
        var list = lines();
        var j = i + delta;
        if (j < 0 || j >= list.length) return;
        var tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
        state.sel = j;
        markStale();
        renderEditor();
    }

    function dropLine(from, insertAt) {
        var list = lines();
        if (from < 0 || from >= list.length) return;
        var item = list.splice(from, 1)[0];
        var at = insertAt > from ? insertAt - 1 : insertAt;
        if (at < 0) at = 0;
        if (at > list.length) at = list.length;
        list.splice(at, 0, item);
        state.sel = at;
        markStale();
        renderEditor();
    }

    function delLine(i) {
        var list = lines();
        if (i < 0 || i >= list.length) return;
        list.splice(i, 1);
        state.sel = Math.min(i, Math.max(0, list.length - 1));
        markStale();
        renderEditor();
    }

    /* ---------- 模式与场景 ---------- */

    /* 每次进入剧情模式、以及换剧本之后，都重播一遍对话框开场（窗口擦入 + 装饰线 + 名牌）。
       不重播的话 HUD 会直接以「已铺开」的终态出现——切剧本、编辑↔播放来回切都看不到动画，
       看起来就像「这次没加载」。open() 内部从第 0 帧起跑，会先撤掉 is-open，
       所以 AUTO 提示牌的滑入也一并重来。 */
    function playDialogIntro(done) {
        if (!state.dialog) { if (done) done(); return; }
        state.dialog.fit();       // 视口可能变过（全屏/缩放），先按当前尺寸摆好
        state.dialog.open(done);
    }

    function setMode(mode) {
        if (mode === 'edit' && state.liveOpen) closeLive();
        state.mode = mode;
        root.setAttribute('data-mode', mode);
        var buttons = document.querySelectorAll('.st-modes button');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-mode') === mode);
        }
        if (mode === 'edit') {
            stopAllBlinks();          // 编辑态预览别的动作，别让上一句的眨眼继续跑
            if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
            skipTyping();
            setHint('');
            // 选中正在播放的那一句，画布预览的站位/上下场与之前的画面保持一致
            state.sel = Math.min(state.idx, Math.max(0, lines().length - 1));
            renderEditor();
        } else if (state.stale) {
            state.stale = false;
            refreshLiveRoles();
            primeStageForIntro();       // 动画期间先看到新剧本的完整场景
            state.introPending = true;
            var introDone = false;
            var finishIntro = function () {
                if (introDone) return;
                introDone = true;
                state.introPending = false;
                restart();
            };
            playDialogIntro(finishIntro);
            setTimeout(finishIntro, 2000);
        } else {
            // 编辑模式可能预览过别的站位，回放前按当前播放行复位
            rebuildStaging(state.ended ? lines().length - 1 : state.idx);
            playDialogIntro();
            if (state.ended) setHint('点击重新开始');
            else if (state.autoOn) armAuto(state.autoReady ? state.lineVoice : null);
            else setHint('点击继续 ▸');
        }
    }

    function applyScene(scene, cast) {
        state.sel = 0;
        state.baseStage = stageOf(scene, cast);
        rebuildStaging(-1);       // 场景默认站位 + 开场显隐
        if (state.mode === 'edit') renderEditor();
        return castingKey(state.baseStage, cast);
    }

    async function loadIndex() {
        var r = await fetch(apiUrl(), { cache: 'no-store' });
        if (!r.ok) throw new Error('场景清单读取失败：' + r.status);
        var j = await r.json();
        state.scenes = j.scenes || [];
        var sel = $('st-scene');
        sel.innerHTML = '';
        state.scenes.forEach(function (s) {
            var opt = document.createElement('option');
            opt.value = s.file;
            opt.textContent = s.title;
            sel.appendChild(opt);
        });
        var fromUrl = new URLSearchParams(location.search).get('scene');
        state.file = (fromUrl && state.scenes.some(function (s) { return s.file === fromUrl; }))
            ? fromUrl : (state.scenes[0] && state.scenes[0].file);
        if (state.file) sel.value = state.file;
    }

    async function switchScene(file) {
        if (!file) return;
        try {
            var scene = await getJson(file);
            var stage = stageOf(scene, state.cast);
            var key = castingKey(stage, state.cast);
            /* 本场若用到尚未加载的模型，wasm 一页只能起一次，整页重载 */
            var needReload = stage.some(function (s) {
                return !state.actors[s.role] || state.actors[s.role].model !== state.cast[s.role].model;
            });
            if (needReload) {
                location.href = '?scene=' + encodeURIComponent(file);
                return;
            }
            state.file = file;
            state.scene = scene;
            applyScene(scene, state.cast);
            stopAllBlinks();          // 换场＝换一套站位与动作，旧眨眼表作废
            stopVoices();
            if (state.mode === 'play') {
                state.stale = false;
                primeStageForIntro();       // 动画期间先看到新剧本的完整场景
                state.introPending = true;
                var introDone = false;
                var finish = function () {
                    if (introDone) return;
                    introDone = true;
                    state.introPending = false;
                    restart();
                };
                playDialogIntro(finish);      // 换剧本＝换一场戏：动画铺开后才落台词
                setTimeout(finish, 2000);
            } else {
                state.stale = true;
            }
            refreshLiveRoles();  // 角色下拉随登场阵容变化（不重复绑定事件）
            msg('已切换到 ' + file + '（' + stage.length + ' 人登场）');
        } catch (err) {
            msg('切换失败：' + err.message);
        }
    }

    async function saveCurrent() {
        var btn = $('st-save');
        try {
            // 只写场景默认站位；每行的 move 已经在 state.scene.lines 里，别把当前位置烤进 stage
            state.scene.stage = cloneStage(state.baseStage);
            // auto 已废弃（改成播放界面的 AUTO 开关）：旧文件保存时顺手清掉
            (state.scene.lines || []).forEach(function (l) { if (l) delete l.auto; });
            await putJson(state.file, state.scene);
            await putJson('cast.json', state.cast);
            var key = castingKey(stageOf(state.scene, state.cast), state.cast);
            var needReload = key !== state.model;
            state.stale = true;
            btn.textContent = '已保存';
            setTimeout(function () { btn.textContent = '保存'; }, 1600);
            if (needReload) {
                msg('角色绑定已保存，刷新后使用新阵容');
            } else {
                msg('已保存到 ' + state.file);
            }
        } catch (err) {
            console.error('[Story] 保存失败', err);
            msg('保存失败：' + err.message);
        }
    }

    /* ---------- 事件绑定 ---------- */

    function indexOfLi(el) {
        var li = el && el.closest ? el.closest('.st-line') : null;
        return li ? Number(li.dataset.i) : -1;
    }

    function bindEditor() {
        var ol = $('st-lines');
        var dragFrom = -1;

        ol.addEventListener('dragstart', function (evt) {
            dragFrom = indexOfLi(evt.target);
            if (dragFrom < 0) return;
            evt.dataTransfer.effectAllowed = 'move';
            evt.dataTransfer.setData('text/plain', String(dragFrom));
            evt.target.closest('.st-line').classList.add('is-drag');
        });
        ol.addEventListener('dragend', function (evt) {
            var li = evt.target.closest && evt.target.closest('.st-line');
            if (li) li.classList.remove('is-drag');
            dragFrom = -1;
        });
        ol.addEventListener('dragover', function (evt) {
            if (dragFrom < 0) return;
            evt.preventDefault();
            evt.dataTransfer.dropEffect = 'move';
        });
        ol.addEventListener('drop', function (evt) {
            if (dragFrom < 0) return;
            evt.preventDefault();
            var li = evt.target.closest && evt.target.closest('.st-line');
            var insertAt = lines().length;
            if (li) {
                var box = li.getBoundingClientRect();
                insertAt = Number(li.dataset.i) + (evt.clientY > box.top + box.height / 2 ? 1 : 0);
            }
            dropLine(dragFrom, insertAt);
            dragFrom = -1;
        });

        $('st-add-line').addEventListener('click', addLine);

        $('st-title').addEventListener('input', function () {
            if (!state.scene) return;
            state.scene.title = this.value;
            markStale();
        });
        $('st-bg').addEventListener('change', function () {
            if (!state.scene) return;
            if (this.value) state.scene.background = this.value;
            else delete state.scene.background;
            markStale();
        });

        $('st-role').addEventListener('change', function () {
            var line = lines()[state.sel];
            if (!line) return;
            var old = speakerOf(line);
            if (old && old !== this.value && (line.action !== undefined || line.voice !== undefined)) {
                // 换说话者：原来那位的动作/语音搬进 cues，别让它们变成新说话者的
                var slot = (line.cues && line.cues[old]) || (line.cues = line.cues || {}, line.cues[old] = {});
                if (line.action !== undefined && slot.action === undefined) slot.action = line.action;
                if (line.voice !== undefined && slot.voice === undefined) slot.voice = line.voice;
                delete line.action;
                delete line.voice;
            }
            line.role = this.value;
            markStale();
            renderList();
            renderProps();
        });
        $('st-line-text').addEventListener('input', function () {
            var line = lines()[state.sel];
            if (!line) return;
            line.text = this.value;
            var li = $('st-lines').children[state.sel];
            if (li) li.querySelector('.st-line-text').textContent = this.value;
            markStale();
        });
        // 显示名：留空＝沿用上一句（删掉字段），写什么就从这个角色这一句起生效
        $('st-display-name').addEventListener('input', function () {
            var line = lines()[state.sel];
            if (!line) return;
            var v = this.value.trim();
            if (v) line.name = v;
            else delete line.name;
            markStale();
            renderList();
            renderNameField(line);   // 「设默认」的可用状态跟着输入走
        });
        $('st-name-default').addEventListener('click', function () {
            var line = lines()[state.sel];
            if (!line) return;
            var role = speakerOf(line);
            line.name = castName(role);     // 从这一句起揭示真名
            markStale();
            renderNameField(line);
            renderList();
        });
        // 设默认：把这一行的称呼写成角色的默认名（写 cast，不动这一行的 line.name）
        $('st-name-makedefault').addEventListener('click', function () {
            var line = lines()[state.sel];
            if (!line) return;
            var role = speakerOf(line);
            var v = (typeof line.name === 'string' ? line.name : '').trim();
            if (!v) return;
            var item = state.cast[role] || (state.cast[role] = {});
            item.name = v;
            markStale();
            renderList();
            renderProps();          // 说话者下拉、角色卡下拉里的「助手（红莉栖）」
            renderDrawer();
            msg('「' + role + '」的默认名已设为「' + v + '」');
        });
        /* 角色卡里的「本行」是动态生成的，用容器上的事件委托。
           data-key=action/voice/timeline/diff1/diff2 全是下拉，macro 是输入。 */
        $('st-stage-list').addEventListener('change', function (evt) {
            var el = evt.target;
            var card = el.closest && el.closest('.st-stage-row');
            if (!card) return;
            var line = lines()[state.sel];
            if (!line) return;
            var role = card.dataset.role;
            var key = el.dataset.key;

            if (key === 'action') {
                if (el.value === '__custom__') {
                    setCue(line, role, 'action', { timeline: '' });
                } else {
                    setCue(line, role, 'action', el.value);
                }
                markStale();
                renderProps();
                return;
            }
            if (key === 'voice') {
                setCue(line, role, 'voice', el.value);
                markStale();
                return;
            }
            // 绑定（第四排）：模型与语音目录都只改 cast，剧本一行都不用动
            if (key === 'model') {
                var ci = state.cast[role] || (state.cast[role] = {});
                if (el.value) ci.model = el.value; else delete ci.model;
                markStale();
                renderRoster();
                renderDrawer();
                var k2 = castingKey(stageOf(state.scene, state.cast), state.cast);
                if (k2 !== state.model) msg('模型已改：保存后刷新页面生效');
                return;
            }
            if (key === 'voiceDir') {
                var vi = state.cast[role] || (state.cast[role] = {});
                var vd = el.value.trim();
                if (vd) vi.voiceDir = vd; else delete vi.voiceDir;
                if (vd && !state.voices[vd]) loadVoices(role);
                markStale();
                renderRoster();
                renderDrawer();
                return;
            }
            var act = cueOf(line, role).action;
            if (!act || typeof act !== 'object') return;
            if (key === 'timeline' || key === 'diff1' || key === 'diff2') {
                var field = key === 'timeline' ? 'timeline'
                    : (key === 'diff1' ? 'diffSlot1' : 'diffSlot2');
                // 空值也照写：显式清空和「没选过」在播放端是两件事
                act[field] = el.value;
                markStale();
                return;
            }
        });
        $('st-wait').addEventListener('input', function () {
            var line = lines()[state.sel];
            if (!line) return;
            if (this.value === '') delete line.wait;      // 留空＝用默认停顿
            else line.wait = Math.max(0, Number(this.value) || 0);
            markStale();
        });
        // 三态按钮 / 绑定展开 / 存为宏：都是动态生成的，用容器上的事件委托
        $('st-stage-list').addEventListener('click', function (evt) {
            var bindBtn = evt.target.closest && evt.target.closest('button[data-bind]');
            if (bindBtn) {
                var bCard = bindBtn.closest('.st-stage-row');
                var bRole = bCard && bCard.dataset.role;
                if (bRole) {
                    state.bindOpen[bRole] = !state.bindOpen[bRole];
                    renderRoster();
                }
                return;
            }
            var saveBtn = evt.target.closest && evt.target.closest('button[data-macro-save]');
            if (saveBtn) {
                var sCard = saveBtn.closest('.st-stage-row');
                var sRole = sCard && sCard.dataset.role;
                var sLine = lines()[state.sel];
                var sAct = sRole && cueOf(sLine || {}, sRole).action;
                if (!sRole || !sAct || typeof sAct !== 'object') { msg('先在上面选好时间线，再存为宏'); return; }
                var nameEl = sCard.querySelector('input[data-key="macro-name"]');
                var nm = nameEl ? nameEl.value.trim() : '';
                if (!nm) { if (nameEl) nameEl.focus(); msg('先给这套动作起个名字'); return; }
                var cItem = state.cast[sRole] || (state.cast[sRole] = { model: '' });
                var cActs = cItem.actions || (cItem.actions = {});
                if (cActs[nm] && !window.confirm('动作宏「' + nm + '」已存在，覆盖？')) return;
                cActs[nm] = { timeline: sAct.timeline || '', diffSlot1: sAct.diffSlot1 || '', diffSlot2: sAct.diffSlot2 || '' };
                Object.keys(cActs[nm]).forEach(function (k) { if (!cActs[nm][k]) delete cActs[nm][k]; });
                setCue(sLine, sRole, 'action', nm);
                markStale();
                renderProps();
                renderDrawer();
                msg('已存为宏「' + nm + '」，之后在动作下拉里直接选');
                return;
            }
            var btn = evt.target.closest && evt.target.closest('button[data-kind]');
            if (!btn) return;
            var line = lines()[state.sel];
            if (!line) return;
            var role = btn.dataset.role;
            var kind = btn.dataset.kind;
            // 先把这个角色从 enter / exit 里都摘掉，再按点击的态写回，避免两边同时存在
            ['enter', 'exit'].forEach(function (k) {
                var rest = [].concat(line[k] || []).filter(function (r) { return r !== role; });
                if (rest.length) line[k] = rest; else delete line[k];
            });
            if (kind) line[kind] = [].concat(line[kind] || []).concat([role]);
            markStale();
            renderRoster();        // 卡片底色与三态一起刷新
            renderList();          // 行列表里的 ↑ / ↓ 小标同步
            if (state.mode === 'edit') rebuildStaging(state.sel);
        });
        $('st-stage-add').addEventListener('click', function () {
            var used = state.baseStage.map(function (s) { return s.role; });
            var pick = castRoles().filter(function (r) { return used.indexOf(r) < 0; })[0];
            if (!pick) { msg('cast.json 里没有更多可用角色了'); return; }
            // 左右交替给个初始站位，避免新角色叠在同一侧；位置随后在角色卡第二排调
            state.baseStage.push({ role: pick,
                x: used.length ? (used.length % 2 ? 0.4 : -0.4) : 0,
                scale: 1, z: used.length });
            markStale();
            rebuildStaging(state.sel);
            renderRoster();
        });

        bindCastEditor();
    }

    /* ---- cast.json 编辑器的事件（结构同 bindEditor，集中在一处） ---- */
    function bindCastEditor() {
        // 页签：剧本 / 角色表。Esc 从角色表退回剧本
        [].forEach.call(document.querySelectorAll('.st-tab'), function (b) {
            b.addEventListener('click', function () { setTab(b.dataset.tab); });
        });
        document.addEventListener('keydown', function (evt) {
            if (evt.key === 'Escape' && castTabOn()) setTab('script');
        });

        /* 角色表整体一个委托：角色行、宏行、两个「新增」的内联输入都从这里走。
           列表会随选中重绘，所以不能绑在行元素上。 */
        $('st-view-cast').addEventListener('click', function (evt) {
            var t = evt.target;
            var roleRow = t.closest && t.closest('#st-cast-role-list .st-cast-item');
            if (roleRow) {
                var role = roleRow.dataset.role;
                if (t.closest('button[data-op="del"]')) { delCastRole(role); return; }
                state.castSel = role;
                state.castAct = null;
                syncBlinkRole();
                renderDrawer();
                return;
            }
            var actRow = t.closest && t.closest('#st-cast-act-list .st-cast-item');
            if (actRow) {
                var act = actRow.dataset.act;
                if (t.closest('button[data-op="del"]')) { delCastAct(state.castSel, act); return; }
                state.castAct = (state.castAct === act ? null : act);   // 再点一次回到角色属性
                renderDrawer();
                return;
            }
            if (t.closest && t.closest('#st-cast-role-add')) {
                var nb = $('st-cast-role-new');
                nb.hidden = !nb.hidden;
                if (!nb.hidden) $('st-cast-role-new-name').focus();
                return;
            }
            if (t.closest && t.closest('#st-cast-role-new-ok')) { createCastRole(); return; }
            if (t.closest && t.closest('#st-cast-act-add')) {
                var ab = $('st-cast-act-new');
                if (!ab) return;
                ab.hidden = !ab.hidden;
                if (!ab.hidden) $('st-cast-act-new-name').focus();
                return;
            }
            if (t.closest && t.closest('#st-cast-act-new-ok')) { createCastAct(); return; }
        });
        $('st-view-cast').addEventListener('keydown', function (evt) {
            if (evt.key !== 'Enter' || !evt.target.id) return;
            if (evt.target.id === 'st-cast-role-new-name') { evt.preventDefault(); createCastRole(); }
            if (evt.target.id === 'st-cast-act-new-name') { evt.preventDefault(); createCastAct(); }
        });

        // 属性区：输入 / 变更
        $('st-cast-fields').addEventListener('change', onCastFieldChange);
        $('st-cast-fields').addEventListener('input', onCastFieldInput);
        $('st-cast-fields').addEventListener('click', onCastFieldClick);

        // 角色表顶部的全局眨眼条
        var gbox = document.querySelector('.st-blink-global');
        if (gbox) gbox.addEventListener('change', onBlinkGlobalChange);
    }

    /* 新增角色：只填内部 id，显示名与模型在右边属性区接着填 */
    function createCastRole() {
        var input = $('st-cast-role-new-name');
        var name = (input.value || '').trim();
        if (!name || name === 'doc' || name.charAt(0) === '_') { msg('角色名无效'); return; }
        if (state.cast[name]) { msg('角色「' + name + '」已存在'); return; }
        state.cast[name] = { actions: {} };   // 先建角色，模型随后在右边挑
        state.castSel = name;
        state.castAct = null;
        input.value = '';
        $('st-cast-role-new').hidden = true;
        markStale();
        renderDrawer();
        msg('已新增角色「' + name + '」，接着在右边绑模型');
    }

    function createCastAct() {
        var role = state.castSel;
        if (!role) return;
        var input = $('st-cast-act-new-name');
        if (!input) return;
        var name = (input.value || '').trim();
        if (!name) return;
        var item = state.cast[role];
        var acts = item.actions || (item.actions = {});
        if (acts[name]) { msg('动作宏「' + name + '」已存在'); return; }
        acts[name] = { timeline: '' };
        state.castAct = name;
        markStale();
        $('st-cast-act-new').hidden = true;
        renderDrawer();
    }

    /* 需要「失焦即同步」的文本类字段：角色 id / 宏名 / 变量名（改名要重绘列表） */
    function onCastFieldChange(evt) {
        var el = evt.target;
        var key = el.dataset.key;
        if (!key) return;
        var role = state.castSel;
        if (!role) return;

        if (key === 'cast-key') {
            renameCastRole(role, el.value.trim()); return;
        }
        if (key === 'act-key' && state.castAct != null) {
            renameCastAct(role, state.castAct, el.value.trim()); return;
        }
        if (key === 'model') {
            var item = state.cast[role];
            if (el.value) item.model = el.value; else delete item.model;
            markStale(); renderDrawer(); return;
        }
        if (key === 'diffSlot1' || key === 'diffSlot2' || key === 'timeline' || key === 'duration') {
            var a = selCastAct();
            if (!a) return;
            if (key === 'duration') {
                if (el.value === '') delete a.duration;
                else a.duration = Math.max(0, Number(el.value) || 0);
            } else {
                if (el.value) a[key] = el.value; else delete a[key];
            }
            markStale();
            // 左列宏名旁边挂着主时间线，改了要跟着变；属性区不重绘，下拉保持展开
            renderCastActList();
            return;
        }
    }

    /* 即时生效、不需要重绘的文本字段 */
    function onCastFieldInput(evt) {
        var el = evt.target;
        var key = el.dataset.key;
        if (!key) return;
        var role = state.castSel;
        if (!role) return;
        var item = state.cast[role];
        if (key === 'name') {
            var v = el.value.trim();
            if (v) item.name = v; else delete item.name;
            markStale();
            // 只刷角色列与剧本行里的称呼；属性区不重绘，否则输入框每敲一个字就重建、光标丢失
            renderCastRoleList(); renderList();
        } else if (key === 'voiceDir') {
            var d = el.value.trim();
            if (d) item.voiceDir = d; else delete item.voiceDir;
            markStale();
        }
    }

    /* 变量行的增删 + 变量值输入 */
    function onCastFieldClick(evt) {
        var add = evt.target.closest && evt.target.closest('#st-cast-var-add');
        if (add) {
            var a = selCastAct();
            if (!a) return;
            var vars = a.variables || (a.variables = []);
            vars.push({
                name: varNamesFor(state.castSel)[0] || '',
                value: 0, duration: DEFAULT_VAR_DURATION, delay: 0
            });
            markStale();
            renderCastVars($('st-cast-var-list'), state.castSel, vars);
            return;
        }
        var del = evt.target.closest && evt.target.closest('button[data-op="del-var"]');
        if (del) {
            var a2 = selCastAct();
            if (!a2 || !a2.variables) return;
            var row = del.closest('.st-var-row');
            a2.variables.splice(Number(row.dataset.i), 1);
            if (!a2.variables.length) delete a2.variables;
            markStale();
            renderCastVars($('st-cast-var-list'), state.castSel, a2.variables || []);
            return;
        }
        var pasteBtn = evt.target.closest && evt.target.closest('#st-cast-var-paste');
        if (pasteBtn) {
            var panel = $('st-cast-var-paste-panel');
            if (!panel) return;
            panel.hidden = !panel.hidden;
            if (!panel.hidden) {
                setPasteMsg('', '');
                var ta = $('st-cast-var-paste-text');
                if (ta) ta.focus();
            }
            return;
        }
        var doPaste = evt.target.closest && evt.target.closest('button[data-op="paste-do"]');
        if (doPaste) { doPasteVars(); return; }
        var cancel = evt.target.closest && evt.target.closest('button[data-op="paste-cancel"]');
        if (cancel) {
            var p = $('st-cast-var-paste-panel');
            if (p) p.hidden = true;
            var t = $('st-cast-var-paste-text');
            if (t) t.value = '';
            setPasteMsg('', '');
            return;
        }
    }
    function setPasteMsg(text, kind) {
        var msg = $('st-cast-var-paste-msg');
        if (!msg) return;
        msg.textContent = text || '';
        msg.className = 'st-var-paste-tip' + (kind ? ' is-' + kind : '');
    }
    function doPasteVars() {
        var ta = $('st-cast-var-paste-text');
        var a = selCastAct();
        if (!ta || !a) return;
        var parsed = parsePastedVars(ta.value);
        if (!parsed.length) {
            setPasteMsg('没解析出变量，请粘贴 [{name,value,duration}, ...] 格式的 JSON。', 'err');
            return;
        }
        var vars = a.variables || (a.variables = []);
        parsed.forEach(function (v) { vars.push(v); });
        markStale();
        renderCastVars($('st-cast-var-list'), state.castSel, vars);
        ta.value = '';
        setPasteMsg('已导入 ' + parsed.length + ' 个变量', 'ok');
    }
    document.addEventListener('keydown', function (evt) {
        if (evt.target && evt.target.id === 'st-cast-var-paste-text' &&
            (evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
            evt.preventDefault();
            doPasteVars();
        }
    });
    // 变量行的四个输入：委托在 fields 上，单独处理（dataset.k）
    function onVarFieldInput(evt) {
        var el = evt.target;
        if (!el.dataset || el.dataset.k == null) return;
        var row = el.closest && el.closest('.st-var-row');
        if (!row) return;
        var a = selCastAct();
        if (!a || !a.variables) return;
        var v = a.variables[Number(row.dataset.i)];
        if (!v) return;
        var k = el.dataset.k;
        if (k === 'name') {
            if (el.value === '__custom__') beginVarNameEdit(row, v);
            else v.name = el.value;
        } else {
            var num = Number(el.value);
            v[k] = isFinite(num) ? num : 0;
        }
        markStale();
    }
    document.addEventListener('input', onVarFieldInput);
    // select 的 change 兜底（部分浏览器不为 select 派发 input）
    document.addEventListener('change', function (evt) {
        var el = evt.target;
        if (el && el.tagName === 'SELECT' && el.dataset && el.dataset.k === 'name') onVarFieldInput(evt);
    });

    /* 该角色在剧本里的引用面：删之前先摊开，别让「无法撤销」变成一句空话 */
    function castRefs(role) {
        var out = { speaker: 0, stage: 0, cue: 0, scenes: {} };
        out.stage = state.baseStage.filter(function (s) { return s.role === role; }).length;
        lines().forEach(function (line) {
            var hit = false;
            if ((line.role || firstRole(state.cast)) === role) { out.speaker++; hit = true; }
            if ([].concat(line.enter || []).indexOf(role) >= 0) hit = true;
            if ([].concat(line.exit || []).indexOf(role) >= 0) hit = true;
            if (line.cues && line.cues[role]) { out.cue++; hit = true; }
            if (line.move && line.move[role]) hit = true;
            if (hit) out.scenes[state.file] = 1;
        });
        return out;
    }

    function delCastRole(role) {
        var refs = castRefs(role);
        var bits = [];
        if (refs.stage) bits.push('本场登场阵容里的站位');
        if (refs.speaker) bits.push(refs.speaker + ' 句台词');
        if (refs.cue) bits.push(refs.cue + ' 处同台演出');
        var detail = bits.length ? '\n\n会一起清掉：' + bits.join('、') + '。' : '\n\n本场没有引用它。';
        if (!window.confirm('删除角色「' + role + '」？' + detail + '\n无法撤销。')) return;
        delete state.cast[role];
        // 剧本里所有对它的引用一并清理
        lines().forEach(function (line) {
            if (line.role === role) delete line.role;
            ['enter', 'exit'].forEach(function (k) {
                if (Array.isArray(line[k])) {
                    line[k] = line[k].filter(function (r) { return r !== role; });
                    if (!line[k].length) delete line[k];
                } else if (line[k] === role) delete line[k];
            });
            if (line.cues) { delete line.cues[role]; if (!Object.keys(line.cues).length) delete line.cues; }
            if (line.move) { delete line.move[role]; if (!Object.keys(line.move).length) delete line.move; }
        });
        state.baseStage = state.baseStage.filter(function (s) { return s.role !== role; });
        state.castSel = castKeys()[0] || '';
        state.castAct = null;
        markStale();
        renderEditor();
    }

    function delCastAct(role, act) {
        if (!act) return;
        if (!window.confirm('删除动作宏「' + act + '」？剧本里 action 填它的行会清掉该字段。')) return;
        var item = state.cast[role];
        if (item && item.actions) delete item.actions[act];
        lines().forEach(function (line) {
            if (line.action === act) delete line.action;
            if (line.cues) Object.keys(line.cues).forEach(function (r) {
                if (line.cues[r] && line.cues[r].action === act) delete line.cues[r].action;
            });
        });
        state.castAct = null;
        markStale();
        renderEditor();
    }

    function renameKey(obj, oldKey, newKey) {
        var out = {};
        Object.keys(obj).forEach(function (k) {
            out[k === oldKey ? newKey : k] = obj[k];
        });
        return out;
    }

    /* 改角色 id：cast 的键 + 剧本所有引用一起迁移 */
    function renameCastRole(oldName, newName) {
        newName = (newName || '').trim();
        if (!newName || newName === oldName || newName === 'doc' || newName.charAt(0) === '_') { renderCastFields(); return; }
        if (state.cast[newName]) { msg('角色「' + newName + '」已存在'); renderCastFields(); return; }
        if (!window.confirm('把角色「' + oldName + '」改名为「' + newName + '」？剧本引用会同步更新。')) {
            renderCastFields(); return;
        }
        state.cast = renameKey(state.cast, oldName, newName);
        // 剧本引用
        lines().forEach(function (line) {
            if (line.role === oldName) line.role = newName;
            ['enter', 'exit'].forEach(function (k) {
                if (Array.isArray(line[k])) line[k] = line[k].map(function (r) { return r === oldName ? newName : r; });
                else if (line[k] === oldName) line[k] = newName;
            });
            if (line.cues && line.cues[oldName]) {
                line.cues[newName] = line.cues[oldName]; delete line.cues[oldName];
            }
            if (line.move && line.move[oldName]) {
                line.move[newName] = line.move[oldName]; delete line.move[oldName];
            }
        });
        state.baseStage.forEach(function (s) { if (s.role === oldName) s.role = newName; });
        state.castSel = newName;
        markStale();
        renderEditor();
    }

    /* 改动作宏名：cast.actions 的键 + 剧本里对该角色的 action 引用一起迁移 */
    function renameCastAct(role, oldName, newName) {
        newName = (newName || '').trim();
        if (!newName || newName === oldName) { renderCastFields(); return; }
        var acts = (state.cast[role] || {}).actions || {};
        if (acts[newName]) { msg('动作宏「' + newName + '」已存在'); renderCastFields(); return; }
        if (!window.confirm('把动作宏「' + oldName + '」改名为「' + newName + '」？剧本引用会同步更新。')) {
            renderCastFields(); return;
        }
        state.cast[role].actions = renameKey(acts, oldName, newName);
        // 只对「这个角色」的 action 引用改名，避免误伤别的角色同名宏
        lines().forEach(function (line) {
            if (line.role === role && line.action === oldName) line.action = newName;
            if (line.cues && line.cues[role] && line.cues[role].action === oldName) {
                line.cues[role].action = newName;
            }
        });
        state.castAct = newName;
        markStale();
        renderEditor();
    }

    /* head 里的脚本执行时控件还没解析，一律用事件委托 */
    document.addEventListener('click', function (evt) {
        var target = evt.target;
        var modeBtn = target.closest && target.closest('.st-modes button');
        if (modeBtn) { setMode(modeBtn.getAttribute('data-mode')); return; }
        if (target.closest && target.closest('#st-save')) { saveCurrent(); return; }
        // AUTO 是开关，不算「点了一下画面」
        if (target.closest && target.closest('#st-auto')) {
            evt.stopPropagation();
            setAuto(!state.autoOn);
            return;
        }
        // 即时台词面板内的点击交给面板自己处理，不推进剧本
        if (target.closest && target.closest('#st-live')) return;
        // 角色卡（含绑定展开、存为宏）自己处理点击，别落到剧本行的删除/移动上
        if (target.closest && target.closest('#st-stage-list')) return;
        // 角色表页内的点击交给它自己的委托处理，不落到剧本行操作
        if (target.closest && target.closest('#st-view-cast')) return;
        if (state.mode !== 'edit') {
            if (state.liveOpen) return;      // 即时台词打开时冻结剧本推进
            if (target.closest && target.closest('#st-bar')) return;
            step();
            return;
        }
        if (target.closest && target.closest('#st-bar')) return;
        var op = target.closest && target.closest('[data-op]');
        if (op) {
            var i = indexOfLi(op);
            if (op.dataset.op === 'up') shiftLine(i, -1);
            else if (op.dataset.op === 'down') shiftLine(i, 1);
            else delLine(i);
            return;
        }
        var li = target.closest && target.closest('.st-line');
        if (li) selectLine(Number(li.dataset.i));
    });

    document.addEventListener('change', function (evt) {
        if (evt.target.id === 'st-scene') switchScene(evt.target.value);
    });

    document.addEventListener('keydown', function (evt) {
        if (state.mode !== 'play' || state.liveOpen) return;
        // 正在文本框/面板里输入时不劫持按键
        if (evt.target && /^(INPUT|TEXTAREA|SELECT)$/.test(evt.target.tagName)) return;
        if (evt.key === ' ' || evt.key === 'Enter' || evt.key === 'ArrowRight') {
            evt.preventDefault();
            step();
        }
    });

    document.addEventListener('DOMContentLoaded', bindEditor);

    window.startStory = async function () {
        // 对话框 UI 先就位（此时是收起的空窗），等第一名角色上完台再播开场
        state.dialog = window.SGDialog ? window.SGDialog.init() : null;
        try {
            await loadIndex();
            state.cast = await getJson('cast.json');
            if (!state.file) throw new Error('story/scenes/ 下没有场景');
            state.scene = await getJson(state.file);
            state.baseStage = stageOf(state.scene, state.cast);
            state.stage = cloneStage(state.baseStage);
            if (!state.stage.length) throw new Error('登场角色没有可用模型绑定（检查 cast.json / scene.stage）');
            state.model = castingKey(state.stage, state.cast);
            $('st-save').disabled = false;

            // 逐个加载期间位置/缩放/显隐还没算好：藏起画布，避免放大与提前登场闪现
            root.classList.add('st-loading-actors');
            $('st-status').textContent = '正在载入 ' + state.stage.length + ' 名角色…';
            var canvas = $('canvas');
            // 第一名角色用 create() 起 device + renderCanvas；其余用 addCharacter() 共用同一台
            var first = state.stage[0];
            var firstUrl = '../../character/data/' + state.cast[first.role].model;
            state.ctx = await window.SGEmoteCore.create({ canvas: canvas, modelUrl: firstUrl });
            state.actors[first.role] = { player: state.ctx.player, config: state.ctx.config,
                                         model: state.cast[first.role].model };
            window.ST_CORE = state.ctx;
            window.ST_STORY = state;    // 调试/验收：查看 stage、actors 与当前行
            window.ST_AUDIO = audioPool;   // 每个角色一台播放器：看谁在播、口型跟谁
            window.ST_BLINK = blinkPool;   // 眨眼表：看 track / vars / trBase / last（已写出的 diff）

            for (var i = 1; i < state.stage.length; i++) {
                var s = state.stage[i];
                var item = state.cast[s.role];
                $('st-status').textContent = '正在载入 ' + s.role + '…';
                var ctx = await window.SGEmoteCore.addCharacter({
                    canvas: canvas, modelUrl: '../../character/data/' + item.model
                });
                state.actors[s.role] = { player: ctx.player, config: ctx.config, model: item.model };
            }

            // 播放器按角色懒创建（audioFor），各自把口型打到自己的 player 上
            stopVoices();

            applyScene(state.scene, state.cast);   // 内部会 resetStage + syncLayout
            state.speaker = (state.stage[0] && state.stage[0].role) || firstRole(state.cast);

            // 先把首句的舞台铺到位：背景、登场角色、站位、动作。
            // 模型已在上面 await 加载完，遮罩一退就能看到完整画面；对话框动画播完才出词。
            primeStageForIntro();
            $('st-status').textContent = '';
            root.classList.remove('st-loading-actors');  // 布局与显隐就绪后再露出画布
            root.classList.add('st-ready');

            state.introPending = true;
            var introDone = false;
            var finishIntro = function () {
                if (introDone) return;
                introDone = true;
                state.introPending = false;
                renderLine(0);   // 名牌 + 文字 + 语音：等对话框擦入动画结束才出
                if (state.autoOn) armAuto(state.autoReady ? state.lineVoice : null);
            };
            playDialogIntro(finishIntro);
            setTimeout(finishIntro, 2000);   // rAF 在后台标签页会被冻结，兜底别让首句永远不出现

            initLive();
            initAuto();
            loadBackgrounds();
            loadModels();
        } catch (err) {
            console.error('[Story] 启动失败', err);
            $('st-status').textContent = '载入失败：' + (err && err.message);
        }
    };
})();
