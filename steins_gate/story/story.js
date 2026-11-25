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
//  场景字段 / 行字段的完整定义：见仓库根 README.md「多角色登场（剧情模式）」一节（唯一权威）。
//    这里只记实现要点，不重复字段文档——加字段时只改 README.md，避免多处漏同步。
//  实现要点：
//    · role 是身份键，不是显示名；name 是本行起的显示名，省略沿用、空串回默认。
//    · 行内 background 只覆盖本行，下一行自动回场景背景。
//    · 站位的只读基准是 scene.stage，行内 move 改写当前站位；enter/exit 决定谁在台。
//    · bgm 区间是绝对句号（剪辑软件 overwrite 语义），插行不平移；同区间跨行连播。
//      range 归一化在 bgmRange() 里做。
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
        bgmFiles: [],          // static/bgm/ 下的音频文件名（BGM 曲目清单）
        bgmAudio: null,        // 单个 <audio loop>，跨行不重建＝不打断、不重播
        bgmKey: '',            // 当前正在播的区间标识 from|to|file；同区间跨行保持不变
        bgmSel: -1,            // 右侧配置面板正在编辑的 BGM 段（-1＝未选，面板隐藏）
        bgmResizing: false,    // 拖动 BGM 段期间暂停按行切曲
        bgmFadeRaf: 0,         // 淡入/淡出音量渐变的 rAF id
        bgmFadeSeq: 0,         // 淡入/淡出令牌：切曲或重播时 +1，旧动画据此作废
        soundFolders: [], soundFiles: {},
        liveOpen: false, liveSrc: 'file', liveBusy: false, liveRole: '', blobUrl: '',
        // 多角色：actors[role] = { player, config, ... }；casting 由 scene.stage 决定
        // baseStage 是场景默认站位（只读基准），stage 是当前生效站位（会被行内 move 改写）
        actors: {}, baseStage: [], stage: [], layout: null, speaker: '', stageRaf: 0,
        voiceSeq: 0,           // 语音令牌：翻页/停播就 +1，解码晚到的旧语音据此丢弃
        // 角色表页签：当前选中的角色 / 宏；bindOpen 记哪些角色卡展开了「绑定」
        castSel: '', castAct: null, bindOpen: {}, tab: 'script',
        // 编辑态暂停现场：从播放切到编辑时冻结当前句的打字进度与语音 offset，
        // 切回播放且剧本没改时从这里续播（不重跑开场、不重播语音）。
        pausedPlayback: null,
        // 对话框（MSG WIN）实例：init 之后才有，重播开场要用
        dialog: null
    };
    // 每个角色一台音频播放器：各自解码、各自驱动自己的口型，台词里的多人语音不会互相打断
    var audioPool = {};

    // 变量缺省时长（ms）：新建变量、粘贴导入缺 duration、演出兜底都用它，
    // 与 stage 的 DEFAULT_FADE_TIME 保持一致，避免 0 导致瞬间跳变。
    var DEFAULT_VAR_DURATION = 300;
    // 上下场与背景切换的默认淡化时长（ms）。写 0 才是瞬间显隐。
    var DEFAULT_FADE_MS = 300;

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

    /* ---------- 多角色登场 ---------- */

    /* 把 scene.stage 归一化；缺省则从台词里出现的角色按先后均分站位。
       每项：{ role, x(-1..1), y(-1..1), scale, z }；y 缺省 0（基准高度） */
    function stageOf(scene, cast) {
        var declared = scene && scene.stage;
        var out = [];
        if (Array.isArray(declared) && declared.length) {
            declared.forEach(function (s, i) {
                if (!s || !s.role || !(cast && cast[s.role] && cast[s.role].model)) return;
                out.push({
                    role: s.role,
                    x: Number.isFinite(s.x) ? s.x : 0,
                    y: Number.isFinite(s.y) ? s.y : 0,
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
                    y: 0, scale: 1, z: 0 });
            });
        }
        return out;
    }

    function cloneStage(list) {
        return (list || []).map(function (s) {
            return { role: s.role, x: s.x, y: s.y || 0, scale: s.scale, z: s.z };
        });
    }

    /* 卡片上「换角色」：让新角色完整继承旧角色在本场的身份与行为。
       只改 slot.role 会留下幽灵引用——剧本行的说话者/上下场/走位/cues 仍挂在旧角色名下，
       表现为「换了模型，原来的动作和登场还在」。这里把这些引用一并改名：
         · 登场槽位的 role
         · 每行的说话者 role、enter/exit 数组、move 键、cues 键
       行级 action/voice 属于说话者，随 role 改了自然跟着走；cast.json 的绑定/动作宏不动。
       若新角色本来就在台或已在别处被引用，同名键会以新角色为准覆盖，避免两份行为打架。 */
    function reassignRoleInScript(from, to) {
        if (!from || !to || from === to) return;
        (state.baseStage || []).forEach(function (s) {
            if (s && s.role === from) s.role = to;
        });
        var renameList = function (v) {
            return [].concat((v || [])).map(function (r) { return r === from ? to : r; });
        };
        lines().forEach(function (l) {
            if (!l) return;
            if (l.role === from) l.role = to;
            ['enter', 'exit'].forEach(function (k) {
                if (l[k] === undefined) return;
                var next = renameList(l[k]);
                // 去重：若新角色本就在列表里，改名后会出现两次
                var uniq = [];
                next.forEach(function (r) { if (uniq.indexOf(r) < 0) uniq.push(r); });
                l[k] = uniq;
            });
            ['move', 'cues'].forEach(function (k) {
                var bag = l[k];
                if (!bag || !Object.prototype.hasOwnProperty.call(bag, from)) return;
                bag[to] = bag[from];          // 新角色继承旧角色的走位/演出
                delete bag[from];
            });
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
    /* 行内站位写法：数字 = 只改 x；对象 = { x, y, scale, z }，只写要改的字段 */
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
        // 变量时长按配置原值执行：300ms 只是新增变量/舞台复制时的默认填写值，
        (act.variables || []).forEach(function (v) {
            if (!v || !v.name) return;
            player.setVariable(v.name, v.value, v.duration);
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
        // 调试开关：冻结在当前眨眼状态
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
    /* 显隐模型。fadeMs>0 时走 SDK 的 setGlobalAlpha，让 wasm 自己插值透明度：
         · 淡出保持 hide=false —— practicalHide 依赖 wasm 里的 _globalA 才能判零停渲染，
           提前 hide 会让 wasm 挂起、插值卡在半路。
         · 淡入先解除 hide，再从 0 强制起渐变 —— SDK 里 _globalA 已是目标值会直接 return，
           不先归零就会「瞬间出现」而不是淡入。
       fadeMs=0 / 重放 / 编辑预览走原来的瞬时 hide 切换，并复位 alpha。 */
    function applyVisible(slot, visible, fadeMs) {
        var p = playerOf(slot.role);
        if (!p) return;
        p.convolveCanvasMovementToPhysics = false;   // 固定站位，移动物理会把它推走
        var ms = Math.max(0, Number(fadeMs) || 0);
        if (ms > 0) {
            if (visible) {
                p.hide = false;
                p.setVariable('face_talk', 0, 0);     // 藏/露都归零，避免嘴停在上次的张开形状
                p.setGlobalAlpha(0, 0);
                p.setGlobalAlpha(1, ms);
            } else {
                p.setGlobalAlpha(0, ms);
            }
            return;
        }
        var next = !visible;
        if (p.hide !== next) {
            // 隐藏期间 wasm 不接收变量写入，嘴会停在最后一张张开的形状上：
            // 藏之前归零、露之前再归零，重新登场时是闭着嘴的
            if (!p.hide) p.setVariable('face_talk', 0, 0);
            p.hide = next;
            if (!p.hide) p.setVariable('face_talk', 0, 0);
        }
        if (p.globalAlpha !== 1) p.setGlobalAlpha(1, 0);   // 复位，别把半透明带进下一场
    }
    /* 统一的淡化时长：行内 > 场景 > 默认 300ms。 */
    function fadeMsOf(line) {
        var raw = line && line.fadeMs != null ? line.fadeMs
                : (state.scene && state.scene.fadeMs != null ? state.scene.fadeMs : DEFAULT_FADE_MS);
        return Math.max(0, Number(raw) || 0);
    }
    /* 上下场事件。animate=false（从开场重放 / 编辑态预览）强制瞬时，
       否则回放历史行会看到一串渐变。 */
    function applyStageEvents(line, animate) {
        if (!line) return;
        var ms = animate ? fadeMsOf(line) : 0;
        // 同一行同时勾了上/下场时，先退后进，最终以「登场」为准
        [].concat(line.exit || []).forEach(function (r) { if (r) applyVisible({ role: r }, false, ms); });
        [].concat(line.enter || []).forEach(function (r) { if (r) applyVisible({ role: r }, true, ms); });
    }
    function resetPositions() {
        state.stage.forEach(function (slot) {
            var b = baseSlotOf(slot.role);
            if (!b) return;
            slot.x = b.x; slot.y = b.y || 0; slot.scale = b.scale; slot.z = b.z;
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
            return { player: playerOf(slot.role), x: slot.x, y: slot.y || 0, scale: slot.scale };
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
            ['x', 'y', 'scale', 'z'].forEach(function (k) {
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
            applyStageEvents(list[i], false);   // 重放只落终态，渐变留给实际演出
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
        // 缩略图清单：node 服务走 /api/thumbs，纯静态服务回退读 .thumbs 目录索引
        state.thumbs = {};
        try {
            var r = await fetch('../../api/thumbs', { cache: 'no-store' });
            if (r.ok && r.headers.get('x-emote-server') === 'node') {
                var j = await r.json();
                (j.files || []).forEach(function (s) { state.thumbs[s] = true; });
            }
        } catch (_) { /* 没有缩略图接口时图库回退显示原图 */ }
        renderBgGallery();
        if (state.scene && state.mode === 'edit') renderProps();
    }

    /* ---- 背景图库：拖拽源，只有这里的图片能拖 ---- */
    var BG_MIME = 'application/x-emote-bg';   // 自定义类型：外部文件拖入时 types 里没有它
    /* 行的有效背景：区分「没写这个字段」和「显式写成空串」。
       以前一律用 line.background || scene.background，导致删掉行级覆盖后
       场景默认背景又把段撑回来，Backspace 看着像没生效。
       现在空串＝这一行明确不要背景，不再回退到场景默认。 */
    function bgOfLine(line) {
        return window.TimelineCore.bgOfLine(line, state.scene && state.scene.background);
    }
    function bgStem(name) { return String(name || '').replace(/\.[^.]+$/, ''); }
    function bgSrc(name) {
        var stem = bgStem(name);
        return state.thumbs && state.thumbs[stem]
            ? '../../static/background/.thumbs/' + encodeURIComponent(stem) + '.jpg'
            : '../../static/background/' + encodeURIComponent(name);
    }
    function bgLabel(name) {
        var stem = bgStem(name);
        return (state.thumbs && state.thumbs[stem]) ? stem : name;
    }
    /* 由鼠标 clientY 反推落在第几行（0-based）；用行的实际位置，行高不固定也准 */
    function rowAtY(y) {
        var rows = $('st-lines') ? $('st-lines').children : [];
        for (var i = 0; i < rows.length; i++) {
            var box = rows[i].getBoundingClientRect();
            if (y >= box.top && y < box.bottom) return i;
        }
        return -1;
    }
    /* 在第 row 行（0-based）落一段 BGM：默认只覆盖这一句。
       与旧段重叠时把那一句让给新段（截短旧段），避免一句两曲；不自动试听。 */
    function addBgmAt(file, row) {
        if (!state.scene) return;
        var n = row + 1;
        var list = bgmList();
        list.forEach(function (b) {
            var r = bgmRange(b);
            if (n < r[0] || n > r[1]) return;
            if (n === r[0]) {
                if (r[1] > r[0]) setBgmRange(b, r[0] + 1, r[1]);
                else b._drop = true;
            } else {
                setBgmRange(b, r[0], n - 1);
            }
        });
        state.scene.bgm = list.filter(function (b) { return !b._drop; });
        state.scene.bgm.forEach(function (b) { delete b._drop; });
        var added = { file: file, range: [n, n] };
        state.scene.bgm.push(added);
        state.bgmSel = state.scene.bgm.indexOf(added);
        markStale('新增');
        renderBgmTrack();
        renderBgmDetail();
        msg('第 ' + n + ' 句起 ' + file + '（拖整段平移，拖上下边缘改长度）');
    }
    function delBgm(j) {
        var bl = bgmList();
        var b = bl[j];
        if (!b) return;
        var key = bgmKeyOf(b);
        bl.splice(j, 1);
        if (state.bgmSel === j) state.bgmSel = -1;
        else if (state.bgmSel > j) state.bgmSel--;
        markStale('删除');
        if (state.bgmKey === key) stopBgm();
        renderBgmTrack();
        renderBgmDetail();
        msg('已删除 BGM ' + b.file);
    }
    function selectBgm(j) {
        state.bgmSel = j;
        renderBgmTrack();
        renderBgmDetail();
    }
    function clearBgmSel() {
        if (state.bgmSel < 0) return;
        state.bgmSel = -1;
        renderBgmTrack();
        renderBgmDetail();
    }
    /* 点段才显示的右侧配置：只保留淡入/淡出。
       覆盖句靠拖动时间轴段两端改，试听靠双击曲目卡片，删除靠段 Backspace。 */
    function renderBgmDetail() {
        var box = $('st-bgm-detail');
        if (!box) return;
        var b = bgmList()[state.bgmSel];
        box.hidden = !b;
        if (!b) return;
        $('st-bgm-detail-title').textContent = 'BGM 段 ' + (state.bgmSel + 1);
        var file = $('st-bgm-detail-file');
        file.textContent = b.file;
        file.title = b.file;
        $('st-bgm-fadein').classList.toggle('is-on', !!b.fadeIn);
        $('st-bgm-fadeout').classList.toggle('is-on', !!b.fadeOut);
    }

    /* 曲目清单：static/bgm/ 下的音频，拖到剧本行右侧 BGM 轨即落一段。
       每项携带 BGM_MIME，外部文件拖进来没有该类型 → 被 isBgmDrag 拒绝。 */
    function renderBgmPicker() {
        var box = $('st-bgm-picker');
        if (!box) return;
        box.innerHTML = '';
        (state.bgmFiles || []).forEach(function (name) {
            var item = document.createElement('div');
            item.className = 'st-bgm-file';
            item.draggable = true;
            item.dataset.file = name;
            item.title = name + '\n拖到剧本行的 BGM 轨，从那一行开始循环播放\n双击试听';
            item.addEventListener('dblclick', function () { previewBgmFile(name); });
            var icon = document.createElement('span');
            icon.className = 'st-bgm-file-ico';
            icon.textContent = '♪';
            var cap = document.createElement('span');
            cap.className = 'st-bgm-file-name';
            cap.textContent = name;
            item.appendChild(icon);
            item.appendChild(cap);
            box.appendChild(item);
        });
        filterBgmPicker();
    }
    /* 曲目搜索：按文件名过滤清单，不区分大小写；空词全显 */
    function filterBgmPicker() {
        var input = $('st-bgm-search'), box = $('st-bgm-picker'), empty = $('st-bgm-empty');
        if (!input || !box) return;
        var q = String(input.value || '').trim().toLowerCase();
        var shown = 0;
        [].forEach.call(box.children, function (x) {
            var ok = !q || (x.dataset.file || '').toLowerCase().indexOf(q) >= 0;
            x.hidden = !ok;
            if (ok) shown++;
        });
        if (empty) {
            var total = (state.bgmFiles || []).length;
            empty.hidden = shown > 0 || !total;
            empty.textContent = total ? '没有匹配的音乐' : '暂无背景音乐';
        }
    }

    /* BGM 竖轨：与行列表同滚、按真实行边界定位一段。
       段主体＝拖动平移；上下两个把手＝改区间端点；删除/配置一律去右侧面板。 */
    function renderBgmTrack() {
        var host = $('st-bgm-track');
        if (!host) return;
        host.innerHTML = '';
        var ol = $('st-lines');
        var rows = ol ? ol.children : [];
        var n = rows.length;
        if (!n) { host.style.height = '0px'; return; }
        var olH = ol.getBoundingClientRect().height;
        host.style.height = olH + 'px';
        // 行高不固定：用首行+行间距画格线，拖动换算用平均行高兜底
        var rowH = rows[0].getBoundingClientRect().height + 2;
        host.style.setProperty('--bgm-row-h', rowH + 'px');
        var hostTop = host.getBoundingClientRect().top;
        bgmList().forEach(function (b, j) {
            var r = bgmRange(b);
            var from = Math.max(1, Math.min(n, r[0]));
            var to = Math.max(from, Math.min(n, r[1]));
            var topRow = rows[from - 1].getBoundingClientRect();
            var botRow = rows[to - 1].getBoundingClientRect();
            var seg = document.createElement('div');
            seg.className = 'st-bgm-seg'
                + (state.sel + 1 >= from && state.sel + 1 <= to ? ' is-at' : '')
                + (state.bgmSel === j ? ' is-sel' : '')
                + (state.bgmResizing && state.bgmSel === j ? ' is-drag' : '');
            seg.dataset.j = String(j);
            seg.style.top = (topRow.top - hostTop) + 'px';
            seg.style.height = (botRow.bottom - topRow.top) + 'px';
            seg.title = b.file + '｜第 ' + from + '–' + to + ' 句（循环）\n'
                + '拖整段平移 · 拖上下边缘改长度 · 点一下在右侧配置';
            var gripTop = document.createElement('span');
            gripTop.className = 'st-bgm-grip st-bgm-grip--top';
            gripTop.dataset.bgmEdge = 'from';
            var name = document.createElement('span');
            name.className = 'st-bgm-seg-name';
            name.textContent = b.file;
            var range = document.createElement('span');
            range.className = 'st-bgm-seg-range';
            range.textContent = from + '–' + to;
            var gripBot = document.createElement('span');
            gripBot.className = 'st-bgm-grip st-bgm-grip--bottom';
            gripBot.dataset.bgmEdge = 'to';
            seg.appendChild(gripTop);
            seg.appendChild(name);
            seg.appendChild(range);
            seg.appendChild(gripBot);
            host.appendChild(seg);
        });
    }

    function renderBgGallery() {
        var box = $('st-bg-gallery');
        if (!box) return;
        box.innerHTML = '';
        (state.bg || []).forEach(function (name) {
            var item = document.createElement('div');
            item.className = 'st-bg-item';
            item.draggable = true;
            item.dataset.file = name;
            item.title = name + '\n拖到时间轴背景轨＝该行背景；拖到图库区＝场景背景（点击只预览）';
            item.style.backgroundImage = 'url("' + bgSrc(name) + '")';
            var cap = document.createElement('span');
            cap.textContent = bgLabel(name);
            item.appendChild(cap);
            box.appendChild(item);
        });
        filterBgGallery();
        syncBgCurrent();
    }
    /* 搜索框：按文件名/标签过滤图库，不区分大小写；空词显示全部 */
    function filterBgGallery() {
        var input = $('st-bg-search');
        var box = $('st-bg-gallery');
        var empty = $('st-bg-empty');
        if (!input || !box) return;
        var q = String(input.value || '').trim().toLowerCase();
        var shown = 0;
        [].forEach.call(box.children, function (x) {
            var hay = (x.dataset.file + ' ' + bgLabel(x.dataset.file)).toLowerCase();
            var ok = !q || hay.indexOf(q) >= 0;
            x.hidden = !ok;
            if (ok) shown++;
        });
        if (empty) empty.hidden = shown > 0 || !(state.bg || []).length;
    }
    /* 点选图库项＝设置整个场景的背景 */
    function setSceneBackground(name) {
        if (!state.scene || !name) return;
        state.scene.background = name;
        markStale();
        syncBgCurrent();
        msg('场景背景已设为 ' + name);
    }
    function syncBgCurrent() {
        var cur = (state.scene && state.scene.background) || '';
        var box = $('st-bg-gallery');
        if (box) [].forEach.call(box.children, function (x) {
            x.classList.toggle('is-current', x.dataset.file === cur);
        });
        var pv = $('st-bg-preview');
        if (pv) {
            pv.style.backgroundImage = cur ? 'url("' + bgSrc(cur) + '")' : '';
            pv.title = cur ? '场景背景：' + cur : '场景未设背景，跟随上一场景';
        }
        var clear = $('st-bg-clear');
        if (clear) clear.disabled = !cur;
    }
    /* 点图库项＝只更新预览大图，**不写任何剧本数据**（插入仍必须靠拖动）。
       预览是临时态：切场景/清背景/拖放设背景时 syncBgCurrent() 会恢复真实场景背景。 */
    function previewBgInGallery(name) {
        var pv = $('st-bg-preview');
        if (!pv || !name) return;
        pv.style.backgroundImage = 'url("' + bgSrc(name) + '")';
        pv.title = '预览：' + name + '（拖到时间轴背景轨才会写入）';
    }
    function isBgDrag(evt) {
        var dt = evt && evt.dataTransfer;
        return !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, BG_MIME) >= 0);
    }

    /* ---- BGM：static/bgm/ 下的音频，按句区间循环播放 ----
       场景 JSON：bgm: [{ file, range: [起, 止] }]，句号 1-based 闭区间，可多段。
       单一 <audio loop>：同一区间跨行只认 key，key 不变则不暂停、不 seek、不重播。
       编辑态不自动播：必须点右侧「播放」才试听；播放模式仍按行自动同步。 */
    var BGM_MIME = 'application/x-emote-bgm';   // 只有曲目清单里的项携带它，外部文件拖入被拒
    var SFX_MIME = 'application/x-emote-sfx';   // 声效卡片专用，拖到时间轴声效轨
    var VOICE_MIME = 'application/x-emote-voice';   // 语音卡片专用，拖到时间轴语音轨
    function bgmUrl(file) { return '../../static/bgm/' + encodeURIComponent(file); }
    function bgmList() {
        var a = state.scene && state.scene.bgm;
        return Array.isArray(a) ? a : [];
    }
    function bgmRange(b) {
        var r = b && b.range;
        var f = Math.max(1, Number(r && r[0]) || 1);
        var t = Math.max(f, Number(r && r[1]) || f);
        return [f, t];
    }
    function setBgmRange(b, from, to) { b.range = [from, to]; }
    function bgmKeyOf(b) {
        var r = bgmRange(b);
        return r[0] + '|' + r[1] + '|' + b.file;
    }
    /* 找覆盖第 idx 行（0-based）的区间；返回 { b, j, key } */
    function bgmAt(idx) {
        var n = idx + 1;
        var list = bgmList();
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            if (!b) continue;
            var r = bgmRange(b);
            if (n >= r[0] && n <= r[1]) return { b: b, j: i, key: bgmKeyOf(b) };
        }
        return null;
    }
    /* 某段能移动到的行范围：由它在拖动开始时的左右邻居决定，拖动中不会跳变 */
    function bgmFreeBounds(j, orig, n) {
        var lo = 1, hi = n;
        bgmList().forEach(function (o, k) {
            if (k === j) return;
            var r = bgmRange(o);
            if (r[1] < orig[0]) lo = Math.max(lo, r[1] + 1);
            if (r[0] > orig[1]) hi = Math.min(hi, r[0] - 1);
        });
        return { lo: lo, hi: hi };
    }
    var BGM_FADE_MS = 900;   // 淡入/淡出固定时长（约 1 秒）
    /* 音量渐变：令牌 bgmFadeSeq 保证只有最后一次切曲的动画存活，快速连按不串音 */
    function cancelBgmFade() {
        state.bgmFadeSeq++;
        if (state.bgmFadeRaf) { cancelAnimationFrame(state.bgmFadeRaf); state.bgmFadeRaf = 0; }
    }
    function rampBgmVolume(a, from, to, done) {
        var seq = state.bgmFadeSeq;
        var t0 = 0;
        function step(ts) {
            if (seq !== state.bgmFadeSeq) return;      // 被更新的一次切曲取消
            if (!t0) t0 = ts;
            var k = Math.min(1, (ts - t0) / BGM_FADE_MS);
            a.volume = from + (to - from) * k;
            if (k < 1) state.bgmFadeRaf = requestAnimationFrame(step);
            else { state.bgmFadeRaf = 0; if (done) done(); }
        }
        state.bgmFadeRaf = requestAnimationFrame(step);
    }
    /* 从当前正在响的段读回它自己（按 src 反查），用它决定淡出与淡入 */
    function currentPlayingBgm() {
        var a = state.bgmAudio;
        if (!a || a.paused || !a.getAttribute('src')) return null;
        var list = bgmList();
        for (var i = 0; i < list.length; i++) {
            if (bgmUrl(list[i].file) === a.getAttribute('src')) return list[i];
        }
        return null;
    }
    function hardStopAudio() {
        var a = state.bgmAudio;
        if (!a) return;
        try { a.pause(); } catch (_) { }
        a.volume = 1;
    }
    /* 硬停：换场/切模式/删段用，不留淡出尾巴 */
    function stopBgm() {
        cancelBgmFade();
        hardStopAudio();
        state.bgmKey = '';
    }
    /* 带淡出地停：正在响的段配了 fadeOut 才渐弱，否则立即停 */
    function fadeOutStopAudio(a, done) {
        if (!a || a.paused || a.volume <= 0.01) { done(); return; }
        rampBgmVolume(a, a.volume, 0, function () {
            try { a.pause(); } catch (_) { }
            a.volume = 1;
            done();
        });
    }
    function bgmAudio() {
        var a = state.bgmAudio;
        if (!a) {
            a = new Audio();
            a.loop = true;
            a.preload = 'auto';
            state.bgmAudio = a;
        }
        return a;
    }
    function startBgm(b, allowFade) {
        cancelBgmFade();
        var a = bgmAudio();
        var url = bgmUrl(b.file);
        if (a.getAttribute('src') !== url) a.src = url;
        try { a.currentTime = 0; } catch (_) { }
        var p = a.play();
        if (p && p.catch) p.catch(function () { /* autoplay 被拦：首次手势后补播 */ });
        if (allowFade && b.fadeIn) {
            a.volume = 0;
            rampBgmVolume(a, 0, 1);
        } else {
            a.volume = 1;
        }
    }
    /* 切到目标段（hit={b,key} 或 null＝停）。同 key 不动＝区间内跨行连播；
       旧段配 fadeOut 先渐弱再切/停，新段配 fadeIn 渐强进场；试听与剧情都走这里。 */
    function switchBgm(hit, allowFade) {
        var key = hit ? hit.key : '';
        if (key === state.bgmKey) return;
        var oldB = currentPlayingBgm();
        var a = state.bgmAudio;
        var fadeOut = !!(allowFade && oldB && oldB.fadeOut && a && !a.paused);
        state.bgmKey = key;
        if (!hit) {
            if (fadeOut) fadeOutStopAudio(a, hardStopAudio);
            else { cancelBgmFade(); hardStopAudio(); }
            return;
        }
        var start = function () { startBgm(hit.b, allowFade); };
        if (fadeOut) fadeOutStopAudio(a, start);
        else start();
    }
    /* 播放模式专用：按行进/出区间切曲，同区间连播（淡入淡出也生效） */
    function syncBgm(idx) {
        if (state.mode !== 'play') return;
        if (state.bgmResizing) return;
        switchBgm(bgmAt(idx), true);
    }
    /* 声效按句触发：scene.sfx = [{file,at,to?}]，at/to 是 1-based 闭区间。
       只在「进入区间的第一句」播一次，区间内跨句不重播；往回跳/重播也会重新触发。
       与 previewSfx 共用一次性 Audio，短音不循环、不落段。 */
    function syncSfx(idx) {
        var list = (state.scene && state.scene.sfx) || [];
        var n = idx + 1;
        list.forEach(function (s) {
            if (!s || !s.file) return;
            var at = Math.max(1, Number(s.at) || 1);
            var to = Math.max(at, Number(s.to) || at);
            if (n === at) playSfxOnce(s.file);
        });
    }
    function playSfxOnce(file) {
        if (!file) return;
        var url = '../../static/' + String(file).split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
        var a = new Audio(url);
        a.preload = 'auto';
        var p = a.play();
        if (p && p.catch) p.catch(function () { /* 音频解锁前可能失败，静默 */ });
    }
    /* 编辑态试听：只有点右侧「播放」才走到这里；再点同一段＝停止（带该段 fadeOut） */
    function previewBgm(j) {
        var b = bgmList()[j];
        if (!b) return;
        var key = bgmKeyOf(b);
        if (state.bgmKey === key && state.bgmAudio && !state.bgmAudio.paused) {
            state.bgmKey = '';
            if (b.fadeOut && state.bgmAudio) fadeOutStopAudio(state.bgmAudio, hardStopAudio);
            else { cancelBgmFade(); hardStopAudio(); }
            return;
        }
        switchBgm({ b: b, key: key }, true);
    }
    /* 双击 BGM 清单卡片试听：卡片是文件清单，不一定已落段。
       已落段→选中并走段级试听（再双击停止）；未落段→用 preview| 临时 key 播放，
       与剧情自动播放的段 key 隔离，避免抢同一段。 */
    function previewBgmFile(file) {
        if (!file) return;
        var list = bgmList();
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].file === file) { selectBgm(i); previewBgm(i); return; }
        }
        var key = 'preview|' + file;
        if (state.bgmKey === key && state.bgmAudio && !state.bgmAudio.paused) {
            state.bgmKey = '';
            hardStopAudio();
            return;
        }
        cancelBgmFade();
        var a = bgmAudio();
        var url = bgmUrl(file);
        if (a.getAttribute('src') !== url) a.src = url;
        try { a.currentTime = 0; } catch (_) {}
        var p = a.play();
        if (p && p.catch) p.catch(function () { msg('试听失败：' + file); });
        a.volume = 1;
        state.bgmKey = key;
        msg('试听 ' + baseName(file) + '（再双击停止）');
    }
    /* autoplay 被浏览器拦时，首次用户手势补播一次（仅当有区间在播且当前 paused） */
    function resumeBgmOnGesture() {
        var a = state.bgmAudio;
        if (a && state.bgmKey && a.paused && a.getAttribute('src')) {
            var p = a.play();
            if (p && p.catch) p.catch(function () { });
        }
    }
    async function loadBgms() {
        var items = await listDir('../../static/bgm/');
        state.bgmFiles = items.filter(function (x) { return !x.isDir && AUDIO_RE.test(x.name); })
            .map(function (x) { return x.name; }).sort();
        renderBgmPicker();
    }

    /* 声效清单：只认 static/sfx/，扫到什么就是什么；目录为空或不存在也保持空，
       不再退回 bgm 清单（bgm 曲目不是声效，混进来只会误导）。
       失败静默为空，不影响编辑。
       provided 可选：外部显式指定清单时跳过目录扫描（供调试/验收直接注入）。 */
    async function loadSfxFiles(provided) {
        var files = provided;
        if (!files) {
            var items = await listDir('../../static/sfx/');
            files = items.filter(function (x) { return !x.isDir && AUDIO_RE.test(x.name); })
                .map(function (x) { return 'sfx/' + x.name; }).sort();
        }
        wb.sfxFiles = files;
        wbRenderSfx();
    }
    /* 双击声效卡片试听：短音一次性播放，不循环、不落段（落段仍靠单击/拖动）。
       清单项形如 'sfx/xxx' 或 'bgm/xxx'，按段编码每一段路径以支持中文名。 */
    function previewSfx(file) {
        if (!file) return;
        var url = '../../static/' + String(file).split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
        var a = new Audio(url);
        a.preload = 'auto';
        var p = a.play();
        if (p && p.catch) p.catch(function () { msg('试听失败：' + file); });
        msg('试听 ' + baseName(file));
    }
    function isBgmDrag(evt) {
        var dt = evt && evt.dataTransfer;
        return !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, BGM_MIME) >= 0);
    }
    function isVoiceDrag(evt) {
        var dt = evt && evt.dataTransfer;
        return !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, VOICE_MIME) >= 0);
    }
    /* 语音库双击试听：语音文件是角色目录里的相对文件名（如 resg06_16_krs0005.xwma.opus），
       完整 URL = cast[role].voiceDir + 文件名，分段编码以兼容中文目录。 */
    function playVoiceFile(role, file) {
        if (!file) return;
        var item = state.cast && state.cast[role];
        var dir = (item && item.voiceDir) || '';
        var url = String(dir) + String(file).split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
        var a = new Audio(url);
        a.preload = 'auto';
        var p = a.play();
        if (p && p.catch) p.catch(function () { msg('试听失败：' + file); });
        msg('试听语音 ' + baseName(file) + '（' + (role || '未指定角色') + '）');
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

    /* 句末齿轮显隐：仅「播放态 + 非 AUTO + 窗口已铺好 + 有台词 + 打字已完成」时显示。
       打字过程中不显示，打完那一刻才出现（原作「按键等待」语义），随后一直转到翻页。
       AUTO 打开 / 编辑态 / 即时台词 / 全剧终 / 开场动画中 → 隐藏。 */
    function syncGear() {
        var show = state.mode === 'play'
                && !state.autoOn && !state.ended && !state.liveOpen && !state.introPending
                && !state.typing
                && (($('st-text-txt').textContent || '').length > 0)
                && !!window.SGDialog && window.SGDialog.isOpen();
        if (window.SGDialog) window.SGDialog.setGear(show);
    }

    function clearTimers() {
        if (state.typeTimer) { clearTimeout(state.typeTimer); state.typeTimer = null; }
        if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
        if (window.SGDialog) window.SGDialog.setGear(false);
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

    /* 背景交叉淡化：两层 div 轮流淡入淡出。新图先 Image 预加载完再挂到隐藏层，
       过渡期间旧图还在，不会像直接换 body.backgroundImage 那样露出黑底。
       fadeMs=0（重放/编辑/首帧）直接落值；seq 令牌让快速连翻时旧的加载回调作废。 */
    var bgLayers = null, bgActive = 0, bgUrl = null, bgSeq = 0;
    function applyBackground(name, fadeMs) {
        if (!bgLayers) bgLayers = [$('st-bg-0'), $('st-bg-1')];
        if (!bgLayers || !bgLayers[0] || !bgLayers[1]) return;
        var rawUrl = name ? '../../static/background/' + encodeURIComponent(name) : '';
        var url = rawUrl ? 'url("' + rawUrl + '")' : '';
        if (url === bgUrl) return;                    // 同名背景：不重播淡化
        var ms = Math.max(0, Number(fadeMs) || 0);
        var seq = ++bgSeq, prev = bgActive, next = 1 - prev;
        var commit = function () {
            if (seq !== bgSeq) return;                // 期间又翻页了，这次切换作废
            var el = bgLayers[next], old = bgLayers[prev];
            el.style.transitionDuration = ms + 'ms';
            old.style.transitionDuration = ms + 'ms';
            el.style.backgroundImage = url;
            void el.offsetWidth;                      // 强制 reflow，让 transition 从 opacity 0 起算
            el.classList.add('is-on');
            old.classList.remove('is-on');
            bgActive = next;
            bgUrl = url;
        };
        // 首帧、无动画、清空背景：直接落，不等加载
        if (bgUrl === null || ms <= 0 || !url) { commit(); return; }
        var img = new Image();
        img.onload = commit;
        img.onerror = commit;                         // 加载失败也切：纯色底好过卡住旧背景
        img.src = rawUrl;
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

    /* 按固定速度打字；语音各走各的播放器，不必互相等待。
       from>0 表示从已打字数续打（编辑切回播放时用），不是从头重来。 */
    function typeText(text, done, from) {
        var el = $('st-text-txt');
        var start = Math.max(0, from || 0);
        el.textContent = (text || '').slice(0, start);
        if (window.SGDialog) { window.SGDialog.setCaret(false); window.SGDialog.setGear(false); }  // 打字中：▼ 与句末齿轮都灭
        state.typing = true;
        state.typeDone = done;
        state.seq++;
        var mySeq = state.seq;
        var i = start;
        (function tick() {
            if (mySeq !== state.seq) return;
            if (i >= text.length) {
                state.typing = false;
                var cb = state.typeDone;
                state.typeDone = null;
                if (cb) cb();
                syncGear();   // 打完这一刻：句末齿轮出现，进入段从帧 0 开始播
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
        $('st-text-txt').textContent = (line && line.text) || '';
        syncGear();
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
        if (window.SGDialog) window.SGDialog.setCaret(false);   // ▼ 常灭：等待提示由句末齿轮承担
        syncGear();
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
        // 句末齿轮只在非 AUTO 下出现，AUTO 打开即隐藏；▼ 常灭
        if (window.SGDialog) window.SGDialog.setCaret(false);
        syncGear();
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
        stopBgm();   // 全剧终：BGM 收尾
        state.ended = true;
        state.typing = false;
        if (window.SGDialog) window.SGDialog.setCaret(true);   // 全剧终无台词，齿轮让位给 ▼
        $('st-text-txt').textContent = '— 完 —';
        syncGear();
        setHint('点击重新开始');
        setProgress();
    }

    /* 从指定行重播：把上/下场与站位重放到该行之前，否则人物会停在退场/走位后的状态。
       start 默认 0（完整重播）；编辑完从选中句开播时传那一行的下标。 */
    function restart(start) {
        var at = Math.max(0, start || 0);
        rebuildStaging(at - 1);
        renderLine(at);
    }

    /* 只把一行的舞台落到画面：背景、上/下场、站位、动作表情。
       与台词（名牌/打字/语音）分开，开场时先铺好它，等对话框动画结束再出词。
       全是幂等落值：动画前铺一次、renderLine 里再走一次不会叠加。 */
    function applyLineStage(line, animate) {
        applyStageEvents(line, animate);
        applyMoves(line, animate);
        applyBackground(bgOfLine(line), animate ? fadeMsOf(line) : 0);
        cueRoles(line).forEach(function (r) {
            var cue = cueOf(line, r);
            if (cue.action) applyAction(cue.action, r);
        });
    }

    /* 对话框擦入动画开始前，先把起始句的背景、登场角色、动作铺到画面上。
       模型此时已加载完，动画期间用户看到的是完整场景，只差台词。
       start 默认 0；从中间句开播时传那一行，顺带把之前的 move/上下场重放一遍。 */
    function primeStageForIntro(start) {
        var at = Math.max(0, start || 0);
        var first = lines()[at];
        if (!first) return;
        rebuildStaging(at - 1);      // 先重放到起始句之前，再落本句舞台
        applyLineStage(first, false);
    }

    /* silent=true：只恢复当前行的画面与文本（关闭即时台词回剧本时用），
       不跑打字机、不重播语音——否则「已经说过的台词会再说一遍」。 */
    function renderLine(i, silent) {
        var list = lines();
        if (i >= list.length) { showEnd(); return; }
        clearTimers();
        stopVoices();          // 上一句没放完的语音（可能是别人的）别盖到这一句上
        state.ended = false;
        state.idx = Math.max(0, i);
        state.lineStart = performance.now();
        syncBgm(state.idx);   // 进入该行所属 BGM 区间；同区间跨行不打断
        syncSfx(state.idx);   // 该句起点的声效（区间首句才响一次）

        var line = list[state.idx];
        var role = speakerOf(line);

        applyLineStage(line, state.mode === 'play' && state.idx > 0);
        state.speaker = role;
        /* 名牌显隐只看剧本里的 role 本身：空说话者＝旁白，传空名让 SGDialog 收起整块名牌。
           speakerOf 的回退仍用于口型/站位，不能动，否则旁白行的默认演出会跟着变。 */
        var shownName = line.role ? displayNameAt(state.idx) : '';
        $('st-name').classList.toggle('is-alias', shownName !== castName(role));   // 用的是别名/未知名时淡一点
        if (window.SGDialog) window.SGDialog.setName(shownName);   // 名牌按名字长度选档并重擦
        setProgress();
        setHint(state.autoOn && state.mode === 'play' ? '自动推进中…' : '');

        if (silent) {
            // 整句直接落字，不打字、不播语音；AUTO 当作这句已显示完继续计时
            $('st-text-txt').textContent = line.text || '';
            state.typing = false;
            state.typeDone = null;
            if (window.SGDialog) window.SGDialog.setCaret(false);   // ▼ 常灭，等待提示由句末齿轮承担
            syncGear();
            state.autoReady = true;
            state.lineVoice = Promise.resolve(0);
            armAuto(0);
            return;
        }

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
        $('st-text-txt').textContent = '';
        syncGear();   // 即时台词模式：齿轮隐藏
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
        // 回到剧本：只恢复当前行画面与文本，不重播已说过的台词/语音
        if (state.mode === 'play') renderLine(state.idx, true);
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

        var el = $('st-text-txt');
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


    /* ================= 编辑态状态 + 工具函数（story.js 保留，供两页共用）================= */
    var introSeq = 0;   // 开场动画令牌（beginIntro/introCurrent 用；场景切换令牌 switchSeq 在 edit.js）
    // 工作台状态对象：story.js 与 edit.js 共享同一引用（sfxFiles 由播放核心写入）
    var wb = {
        tick: 96, previewZoom: 1, sfxFiles: [],
        searchHits: [], searchCur: -1,
        pvRaf: 0, layoutKey: 'story-workbench-layout',
        history: [], histLabels: [], histActions: [], pendingAct: '改动', frameAct: '改动',
        histIdx: -1, histBatching: false, histPreview: -1,
        histTimer: 0, histDirty: false,   // 延迟提交：改动停止后再压一帧
        pvPlaying: false, pvTimer: 0, pvFullText: '', pvShown: 0, phRaf: 0,
        laneKeyKey: 'story-workbench-lanes', dragLine: -1, dragLane: -1,
        drawerKey: 'story-workbench-drawers', dragDrawer: null,
        selSeg: null,  // 时间轴上当前选中的段：{lane,from,to,del}，Backspace 删除用
        multiSel: []   // 框选的多个滑块：{el,from,to,commit,opt}；拖动其中一个时整组一起平移
    };

    /* markStale 是工作台所有数据改动的汇聚点，但过去只标脏+记历史，视图重绘散落在
       各调用点：BGM 增删、场景背景、台词编辑、背景落段等只调 markStale 的路径改完
       不会重绘时间轴，要等缩放（wbZoom→wbRenderTimeline）才看到最新状态。
       这里在 markStale 里挂一个 rAF 防抖的统一刷新：同一帧内的多次改动合并成一次，
       下一帧重绘时间轴/校验/预览/声效清单，与声效原有的 refreshAfterTimelineEdit 同一逻辑。 */
    var wbRefreshRaf = 0;
    function scheduleWorkbenchRefresh() {
        if (wbRefreshRaf) return;
        if (typeof requestAnimationFrame !== 'function') {
            if (typeof refreshWorkbench === 'function') refreshWorkbench(['timeline', 'issues', 'preview', 'sfx', 'bgthumbs']);
            return;
        }
        wbRefreshRaf = requestAnimationFrame(function () {
            wbRefreshRaf = 0;
            if (state.mode !== 'edit') return;
            if (typeof refreshWorkbench === 'function') refreshWorkbench(['timeline', 'issues', 'preview', 'sfx', 'bgthumbs']);
        });
    }

    function markStale(action) {
        state.stale = true;
        // pendingAct 是"下一次改动要用的动作"（段删除等闭包内无法直接传参时使用）
        var act = action || (typeof wb !== 'undefined' && wb.pendingAct) || '改动';
        if (typeof wb !== 'undefined') wb.pendingAct = '改动';
        if (typeof wbScheduleHistory === 'function') wbScheduleHistory(act);
        scheduleWorkbenchRefresh();
    }

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


    function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
    /* 播放头静止时停在选中句的句子头；预览播放时从句子头扫到句子尾（wbPlayheadSweep）。 */

    function addOption(sel, value, text) {
        var o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        sel.appendChild(o);
    }

    /* 某个角色的模型能用的标签清单（主时间线 / 差分槽），两个差分槽共用同一份 */

    function beginIntro() { return ++introSeq; }

    function introCurrent(seq) { return seq === introSeq; }


    function playDialogIntro(done, start) {
        if (!state.dialog) { if (done) done(); return; }
        state.dialog.fit();       // 视口可能变过（全屏/缩放），先按当前尺寸摆好
        /* 预置起始句名牌：擦入动画由 open() 的 50–58 帧统一负责，文字先就位，
           这样开场播完 renderLine(start) 的 setName 看到名字没变就不会再擦一遍。
           从中间句开播时用那句的称呼，别先亮首句的名字再改。 */
        var at = Math.max(0, start || 0);
        // 首行是空说话者（旁白）时预置空名，开场动画的装饰线/名牌层才不会亮起来。
        // 必须无条件预置（含空串）：空串走 setName('') 会清掉上一场残留的 st.name。
        var firstLine = lines()[at];
        var firstName = (firstLine && firstLine.role) ? displayNameAt(at) : '';
        state.dialog.primeName(firstName);
        state.dialog.open(done);
    }

    /* 播放 → 编辑：冻结现场供切回时续播。
       语音不 destroy，只 pause（记 offset）；打字不补全，记住已打字数并停下 timer；
       AUTO 计时停掉。快照挂在 state.pausedPlayback，切回播放时若剧本没改就照它续上。 */

    function setMode(mode) {
        var fromEdit = state.mode === 'edit';
        var fromPlay = state.mode === 'play';
        if (mode === 'edit' && state.liveOpen) closeLive();
        // 离开编辑态：停掉预览镜像的 rAF，别在播放时持续 drawImage
        if (mode !== 'edit' && wb.pvRaf) { cancelAnimationFrame(wb.pvRaf); wb.pvRaf = 0; }
        if (mode !== 'edit' && wb.pvTimer) { clearInterval(wb.pvTimer); wb.pvTimer = 0; wb.pvPlaying = false; }

        /* 播放 → 编辑：冻结现场（语音暂停记 offset、打字停在当前字数），不销毁。
           全剧终/开场动画未落字时没有可续播的现场，快照置空。 */
        if (mode === 'edit') {
            if (fromPlay && !state.ended && !state.introPending) pauseForEdit();
            else state.pausedPlayback = null;
        }

        /* 从编辑切播放：若剧本没改、且选中的仍是暂停那一句 → 从暂停处续播；
           否则（改了稿、或选了别的句）作废快照，走完整开播，落点由 startAt 决定。 */
        var startAt = (fromEdit && mode === 'play')
            ? Math.max(0, Math.min(state.sel, lines().length - 1)) : 0;
        var canResume = fromEdit && mode === 'play' && !state.stale &&
            state.pausedPlayback && state.pausedPlayback.idx === startAt;
        if (fromEdit && mode === 'play' && !canResume) state.pausedPlayback = null;

        state.mode = mode;
        // 编辑态的试听不能带进剧情：续播时保留 BGM，其余情况清空 key 让起始句重新起播
        if (fromEdit && mode === 'play' && !canResume) stopBgm();
        root.setAttribute('data-mode', mode);
        var buttons = document.querySelectorAll('.st-modes button');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-mode') === mode);
        }
        if (mode === 'edit') {
            stopAllBlinks();          // 编辑态预览别的动作，别让上一句的眨眼继续跑
            if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
            // 语音/打字由 pauseForEdit 冻结；这里不再 stopVoices / skipTyping
            setHint('');
            // 选中正在播放的那一句，画布预览的站位/上下场与之前的画面保持一致
            state.sel = Math.min(state.idx, Math.max(0, lines().length - 1));
            renderEditor();
            // 进入编辑态压入初始快照，撤销能回到刚进来时的状态
            if (wb.histIdx < 0) wbPushHistory('初始');
        } else if (canResume) {
            resumePlayback();         // 不重跑开场动画、不重播语音：从冻结处接着走
        } else if (state.stale || fromEdit) {
            /* 剧本有改动，或从编辑页切过来（换了句/首次进入）：
               走一次完整开播，落点由 startAt 决定。 */
            state.stale = false;
            refreshLiveRoles();
            primeStageForIntro(startAt);   // 动画期间先看到新剧本、起始句的完整场景
            state.introPending = true;
            var myIntro = beginIntro();
            var introDone = false;
            var finishIntro = function () {
                if (introDone || !introCurrent(myIntro)) return;
                introDone = true;
                state.introPending = false;
                restart(startAt);          // 编辑后从选中句开播，不再总是第 0 行
            };
            playDialogIntro(finishIntro, startAt);
            setTimeout(finishIntro, 2000);
        } else {
            // 编辑模式可能预览过别的站位，回放前按当前播放行复位
            rebuildStaging(state.ended ? lines().length - 1 : state.idx);
            playDialogIntro(null, state.idx);
            if (state.ended) setHint('点击重新开始');
            else if (state.autoOn) armAuto(state.autoReady ? state.lineVoice : null);
            else setHint('点击继续 ▸');
        }
    }


    function applyScene(scene, cast) {
        state.sel = 0;
        state.pausedPlayback = null;   // 换场：旧的暂停现场作废
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
        var menu = $('st-scene-menu');
        menu.innerHTML = '';
        state.scenes.forEach(function (s) {
            var opt = document.createElement('option');
            opt.value = s.file;
            opt.textContent = s.title;
            sel.appendChild(opt);

            var item = document.createElement('div');
            item.className = 'st-scene-opt';
            item.setAttribute('role', 'option');
            item.dataset.file = s.file;
            item.innerHTML = '<span class="st-scene-check"></span>' +
                '<span class="st-scene-title"></span><span class="st-scene-file"></span>';
            item.querySelector('.st-scene-title').textContent = s.title;
            item.querySelector('.st-scene-file').textContent = s.file;
            menu.appendChild(item);
        });
        var fromUrl = new URLSearchParams(location.search).get('scene');
        state.file = (fromUrl && state.scenes.some(function (s) { return s.file === fromUrl; }))
            ? fromUrl : (state.scenes[0] && state.scenes[0].file);
        if (state.file) sel.value = state.file;
        syncScenePicker();
        wbRenderScenes();
        return true;
    }
    /* 更新地址栏的 scene 参数，让 loadIndex 重新读清单时选中目标文件 */

    /* ================= 工作台转发桩（实现在 edit.js 的 ST.workbench）================= */
    function wbPushHistory() {
        var w = ST.workbench && ST.workbench.wbPushHistory;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function wbScheduleHistory() {
        var w = ST.workbench && ST.workbench.wbScheduleHistory;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function wbRenderScenes() {
        var w = ST.workbench && ST.workbench.wbRenderScenes;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function wbRenderSfx() {
        var w = ST.workbench && ST.workbench.wbRenderSfx;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function refreshWorkbench() {
        var w = ST.workbench && ST.workbench.refreshWorkbench;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function wbBind() {
        var w = ST.workbench && ST.workbench.wbBind;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function renderDrawer() {
        var w = ST.workbench && ST.workbench.renderDrawer;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function renderProps() {
        var w = ST.workbench && ST.workbench.renderProps;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function renderEditor() {
        var w = ST.workbench && ST.workbench.renderEditor;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function pauseForEdit() {
        var w = ST.workbench && ST.workbench.pauseForEdit;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function resumePlayback() {
        var w = ST.workbench && ST.workbench.resumePlayback;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }

    function syncScenePicker() {
        var w = ST.workbench && ST.workbench.syncScenePicker;
        return w ? w.apply(ST.workbench, arguments) : undefined;
    }


    // 暴露播放核心给 edit.js（工作台层）。state 与 wb 为同一对象引用，两页共享编辑态状态。
    window.ST = {
        state: state,
        wb: wb,
        $: $,
        applyScene: applyScene,
        addOption: addOption,
        baseName: baseName,
        beginIntro: beginIntro,
        fillSelect: fillSelect,
        introCurrent: introCurrent,
        loadIndex: loadIndex,
        markStale: markStale,
        playDialogIntro: playDialogIntro,
        setMode: setMode,
        setVal: setVal,
        BGM_MIME: BGM_MIME,
        BG_MIME: BG_MIME,
        BLINK_KEYS: BLINK_KEYS,
        DEFAULT_BLINK: DEFAULT_BLINK,
        DEFAULT_VAR_DURATION: DEFAULT_VAR_DURATION,
        SFX_MIME: SFX_MIME,
        VOICE_MIME: VOICE_MIME,
        isVoiceDrag: isVoiceDrag,
        playVoiceFile: playVoiceFile,
        addBgmAt: addBgmAt,
        apiUrl: apiUrl,
        applyLineStage: applyLineStage,
        armAuto: armAuto,
        audioFor: audioFor,
        audioPool: audioPool,
        baseSlotOf: baseSlotOf,
        bgOfLine: bgOfLine,
        bgSrc: bgSrc,
        bgmFreeBounds: bgmFreeBounds,
        bgmAt: bgmAt,
        bgmKeyOf: bgmKeyOf,
        bgmList: bgmList,
        bgmRange: bgmRange,
        switchBgm: switchBgm,
        syncSfx: syncSfx,
        playSfxOnce: playSfxOnce,
        castName: castName,
        castRoles: castRoles,
        clearBgmSel: clearBgmSel,
        clearTimers: clearTimers,
        cloneStage: cloneStage,
        closeLive: closeLive,
        cueOf: cueOf,
        cueRoles: cueRoles,
        currentLine: currentLine,
        delBgm: delBgm,
        displayNameAt: displayNameAt,
        fadeMsOf: fadeMsOf,
        filterBgGallery: filterBgGallery,
        filterBgmPicker: filterBgmPicker,
        firstRole: firstRole,
        getJson: getJson,
        inheritedName: inheritedName,
        isBgDrag: isBgDrag,
        isBgmDrag: isBgmDrag,
        lines: lines,
        loadSfxFiles: loadSfxFiles,
        loadVoices: loadVoices,
        moveOf: moveOf,
        msg: msg,
        onTyped: onTyped,
        playVoiceFor: playVoiceFor,
        playerOf: playerOf,
        previewBgInGallery: previewBgInGallery,
        previewSfx: previewSfx,
        primeStageForIntro: primeStageForIntro,
        putJson: putJson,
        reassignRoleInScript: reassignRoleInScript,
        rebuildStaging: rebuildStaging,
        refreshLiveRoles: refreshLiveRoles,
        renderBgmDetail: renderBgmDetail,
        renderBgmTrack: renderBgmTrack,
        renderLine: renderLine,
        resetStage: resetStage,
        restart: restart,
        resumeBgmOnGesture: resumeBgmOnGesture,
        root: root,
        rowAtY: rowAtY,
        selectBgm: selectBgm,
        setAuto: setAuto,
        setBgmRange: setBgmRange,
        setCue: setCue,
        setHint: setHint,
        setProgress: setProgress,
        setSceneBackground: setSceneBackground,
        skipTyping: skipTyping,
        speakerOf: speakerOf,
        stageOf: stageOf,
        state: state,
        step: step,
        stopAllBlinks: stopAllBlinks,
        stopBgm: stopBgm,
        stopVoices: stopVoices,
        syncBgCurrent: syncBgCurrent,
        syncGear: syncGear,
        syncLayout: syncLayout,
        typeText: typeText,
    };

    /* ================= 启动流程（工作台绑定已移至 edit.js）================= */
    /* 编辑页（steins_gate/edit/index.html）是独立文档：同样加载模型以便实时预览，
       但启动后停在编辑态，不播开场动画、不推进剧情。它与剧情页各自一台 wasm device，
       页面切换时浏览器回收整页内存，编辑期的反复 rebuildStaging 不再污染剧情模式。 */
    var EDIT_PAGE = document.documentElement.getAttribute('data-editor') === '1';

    window.startStory = async function () {
        // 对话框 UI 先就位（此时是收起的空窗），等第一名角色上完台再播开场
        state.dialog = window.SGDialog ? window.SGDialog.init() : null;
        try {
            await loadIndex();
            state.cast = await getJson('cast.json');
            if (!state.file) throw new Error('edit/scenes/ 下没有场景');
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

            if (EDIT_PAGE) {
                // 编辑页：直接进入编辑态（不播开场、不推进剧情），并让「剧情预览」带上当前场景
                setMode('edit');
                var goto = $('st-goto-play');
                if (goto) goto.href = 'index.html?scene=' + encodeURIComponent(state.file || '');
            } else {
            state.introPending = true;
            var myIntro = beginIntro();
            var introDone = false;
            var finishIntro = function () {
                if (introDone || !introCurrent(myIntro)) return;
                introDone = true;
                state.introPending = false;
                renderLine(0);   // 名牌 + 文字 + 语音：等对话框擦入动画结束才出
                if (state.autoOn) armAuto(state.autoReady ? state.lineVoice : null);
            };
            playDialogIntro(finishIntro);
            setTimeout(finishIntro, 2000);   // rAF 在后台标签页会被冻结，兜底别让首句永远不出现
            }

            initLive();
            initAuto();
            loadBackgrounds();
            loadBgms();
            loadSfxFiles();
            wbBind();
            refreshWorkbench();
            loadModels();
        } catch (err) {
            console.error('[Story] 启动失败', err);
            $('st-status').textContent = '载入失败：' + (err && err.message);
        }
    };
})();

