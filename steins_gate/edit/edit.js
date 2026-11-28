// ============================================================
//  edit.js —— 编辑工作台（纯 DOM 命令式，无框架）
//
//  从 story.js 拆出的工作台层：时间轴渲染、台词/角色表单、历史栈、
//  场景导航、搜索校验、实时预览镜像、四区布局与全部编辑事件绑定。
//  依赖 story.js 暴露的 window.ST（state + 播放核心 API），不反向修改播放引擎。
//  纯算法（挤开/分段/历史栈数据）在 timeline-core.js，本文件只负责 DOM 呈现。
// ============================================================
(function () {
    'use strict';
    var ST = window.ST;
    if (!ST) { console.error('[Edit] story.js 未加载，工作台无法启动'); return; }
    var EDIT_PAGE = document.documentElement.getAttribute('data-editor') === '1';

    // 从 story 核心解构出工作台需要的符号（函数体保持原样，裸调用即可命中这些别名）
    var $ = ST.$;
    var applyScene = ST.applyScene;
    var addOption = ST.addOption;
    var baseName = ST.baseName;
    var beginIntro = ST.beginIntro;
    var fillSelect = ST.fillSelect;
    var introCurrent = ST.introCurrent;
    var loadIndex = ST.loadIndex;
    var markStale = ST.markStale;
    var playDialogIntro = ST.playDialogIntro;
    var setMode = ST.setMode;
    var setVal = ST.setVal;
    var BGM_MIME = ST.BGM_MIME;
    var BG_MIME = ST.BG_MIME;
    var BLINK_KEYS = ST.BLINK_KEYS;
    var DEFAULT_BLINK = ST.DEFAULT_BLINK;
    var DEFAULT_VAR_DURATION = ST.DEFAULT_VAR_DURATION;
    var SFX_MIME = ST.SFX_MIME;
    var VOICE_MIME = ST.VOICE_MIME;
    var isVoiceDrag = ST.isVoiceDrag;
    var playVoiceFile = ST.playVoiceFile;
    var addBgmAt = ST.addBgmAt;
    var apiUrl = ST.apiUrl;
    var applyLineStage = ST.applyLineStage;
    var armAuto = ST.armAuto;
    var audioFor = ST.audioFor;
    var audioPool = ST.audioPool;
    var baseSlotOf = ST.baseSlotOf;
    var bgOfLine = ST.bgOfLine;
    var bgSrc = ST.bgSrc;
    var bgmFreeBounds = ST.bgmFreeBounds;
    var bgmAt = ST.bgmAt;
    var bgmKeyOf = ST.bgmKeyOf;
    var bgmList = ST.bgmList;
    var bgmRange = ST.bgmRange;
    var switchBgm = ST.switchBgm;
    var syncSfx = ST.syncSfx;
    var playSfxOnce = ST.playSfxOnce;
    var castName = ST.castName;
    var castRoles = ST.castRoles;
    var clearBgmSel = ST.clearBgmSel;
    var clearTimers = ST.clearTimers;
    var cloneStage = ST.cloneStage;
    var cueOf = ST.cueOf;
    var cueRoles = ST.cueRoles;
    var currentLine = ST.currentLine;
    var delBgm = ST.delBgm;
    var displayNameAt = ST.displayNameAt;
    var fadeMsOf = ST.fadeMsOf;
    var filterBgGallery = ST.filterBgGallery;
    var filterBgmPicker = ST.filterBgmPicker;
    var firstRole = ST.firstRole;
    var getJson = ST.getJson;
    var inheritedName = ST.inheritedName;
    var isBgDrag = ST.isBgDrag;
    var isBgmDrag = ST.isBgmDrag;
    var lines = ST.lines;
    var loadSfxFiles = ST.loadSfxFiles;
    var loadVoicesRaw = ST.loadVoices;
    /* story.js 的 loadVoices 载入后只调 renderProps（那是播放核心的职责边界），
       但语音库 picker 归工作台的 sfx 刷新域：这里包一层，载入完成后补一次 sfx 刷新，
       卡片才会马上出现，不必等切换角色才触发 wbRenderVoicePicker。
       只在真的新载入目录时刷新，避免与 picker 末尾的兜底调用互相递归。 */
    function loadVoices(role) {
        var item = state.cast && state.cast[role];
        var dir = item && item.voiceDir;
        var had = !!(dir && state.voices[dir]);
        return Promise.resolve(loadVoicesRaw(role)).then(function () {
            if (!had && dir && state.voices[dir] && state.mode === 'edit') refreshWorkbench('sfx');
        });
    }
    var moveOf = ST.moveOf;
    var msg = ST.msg;
    var onTyped = ST.onTyped;
    var playVoiceFor = ST.playVoiceFor;
    var playerOf = ST.playerOf;
    var previewBgInGallery = ST.previewBgInGallery;
    var previewSfx = ST.previewSfx;
    var primeStageForIntro = ST.primeStageForIntro;
    var putJson = ST.putJson;
    var reassignRoleInScript = ST.reassignRoleInScript;
    var rebuildStaging = ST.rebuildStaging;
    var renderBgmDetail = ST.renderBgmDetail;
    var renderBgmTrack = ST.renderBgmTrack;
    var renderLine = ST.renderLine;
    var resetStage = ST.resetStage;
    var restart = ST.restart;
    var resumeBgmOnGesture = ST.resumeBgmOnGesture;
    var root = ST.root;
    var rowAtY = ST.rowAtY;
    var selectBgm = ST.selectBgm;
    var setAuto = ST.setAuto;
    var setBgmRange = ST.setBgmRange;
    var setCue = ST.setCue;
    var setHint = ST.setHint;
    var setProgress = ST.setProgress;
    var setSceneBackground = ST.setSceneBackground;
    var skipTyping = ST.skipTyping;
    var speakerOf = ST.speakerOf;
    var stageOf = ST.stageOf;
    var state = ST.state;
    var step = ST.step;
    var stopAllBlinks = ST.stopAllBlinks;
    var stopBgm = ST.stopBgm;
    var stopVoices = ST.stopVoices;
    var syncBgCurrent = ST.syncBgCurrent;
    var syncGear = ST.syncGear;
    var syncLayout = ST.syncLayout;
    var typeText = ST.typeText;
    // wb 是与 story.js 共享的工作台状态对象（同一引用）
    var wb = ST.wb;

    // ST.workbench 由本文件在末尾填充；story.js 侧的转发桩在此之前不会触发（均在用户交互/启动后调用）

    /* 剧本行背景缩略图：按该句「有效背景」只读显示，包含继承场景背景的情况。
       编辑统一走时间轴背景轨，这里不接拖放、不放清除钮。 */
    function setLineBgThumb(slot, line) {
        if (!slot) return;
        var bgName = bgOfLine(line);
        slot.classList.toggle('has-bg', !!bgName);
        slot.style.backgroundImage = bgName ? ('url("' + bgSrc(bgName) + '")') : '';
        slot.title = bgName ? ('本行背景：' + bgName + '\n预览（在时间轴背景轨修改）') : '';
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
                + '<span class="st-line-bg"></span>'
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
            setLineBgThumb(li.querySelector('.st-line-bg'), line);
            ol.appendChild(li);
        });
        if (state.sel >= lines().length) state.sel = Math.max(0, lines().length - 1);
        $('st-json-name').textContent = state.file;
        $('st-sel-idx').textContent = String(state.sel + 1);
        renderBgmTrack();
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
            var next = this.value;
            /* 换卡片角色＝让新角色继承旧角色在这场的全部行为：登场阵容里的位置/缩放，
               以及剧本里所有引用旧角色的行（说话者、enter/exit、move、cues）。
               只改 slot.role 会让旧角色的行为以幽灵引用留在剧本里，切回来又冒出来。 */
            reassignRoleInScript(role, next);
            markStale();
            rebuildStaging(state.sel);
            renderRoster(); renderList();   // 三排与行列表的小标都跟着换角色
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

        var xLbl = document.createElement('span');
        xLbl.className = 'lbl'; xLbl.textContent = 'X';
        var x = stageNumInput('st-stage-x', shown.x, '-1', '1',
            atScene ? '全场横向位置 -1..1' : (own ? '本行横向位置 -1..1' : '沿用上一句的水平位置'));
        var yLbl = document.createElement('span');
        yLbl.className = 'lbl'; yLbl.textContent = 'Y';
        var y = stageNumInput('st-stage-y', shown.y || 0, '-1', '1',
            atScene ? '全场纵向位置 -1..1（+ 上移 / - 下移）'
                    : (own ? '本行纵向位置 -1..1' : '沿用上一句的纵向位置'));
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
                    x.title = y.title = sc.title = '本行已改站位';
                    renderList();                      // 行列表里的 ↔ 小标同步
                }
                rebuildStaging(state.sel);
            });
        }
        bind(x, 'x'); bind(y, 'y'); bind(sc, 'scale');

        reset.addEventListener('click', function () {
            clearLineMove(role);
            rebuildStaging(state.sel);
            renderRoster();
            renderList();
        });

        posRow.appendChild(xLbl); posRow.appendChild(x);
        posRow.appendChild(yLbl); posRow.appendChild(y);
        posRow.appendChild(scLbl); posRow.appendChild(sc);
        posRow.appendChild(reset);
        card.appendChild(posRow);

        /* ③ 本行：动作（语音由右栏「角色语音库」与语音轨控制，不在这里改） */
        var cue = cueOf(line, role);
        var item = state.cast && state.cast[role];

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
                    ['x', 'y', 'scale', 'z'].forEach(function (k) {
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
        var next = { x: cur.x, y: cur.y, scale: cur.scale, z: cur.z };
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

    /* ====================================================================
       工作台（Workbench）—— 编辑态的四区布局增强。
       设计约束：只读 state / lines()，不碰播放引擎；所有刷新走 refreshWorkbench()，
       由 renderEditor() 末尾调用。播放态（#st-hud / fit / 全屏 canvas）完全不参与。
       ==================================================================== */
    // wb 定义在 story.js（ST.wb），此处通过顶部别名引用
    /* 轨道顺序记忆：只存 key 顺序，重载后按它重排 WB_LANES */
    function wbLoadLaneOrder() {
        try {
            var order = JSON.parse(localStorage.getItem(wb.laneKeyKey) || 'null');
            if (!Array.isArray(order)) return;
            var byKey = {}; WB_LANES.forEach(function (l) { byKey[l.key] = l; });
            var out = [];
            order.forEach(function (k) { if (byKey[k]) { out.push(byKey[k]); delete byKey[k]; } });
            Object.keys(byKey).forEach(function (k) { out.push(byKey[k]); });
            WB_LANES = out;
        } catch (_) {}
    }
    function wbSaveLaneOrder() {
        try { localStorage.setItem(wb.laneKeyKey, JSON.stringify(WB_LANES.map(function (l) { return l.key; }))); } catch (_) {}
    }

    /* ====================================================================
       面板抽屉：左栏与右栏的模块可折叠、拖动排序，状态存 localStorage。
       拖拽只绑在把手上，用独立 MIME 与背景/BGM/语音卡片的拖放隔离。
       ==================================================================== */
    var DRAWER_MIME = 'application/x-wb-drawer';
    var WbDrawers = [];

    function drawerHost(group) {
        if (group === 'nav') return document.getElementById('wb-scene-props');
        return document.querySelector('#st-props .st-sec');
    }

    function makeGripToggle(head, d, locked) {
        var grip = document.createElement('span');
        grip.className = 'wb-drawer-grip';
        grip.title = '拖动调整顺序';
        if (!locked) grip.draggable = true;
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'wb-drawer-toggle';
        toggle.title = '展开 / 收起';
        toggle.setAttribute('aria-expanded', 'true');
        head.insertBefore(grip, head.firstChild);
        head.appendChild(toggle);
        head.classList.add('wb-drawer-head');
        toggle.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            d.open = !d.open; applyDrawerOpen(d); saveDrawerState();
        });
        head.addEventListener('click', function (e) {
            // label 内的抽屉头会触发 input 聚焦；阻止默认行为后点击反馈与其他头一致。
            e.preventDefault();
            if (e.target === grip || e.target === toggle || grip.contains(e.target)) return;
            d.open = !d.open; applyDrawerOpen(d); saveDrawerState();
        });
        return { grip: grip, toggle: toggle };
    }

    // el 保持在原父节点中，只在内部加抽屉头与 body，不改变 DOM 层级。
    function wrapDrawer(cfg) {
        var el = cfg.el, head = cfg.head;
        var d = { key: cfg.key, group: cfg.group, el: el, head: head,
                  locked: !!cfg.locked, open: true };
        var gt = makeGripToggle(head, d, d.locked);
        d.grip = gt.grip; d.toggle = gt.toggle;
        var body = document.createElement('div');
        body.className = 'wb-drawer-body';
        [].slice.call(el.childNodes).forEach(function (n) { if (n !== head) body.appendChild(n); });
        el.appendChild(body);
        d.body = body;
        el.classList.add('wb-drawer', 'wb-drawer--' + cfg.group);
        el.dataset.drawerKey = cfg.key;
        WbDrawers.push(d);
        if (!d.locked) bindDrawerDrag(d);
        return d;
    }

    // 用新建外壳包住若干同级节点；用于本行演出里语音/登台段（它们的头与内容是兄弟关系）。
    function shellDrawer(cfg) {
        var shell = document.createElement('div');
        cfg.head.parentNode.insertBefore(shell, cfg.head);
        var d = { key: cfg.key, group: cfg.group, el: shell, head: cfg.head,
                  locked: !!cfg.locked, open: true };
        var gt = makeGripToggle(cfg.head, d, d.locked);
        d.grip = gt.grip; d.toggle = gt.toggle;
        shell.appendChild(cfg.head);
        var body = document.createElement('div');
        body.className = 'wb-drawer-body';
        cfg.nodes.forEach(function (n) { body.appendChild(n); });
        shell.appendChild(body);
        d.body = body;
        shell.className = 'wb-drawer wb-drawer--' + cfg.group;
        shell.dataset.drawerKey = cfg.key;
        WbDrawers.push(d);
        if (!d.locked) bindDrawerDrag(d);
        return d;
    }

    function applyDrawerOpen(d) {
        d.el.classList.toggle('is-collapsed', !d.open);
        if (d.toggle) d.toggle.setAttribute('aria-expanded', d.open ? 'true' : 'false');
    }

    function bindDrawerDrag(d) {
        d.grip.addEventListener('dragstart', function (e) {
            wb.dragDrawer = { key: d.key, group: d.group };
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData(DRAWER_MIME, d.key);
            e.dataTransfer.setData('text/plain', 'drawer:' + d.key);
            d.el.classList.add('is-drag');
        });
        d.grip.addEventListener('dragend', function () {
            wb.dragDrawer = null;
            d.el.classList.remove('is-drag');
            WbDrawers.forEach(function (x) { x.el.classList.remove('is-over'); });
        });
        d.el.addEventListener('dragover', function (e) {
            if (!wb.dragDrawer || wb.dragDrawer.group !== d.group) return;
            if (Array.prototype.indexOf.call(e.dataTransfer.types, DRAWER_MIME) < 0) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            d.el.classList.add('is-over');
        });
        d.el.addEventListener('dragleave', function (e) {
            if (!d.el.contains(e.relatedTarget)) d.el.classList.remove('is-over');
        });
        d.el.addEventListener('drop', function (e) {
            d.el.classList.remove('is-over');
            if (!wb.dragDrawer || wb.dragDrawer.group !== d.group) return;
            if (Array.prototype.indexOf.call(e.dataTransfer.types, DRAWER_MIME) < 0) return;
            e.preventDefault();
            moveDrawer(wb.dragDrawer.key, d.key, d.group);
            wb.dragDrawer = null;
        });
    }

    function reflowDrawerHost(group) {
        var host = drawerHost(group);
        if (!host) return;
        var first = WbDrawers.filter(function (d) { return d.group === group && d.key === 'project'; });
        var movable = WbDrawers.filter(function (d) { return d.group === group && !d.locked && d.key !== 'project'; });
        var last = WbDrawers.filter(function (d) { return d.group === group && d.locked && d.key !== 'project'; });
        var groupTitle = null;
        [].slice.call(host.children).forEach(function (c) {
            if (c.classList && c.classList.contains('wb-res-group-title')) groupTitle = c;
        });
        first.concat(movable, last).forEach(function (d) {
            if (d.key !== 'project') host.appendChild(d.el);
        });
        if (first[0]) host.insertBefore(first[0].el, host.firstChild);
        if (groupTitle) host.insertBefore(groupTitle, first[0] ? first[0].el.nextSibling : host.firstChild);
    }

    function moveDrawer(from, to, group) {
        if (from === to) return;
        var idx = -1, dst = -1;
        WbDrawers.forEach(function (d, i) {
            if (d.group !== group || d.locked) return;
            if (d.key === from) idx = i;
            if (d.key === to) dst = i;
        });
        if (idx < 0 || dst < 0) return;
        WbDrawers.splice(dst, 0, WbDrawers.splice(idx, 1)[0]);
        reflowDrawerHost(group);
        saveDrawerState();
        msg('面板顺序已调整');
    }

    function saveDrawerState() {
        var order = {}, open = {};
        ['nav', 'insp'].forEach(function (g) {
            order[g] = WbDrawers.filter(function (d) { return d.group === g; })
                .map(function (d) { return d.key; });
        });
        WbDrawers.forEach(function (d) { open[d.key] = d.open; });
        try { localStorage.setItem(wb.drawerKey, JSON.stringify({ v: 1, order: order, open: open })); } catch (_) {}
    }

    function loadDrawerState() {
        var s = {};
        try { s = JSON.parse(localStorage.getItem(wb.drawerKey) || '{}'); } catch (_) {}
        var byKey = {}; WbDrawers.forEach(function (d) { byKey[d.key] = d; });
        WbDrawers.forEach(function (d) {
            d.open = (s.open && typeof s.open[d.key] === 'boolean') ? s.open[d.key] : true;
            applyDrawerOpen(d);
        });
        var rebuilt = [];
        ['nav', 'insp'].forEach(function (g) {
            var want = (s.order && Array.isArray(s.order[g])) ? s.order[g] : [];
            var used = {}, ordered = [];
            want.forEach(function (k) { if (byKey[k] && byKey[k].group === g && !used[k]) {
                ordered.push(byKey[k]); used[k] = 1;
            } });
            WbDrawers.filter(function (d) { return d.group === g && !used[d.key]; })
                .forEach(function (d) { ordered.push(d); });
            ordered.forEach(function (d) { rebuilt.push(d); });
        });
        WbDrawers = rebuilt;
        ['nav', 'insp'].forEach(function (g) { reflowDrawerHost(g); });
    }

    function collectAfter(node, stopClass) {
        var out = [], n = node.nextSibling;
        while (n && !(n.nodeType === 1 && n.classList && n.classList.contains(stopClass))) {
            if (n.nodeType === 1) out.push(n);
            n = n.nextSibling;
        }
        return out;
    }

    function bindDrawers() {
        if (WbDrawers.length) return;
        var nav = document.getElementById('wb-nav');
        var head = document.querySelector('.wb-nav-head');
        var sceneGroup = document.querySelector('.wb-nav-scene-group');
        var sceneProps = document.getElementById('wb-scene-props');
        var hist = document.querySelector('.wb-nav-history');
        var propsSec = document.querySelector('#st-props .st-sec');
        if (!nav || !head || !sceneGroup || !sceneProps || !hist || !propsSec) return;

        // 左栏：项目（剧本 + 标题）为固定首项；资源抽屉组背景 / 背景音乐 / 声效 / 改动历史可排序。
        shellDrawer({ key: 'project', group: 'nav', head: head, nodes: [sceneGroup], locked: true });
        wrapDrawer({ key: 'history', group: 'nav', el: hist,
                     head: hist.querySelector('.wb-nav-group-title'), locked: true });
        var keys = ['bg', 'bgm', 'sfx'];
        var sels = ['.st-bg-field', '.st-bgm-field', '.st-sfx-field'];
        keys.forEach(function (key, idx) {
            var label = sceneProps.querySelector(sels[idx] + ' > .wb-nav-group-title');
            if (label && label.parentNode) wrapDrawer({ key: key, group: 'nav',
                el: label.parentNode, head: label });
        });

        // 右栏：台词 / 角色语音库 / 登台角色。linebar 就地包装，保持 .st-sec 直接子元素。
        var linebar = propsSec.querySelector('#wb-linebar');
        if (linebar) wrapDrawer({ key: 'linebar', group: 'insp', el: linebar,
            head: linebar.querySelector('.wb-linebar-head') });
        var subs = [].slice.call(propsSec.children).filter(function (c) {
            return c.classList && c.classList.contains('st-sub');
        });
        if (subs.length >= 2) {
            shellDrawer({ key: 'voice', group: 'insp', head: subs[0], nodes: collectAfter(subs[0], 'st-sub') });
            shellDrawer({ key: 'stage', group: 'insp', head: subs[1], nodes: collectAfter(subs[1], 'st-sub') });
        }
        // 日历抽屉注册在最后：台词 / 角色语音库 / 登台角色 / 日历。
        var cal = propsSec.querySelector('.st-subwin-props');
        if (cal) wrapDrawer({ key: 'calendar', group: 'insp', el: cal,
            head: cal.querySelector('.wb-linebar-head') });
        loadDrawerState();
    }

    /* ---- 预览字幕：点某句立刻显示该句台词；空格切换逐字播放/暂停 ---- */
    function wbCaptionShow(full, instant) {
        wb.pvFullText = String(full || '');
        var box = $('wb-pv-caption'), txt = $('wb-pv-cap-text');
        if (!box || !txt) return;
        box.hidden = !wb.pvFullText;
        if (instant || !wb.pvPlaying) { wb.pvShown = wb.pvFullText.length; txt.textContent = wb.pvFullText; return; }
        wb.pvShown = 0; txt.textContent = '';
        if (wb.pvTimer) { clearInterval(wb.pvTimer); wb.pvTimer = 0; }
        wb.pvTimer = setInterval(function () {
            if (state.mode !== 'edit' || !wb.pvPlaying) { clearInterval(wb.pvTimer); wb.pvTimer = 0; return; }
            wb.pvShown = Math.min(wb.pvFullText.length, wb.pvShown + 1);
            txt.textContent = wb.pvFullText.slice(0, wb.pvShown);
            if (wb.pvShown >= wb.pvFullText.length) { clearInterval(wb.pvTimer); wb.pvTimer = 0; }
        }, 32);
    }
    /* 工作台「播放」= 真正演出当前句：立绘上下场/移动/动作带动画 + 语音 + 逐字台词。
       编辑态 selectLine 只做瞬时落位（静态预览），点播放才走这条完整演出路径。
       暂停则停掉语音；这些函数都不依赖 mode==='play'，编辑态调用安全。 */
    function wbPreviewPerform(line) {
        if (!line) return;
        var idx = lines().indexOf(line);
        if (idx < 0) idx = state.sel;
        stopVoices();                              // 上一句残留语音先停，推进令牌
        var token = state.voiceSeq;
        applyLineStage(line, true);                // enter/exit 淡入淡出 + move 缓动 + cues 动作 + 背景
        switchBgm(bgmAt(idx), true);               // BGM 按区间一起播（编辑态需显式调用，syncBgm 只在 play 生效）
        syncSfx(idx);                              // 声效按句一起播
        cueRoles(line).forEach(function (r) {
            var cue = cueOf(line, r);
            if (cue.voice) playVoiceFor(r, cue.voice, token);
        });
        wbPreviewSync();                           // 立刻把演出结果镜像到小窗
        wbPlayheadSweep(line);                     // 播放头从句子头扫到句子尾
    }
    function wbPreviewTogglePlay() {
        wb.pvPlaying = !wb.pvPlaying;
        var pv = $('wb-preview');
        if (pv) pv.classList.toggle('is-playing', wb.pvPlaying);
        var line = lines()[state.sel];
        if (wb.pvPlaying) wbPreviewPerform(line);
        else {
            stopVoices();                          // 暂停时收声，避免角色还在说话
            stopBgm();                             // BGM 也一起停，不留残响
            wbPlayheadStop(); wbRenderPlayhead(0);  // 暂停：停扫并归位句子头
        }
        wbCaptionShow(line && line.text, false);
        msg(wb.pvPlaying ? '预览播放中（空格暂停）' : '预览已暂停');
    }

    /* ---- 撤销 / 重做：JSON 快照栈 ----------------------------------------
       场次数据不大（几 KB），整份快照最简单可靠。入栈只认「实质改动」：
       所有改数据的入口最终都会调 markStale()，由它触发 wbScheduleHistory()
       防抖提交一帧，连续输入合并成一条、纯点击/选中根本不碰历史。
       history[0] = 进入编辑时的初始态，history[n] = 第 n 次改动后的态。 */
    function wbSnapshot() {
        return JSON.stringify({ scene: state.scene, cast: state.cast, sel: state.sel });
    }
    function wbHistoryLabel(act) {
        var line = lines()[state.sel] || {};
        var t = String(line.text || '').replace(/\s+/g, ' ').slice(0, 10) || '空行';
        return '第' + (state.sel + 1) + '行 · ' + t;
    }
    /* 立即把当前状态提交为一帧历史（去重；丢弃 redo 分支）。
       act 是动作类型（新增/删除/重排/改动），随帧存进 histActions 供左栏显示。 */
    function wbPushHistory(act) {
        if (state.mode !== 'edit' || !state.scene || wb.histBatching) return;
        var snap = wbSnapshot();
        if (wb.histIdx >= 0 && wb.history[wb.histIdx] === snap) { wb.histDirty = false; return; }
        wb.history.length = wb.histIdx + 1;   // 丢弃 redo 分支
        wb.history.push(snap);
        wb.histLabels.length = wb.histIdx + 1;
        wb.histLabels.push(wbHistoryLabel(act));
        wb.histActions.length = wb.histIdx + 1;
        wb.histActions.push(act || wb.pendingAct || '改动');
        if (wb.history.length > 60) { wb.history.shift(); wb.histLabels.shift(); wb.histActions.shift(); }
        wb.histIdx = wb.history.length - 1;
        wb.histPreview = -1;
        wb.histDirty = false;
        wbUpdateHistButtons();
    }
    /* 改动发生后调度延迟提交：停止操作 350ms 才入栈，连续输入合并一帧。
       act 由 markStale 捕获（显式动作 or 一次性 pendingAct），存进这一帧。 */
    function wbScheduleHistory(act) {
        if (state.mode !== 'edit' || !state.scene || wb.histBatching) return;
        wb.histDirty = true;
        if (act && act !== '改动') wb.pendingAct = act;
        // 同一会话里出现更强的动作就升级本帧标签（改动 < 重排 < 新增/删除）
        var rank = { '改动': 0, '重排': 1, '新增': 2, '删除': 2 };
        if (rank[act] > (rank[wb.frameAct] || 0)) wb.frameAct = act;
        if (wb.histTimer) clearTimeout(wb.histTimer);
        wb.histTimer = setTimeout(function () {
            wb.histTimer = 0;
            var a = wb.frameAct || '改动'; wb.frameAct = '改动';
            wbPushHistory(a);
        }, 350);
    }
    /* 撤销/重做/跳历史前，把还没提交的改动先落帧，保证能一步撤回 */
    function wbFlushHistory() {
        if (wb.histTimer) { clearTimeout(wb.histTimer); wb.histTimer = 0; }
        if (wb.histDirty) wbPushHistory();
    }
    function wbUpdateHistButtons() {
        var u = $('wb-undo'), r = $('wb-redo');
        // 只要有历史帧就允许撤销：即便只有 1 帧，也可能有尚未入栈的当前改动可丢弃
        if (u) u.disabled = wb.histIdx < 0;
        if (r) r.disabled = wb.histIdx >= wb.history.length - 1;
        wbRenderHistory();
    }
    /* 左侧「改动历史」：每个快照一条，点一下回到那个状态（预览式撤回）。
       is-on = 当前所在帧；is-preview = 正在预览但还没落为当前帧。 */
    function wbRenderHistory() {
        var host = $('wb-hist-list'), cnt = $('wb-hist-count');
        if (!host) return;
        host.innerHTML = '';
        if (cnt) cnt.textContent = wb.history.length ? String(wb.histIdx + 1) + '/' + wb.history.length : '';
        if (!wb.history.length) {
            var e = document.createElement('div'); e.className = 'wb-hist-item';
            e.style.cursor = 'default'; e.textContent = '改动后在这里留痕';
            host.appendChild(e); return;
        }
        wb.history.forEach(function (snap, i) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'wb-hist-item' + (i === wb.histIdx ? ' is-on' : '')
                + (i === wb.histPreview && i !== wb.histIdx ? ' is-preview' : '');
            var idx = document.createElement('span'); idx.className = 'wb-hist-idx'; idx.textContent = String(i + 1);
            var act = document.createElement('span'); act.className = 'wb-hist-act';
            var actTxt = wb.histActions[i] || '改动';
            act.dataset.act = actTxt; act.textContent = actTxt;
            var lab = document.createElement('span'); lab.className = 'wb-hist-label';
            lab.textContent = wb.histLabels[i] || ('快照 ' + (i + 1));
            b.appendChild(idx); b.appendChild(act); b.appendChild(lab);
            b.title = actTxt + ' · 回到第 ' + (i + 1) + ' 个改动：' + lab.textContent;
            b.addEventListener('click', function () { wbGotoHistory(i); });
            host.appendChild(b);
        });
    }
    function wbGotoHistory(i) {
        if (i < 0 || i >= wb.history.length || wb.histBatching) return;
        wbFlushHistory();
        if (i >= wb.history.length) return;
        wb.histBatching = true;
        try {
            wbApplySnapshot(wb.history[i]);
            wb.histIdx = i; wb.histPreview = i;
            wbUpdateHistButtons();
            msg('已回到改动历史第 ' + (i + 1) + ' 步');
        } finally { wb.histBatching = false; }
    }
    function wbApplySnapshot(snap) {
        var obj = JSON.parse(snap);
        state.scene = obj.scene;
        state.cast = obj.cast;
        state.sel = Math.max(0, Math.min(obj.sel || 0, lines().length - 1));
        state.stale = true;
        // 站位基准跟着场景复位（不重开 wasm；只是把内存里的舞台数据对齐）
        state.baseStage = cloneStage(stageOf(state.scene, state.cast));
        state.stage = cloneStage(state.baseStage);
        syncLayout();
        renderEditor();
    }
    function wbUndo() {
        wbFlushHistory();   // 未提交的改动先落帧，才能一步撤回到改动前
        if (wb.histIdx <= 0) return;
        wb.histBatching = true;
        try { wb.histIdx--; wbApplySnapshot(wb.history[wb.histIdx]); }
        finally { wb.histBatching = false; }
        wb.histPreview = -1;
        wbUpdateHistButtons();
        msg('已撤销');
    }
    function wbRedo() {
        wbFlushHistory();
        if (wb.histIdx >= wb.history.length - 1) return;
        wb.histBatching = true;
        try { wb.histIdx++; wbApplySnapshot(wb.history[wb.histIdx]); }
        finally { wb.histBatching = false; }
        wb.histPreview = -1;
        wbUpdateHistButtons();
        msg('已重做');
    }

    /* ---- 剧本导航：编辑页是下拉，story 页编辑态仍是列表，两处都渲染 ---- */
    function wbRenderScenes() {
        var sel = $('wb-scene-select');
        if (sel) {
            var prev = sel.value;
            sel.innerHTML = '';
            state.scenes.forEach(function (s) {
                var o = document.createElement('option');
                o.value = s.file;
                o.textContent = (s.title || s.file) + '（' + s.file + '）';
                sel.appendChild(o);
            });
            sel.value = state.file || prev || (state.scenes[0] && state.scenes[0].file) || '';
        }
        // story 页编辑态沿用旧的列表结构（编辑页已无此元素）
        var list = $('wb-scene-list');
        if (list) {
            list.innerHTML = '';
            state.scenes.forEach(function (s) {
                var d = document.createElement('div');
                d.className = 'wb-nav-scene' + (s.file === state.file ? ' is-on' : '');
                d.dataset.file = s.file;
                var t = document.createElement('span');
                t.className = 'wb-nav-scene-title';
                t.textContent = s.title || s.file;
                d.appendChild(t);
                d.title = s.title + '\n' + s.file;
                d.addEventListener('click', function () { switchScene(s.file); });
                list.appendChild(d);
            });
        }
    }
    /* 新建剧本：弹名字 → PUT 一份最小合法场景 → 重新读清单并切过去 */
    async function wbNewScene() {
        var name = window.prompt('新剧本文件名（.json 结尾，中英文/数字/空格/连字符）：', '新剧本.json');
        if (!name) return;
        name = String(name).trim();
        if (!/\.json$/i.test(name)) name += '.json';
        if (state.scenes.some(function (s) { return s.file === name; })) { msg('剧本「' + name + '」已存在'); return; }
        var data = { title: name.replace(/\.json$/i, ''), background: '', lines: [{ role: firstRole(state.cast), text: '' }] };
        try {
            var r = await fetch('/api/story?name=' + encodeURIComponent(name), {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
            });
            var j = await r.json();
            if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
            wbSetUrlScene(name);
            await loadIndex();
            switchScene(name);
            msg('已新建剧本：' + name);
        } catch (e) { msg('新建失败：' + e.message); }
    }
    /* 删除剧本：二次确认 → DELETE → 重新读清单并切到第一个 */
    async function wbDeleteScene() {
        var file = state.file;
        if (!file) return;
        if (!window.confirm('确定删除剧本「' + file + '」？此操作不可撤销。')) return;
        try {
            var r = await fetch('/api/story?name=' + encodeURIComponent(file), { method: 'DELETE' });
            var j = await r.json();
            if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
            var next = state.scenes.filter(function (s) { return s.file !== file; })[0];
            var nextFile = next && next.file;
            wbSetUrlScene(nextFile || '');
            await loadIndex();
            if (nextFile) switchScene(nextFile);
            msg('已删除剧本：' + file);
        } catch (e) { msg('删除失败：' + e.message); }
    }

    /* ---- 实时预览：把全屏主画布镜像到小窗，缩放只作用于内层 transform ---- */
    /* 把主画布等比 contain 画进 16:9 镜像缓冲：只 clearRect（防透明底叠影），
       绝不填不透明底——镜像 canvas 是透明的，后面的 .wb-preview-bg 才能透出背景图。
       再按 min(缩放比) 居中绘制，绝不拉伸变形。 */
    function wbMirrorDraw() {
        var canvas = $('canvas'), mirror = $('wb-preview-canvas');
        if (!canvas || !mirror) return;
        var ctx = mirror.getContext('2d');
        if (!ctx) return;
        var W = mirror.width, H = mirror.height;
        ctx.clearRect(0, 0, W, H);
        var s = Math.min(W / Math.max(1, canvas.width), H / Math.max(1, canvas.height));
        var dw = canvas.width * s, dh = canvas.height * s;
        var dx = (W - dw) / 2, dy = (H - dh) / 2;
        try { ctx.drawImage(canvas, dx, dy, dw, dh); } catch (_) {}
    }
    function wbPreviewSync() {
        var canvas = $('canvas'), mirror = $('wb-preview-canvas');
        var bg = $('wb-preview-bg'), hint = $('wb-preview-hint');
        if (!canvas || !mirror) return;
        var line = lines()[state.sel];
        if (hint) hint.hidden = !!line;
        // 场景/行背景映射到预览底层（沿用 bgSrc 的解析逻辑）
        var bgName = bgOfLine(line);
        if (bg) bg.style.backgroundImage = bgName ? ('url("' + bgSrc(bgName) + '")') : 'none';
        var lineLabel = line
            ? ('第 ' + (state.sel + 1) + ' 句 · ' + (line.role ? castName(line.role) : '旁白')) : '—';
        var title = $('wb-preview-line'), titleSub = $('wb-preview-line-sub');
        if (title) title.textContent = lineLabel;
        if (titleSub) titleSub.textContent = lineLabel;
        // 点台词即时预览：字幕立刻跟上当前句，说话者同步
        var cn = $('wb-pv-cap-name');
        if (cn) cn.textContent = line ? (line.role ? castName(line.role) : '旁白') : '';
        wbCaptionShow(line && line.text, !wb.pvPlaying);
        // 预览监视器固定 16:9（960×540），不跟随浏览器窗口比例——
        // 主画布是全屏尺寸（比例随窗口变），若镜像也跟着变就不是等比监视器了。
        if (mirror.width !== 960 || mirror.height !== 540) { mirror.width = 960; mirror.height = 540; }
        if (wb.pvRaf) return;
        wb.pvRaf = requestAnimationFrame(function () {
            wb.pvRaf = 0;
            if (state.mode !== 'edit') return;
            wbMirrorDraw();   // 含清屏 + 等比 contain，避免叠影和拉伸
            if (state.mode === 'edit') wb.pvRaf = requestAnimationFrame(function () { wb.pvRaf = 0; wbPreviewSyncPump(); });
        });
    }
    // drawImage 循环单独抽出来，避免每次 setState 都重排 rAF
    function wbPreviewSyncPump() {
        var canvas = $('canvas'), mirror = $('wb-preview-canvas');
        if (!canvas || !mirror || state.mode !== 'edit') { wb.pvRaf = 0; return; }
        wbMirrorDraw();   // 同 wbPreviewSync：清屏 + 等比 contain
        wb.pvRaf = requestAnimationFrame(wbPreviewSyncPump);
    }
    /* 预览框：默认「适应」＝按镜像画布宽高比等比缩放到刚好装进 viewport，完整画面不裁切。
       zoom 是在这个基准上再放大；放大后 viewport 出滚动条可拖看四周。 */
    function wbPreviewApplyZoom() {
        var inner = $('wb-preview-inner'), vp = $('wb-preview-viewport'), mirror = $('wb-preview-canvas');
        if (!inner || !vp) return;
        var bw = (mirror && mirror.width) || 960, bh = (mirror && mirror.height) || 540;
        var vw = Math.max(1, vp.clientWidth - 4), vh = Math.max(1, vp.clientHeight - 4);
        var fit = Math.min(vw / bw, vh / bh);
        var k = fit * wb.previewZoom;
        inner.style.width = Math.max(1, Math.round(bw * k)) + 'px';
        inner.style.height = Math.max(1, Math.round(bh * k)) + 'px';
        var lab = $('wb-pv-level');
        if (lab) lab.textContent = Math.abs(wb.previewZoom - 1) < 1e-6 ? '适应' : Math.round(wb.previewZoom * 100) + '%';
    }

    /* ---- 时间轴：按句铺开，多轨对齐 ---- */
    var WB_LANES = [
        { key: 'text',  name: '台词',   color: '#63d6c4' },
        { key: 'bg',    name: '背景',   color: '#8fd3e8' },
        { key: 'bgm',   name: '背景乐', color: '#e2a45f' },
        { key: 'sfx',   name: '声效',   color: '#bda7ec' },
        { key: 'voice', name: '语音',   color: '#e9b96e' },
        { key: 'stage', name: '立绘',   color: '#63d6c4' },
        { key: 'cam',   name: '运镜',   color: '#8aa29d' },
        { key: 'fx',    name: '特效',   color: '#8aa29d' }
    ];
    function wbSfxList() {
        var a = state.scene && state.scene.sfx;
        return Array.isArray(a) ? a : [];
    }
    function wbRenderTimeline() {
        var scroll = $('wb-tl-scroll'), inner = $('wb-tl-inner');
        var ruler = $('wb-tl-ruler'), lanes = $('wb-tl-lanes'), cells = $('wb-tl-cells');
        if (!scroll || !inner) return;
        scroll.style.setProperty('--tl-tick', wb.tick + 'px');
        var n = lines().length;
        var width = Math.max(n * wb.tick, 600);

        // 标尺
        ruler.innerHTML = '';
        var rl = document.createElement('div'); rl.className = 'wb-tl-ruler-label'; rl.textContent = '轨道 / 句';
        ruler.appendChild(rl);
        var track = document.createElement('div'); track.className = 'wb-tl-ruler-track';
        for (var i = 0; i < n; i++) {
            var tk = document.createElement('div');
            tk.className = 'wb-tl-tick' + (i === state.sel ? ' is-sel' : '');
            tk.textContent = String(i + 1);
            tk.dataset.i = String(i);
            track.appendChild(tk);
        }
        ruler.appendChild(track);

        // 轨道名（左侧固定）
        lanes.innerHTML = '';
        WB_LANES.forEach(function (lane, li) {
            var lab = document.createElement('div'); lab.className = 'wb-tl-lane-label';
            var dot = document.createElement('span'); dot.className = 'wb-tl-lane-dot';
            dot.style.background = lane.color;
            var nm = document.createElement('span'); nm.textContent = lane.name;
            lab.appendChild(dot); lab.appendChild(nm);
            lab.style.height = '38px';
            // 轨道名可上下拖动排序，顺序存 localStorage，重载后保持
            lab.draggable = true; lab.dataset.laneIdx = String(li);
            lab.title = '拖动调整轨道顺序（顺序会被记住）';
            lab.addEventListener('dragstart', function (evt) {
                wb.dragLane = li; evt.dataTransfer.effectAllowed = 'move';
                evt.dataTransfer.setData('text/plain', 'lane:' + li);
                lab.classList.add('is-drag');
            });
            lab.addEventListener('dragend', function () { wb.dragLane = -1; lab.classList.remove('is-drag'); });
            lab.addEventListener('dragover', function (evt) {
                if (wb.dragLane < 0) return;
                evt.preventDefault(); evt.dataTransfer.dropEffect = 'move';
            });
            lab.addEventListener('drop', function (evt) {
                if (wb.dragLane < 0) return;
                evt.preventDefault();
                var from = wb.dragLane, to = li; wb.dragLane = -1;
                if (from === to) return;
                var moved = WB_LANES.splice(from, 1)[0];
                WB_LANES.splice(to, 0, moved);
                wbSaveLaneOrder();
                wbRenderTimeline();
                msg('轨道顺序已调整并记住');
            });
            lanes.appendChild(lab);
        });

        // 格子层（重绘会丢弃旧 DOM，框选引用一并作废）
        if (wb.multiSel && wb.multiSel.length) wb.multiSel = [];
        cells.innerHTML = '';
        cells.style.width = width + 'px';
        WB_LANES.forEach(function (lane, laneIdx) {
            var row = document.createElement('div');
            row.className = 'wb-tl-lane'; row.style.width = width + 'px';
            row.dataset.lane = lane.key;
            // 拖卡片到对应轨道落段：BGM→背景乐轨，声效→声效轨，背景→背景轨，语音→语音轨
            if (lane.key === 'bgm' || lane.key === 'sfx' || lane.key === 'bg' || lane.key === 'voice') {
                var want = lane.key === 'bgm' ? BGM_MIME
                    : lane.key === 'sfx' ? SFX_MIME
                    : lane.key === 'voice' ? VOICE_MIME : BG_MIME;
                row.addEventListener('dragover', function (evt) {
                    if (Array.prototype.indexOf.call(evt.dataTransfer.types, want) < 0) return;
                    evt.preventDefault(); evt.dataTransfer.dropEffect = 'copy';
                    row.classList.add('is-drop');
                });
                row.addEventListener('dragleave', function () { row.classList.remove('is-drop'); });
                row.addEventListener('drop', function (evt) {
                    row.classList.remove('is-drop');
                    if (Array.prototype.indexOf.call(evt.dataTransfer.types, want) < 0) return;
                    evt.preventDefault();
                    var file = evt.dataTransfer.getData(want);
                    if (!file) return;
                    var rect = row.getBoundingClientRect();
                    var at = Math.max(1, Math.min(n, Math.floor((evt.clientX - rect.left) / wb.tick) + 1));
                    // addBgmAt 接收 0-based 行号（内部 n=row+1），声效/背景的 at 是 1-based。
                    // 这里必须传 at-1，否则拖到第2格会落到第3格（竖轨 drop 传的 rowAtY 本来就是 0-based）。
                    if (lane.key === 'bgm') addBgmAt(file, at - 1);
                    else if (lane.key === 'bg') {
                        // 背景写入的唯一入口：只改行级 background，剧本行那里只做只读预览。
                        // 图库来源由 BG_MIME 保证（外部文件拖不进来）
                        var line = lines()[at - 1];
                        if (line && (state.bg || []).indexOf(file) >= 0) {
                            line.background = file;
                            markStale('新增');
                            msg('第 ' + at + ' 句背景已设为 ' + baseName(file));
                        }
                    }
                    else if (lane.key === 'voice') addVoiceAt(file, at);
                    else addSfxAt(file, at);
                });
            }
            for (var g = 0; g <= n; g++) {
                var gl = document.createElement('div'); gl.className = 'wb-tl-gridline';
                gl.style.left = (g * wb.tick) + 'px'; row.appendChild(gl);
            }
            cells.appendChild(row);
        });

        // 轨道 key → DOM 行（语音轨加入后不能再用硬编码索引）
        var rowByKey = {};
        [].forEach.call(cells.children, function (r) { rowByKey[r.dataset.lane] = r; });

        /* 通用段手势：拖整段平移(move) / 拖左右边缘改长度(resize)。
           commit(nf,nt) 由调用方写回数据；句号 1-based、含端点。 */
        function bindSpan(c, from, to, commit, opt) {
            opt = opt || {};
            var mode = '', sx = 0, f0 = from, t0 = to, moved = false;
            var baseLeft = 0, baseWidth = 0;
            var previewEls = [];   // 预览期被临时挪动的块 [{el,left,width}]
            var group = null;      // 框选整组拖动：其它被选中块的快照
            function begin(e, m) {
                if (e.button !== 0) return;
                e.preventDefault(); e.stopPropagation();
                mode = m; sx = e.clientX; f0 = from; t0 = to; moved = false;
                baseLeft = parseFloat(c.style.left) || 0;
                baseWidth = parseFloat(c.style.width) || 0;
                group = null;
                // 整组拖动：抓的不是 resize 手柄、且这块在框选集合里 → 其余选中块跟同一 dx 走
                if (m === 'move' && wb.multiSel && wb.multiSel.length > 1
                    && wb.multiSel.indexOf(c) >= 0) {
                    group = wb.multiSel.filter(function (x) { return x !== c && x._wbCell && x.parentNode; })
                        .map(function (x) {
                            return { el: x, meta: x._wbCell,
                                left: parseFloat(x.style.left) || 0,
                                width: parseFloat(x.style.width) || 0 };
                        });
                    group.forEach(function (g) { g.el.classList.add('is-dragging'); });
                }
                c.classList.add(m === 'move' ? 'is-dragging' : 'is-resizing');
                document.addEventListener('pointermove', move);
                document.addEventListener('pointerup', up);
                document.addEventListener('pointercancel', up);
            }
            // 跟手拖动时高亮「与拖动块有任何重叠」的另一段，提示松手将与它交换。
            // 判定用整块区间 [nf,nt] 相交，而不是段首单点：
            // 长条拖到短条上、或短条压到长条中间，都应立刻高亮，不必等左边第一格对齐。
            function markTarget(f, t) {
                var row = c.parentNode, hit = null;
                [].forEach.call(row.children, function (x) {
                    if (x === c || !x.classList || !x.classList.contains('wb-tl-cell')) return;
                    var xf = Number(x.dataset.i) + 1, xt = Number(x.dataset.to) || xf;
                    var on = f <= xt && t >= xf;
                    x.classList.toggle('is-swap-target', on);
                    if (on && !hit) hit = { el: x, f: xf, t: xt };
                });
                return hit;
            }
            function clearTarget() {
                [].forEach.call(c.parentNode.children, function (x) {
                    if (x.classList) x.classList.remove('is-swap-target');
                });
            }
            /* 预渲染：未松手就把「如果现在放下会变成的布局」画出来（像手机拖图标）。
               只改 DOM 样式，绝不碰真实数据/commit 区间；松手或取消时全部还原。
               move＝与被压住的块交换位置（把目标块挪到拖动块的原格位）；
               resize＝伸长推着同侧所有邻块整体平移（长度不变）、缩短则留空。 */
            function previewLayout(nf, nt, hit) {
                [].forEach.call(previewEls, function (p) {
                    p.el.style.left = p.left; p.el.style.width = p.width;
                    p.el.classList.remove('is-preview');
                });
                previewEls = [];
                var tick = wb.tick || 1;
                function mark(el) {
                    previewEls.push({ el: el, left: el.style.left, width: el.style.width });
                    el.classList.add('is-preview');
                }
                function place(el, f, t) {
                    mark(el);
                    el.style.left = ((f - 1) * tick + 2) + 'px';
                    el.style.width = Math.max(16, (t - f + 1) * tick - 4) + 'px';
                }
                if (mode === 'move' && hit) {
                    // 目标块移到拖动块原来的位置（交换的另一半）；拖动块本身继续像素跟手
                    place(hit.el, f0, t0);
                } else if (mode !== 'move') {
                    // ripple 预览与数据层用同一算法 rippleShift：
                    // 伸出的格先填紧邻空格，只有盖到真实块才推着它整体平移；缩短则留空。
                    // 用本行现有滑块当作「占用区间」传给 occupied，避免预览与落数据不一致。
                    var segs = [], kids = [].slice.call(c.parentNode.children).filter(function (x) {
                        return x !== c && x.classList && x.classList.contains('wb-tl-cell');
                    });
                    kids.forEach(function (x) {
                        var xf = Number(x.dataset.i) + 1, xt = Number(x.dataset.to) || xf;
                        segs.push({ from: xf, to: xt, el: x });
                    });
                    var occ = function (k) {
                        for (var q = 0; q < segs.length; q++) {
                            if (segs[q].from <= k && k <= segs[q].to) return true;
                        }
                        return false;
                    };
                    var sh = window.TimelineCore.rippleShift(segs, f0, t0, nf, nt, occ);
                    var shift = mode === 'r' ? sh.dR : sh.dL;
                    if (shift > 0) {
                        kids.forEach(function (x) {
                            var xf = Number(x.dataset.i) + 1, xt = Number(x.dataset.to) || xf;
                            if (mode === 'r' && xf > t0) place(x, xf + shift, xt + shift);
                            else if (mode === 'l' && xt < f0) place(x, xf - shift, xt - shift);
                        });
                    }
                }
            }
            function clearPreview() {
                [].forEach.call(previewEls, function (p) {
                    p.el.style.left = p.left; p.el.style.width = p.width;
                    p.el.classList.remove('is-preview');
                });
                previewEls = [];
            }
            function move(e) {
                var dx = e.clientX - sx;
                var d = Math.round(dx / wb.tick);
                var nf = f0, nt = t0;
                if (mode === 'move') {
                    nf = Math.max(1, Math.min(n - (t0 - f0), f0 + d)); nt = nf + (t0 - f0);
                } else if (mode === 'l') {
                    nf = Math.max(1, Math.min(t0, f0 + d)); nt = t0;
                } else {
                    // 句数固定：右拉最多到末尾，越界的内容丢弃，不自动增句
                    nf = f0; nt = Math.max(f0, Math.min(n, t0 + d));
                }
                if (nf !== f0 || nt !== t0) moved = true;
                c._nf = nf; c._nt = nt;
                if (mode === 'move') {
                    // 像素级跟手：块始终贴着鼠标，松手才吸附到整句（像桌面 app / Vegas）
                    c.style.left = (baseLeft + dx) + 'px';
                    c.style.width = baseWidth + 'px';
                    if (group) {
                        // 框选组：所有选中块按相同像素位移跟手，整组统一钳制到 [1,n]
                        var shift = nf - f0;
                        group.forEach(function (g) {
                            var gf = g.meta.from + shift, gt = g.meta.to + shift;
                            gf = Math.max(1, Math.min(n - (g.meta.to - g.meta.from), gf));
                            gt = gf + (g.meta.to - g.meta.from);
                            g.styleShift = gf - g.meta.from;
                            g.el.style.left = (g.left + g.styleShift * wb.tick) + 'px';
                        });
                    }
                    var hit = markTarget(nf, nt);
                    previewLayout(nf, nt, hit);
                } else {
                    c.style.left = ((nf - 1) * wb.tick + 2) + 'px';
                    c.style.width = Math.max(16, (nt - nf + 1) * wb.tick - 4) + 'px';
                    previewLayout(nf, nt, null);
                }
            }
            function up() {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', up);
                document.removeEventListener('pointercancel', up);
                c.classList.remove('is-dragging', 'is-resizing');
                if (group) group.forEach(function (g) {
                    g.el.classList.remove('is-dragging');
                    g.el.style.left = g.left + 'px'; g.el.style.width = g.width + 'px';
                });
                clearTarget();
                clearPreview();
                if (!moved) {
                    c.style.left = baseLeft + 'px'; c.style.width = baseWidth + 'px';
                    group = null;
                    return;
                }
                c.style.left = baseLeft + 'px'; c.style.width = baseWidth + 'px';
                // 把手势模式交给调用方：move＝整段交换，l/r＝拖边缘挤开让位
                if (commit) commit(c._nf, c._nt, mode);
                // 框选组：其余选中块各按自己的位移量提交一次（用它们各自的 commit）
                if (group) {
                    group.forEach(function (g) {
                        if (!g.styleShift || !g.meta || !g.meta.commit) return;
                        g.meta.commit(g.meta.from + g.styleShift, g.meta.to + g.styleShift, 'move');
                    });
                    msg('已一起移动 ' + (group.length + 1) + ' 个滑块');
                    wbClearMultiSel();
                }
                group = null;
            }
            // 整段拖动（台词/立绘/声效方块）
            if (opt.move) c.addEventListener('pointerdown', function (e) {
                if (e.target.classList.contains('wb-tl-handle')) return;
                begin(e, 'move');
            });
            // 左右长度手柄（背景/BGM/声效/语音/立绘段）
            if (opt.resize) {
                ['l', 'r'].forEach(function (side) {
                    var h = document.createElement('div');
                    h.className = 'wb-tl-handle wb-tl-handle--' + side;
                    h.addEventListener('pointerdown', function (e) { begin(e, side); });
                    c.appendChild(h);
                });
            }
            // 拖动后别再当成点击定位
            c.addEventListener('click', function (e) {
                if (moved) { moved = false; e.stopPropagation(); return; }
                if (opt.onClick) opt.onClick(e);
            }, true);
        }

        function putCell(laneKey, from, to, cls, text, title, opt) {
            var row = rowByKey[laneKey];
            if (!row) return;
            var c = document.createElement('div');
            c.className = 'wb-tl-cell ' + cls + (from - 1 <= state.sel && state.sel <= to - 1 ? ' is-sel' : '');
            c.style.left = ((from - 1) * wb.tick + 2) + 'px';
            c.style.width = Math.max(16, (to - from + 1) * wb.tick - 4) + 'px';
            var nm = document.createElement('span'); nm.className = 'wb-tl-cell-name'; nm.textContent = text;
            c.appendChild(nm);
            c.title = title || text;
            c.dataset.i = String(Math.max(0, from - 1));
            c.dataset.to = String(to);   // 跟手拖动时用来高亮落点段
            opt = opt || {};
            // 段选中：点任意演出段（背景/BGM/声效/语音/立绘）记为当前段，供 Backspace 删除
            var seg = opt.del ? { lane: laneKey, from: from, to: to, del: opt.del } : null;
            if (seg) {
                c.classList.add('wb-tl-cell--seg');
                c.dataset.segLane = laneKey;
                var isSel = function () { return wb.selSeg && wb.selSeg.lane === laneKey
                    && wb.selSeg.from === from && wb.selSeg.to === to; };
                if (isSel()) c.classList.add('is-seg-sel');
                c._refreshSegSel = function () { c.classList.toggle('is-seg-sel', !!isSel()); };
            }
            if (opt.onClick !== false) opt.onClick = opt.onClick || function (e) {
                if (seg) wbSelectSeg(seg); else wbClearSegSel();   // 点台词格＝取消段选中
                /* 播放起点＝被点的那一格，不是块的头。跨多格的段（立绘/BGM/背景）
                   是一个 DOM 块，点第 2 格就要从第 2 句播放，而不是跳回段首。
                   用 clientX 相对块左缘、按 tick 反算格号，再钳制回 [from,to]。 */
                var hit = from;
                if (e && typeof e.clientX === 'number') {
                    var rect = c.getBoundingClientRect();
                    var tick = wb.tick || 1;
                    hit = from + Math.floor((e.clientX - rect.left) / tick);
                    if (hit < from) hit = from;
                    if (hit > to) hit = to;
                }
                selectLine(Math.max(0, hit - 1)); wbFocus();
            };
            bindSpan(c, from, to, opt.commit, opt);
            // 框选整组拖动用：每块记住自己的区间与提交函数（重绘后随 DOM 一起重建）
            c._wbCell = { from: from, to: to, commit: opt.commit, opt: opt, lane: laneKey };
            if (wb.multiSel && wb.multiSel.indexOf(c) >= 0) c.classList.add('is-multi-sel');
            row.appendChild(c);
        }

        // 把连续若干句里「取同一值」的句子合并成一段（算法在 TimelineCore 纯函数模块）
        function runsOf(getter) {
            return window.TimelineCore.runsOf(lines(), getter);
        }
        // 台词轨：每句一格，与其它轨同一套 pointer 整段交换手势（拖动预渲染、松手落数据）
        lines().forEach(function (line, i) {
            var txt = (line.text || '').replace(/\s+/g, ' ').slice(0, 12) || '（空）';
            var who = line.role ? castName(line.role) : '旁白';
            putCell('text', i + 1, i + 1, 'wb-tl-cell--text', who + '：' + txt,
                '第 ' + (i + 1) + ' 句（拖到别的台词格＝两行交换，拖动时预览、松手生效）',
                { move: true, commit: function (f, t, mode) {
                    if (mode === 'move') { dropLine(i, f - 1); msg('台词已重排'); }
                },
                  del: function () { delLine(i); } });
        });
        // 背景轨：每句的有效背景（行内覆盖场景默认），连续相同合成一段；左右拖改长度
        runsOf(function (line) { return bgOfLine(line); }).forEach(function (seg) {
            putCell('bg', seg.from, seg.to, 'wb-tl-cell--bg', baseName(seg.key),
                '背景 ' + seg.key + ' 第 ' + seg.from + '–' + seg.to + ' 句（拖整段与别的背景段交换，拖两端改长度）',
                { move: true, resize: true, commit: function (f, t, mode) {
                    if (mode === 'move') wbSwapBackground(seg.from, seg.to, f, t);
                    else wbResizeBackground(seg.key, f, t, seg.from, seg.to, mode);
                },
                  // 显式写空串而不是 delete：否则场景默认背景会让段原地复活，Backspace 像没删掉
                  del: function () { wbSetRunField('background', '', seg.from, seg.to); } });
        });
        // BGM 轨：整段可左右平移，两侧手柄改长度；与其它轨一样挤开相邻段
        bgmList().forEach(function (b, bi) {
            var r = bgmRange(b);
            putCell('bgm', r[0], r[1], 'wb-tl-cell--bgm', baseName(b.file),
                'BGM ' + b.file + ' 第 ' + r[0] + '–' + r[1] + ' 句（拖整段与别的 BGM 段交换，拖两端改长度让位）',
                { move: true, resize: true, commit: function (f, t, mode) {
                    wbRippleBgm(bi, r[0], r[1], f, t, mode);
                }, del: function () { delBgm(bi); } });
        });
        // 声效轨：一个声效一个方块，可左右拖动改触发句；长度手柄延长持续句
        wbSfxList().forEach(function (s, si) {
            var at = Math.max(1, Math.min(n, Number(s.at) || 1));
            var to = Math.max(at, Math.min(n, Number(s.to) || at));
            putCell('sfx', at, to, 'wb-tl-cell--sfx', '♪ ' + baseName(s.file),
                '声效 ' + s.file + ' 第 ' + at + (to > at ? '–' + to : '') + ' 句（拖整段与别的声效交换，拖两端改长度）',
                { move: true, resize: true, commit: function (f, t, mode) {
                    if (mode === 'move') wbSwapSfx(si, at, to, f, t);
                    else wbStretchSfx(si, at, to, f, t, mode);
                }, del: function () {
                    var j = (state.scene.sfx || []).indexOf(s);
                    if (j >= 0) state.scene.sfx.splice(j, 1);
                    markStale(); refreshAfterTimelineEdit();
                } });
        });
        // 语音轨：说话者行级 voice 或登台角色 cue.voice；连续相同合成一段
        runsOf(function (line) {
            var v = line.voice || '';
            if (!v && Array.isArray(line.cues)) {
                for (var k = 0; k < line.cues.length; k++) {
                    if (line.cues[k].voice) { v = line.cues[k].voice; break; }
                }
            }
            return v;
        }).forEach(function (seg) {
            putCell('voice', seg.from, seg.to, 'wb-tl-cell--voice', '▸ ' + baseName(seg.key),
                '语音 ' + seg.key + ' 第 ' + seg.from + '–' + seg.to + ' 句（拖整段与别的语音段交换，拖两端改长度）',
                { move: true, resize: true, commit: function (f, t, mode) {
                    if (mode === 'move') wbSwapVoice(seg.from, seg.to, f, t);
                    else wbResizeVoice(seg.key, f, t, seg.from, seg.to, mode);
                },
                  del: function () {
                      wbClearRunField('voice', seg.from, seg.to);
                      // cues 里的角色语音也要清掉
                      var ls = lines();
                      for (var i = seg.from - 1; i <= seg.to - 1 && i < ls.length; i++) {
                          var cs = ls[i] && ls[i].cues;
                          if (!cs) continue;
                          Object.keys(cs).forEach(function (r) { if (cs[r] && typeof cs[r] === 'object') delete cs[r].voice; });
                      }
                      markStale(); refreshAfterTimelineEdit();
                  } });
        });
        /* 立绘轨分段键 = 在台阵容 + 本句动作签名。
           在台阵容沿用 resetStage 语义（写过 enter 的角色开场先隐藏，到 enter 那句才上，
           之后一直在台直到 exit），保证「登场句 + 后面静态延续」合并成一格。
           动作签名取 cues.action / move；没写动作的句子继承上一句的动作签名（状态延续），
           于是第 1 句 enter、第 2 句无动作仍合并，但第 3 句「吃惊」→第 4 句「困扰」
           这种真正的动作变化会断成两格——这是按纯阵容分段漏掉的信息。
           空阵容（无人在台）不画格。 */
        function wbStageKeys() {
            var roles = stageOf(state.scene, state.cast).map(function (s) { return s.role; });
            return window.TimelineCore.stageKeysOf(lines(), roles);
        }
        var stageKeys = wbStageKeys();
        runsOf(function (line, i) { return stageKeys[i].key; }).forEach(function (seg) {
            var info = stageKeys[seg.idx];
            // 段名带上动作摘要（如「红莉栖+铃羽 · 困扰」），一眼看出动作变化
            var acts = info.act ? info.act.split('/').map(function (x) {
                return x.slice(x.indexOf(':') + 1);
            }).filter(function (v, k, a) { return a.indexOf(v) === k; }) : [];
            var label = info.roster + (acts.length ? ' · ' + acts.join('/') : '');
            putCell('stage', seg.from, seg.to, 'wb-tl-cell--stage', label,
                '在台 [' + info.roster + '] 动作 [' + info.act + '] 第 ' + seg.from + '–' + seg.to + ' 句（拖整段与其它动作段交换；拖两端＝伸长推着邻块走、缩短则留空）',
                { move: true, resize: true, commit: function (f, t, mode) {
                    var bounds = null;
                    if (mode === 'move') bounds = function (x) {
                        var key = stageKeys[x - 1] && stageKeys[x - 1].key;
                        if (key == null) return null;
                        var a = x, b = x;
                        while (a > 1 && stageKeys[a - 2] && stageKeys[a - 2].key === key) a--;
                        while (b < stageKeys.length && stageKeys[b] && stageKeys[b].key === key) b++;
                        return [a, b];
                    };
                    wbResizeStage(seg.idx, f, t, seg.from, seg.to, mode, bounds, stageKeys);
                },
                  del: function () { wbClearStageSeg(seg.from, seg.to); } });
        });
        // 运镜 / 特效轨：预留（当前数据无字段，显示占位说明于标题）
        var camLi = -1, fxLi = -1;
        WB_LANES.forEach(function (l, k) { if (l.key === 'cam') camLi = k; if (l.key === 'fx') fxLi = k; });
        if (lanes.children[camLi]) lanes.children[camLi].title = '运镜（暂未启用）';
        if (lanes.children[fxLi]) lanes.children[fxLi].title = '特效（暂未启用）';

        // 时间轴重绘会清空 cells.innerHTML，把框选框挂回去（绑定只做一次）
        if (cells._band && cells._band.parentNode !== cells) cells.appendChild(cells._band);
        inner.style.width = (104 + width) + 'px';
        inner.style.height = (26 + WB_LANES.length * 38) + 'px';
        wbRenderPlayhead();
        var lab = $('wb-tl-zoom-label');
        if (lab) lab.textContent = Math.round(wb.tick / 96 * 100) + '%';
    }
    /* 框选多个滑块：在轨道空白区按住左键拖出选框，框住的所有滑块高亮；
       之后按住其中任意一个拖动，整组按相同位移一起移动、松手各自提交。
       Esc / 单击空白取消。选框只做视觉，不改数据。 */
    function wbClearMultiSel() {
        if (!wb.multiSel || !wb.multiSel.length) return;
        wb.multiSel.forEach(function (c) { c.classList.remove('is-multi-sel'); });
        wb.multiSel = [];
    }
    function wbBindMultiSelect() {
        var cells = $('wb-tl-cells');
        if (!cells || cells._multiBound) return;
        cells._multiBound = true;
        var band = document.createElement('div');
        band.className = 'wb-tl-band'; band.hidden = true;
        cells._band = band;
        cells.appendChild(band);
        var active = false, x0 = 0, y0 = 0, dragged = false;
        cells.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 || e.target.closest('.wb-tl-cell')) return;
            var r = cells.getBoundingClientRect();
            active = true; dragged = false;
            x0 = e.clientX - r.left; y0 = e.clientY - r.top;
            band.hidden = false;
            band.style.left = x0 + 'px'; band.style.top = y0 + 'px';
            band.style.width = '0px'; band.style.height = '0px';
        });
        document.addEventListener('pointermove', function (e) {
            if (!active) return;
            var r = cells.getBoundingClientRect();
            var x1 = Math.max(0, Math.min(r.width, e.clientX - r.left));
            var y1 = Math.max(0, Math.min(r.height, e.clientY - r.top));
            var l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
            if (w > 3 || h > 3) dragged = true;
            band.style.left = l + 'px'; band.style.top = t + 'px';
            band.style.width = w + 'px'; band.style.height = h + 'px';
            var bl = r.left + l, bt = r.top + t, br = r.left + l + w, bb = r.top + t + h;
            [].forEach.call(cells.querySelectorAll('.wb-tl-cell'), function (c) {
                var cr = c.getBoundingClientRect();
                c.classList.toggle('is-multi-sel',
                    cr.right > bl && cr.left < br && cr.bottom > bt && cr.top < bb);
            });
        });
        document.addEventListener('pointerup', function () {
            if (!active) return;
            active = false; band.hidden = true;
            if (!dragged) { wbClearMultiSel(); return; }   // 单击空白＝取消框选
            wb.multiSel = [].slice.call(cells.querySelectorAll('.wb-tl-cell.is-multi-sel'));
            if (wb.multiSel.length > 1) msg('已框选 ' + wb.multiSel.length + ' 个滑块（按住其中一个一起拖，Esc 取消）');
            else wbClearMultiSel();   // 只框到 0/1 个不形成组
        });
    }

    /* 段长度写回：把 [f..t] 内每行设为 value，范围外若原本等于 value 则清掉。
       用于背景 / 语音这类「逐行字段」，拖动时间轴手柄后仍与播放逻辑一致。 */
    function wbSetRunField(field, value, f, t) {
        var ls = lines();
        for (var i = 0; i < ls.length; i++) {
            var inRange = (i + 1 >= f && i + 1 <= t);
            if (inRange) ls[i][field] = value;
            else if (ls[i][field] === value) delete ls[i][field];
        }
        markStale(); refreshAfterTimelineEdit();
    }
    /* 时间轴段「挤开」写回：拖手柄改长度时，把被侵占方向的相邻行整体平移让位，
       相邻段保持自己的长度、首尾相接、不重叠，而不是被吃掉变短。
       时间轴横轴＝台词行，行数固定，所以被挤出末尾的内容会丢弃（可撤销恢复）。
       getVal/setVal 抽象单个句子的读写：背景/语音是单字段，立绘是一组动作字段。 */
    function wbRippleRun(oldF, oldT, f, t, getVal, setVal) {
        var n = lines().length, i;
        var snap = [];
        for (i = 1; i <= n; i++) snap.push(getVal(i));   // 1-based
        // 挤开算法在 TimelineCore 纯函数模块；这里只负责取值与写回
        var out = window.TimelineCore.ripple(snap, oldF, oldT, f, t);
        for (i = 0; i < n; i++) setVal(i + 1, out[i]);
        markStale(); refreshAfterTimelineEdit();
    }
    /* 整段「交换」写回：拖整段到另一段上时，两段各自完整搬到对方原来的区间
       （块长跟着对方走），不切分块、不推挤无关段。drag 边缘改长度仍走上面的挤开。
       bounds(f) 让立绘动作这种「对象值」也能准确找到目标段的完整边界。 */
    function wbSwapRun(oldF, oldT, f, t, getVal, setVal, bounds) {
        var n = lines().length, i;
        var snap = [];
        for (i = 1; i <= n; i++) snap.push(getVal(i));
        var out = window.TimelineCore.swap(snap, oldF, oldT, f, t, bounds);
        for (i = 0; i < n; i++) setVal(i + 1, out[i]);
        markStale(); refreshAfterTimelineEdit();
    }
    /* 句数固定：拉长越界的内容丢弃，不再自动补行。保留此入口仅为兼容调用点。 */
    function wbEnsureLines() { return lines().length; }
    /* 拖手柄改长度的通用写回：
       右拉＝后续内容整体右推、末尾不够自动增句；左收＝让出的句子留空、别的块不补位。
       块本身精确覆盖 [f,t]，来回拖不会累积变长。 */
    function wbStretchRun(oldF, oldT, f, t, getVal, setVal) {
        var n = lines().length, i;
        var snap = [];
        for (i = 1; i <= n; i++) snap.push(getVal(i));
        var out = window.TimelineCore.stretch(snap, oldF, oldT, f, t);
        wbEnsureLines(out.length);
        for (i = 0; i < out.length; i++) setVal(i + 1, out[i]);
        markStale(); refreshAfterTimelineEdit();
    }
    /* 改长度（ripple）：拖一块的边界，邻块保持原长度整体被推走（伸长）
       或原位不动（缩短留空）。getVal 返回逐句值当段键。 */
    function wbStretchRun(oldF, oldT, f, t, getVal, setVal) {
        var n = lines().length, i;
        var values = [];
        for (i = 1; i <= n; i++) {
            var v = getVal(i);
            values.push(v == null ? '' : String(v));
        }
        var out = window.TimelineCore.stretch(values, oldF, oldT, f, t);
        for (i = 0; i < n; i++) setVal(i + 1, out[i] === undefined ? '' : out[i]);
        markStale(); refreshAfterTimelineEdit();
        return { f: f, t: t };
    }
    /* 背景整段交换：值用「有效背景」（含场景默认），写回落成行级 background。 */
    function wbSwapBackground(oldF, oldT, f, t) {
        var ls = lines();
        wbSwapRun(oldF, oldT, f, t,
            function (i) { var l = ls[i - 1]; return l ? bgOfLine(l) : ''; },
            function (i, v) { if (ls[i - 1]) ls[i - 1].background = v || ''; });
    }
    /* 语音整段交换：值取行级 voice 或角色 cue.voice，写回统一落行级 voice 并清掉 cue 语音。 */
    function wbSwapVoice(oldF, oldT, f, t) {
        var ls = lines();
        wbSwapRun(oldF, oldT, f, t,
            function (i) {
                var l = ls[i - 1]; if (!l) return '';
                if (l.voice) return l.voice;
                var cs = l.cues || {};
                for (var r in cs) if (cs[r] && cs[r].voice) return cs[r].voice;
                return '';
            },
            function (i, v) {
                var l = ls[i - 1]; if (!l) return;
                if (v) l.voice = v; else delete l.voice;
                var cs = l.cues || {};
                Object.keys(cs).forEach(function (r) { if (cs[r] && typeof cs[r] === 'object') delete cs[r].voice; });
            });
    }
    /* 单字段（背景/语音）的挤开写回 */
    function wbRippleField(field, oldF, oldT, f, t) {
        var ls = lines();
        wbRippleRun(oldF, oldT, f, t,
            function (i) { return ls[i - 1] ? ls[i - 1][field] : undefined; },
            function (i, v) { if (!ls[i - 1]) return; if (v === undefined) delete ls[i - 1][field]; else ls[i - 1][field] = v; });
    }
    function wbResizeBackground(value, f, t, oldF, oldT, mode) {
        if (oldF && oldT) {
            var ls = lines();
            wbStretchRun(oldF, oldT, f, t,
                function (i) { var l = ls[i - 1]; return l ? bgOfLine(l) : ''; },
                // 让出的行显式写空串：不写空会回退场景默认，视觉上像「缩短后自动恢复」
                function (i, v) { var l = ls[i - 1]; if (l) l.background = v || ''; });
        } else wbSetRunField('background', value, f, t);
        msg('背景第 ' + f + '–' + t + ' 句（伸长推着邻块走、缩短则留空）');
    }
    function wbResizeVoice(value, f, t, oldF, oldT, mode) {
        if (oldF && oldT) {
            var ls = lines();
            wbStretchRun(oldF, oldT, f, t,
                function (i) {
                    var l = ls[i - 1]; if (!l) return '';
                    if (l.voice) return l.voice;
                    var cs = l.cues || {};
                    for (var r2 in cs) if (cs[r2] && cs[r2].voice) return cs[r2].voice;
                    return '';
                },
                function (i, v) {
                    var l = ls[i - 1]; if (!l) return;
                    if (v) l.voice = v; else delete l.voice;
                    var cs = l.cues || {};
                    Object.keys(cs).forEach(function (r2) { if (cs[r2] && typeof cs[r2] === 'object') delete cs[r2].voice; });
                });
        } else wbSetRunField('voice', value, f, t);
        msg('语音第 ' + f + '–' + t + ' 句（伸长推着邻块走、缩短则留空）');
    }
    /* 立绘段写回：
       · 整段拖动(move)＝与其它动作段交换位置（Vegas 式），保持原语义。
       · 拖两端改长度(l/r)＝ripple：伸长推着同侧所有邻块整体平移（长度不变、
         末尾溢出丢弃），缩短让出的格留空（写 stageHidden=true 显式标记）、其它块不动。
       stageKeys 只用来定段边界；动作字段按段首句模板整段写回。 */
    function wbResizeStage(startIdx, f, t, oldF, oldT, mode, bounds, stageKeys) {
        var ls = lines(), src = ls[startIdx];
        if (!src) return;
        var keys = ['enter', 'exit', 'move', 'cues'];
        function getVal(i) {
            var l = ls[i - 1]; if (!l) return undefined;
            var o = null;
            keys.forEach(function (k) { if (l[k] !== undefined) { o = o || {}; o[k] = JSON.parse(JSON.stringify(l[k])); } });
            return o;
        }
        function setVal(i, v) {
            var l = ls[i - 1]; if (!l) return;
            keys.forEach(function (k) {
                if (v && v[k] !== undefined) l[k] = JSON.parse(JSON.stringify(v[k]));
                else delete l[k];
            });
        }
        if (oldF && oldT) {
            if (mode === 'move') {
                wbSwapRun(oldF, oldT, f, t, getVal, setVal, bounds);
            } else {
                var segKeys = (stageKeys || []).map(function (k) { return k.key; });
                var newKeys = window.TimelineCore.stretch(segKeys, oldF, oldT, f, t);
                // 段首句的动作当模板。段内后续句常常「不写动作、继承上一句」，
                // 所以不能只重写标识变化的句子——那样新纳入的句子仍挂在旧继承链上，
                // 重新分段时会被算进邻段（看着像邻段被吞并）。受影响段的每一句都要写模板。
                var snap = [], j;
                for (j = 1; j <= ls.length; j++) snap.push(getVal(j));
                var tmpl = {};
                for (j = 0; j < segKeys.length; j++) {
                    var kk = segKeys[j];
                    if (kk && tmpl[kk] === undefined) tmpl[kk] = snap[j];
                }
                // 空 key 的句子写 stageHidden=true，让 stageKeysOf/runsOf 真正跳过它；
                // 否则「在台但没写动作」仍会算出段键，缩短让出的格又被并回立绘块。
                for (j = 0; j < ls.length; j++) {
                    var nk = newKeys[j];
                    if (nk) {
                        setVal(j + 1, tmpl[nk] || null);
                        delete ls[j].stageHidden;
                    } else {
                        setVal(j + 1, null);
                        ls[j].stageHidden = true;
                    }
                }
                markStale(); refreshAfterTimelineEdit();
            }
        } else {
            var payload = getVal(startIdx + 1) || {};
            for (var i = 0; i < ls.length; i++) {
                var inRange = (i + 1 >= f && i + 1 <= t);
                keys.forEach(function (k) {
                    if (inRange) { if (payload[k] !== undefined) ls[i][k] = JSON.parse(JSON.stringify(payload[k])); }
                    else if (JSON.stringify(ls[i][k]) === JSON.stringify(payload[k])) delete ls[i][k];
                });
            }
            markStale(); refreshAfterTimelineEdit();
        }
        msg(mode === 'move' ? '立绘段已与目标段交换位置'
            : '立绘段 ' + f + '–' + t + '（伸长推着邻块走、缩短则留空）');
    }
    /* BGM 段位置/长度写回：与声效完全同一套段数组逻辑。
       BGM [{file,range,fade}] 与声效 [{file,at,to}] 都是「区间存在段项上」的数组，
       不再绕 owner 逐句展开（旧做法里空档 null 会被值相等扩展成一整段，
       往右/左拖就一路填满到末尾）。move 用 swapSegments，resize 用 stretchSegments。 */
    function wbRippleBgm(bi, oldF, oldT, f, t, mode) {
        var TC = window.TimelineCore;
        var list = bgmList(), moving = list[bi];
        if (!moving) return;
        var oldKey = bgmKeyOf(moving);
        var segs = list.map(function (b) { var r = bgmRange(b); return { from: r[0], to: r[1] }; });
        var out = mode === 'move'
            ? TC.swapSegments(segs, oldF, oldT, f, t)
            : TC.stretchSegments(segs, oldF, oldT, f, t);
        // 只改每段的 range，file/fadeIn/fadeOut 原样保留；数组顺序与段项身份不变
        // 被推出末尾的段直接丢弃（ripple 语义，剧本行数/段数不凭空增长）
        var n = lines().length;
        out.forEach(function (o, k) {
            if (o.from > n) { list[k]._drop = true; return; }
            setBgmRange(list[k], Math.min(n, o.from), Math.min(n, o.to));
        });
        for (var j = list.length - 1; j >= 0; j--) if (list[j]._drop) { delete list[j]._drop; list.splice(j, 1); }
        state.bgmSel = bi;
        var nk = bgmKeyOf(moving);
        if (state.bgmKey === oldKey && nk !== oldKey) state.bgmKey = nk;  // 试听中续播，不重头
        markStale(); refreshAfterTimelineEdit(); renderBgmTrack(); renderBgmDetail();
        msg('BGM ' + baseName(moving.file) + (mode === 'move'
            ? ' 已与目标段交换位置' : ' 第 ' + f + '–' + t + ' 句（伸长推着邻块走 / 缩短留空）'));
    }
    /* 选中时间轴段：高亮当前段、清掉其余段的选中态（台词格不参与） */
    function wbSelectSeg(seg) {
        wb.selSeg = seg;
        [].forEach.call(document.querySelectorAll('#wb-tl-cells .wb-tl-cell'), function (c) {
            if (c._refreshSegSel) c._refreshSegSel();
        });
    }
    function wbClearSegSel() {
        if (!wb.selSeg) return;
        wb.selSeg = null;
        [].forEach.call(document.querySelectorAll('#wb-tl-cells .wb-tl-cell.is-seg-sel'), function (c) {
            c.classList.remove('is-seg-sel');
        });
    }
    /* Backspace/Delete 删除当前选中的时间轴段。段类型不同，写回方式不同：
       背景/语音＝清行级字段；BGM＝删数组项；声效＝删数组项；立绘＝清四个动作字段。 */
    function wbDeleteSelectedSeg() {
        if (!wb.selSeg) return false;
        wb.pendingAct = '删除';   // del() 内的 markStale() 会消费它，标注这一帧为「删除」
        if (wb.selSeg.del) wb.selSeg.del();
        wb.selSeg = null;
        msg('已删除时间轴段');
        return true;
    }
    /* 清掉 [f..t] 行的某个字段（delete 而非置空，避免留空串污染数据） */
    function wbClearRunField(field, f, t) {
        var ls = lines();
        for (var i = f - 1; i <= t - 1 && i < ls.length; i++) if (ls[i]) delete ls[i][field];
        markStale(); refreshAfterTimelineEdit();
    }
    /* 立绘段删除：清掉范围内每行与段签名相关的动作字段 */
    function wbClearStageSeg(f, t) {
        var ls = lines(), keys = ['enter', 'exit', 'move', 'cues'];
        for (var i = f - 1; i <= t - 1 && i < ls.length; i++) {
            if (!ls[i]) continue;
            keys.forEach(function (k) { delete ls[i][k]; });
        }
        markStale(); refreshAfterTimelineEdit();
    }
    function wbRenderPlayhead(progress) {
        var ph = $('wb-tl-playhead');
        if (!ph) return;
        var p = Math.max(0, Math.min(1, Number(progress) || 0));
        ph.style.left = (104 + state.sel * wb.tick + wb.tick * p) + 'px';
        ph.style.display = state.mode === 'edit' ? 'block' : 'none';
    }
    /* 一句的演出时长估算：优先 AUTO 停顿，再按台词长度兜底，控制在 0.8–8 秒。 */
    function wbLineDuration(line) {
        var wait = Number(line && line.wait);
        if (wait > 0) return Math.max(800, Math.min(8000, wait));
        return Math.max(1200, Math.min(8000, String((line && line.text) || '').length * 110));
    }
    /* 预览播放期间播放头从句子头匀速走到句子尾；暂停/切句时停扫并归位到句子头。 */
    function wbPlayheadSweep(line) {
        wbPlayheadStop();
        if (!wb.pvPlaying) { wbRenderPlayhead(0); return; }
        var ph = $('wb-tl-playhead');
        if (!ph) return;
        var dur = wbLineDuration(line);
        var t0 = performance.now();
        (function frame(now) {
            if (!wb.pvPlaying || state.mode !== 'edit') { ph.style.left = (104 + state.sel * wb.tick) + 'px'; wb.phRaf = 0; return; }
            var p = Math.min(1, (now - t0) / dur);
            ph.style.left = (104 + state.sel * wb.tick + wb.tick * p) + 'px';
            wb.phRaf = p < 1 ? requestAnimationFrame(frame) : 0;
        })(t0);
    }
    function wbPlayheadStop() {
        if (wb.phRaf) { cancelAnimationFrame(wb.phRaf); wb.phRaf = 0; }
    }
    function wbFocus() {
        var scroll = $('wb-tl-scroll');
        if (!scroll) return;
        var x = state.sel * wb.tick;
        if (x < scroll.scrollLeft || x + wb.tick > scroll.scrollLeft + scroll.clientWidth - 104) {
            scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 3);
        }
    }
    function wbZoom(mult, anchorClientX) {
        var scroll = $('wb-tl-scroll');
        if (!scroll) return;
        var rect = scroll.getBoundingClientRect();
        var ax = (anchorClientX == null ? rect.left + rect.width / 2 : anchorClientX) - rect.left - 104 + scroll.scrollLeft;
        var anchorIdx = ax / wb.tick;
        var old = wb.tick;
        wb.tick = Math.max(36, Math.min(320, Math.round(wb.tick * mult)));
        if (wb.tick === old) return;
        wbRenderTimeline();
        // 锚定光标下的句子不移动
        scroll.scrollLeft = Math.max(0, anchorIdx * wb.tick - (anchorClientX == null ? (rect.width - 104) / 2 : anchorClientX - rect.left - 104));
    }

    /* ---- 校验：保存前的问题清单 ---- */
    function wbValidate() {
        var issues = [];
        if (!state.scene) return issues;
        var keys = castKeys();
        lines().forEach(function (line, i) {
            var at = '第 ' + (i + 1) + ' 句';
            if (!line || typeof line !== 'object') { issues.push({ sev: 'err', at: at, i: i, msg: '行数据不是对象' }); return; }
            if (line.role && keys.indexOf(line.role) < 0)
                issues.push({ sev: 'err', at: at, i: i, msg: '说话者「' + line.role + '」不在角色表中' });
            if (!line.text || !String(line.text).trim())
                issues.push({ sev: 'warn', at: at, i: i, msg: '台词为空' });
            if (Array.isArray(line.enter)) line.enter.forEach(function (r) {
                if (keys.indexOf(r) < 0) issues.push({ sev: 'err', at: at, i: i, msg: '登场角色「' + r + '」不在角色表中' });
            });
            if (Array.isArray(line.exit)) line.exit.forEach(function (r) {
                if (keys.indexOf(r) < 0) issues.push({ sev: 'err', at: at, i: i, msg: '退场角色「' + r + '」不在角色表中' });
            });
        });
        var n = lines().length;
        bgmList().forEach(function (b, j) {
            var r = bgmRange(b);
            if (r[1] > n) issues.push({ sev: 'warn', at: 'BGM ' + (j + 1), i: Math.min(n - 1, r[0] - 1), msg: '覆盖到第 ' + r[1] + ' 句，超出剧本范围（共 ' + n + ' 句）' });
            if (!b.file) issues.push({ sev: 'err', at: 'BGM ' + (j + 1), i: 0, msg: '未指定音乐文件' });
        });
        wbSfxList().forEach(function (s, j) {
            if (!s.file) issues.push({ sev: 'err', at: '声效 ' + (j + 1), i: 0, msg: '未指定声效文件' });
            if ((Number(s.at) || 0) > n) issues.push({ sev: 'warn', at: '声效 ' + (j + 1), i: n - 1, msg: '触发句超出剧本范围' });
        });
        return issues;
    }
    function wbRenderIssues() {
        var list = $('wb-issues-list'), badge = $('wb-issue-badge'), title = $('wb-issues-title');
        var count = $('wb-issue-count');
        var issues = wbValidate();
        var errs = issues.filter(function (x) { return x.sev === 'err'; }).length;
        if (badge) badge.classList.toggle('has-issue', issues.length > 0);
        if (count) count.textContent = issues.length ? (errs ? '✕ ' + errs : '⚠ ' + issues.length) : '✓ 0';
        if (title) title.textContent = '问题（' + issues.length + '）' + (errs ? ' · ' + errs + ' 处错误' : '');
        if (!list) return;
        list.innerHTML = '';
        if (!issues.length) {
            var ok = document.createElement('div'); ok.className = 'wb-issues-empty'; ok.textContent = '✓ 没有发现问题';
            list.appendChild(ok); return;
        }
        issues.forEach(function (x) {
            var d = document.createElement('div');
            d.className = 'wb-issue wb-issue--' + x.sev;
            var sev = document.createElement('span'); sev.className = 'wb-issue-sev';
            sev.textContent = x.sev === 'err' ? '错误' : '提示';
            var body = document.createElement('span'); body.textContent = x.at + '：' + x.msg;
            d.appendChild(sev); d.appendChild(body);
            d.addEventListener('click', function () {
                if (x.i >= 0) { selectLine(x.i); setTab('script'); wbFocusScript(); }
            });
            list.appendChild(d);
        });
    }
    function wbFocusScript() {
        var li = $('st-lines') && $('st-lines').children[state.sel];
        if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    }

    /* ---- 搜索：高亮命中并支持逐个跳转 ---- */
    function wbRunSearch(q) {
        wb.searchHits = []; wb.searchCur = -1;
        var count = $('wb-search-count');
        q = String(q || '').trim().toLowerCase();
        // 先重置：renderList 会重建整张列表，天然清掉旧高亮
        if (!q) { renderList(); if (count) count.textContent = ''; return; }
        var isNum = /^\d+$/.test(q);
        lines().forEach(function (line, i) {
            var role = line.role ? castName(line.role) : '旁白';
            var text = line.text || '';
            var hit = isNum ? (i + 1 === Number(q)) : (text.toLowerCase().indexOf(q) >= 0 || role.toLowerCase().indexOf(q) >= 0);
            if (hit) wb.searchHits.push(i);
        });
        if (count) count.textContent = wb.searchHits.length ? (wb.searchHits.length + ' 处') : '无匹配';
        // 关键顺序：先 selectLine（内部 renderList 重建行 DOM），再在最新的 DOM 上打高亮
        if (wb.searchHits.length) { wb.searchCur = 0; selectLine(wb.searchHits[0]); wbFocusScript(); }
        else renderList();
        wb.searchHits.forEach(function (i) {
            var li = $('st-lines').children[i];
            if (!li) return;
            li.classList.add('is-hit');
            if (!isNum) {
                var line = lines()[i];
                var t = li.querySelector('.st-line-text');
                if (t) t.innerHTML = hl(line.text || '', q);
                var r = li.querySelector('.st-line-role');
                if (r) r.innerHTML = hl(line.role ? castName(line.role) : '旁白', q);
            }
        });
    }
    function hl(text, q) {
        var s = String(text);
        var idx = s.toLowerCase().indexOf(q.toLowerCase());
        if (idx < 0) return esc(s);
        return esc(s.slice(0, idx)) + '<mark>' + esc(s.slice(idx, idx + q.length)) + '</mark>' + esc(s.slice(idx + q.length));
    }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function wbSearchStep(dir) {
        if (!wb.searchHits.length) return;
        wb.searchCur = (wb.searchCur + dir + wb.searchHits.length) % wb.searchHits.length;
        selectLine(wb.searchHits[wb.searchCur]);
        wbFocusScript();
    }

    /* ---- 声效清单 ---- */
    function wbRenderSfx() {
        var list = $('st-sfx-list');
        if (list) {
            list.innerHTML = '';
            var arr = wbSfxList();
            if (!arr.length) {
                var e = document.createElement('div'); e.className = 'st-sfx-empty'; e.textContent = '还没有声效。把音频卡片拖到时间轴声效轨即可添加。';
                list.appendChild(e);
            }
            arr.forEach(function (s, j) {
                var d = document.createElement('div'); d.className = 'st-sfx-row';
                var a = document.createElement('span'); a.className = 'st-sfx-at'; a.textContent = '第' + (Number(s.at) || 1) + '句';
                var nm = document.createElement('span'); nm.className = 'st-sfx-name'; nm.textContent = baseName(s.file); nm.title = s.file;
                var del = document.createElement('button'); del.type = 'button'; del.textContent = '✕'; del.title = '删除这段声效';
                del.addEventListener('click', function () {
                    if (!state.scene.sfx) return;
                    state.scene.sfx.splice(j, 1); markStale(); refreshAfterTimelineEdit();
                });
                d.appendChild(a); d.appendChild(nm); d.appendChild(del);
                list.appendChild(d);
            });
        }
        // 声效卡片图库：和背景/BGM 一致的缩略大卡，可搜索、可拖到时间轴声效轨、点击加到当前句
        var cards = $('st-sfx-picker');
        if (cards) {
            cards.innerHTML = '';
            (wb.sfxFiles || []).forEach(function (f) {
                var c = document.createElement('div');
                c.className = 'st-sfx-file-card'; c.draggable = true;
                c.dataset.file = f; c.title = f + '\n拖到时间轴声效轨；单击加到当前句；双击试听';
                var ico = document.createElement('span'); ico.className = 'st-bgm-file-ico'; ico.textContent = '♫';
                var cap = document.createElement('span'); cap.className = 'st-bgm-file-name'; cap.textContent = baseName(f);
                c.appendChild(ico); c.appendChild(cap);
                // 单击＝加到当前句；双击＝试听。延后单击 220ms，双击时取消，避免双击顺带加两段。
                var clickTimer = null;
                c.addEventListener('click', function () {
                    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
                    clickTimer = setTimeout(function () {
                        clickTimer = null;
                        addSfxAt(f, state.sel + 1);
                    }, 220);
                });
                c.addEventListener('dblclick', function () {
                    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                    previewSfx(f);
                });
                cards.appendChild(c);
            });
            filterSfxPicker();
            var empty = $('st-sfx-empty');
            if (empty) empty.hidden = !!(wb.sfxFiles || []).length;
        }
    }
    function filterSfxPicker() {
        var input = $('st-sfx-search'), box = $('st-sfx-picker');
        if (!input || !box) return;
        var q = String(input.value || '').trim().toLowerCase(), shown = 0;
        [].forEach.call(box.children, function (x) {
            var ok = !q || (x.dataset.file || '').toLowerCase().indexOf(q) >= 0;
            x.hidden = !ok; if (ok) shown++;
        });
    }
    /* 在第 row 句（1-based）落一段声效 */
    function addSfxAt(file, row) {
        if (!state.scene || !file) return;
        if (!state.scene.sfx) state.scene.sfx = [];
        state.scene.sfx.push({ file: file, at: Math.max(1, row) });
        markStale('新增'); refreshAfterTimelineEdit();
        msg('第 ' + row + ' 句声效：' + baseName(file));
    }

    /* ---- 语音资源库：解耦登台角色的语音下拉，台词里用卡片可视化管理 ----
       卡片来源＝当前选中句说话者的 voiceDir（cast[role].voiceDir）清单；
       角色下拉可切换到别人的语音库（给同台角色配 cues.voice）。
       拖到时间轴语音轨落段、单击加到当前句、双击试听，与声效库操作一致。 */
    function voiceCardRole() {
        var sel = $('st-voice-role');
        return sel && sel.value ? sel.value : (function () {
            var l = lines()[state.sel];
            return l && l.role ? l.role : firstRole(state.cast);
        })();
    }
    function voiceFilesOf(role) {
        var item = state.cast && state.cast[role];
        var dir = item && item.voiceDir;
        return (dir && state.voices[dir]) || [];
    }
    function addVoiceAt(file, row) {
        var list = lines(), line = list[Math.max(0, (row || 1) - 1)];
        if (!line || !file) return;
        var role = voiceCardRole();
        // 说话者与卡片角色一致（或说话者为空）→ 写行级 voice；否则写该角色的 cue.voice
        if (!line.role || line.role === role) {
            line.voice = file;
        } else {
            if (!line.cues) line.cues = {};
            if (!line.cues[role] || typeof line.cues[role] !== 'object') line.cues[role] = {};
            line.cues[role].voice = file;
        }
        markStale('新增'); refreshAfterTimelineEdit(); renderProps();
        msg('第 ' + row + ' 句语音：' + baseName(file) + '（' + role + '）');
    }
    function wbRenderVoicePicker() {
        var roleSel = $('st-voice-role');
        if (roleSel) {
            var roles = Object.keys(state.cast || {}).filter(function (r) {
                var it = state.cast[r];
                return it && it.voiceDir && r.charAt(0) !== '_' && r !== 'doc';
            });
            var cur = roleSel.value || (function () {
                var l = lines()[state.sel];
                return l && l.role && roles.indexOf(l.role) >= 0 ? l.role : (roles[0] || '');
            })();
            roleSel.innerHTML = '';
            roles.forEach(function (r) { addOption(roleSel, r, r); });
            roleSel.value = cur;
        }
        var role = voiceCardRole();
        var files = voiceFilesOf(role);
        var cards = $('st-voice-picker');
        if (cards) {
            cards.innerHTML = '';
            (files || []).forEach(function (f) {
                var c = document.createElement('div');
                // 独立 class：不能复用 st-sfx-file-card，否则声效搜索的全局选择器会把语音卡片一起隐藏
                c.className = 'st-voice-file-card'; c.draggable = true;
                c.dataset.file = f; c.dataset.role = role;
                c.title = f + '\n拖到时间轴语音轨；单击加到当前句；双击试听';
                var ico = document.createElement('span'); ico.className = 'st-bgm-file-ico'; ico.textContent = '▸';
                var cap = document.createElement('span'); cap.className = 'st-bgm-file-name'; cap.textContent = baseName(f);
                c.appendChild(ico); c.appendChild(cap);
                var clickTimer = null;
                c.addEventListener('click', function () {
                    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
                    clickTimer = setTimeout(function () { clickTimer = null; addVoiceAt(f, state.sel + 1); }, 220);
                });
                c.addEventListener('dblclick', function () {
                    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                    playVoiceFile(role, f);
                });
                cards.appendChild(c);
            });
            filterVoicePicker();
            var empty = $('st-voice-empty');
            if (empty) {
                var dir = (state.cast && state.cast[role] && state.cast[role].voiceDir) || '';
                empty.hidden = !!(files || []).length;
                empty.textContent = dir ? ('该角色语音目录里没有音频：' + dir) : ('角色 ' + (role || '—') + ' 未配置 voiceDir');
            }
        }
        // 目录还没扫过就触发加载，载入后 renderProps 会再调一次本函数
        var item = state.cast && state.cast[role];
        if (item && item.voiceDir && !state.voices[item.voiceDir]) loadVoices(role);
    }
    function filterVoicePicker() {
        var input = $('st-voice-search'), box = $('st-voice-picker');
        if (!input || !box) return;
        var q = String(input.value || '').trim().toLowerCase(), shown = 0;
        [].forEach.call(box.children, function (x) {
            var ok = !q || (x.dataset.file || '').toLowerCase().indexOf(q) >= 0;
            x.hidden = !ok; if (ok) shown++;
        });
        var empty = $('st-voice-empty');
        if (empty) empty.hidden = shown > 0;
    }
    function setSfxTo(s, to) { if (to > s.at) s.to = to; else delete s.to; }
    /* 声效改长度：与 BGM/背景/语音/立绘统一——伸长推着右侧邻块整体右移
       （邻块长度不变、被推出末尾的丢弃），缩短则让出的格留空、其它块不动。 */
    function wbStretchSfx(si, oldF, oldT, f, t, mode) {
        var list = wbSfxList(), TC = window.TimelineCore;
        if (!list[si]) return;
        var segs = list.map(function (s) {
            var sf = Math.max(1, Number(s.at) || 1), st = Math.max(sf, Number(s.to) || sf);
            return { from: sf, to: st };
        });
        var n = lines().length;
        var out = TC.stretchSegments(segs, oldF, oldT, f, t);
        out.forEach(function (o, k) {
            if (o.from > n) { list[k]._drop = true; return; }
            list[k].at = o.from; setSfxTo(list[k], Math.min(n, o.to));
        });
        for (var j = list.length - 1; j >= 0; j--) if (list[j]._drop) { delete list[j]._drop; list.splice(j, 1); }
        markStale(); refreshAfterTimelineEdit();
        msg('声效第 ' + f + (t > f ? '–' + t : '') + ' 句（伸长推着邻块走、缩短则留空）');
    }
    /* 声效整段交换：拖到另一段声效上，两段互换触发区间（长度也跟着换），互不切分。
       落在空白处则原段整体平移过去、保持长度。 */
    function wbSwapSfx(si, oldF, oldT, f, t) {
        var list = wbSfxList(), a = list[si], n = lines().length;
        if (!a) return;
        var bj = -1, br = null, j;
        for (j = 0; j < list.length; j++) {
            if (j === si) continue;
            var s = list[j];
            var sf = Math.max(1, Number(s.at) || 1);
            var st = Math.max(sf, Math.min(n, Number(s.to) || sf));
            if (f >= sf && f <= st) { bj = j; br = [sf, st]; break; }
        }
        if (bj >= 0) {
            var b = list[bj];
            a.at = br[0]; setSfxTo(a, br[1]);
            b.at = oldF; setSfxTo(b, oldT);
            msg('声效已与第 ' + br[0] + ' 句声效交换位置');
        } else {
            a.at = f; setSfxTo(a, t);
        }
        markStale(); refreshAfterTimelineEdit();
    }

    /* ---- 统一刷新入口 ---- */
    /* ---- 细粒度刷新入口 ----
       refreshWorkbench() 不带参数＝全量重绘（兼容旧调用与启动流程）；
       带域参数＝只重绘受影响的模块，避免时间轴拖手柄这类高频操作重画整个工作台。
       域：scenes（场景下拉）/ timeline（时间轴）/ issues（校验）/ sfx（声效清单）
           / preview（实时预览字幕与站位）/ bgthumbs（剧本行背景缩略图）/ zoom（预览缩放）。 */
    var REFRESH_ALL = ['scenes', 'timeline', 'issues', 'sfx', 'preview', 'bgthumbs', 'zoom'];
    /* 剧本行背景缩略图的轻量刷新：只改缩略图本身，不重建列表 DOM，
       这样打字/拖动时不会丢光标。场景背景或行背景一改动就会走到这里。 */
    function wbRefreshLineBgThumbs() {
        var ol = $('st-lines');
        if (!ol) return;
        var list = lines();
        [].forEach.call(ol.children, function (li, i) {
            setLineBgThumb(li.querySelector && li.querySelector('.st-line-bg'), list[i]);
        });
    }

    function refreshWorkbench(domains) {
        if (state.mode !== 'edit') return;
        var d = domains == null ? null
            : (Array.isArray(domains) ? domains : [domains]);
        var all = !d;
        var has = function (k) { return all || d.indexOf(k) >= 0; };
        if (has('scenes')) wbRenderScenes();
        if (has('timeline')) wbRenderTimeline();
        if (has('issues')) wbRenderIssues();
        if (has('sfx')) { wbRenderSfx(); wbRenderVoicePicker(); }
        if (has('preview')) wbPreviewSync();
        if (has('bgthumbs')) wbRefreshLineBgThumbs();
        if (has('zoom')) wbPreviewApplyZoom();
    }
    /* 时间轴段改动后的标准刷新：时间轴 + 校验 + 预览站位 + 声效清单；
       不动场景下拉与预览缩放（这两个与段拖动无关，重画纯属浪费）。 */
    function refreshAfterTimelineEdit() {
        refreshWorkbench(['timeline', 'issues', 'preview', 'sfx', 'bgthumbs']);
    }

    /* ---- 分割条拖动（左栏 / 右栏 / 预览高度）+ localStorage ---- */
    function wbLoadLayout() {
        try {
            var s = JSON.parse(localStorage.getItem(wb.layoutKey) || '{}');
            var ed = $('st-editor');
            if (typeof s.nav === 'number') ed.style.setProperty('--nav-w', Math.max(140, Math.min(360, s.nav)) + 'px');
            if (typeof s.insp === 'number') ed.style.setProperty('--inspector-w', Math.max(280, Math.min(560, s.insp)) + 'px');
            if (typeof s.pv === 'number') ed.style.setProperty('--preview-h', Math.max(15, Math.min(65, s.pv)) + '%');
            if (typeof s.lb === 'number') ed.style.setProperty('--linebar-w', Math.max(18, Math.min(65, s.lb)) + '%');
            if (typeof s.cr === 'number') ed.style.setProperty('--cast-roles-w', Math.max(120, Math.min(360, s.cr)) + 'px');
            if (typeof s.ca === 'number') ed.style.setProperty('--cast-acts-w', Math.max(160, Math.min(480, s.ca)) + 'px');
        } catch (_) {}
    }
    function wbSaveLayout() {
        var ed = $('st-editor');
        var cs = getComputedStyle(ed);
        try {
            localStorage.setItem(wb.layoutKey, JSON.stringify({
                nav: parseFloat(cs.getPropertyValue('--nav-w')) || 196,
                insp: parseFloat(cs.getPropertyValue('--inspector-w')) || 364,
                pv: parseFloat(cs.getPropertyValue('--preview-h')) || 32,
                lb: parseFloat(cs.getPropertyValue('--linebar-w')) || 30,
                cr: parseFloat(cs.getPropertyValue('--cast-roles-w')) || 190,
                ca: parseFloat(cs.getPropertyValue('--cast-acts-w')) || 282
            }));
        } catch (_) {}
    }
    function wbBindSplits() {
        [].forEach.call(document.querySelectorAll('.wb-split'), function (sp) {
            sp.addEventListener('pointerdown', function (e) {
                e.preventDefault();
                var kind = sp.dataset.split, vertical = sp.classList.contains('wb-split--h');
                var ed = $('st-editor'), body = $('wb-body'), center = document.querySelector('.wb-center');
                var start = vertical ? e.clientY : e.clientX;
                // 预览分割条要以「预览自身高度」为基准，不能用 center 总高（否则一拖就触顶/触底）
                var cur = vertical
                    ? (kind === 'preview' ? $('wb-preview').getBoundingClientRect().height : center.getBoundingClientRect().height)
                    : (kind === 'nav' ? body.children[0].getBoundingClientRect().width
                        : kind === 'linebar' ? $('wb-linebar').getBoundingClientRect().width
                        : kind === 'cast-roles' ? document.querySelector('.st-cast-col-roles').getBoundingClientRect().width
                        : kind === 'cast-acts' ? document.querySelector('.st-cast-col-acts').getBoundingClientRect().width
                        : $('wb-inspector').getBoundingClientRect().width);
                sp.classList.add('is-drag');
                document.body.classList.add(vertical ? 'wb-resizing-v' : 'wb-resizing');
                function move(ev) {
                    var d = (vertical ? ev.clientY : ev.clientX) - start;
                    if (kind === 'nav') ed.style.setProperty('--nav-w', Math.max(140, Math.min(360, cur + d)) + 'px');
                    else if (kind === 'inspector') ed.style.setProperty('--inspector-w', Math.max(280, Math.min(560, cur - d)) + 'px');
                    else if (kind === 'cast-roles') ed.style.setProperty('--cast-roles-w', Math.max(120, Math.min(360, cur + d)) + 'px');
                    else if (kind === 'cast-acts') ed.style.setProperty('--cast-acts-w', Math.max(160, Math.min(480, cur + d)) + 'px');
                    else if (kind === 'linebar') {
                        var previewBody = $('wb-preview-body');
                        var totalW = previewBody ? previewBody.getBoundingClientRect().width : 1;
                        var pct = Math.max(18, Math.min(65, (cur + d) / (totalW || 1) * 100));
                        ed.style.setProperty('--linebar-w', pct + '%');
                    }
                    else if (kind === 'preview') {
                        var totalH = center.getBoundingClientRect().height || 1;
                        var pct = Math.max(15, Math.min(72, (cur + d) / totalH * 100));
                        ed.style.setProperty('--preview-h', pct + '%');
                    }
                    if (kind === 'preview') wbPreviewApplyZoom();
                }
                function up() {
                    sp.classList.remove('is-drag');
                    document.body.classList.remove('wb-resizing', 'wb-resizing-v');
                    document.removeEventListener('pointermove', move);
                    document.removeEventListener('pointerup', up);
                    wbSaveLayout();
                    if (window.WbTimeline) window.WbTimeline.render();
                }
                document.addEventListener('pointermove', move);
                document.addEventListener('pointerup', up);
            });
        });
    }

    /* ---- 工作台事件绑定（启动时一次）---- */
    function wbBind() {
        wbLoadLayout();
        wbLoadLaneOrder();
        bindDrawers();
        wbBindSplits();

        /* 编辑页专属：全屏只全屏工作台本身（#st-editor），背后播放层/画布不进全屏，
           所以不会出现「编辑全屏露出 story 背景」。同步工具栏里的主页/剧情预览链接。 */
        if (EDIT_PAGE) {
            var wbFull = $('wb-full');
            if (wbFull) {
                wbFull.addEventListener('click', function () {
                    var ed = $('st-editor');
                    if (document.fullscreenElement) {
                        if (document.exitFullscreen) document.exitFullscreen();
                    } else if (ed && ed.requestFullscreen) {
                        ed.requestFullscreen();
                    }
                });
                document.addEventListener('fullscreenchange', function () {
                    var on = document.fullscreenElement === $('st-editor');
                    wbFull.classList.toggle('is-on', on);
                    wbFull.textContent = on ? '⛶ 退出' : '⛶ 全屏';
                    wbFull.title = on ? '退出全屏（Esc）' : '全屏：只留工作台，隐藏剧情背景层';
                    setTimeout(function () { wbPreviewApplyZoom(); if (window.WbTimeline) window.WbTimeline.render(); }, 60);
                });
                if (!document.documentElement.requestFullscreen) wbFull.disabled = true;
            }
            var wbPlay = $('wb-goto-play');
            if (wbPlay) wbPlay.href = 'index.html?scene=' + encodeURIComponent(state.file || '');
        }
        window.addEventListener('resize', function () {
            if (state.mode === 'edit') { wbPreviewSync(); if (window.WbTimeline) window.WbTimeline.render(); }
        });

        // 撤销/重做：按钮 + 快捷键。历史入栈已统一收口到 markStale()，
        // 点击/选中/聚焦都不再入栈，只有真正改数据才留痕（见 wbScheduleHistory）。
        var uBtn = $('wb-undo'), rBtn = $('wb-redo');
        if (uBtn) uBtn.addEventListener('click', wbUndo);
        if (rBtn) rBtn.addEventListener('click', wbRedo);
        document.addEventListener('keydown', function (e) {
            if (state.mode !== 'edit') return;
            // Esc：取消框选（全屏由浏览器自己处理 Esc，不冲突）
            if (e.key === 'Escape' && wb.multiSel && wb.multiSel.length) {
                wbClearMultiSel(); return;
            }
            // 空格：播放/暂停预览当前句（无修饰键；在输入控件里打字时不劫持）
            if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                var t = e.target;
                if (t && (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) || t.isContentEditable)) return;
                e.preventDefault(); wbPreviewTogglePlay(); return;
            }
            var mod = e.ctrlKey || e.metaKey;
            if (!mod) return;
            var k = e.key.toLowerCase();
            if (k === 'z' && !e.shiftKey) { e.preventDefault(); wbUndo(); }
            else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); wbRedo(); }
            else if (k === 's') { e.preventDefault(); saveCurrent(); }
            else if (k === 'f') { e.preventDefault(); if ($('wb-search-input')) $('wb-search-input').focus(); }
        });

        // 点时间轴/剧本列表的空白处取消选中（点格子本身由各自 onClick 处理并 stopPropagation）
        [ $('wb-tl-scroll'), $('st-lines') ].forEach(function (host) {
            if (host) host.addEventListener('click', function (e) {
                if (!e.target.closest || !e.target.closest('.wb-tl-cell,.st-line')) {
                    wbClearSegSel(); wbClearMultiSel();
                }
            });
        });
        // 框选滑块：空白处左键拖出选框，Esc 取消
        wbBindMultiSelect();

        // 时间轴缩放按钮
        var zi = $('wb-tl-zoom-in'), zo = $('wb-tl-zoom-out'), zf = $('wb-tl-zoom-fit');
        if (zi) zi.addEventListener('click', function () { wbZoom(1.2); });
        if (zo) zo.addEventListener('click', function () { wbZoom(1 / 1.2); });
        if (zf) zf.addEventListener('click', function () {
            var n = Math.max(1, lines().length), scroll = $('wb-tl-scroll');
            if (!scroll) return;
            wb.tick = Math.max(36, Math.min(320, Math.floor((scroll.clientWidth - 104 - 12) / n)));
            wbRenderTimeline(); scroll.scrollLeft = 0;
        });
        // 滚轮：默认缩放（锚定光标所在句）；Shift+滚轮保留浏览器原生纵向滚动。
        var tlScroll = $('wb-tl-scroll');
        if (tlScroll) tlScroll.addEventListener('wheel', function (e) {
            if (e.shiftKey) {
                e.preventDefault();
                tlScroll.scrollTop += e.deltaY;
                return;
            }
            e.preventDefault();
            wbZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX);
        }, { passive: false });
        // 拖动平移时间轴（空白处按住拖）；轨道格子区让给框选手势，避免两者抢同一 drag
        if (tlScroll) {
            var dragging = false, sx = 0, sl = 0;
            tlScroll.addEventListener('pointerdown', function (e) {
                if (e.button !== 0 || e.target.closest('.wb-tl-cell')) return;
                if (e.target.closest('#wb-tl-cells')) return;   // 这一区由框选接管
                dragging = true; sx = e.clientX; sl = tlScroll.scrollLeft;
            });
            document.addEventListener('pointermove', function (e) { if (dragging) tlScroll.scrollLeft = sl - (e.clientX - sx); });
            document.addEventListener('pointerup', function () { dragging = false; });
        }

        // 预览缩放 / 浮动
        var pIn = $('wb-pv-in'), pOut = $('wb-pv-out'), pFit = $('wb-pv-fit'), pLvl = $('wb-pv-level'), pFloat = $('wb-pv-float');
        if (pIn) pIn.addEventListener('click', function () { wb.previewZoom = Math.min(3, wb.previewZoom + .25); wbPreviewApplyZoom(); });
        if (pOut) pOut.addEventListener('click', function () { wb.previewZoom = Math.max(.5, wb.previewZoom - .25); wbPreviewApplyZoom(); });
        if (pLvl) pLvl.addEventListener('click', function () { wb.previewZoom = 1; wbPreviewApplyZoom(); });
        if (pFit) pFit.addEventListener('click', function () { wb.previewZoom = 1; wbPreviewApplyZoom(); });
        // 右下角斜向拖拽：grid 动态联动——同时改预览行高与右栏列宽，画面等比跟着缩放。
        // 事件挂 document（不用 setPointerCapture），拖出 grip 也不丢，避免「拖不动」。
        var grip = $('wb-pv-grip');
        if (grip) grip.addEventListener('pointerdown', function (e) {
            e.preventDefault(); e.stopPropagation();
            var ed = $('st-editor'), center = document.querySelector('.wb-center');
            var startX = e.clientX, startY = e.clientY;
            var h0 = $('wb-preview').getBoundingClientRect().height;
            var w0 = $('wb-inspector').getBoundingClientRect().width;
            var totalH = center.getBoundingClientRect().height || 1;
            grip.classList.add('is-drag');
            document.body.classList.add('wb-resizing', 'wb-resizing-v');
            function move(ev) {
                // 斜向位移折成增量：向右下＝预览放大、检查器变窄；向左上反之
                var d = ((ev.clientX - startX) + (ev.clientY - startY)) / 2;
                ed.style.setProperty('--preview-h', Math.max(15, Math.min(72, (h0 + d) / totalH * 100)) + '%');
                ed.style.setProperty('--inspector-w', Math.max(280, Math.min(560, w0 - d)) + 'px');
                wbPreviewApplyZoom();
            }
            function up() {
                grip.classList.remove('is-drag');
                document.body.classList.remove('wb-resizing', 'wb-resizing-v');
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', up);
                wbSaveLayout();
                if (window.WbTimeline) window.WbTimeline.render();
            }
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
        });
        if (pFloat) pFloat.addEventListener('click', function () {
            $('wb-preview').classList.toggle('is-float');
            pFloat.textContent = $('wb-preview').classList.contains('is-float') ? '停靠' : '浮动';
            setTimeout(wbPreviewSync, 30);
        });

        // 搜索
        var sIn = $('wb-search-input');
        if (sIn) {
            sIn.addEventListener('input', function () { wbRunSearch(this.value); });
            sIn.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); wbSearchStep(e.shiftKey ? -1 : 1); }
                if (e.key === 'Escape') { this.value = ''; wbRunSearch(''); this.blur(); }
            });
        }
        // 问题徽章 / 关闭
        var badge = $('wb-issue-badge'), issues = $('wb-issues'), iClose = $('wb-issues-close');
        if (badge) badge.addEventListener('click', function () { if (issues) issues.hidden = !issues.hidden; });
        if (iClose) iClose.addEventListener('click', function () { if (issues) issues.hidden = true; });

        // 配色切换：青绿 / 石墨橙，写入 localStorage，刷新后保持
        var themeBtn = $('wb-theme-toggle');
        if (themeBtn) themeBtn.addEventListener('click', function () {
            var next = document.documentElement.getAttribute('data-theme') === 'graphite' ? 'teal' : 'graphite';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem('story-workbench-theme', next); } catch (_) {}
            themeBtn.title = next === 'graphite' ? '当前：石墨橙（点切回青绿）' : '当前：青绿（点切到石墨橙）';
        });

        // 剧本下拉切换 + 新建/删除
        var scSel = $('wb-scene-select');
        if (scSel) scSel.addEventListener('change', function () { switchScene(this.value); });
        var scNew = $('wb-scene-new'), scDel = $('wb-scene-del');
        if (scNew) scNew.addEventListener('click', wbNewScene);
        if (scDel) scDel.addEventListener('click', wbDeleteScene);

        // 视图记忆：上次停在剧本/时间轴/角色表，这次打开就回到那里
        try {
            var savedTab = localStorage.getItem('story-workbench-tab');
            if (savedTab === 'timeline' || savedTab === 'cast' || savedTab === 'script') setTab(savedTab);
        } catch (_) {}

        // 暴露给 setTab 调用；loadSfx 供外部显式刷新声效清单（验收/调试）
        window.WbTimeline = { render: wbRenderTimeline, refresh: refreshWorkbench, loadSfx: loadSfxFiles };
    }

    /* 两个页签：剧本 / 时间轴 / 角色表。切页只改显示，不重建剧本列表，
       所以「去角色表改完再回来」仍然停在原来那一行。 */
    function setTab(tab) {
        if (tab === 'cast' && !state.cast) return;
        state.tab = (tab === 'cast') ? 'cast' : (tab === 'timeline') ? 'timeline' : 'script';
        try { localStorage.setItem('story-workbench-tab', state.tab); } catch (_) {}
        $('st-editor').dataset.tab = state.tab;
        $('st-editor').dataset.view = state.tab;
        $('st-view-script').hidden = (state.tab !== 'script');
        $('st-view-cast').hidden = (state.tab !== 'cast');
        if ($('st-view-timeline')) $('st-view-timeline').hidden = (state.tab !== 'timeline');
        [].forEach.call(document.querySelectorAll('.st-tab'), function (b) {
            b.classList.toggle('is-on', b.dataset.tab === state.tab);
        });
        // 切到时间轴时即时渲染一次（数据可能在上次离开后改过）
        if (state.tab === 'timeline' && window.WbTimeline) window.WbTimeline.render();
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

    // 台词字数：常驻显示，输入与切行时同步。
    function wbUpdateTextCount() {
        var t = $('st-line-text'), c = $('wb-text-count');
        if (t && c) c.textContent = (t.value || '').length + ' 字';
    }

    function renderProps() {
        if (!state.scene) return;
        setVal($('st-title'), state.scene.title || '');
        // 日历是本行演出：读本句生效值（字段级沿用上一句），写也写回本句
        var sw = ST.subwinAt ? ST.subwinAt(state.sel) : (state.scene.subwin || {});
        var swVal = function (id, v) { var el = $(id); if (el) setVal(el, v); };
        swVal('sw-month', sw.month == null ? '' : sw.month);
        swVal('sw-day', sw.day == null ? '' : sw.day);
        swVal('sw-week', sw.week == null ? '' : sw.week);
        swVal('sw-notify', sw.notify || 'none');
        ST.setSubwin(sw);
        syncBgCurrent();

        var line = lines()[state.sel];
        $('st-sel-idx').textContent = String(state.sel + 1);
        if (!line) {
            $('st-role').innerHTML = '';
            $('st-line-text').value = '';
            renderNameField(null);
            renderRoster();
            return;
        }
        /* 说话者可留空＝旁白：此时名牌不显示。
           current 必须用剧本里的原始 line.role（而不是 speakerOf 的回退值），
           否则空说话者会被画成第一个角色，用户没法在下拉里选「无」。
           fillSelect 的第 4 参非空才会生成空值选项。 */
        fillSelect($('st-role'), castKeys(),
            line.role || '', '旁白', roleLabel);
        setVal($('st-line-text'), line.text || '');
        wbUpdateTextCount();
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
        if (!field) return;
        if (!line) {
            field.value = '';
            field.placeholder = '';
            field.disabled = true;
            if (btn) btn.disabled = true;
            return;
        }
        var role = speakerOf(line);
        var own = typeof line.name === 'string' ? line.name : '';
        // 空说话者（旁白）没有名牌，显示名及其两个按钮一并禁用，避免改了却不生效
        var noName = !line.role;
        field.disabled = noName;
        field.value = own;
        field.placeholder = noName ? '旁白' : '沿用：' + inheritedName(role, state.sel);
        field.title = noName ? '这一句是旁白，没有说话者' : '这一句起对话框上显示的名字；留空＝沿用上一句。角色默认名「' + castName(role) + '」';
        if (btn) {
            btn.disabled = noName;
            btn.title = '填入角色本名「' + castName(role) + '」（用来揭示真名）';
        }
    }

    function renderEditor() {
        renderList();
        renderProps();      // 里面会画角色卡
        renderBgmDetail();  // 段配置面板跟随当前场景/选中段
        // 缺省显示默认 300 而不是空，让用户看得见当前生效值
        setVal($('st-fade-ms'), fadeMsOf());
        renderDrawer();
        // 选中哪一句，画布就预览哪一句的站位与上下场
        if (state.mode === 'edit') rebuildStaging(state.sel);
        refreshWorkbench();
    }

    function selectLine(i) {
        state.sel = i;
        if (state.mode === 'edit') {
            rebuildStaging(i);
            // 预览处于播放态时，切句＝演出新句（语音/上下场/动作都跟上）
            if (wb.pvPlaying) wbPreviewPerform(lines()[i]);
        }
        renderList();
        renderProps();
        clearBgmSel();   // 点台词行收起 BGM 配置；编辑态不自动试听
        wbRenderPlayhead();
        wbPreviewSync();
    }

    function addLine() {
        var list = lines();
        var base = list[state.sel] || {};
        // 新行是干净空白行：显式空背景，避免 bgOfLine 回退场景默认后
        // 让已有背景块自动延伸覆盖新行（其它轨：语音无字段天然断点，
        // BGM/声效是显式区间不会顺延，立绘是角色在台状态延续属剧情语义）。
        var line = { role: base.role || firstRole(state.cast), text: '', background: '' };
        var at = list.length ? state.sel + 1 : 0;
        list.splice(at, 0, line);
        state.sel = at;
        markStale('新增');
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
        markStale('重排');
        renderEditor();
    }

    /* 台词拖动＝与其它轨一致的「整段交换」：两行台词整块互换位置（长度都是 1 格），
       不再是 splice 插入导致中间行顺移。行数不变、无块被切分，和 Vegas 里交换片段一个语义。 */
    function dropLine(from, to) {
        var list = lines();
        if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return;
        var tmp = list[from];
        list[from] = list[to];
        list[to] = tmp;
        state.sel = to;
        markStale('重排');
        renderEditor();
    }

    function delLine(i) {
        var list = lines();
        if (i < 0 || i >= list.length) return;
        list.splice(i, 1);
        state.sel = Math.min(i, Math.max(0, list.length - 1));
        markStale('删除');
        renderEditor();
    }

    /* ---------- 模式与场景 ---------- */

    /* 每次进入剧情模式、以及换剧本之后，都重播一遍对话框开场（窗口擦入 + 装饰线 + 名牌），
       否则 HUD 会以「已铺开」的终态直接出现。open() 从第 0 帧起跑，AUTO 提示牌的滑入一并重来。 */
    /* 开场动画（intro）串行令牌：进入剧情模式、切剧本、编辑→播放都可能起一次 intro，
       每次带一个 2 秒兜底 timer。若在前一次 intro 还没结束时又起新的（典型：进故事模式
       后马上切剧本），两个 timer 会各自触发一次 restart → 首句文字和语音播两遍。
       它们各自的 introDone 只是局部变量，管不住对方。这里用模块级 seq：起 intro 时领取
       一个序号，回调时只有仍是最新的那次才放行，过期的作废。 */
    var introSeq = 0;
    function pauseForEdit() {
        var line = currentLine();
        var shown = $('st-text-txt') ? ($('st-text-txt').textContent || '').length : 0;
        state.pausedPlayback = {
            idx: state.idx,
            text: line ? (line.text || '') : '',
            typedChars: shown,
            typing: !!state.typing,
            speaker: state.speaker,
            lineStart: state.lineStart
        };
        // 语音：暂停而非停止，保留每段的播放 offset
        Object.keys(audioPool).forEach(function (r) {
            try { audioPool[r].pause(); } catch (_) { /* 没在播 */ }
        });
        // 打字：停 timer，但保留已显示的文字与 typeDone，续播时从这里继续
        if (state.typeTimer) { clearTimeout(state.typeTimer); state.typeTimer = null; }
        if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
    }

    /* 编辑 → 播放：剧本未改动时从暂停处续上，不重跑开场动画、不重播语音/打字。
       - 打字：从 typedChars 接着打（已打完则直接补全并重新 armAuto）
       - 语音：各角色 audioPlayer.resume() 从 offset 续播，说话者剩余时长喂给 AUTO
       - AUTO：用「剩余语音 ms」续计时，lineStart 平移到冻结时刻，避免把编辑停留算进去
       返回是否真的续播了。 */
    function resumePlayback() {
        var snap = state.pausedPlayback;
        state.pausedPlayback = null;
        if (!snap) return false;
        var line = lines()[snap.idx];
        if (!line) return false;

        state.idx = snap.idx;
        state.ended = false;
        state.mode = 'play';
        // 冻结期间经过的墙钟时间不算进本句：lineStart 重置到续播这一刻，
        // speakerVoice 解析出的又是「剩余语音 ms」，两者相减正好是还要等多久。
        state.lineStart = performance.now();

        // 语音续播：说话者那段返回剩余毫秒，AUTO 据此续计时
        var role = speakerOf(line);
        var speakerVoice = Promise.resolve(0);
        cueRoles(line).forEach(function (r) {
            var cue = cueOf(line, r);
            if (!cue.voice) return;
            var ap = audioFor(r);
            var p = ap.resume();
            if (r === role) speakerVoice = p;
        });
        state.lineVoice = speakerVoice;
        state.autoReady = false;

        // 文字续打：已打完就直接补全，不再触发一次打字
        var full = line.text || '';
        var el = $('st-text-txt');
        if (snap.typing && snap.typedChars < full.length) {
            typeText(full, function () { onTyped(line, speakerVoice); }, snap.typedChars);
        } else {
            if (el) el.textContent = full;
            state.typing = false;
            state.typeDone = null;
            if (window.SGDialog) window.SGDialog.setCaret(false);
            syncGear();
            state.autoReady = true;
            armAuto(speakerVoice);
        }
        setProgress();
        setHint(state.autoOn && state.mode === 'play' ? '自动推进中…' : '点击继续 ▸');
        return true;
    }

    function wbSetUrlScene(file) {
        try {
            var u = new URL(location.href);
            if (file) u.searchParams.set('scene', file); else u.searchParams.delete('scene');
            history.replaceState(null, '', u.pathname + u.search);
        } catch (_) {}
    }

    /* 场景选择器：隐藏的 select 仍是数据载体与 change 事件源，
       可见部分是自定义下拉，深色主题下可读，并显示文件名副信息。 */
    function syncScenePicker() {
        var sel = $('st-scene'), menu = $('st-scene-menu'), label = $('st-scene-label');
        /* 剧情页顶栏已移除；剧本选择改由 SYSTEM → OBSERVER 面板承担。 */
        if (!menu || !label) return;
        var s = state.scenes.filter(function (x) { return x.file === state.file; })[0];
        label.textContent = s ? s.title : (state.file || '选择场景');
        [].forEach.call(menu.children, function (item) {
            item.setAttribute('aria-selected', item.dataset.file === state.file ? 'true' : 'false');
            item.querySelector('.st-scene-check').textContent = item.dataset.file === state.file ? '✓' : '';
        });
    }
    function openSceneMenu(open) {
        var picker = $('st-scene-picker'), menu = $('st-scene-menu'), trig = $('st-scene-trigger');
        if (!picker || !menu || !trig) return;
        picker.classList.toggle('is-open', open);
        trig.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.hidden = !open;
        if (open) {
            var active = menu.querySelector('[aria-selected="true"]') || menu.firstElementChild;
            if (active) setSceneActive(active);
        }
    }
    function setSceneActive(item) {
        var menu = $('st-scene-menu');
        if (!menu) return;
        [].forEach.call(menu.children, function (x) { x.classList.remove('is-active'); });
        if (item) { item.classList.add('is-active'); item.scrollIntoView({ block: 'nearest' }); }
    }
    function pickScene(file) {
        openSceneMenu(false);
        if (!file || file === state.file) return;
        /* 顶栏 select 可能已不存在，直接走同一条切换路径。 */
        switchScene(file);
    }
    document.addEventListener('click', function (evt) {
        var trig = evt.target.closest && evt.target.closest('#st-scene-trigger');
        if (trig) { openSceneMenu($('st-scene-menu').hidden); return; }
        var opt = evt.target.closest && evt.target.closest('.st-scene-opt');
        if (opt) { pickScene(opt.dataset.file); return; }
        if (!evt.target.closest || !evt.target.closest('#st-scene-picker')) openSceneMenu(false);
    });
    document.addEventListener('keydown', function (evt) {
        var picker = $('st-scene-picker');
        if (!picker) return;
        var open = !$('st-scene-menu').hidden;
        var trigFocus = document.activeElement === $('st-scene-trigger');
        if ((trigFocus && (evt.key === 'Enter' || evt.key === ' ' || evt.key === 'ArrowDown')) ||
            (open && evt.key === 'Escape')) {
            evt.preventDefault();
            openSceneMenu(!open);
            if (open) $('st-scene-trigger').focus();
            return;
        }
        if (!open) return;
        var items = [].slice.call($('st-scene-menu').children);
        var cur = items.indexOf($('st-scene-menu').querySelector('.is-active'));
        if (evt.key === 'ArrowDown') { evt.preventDefault(); setSceneActive(items[(cur + 1) % items.length]); }
        else if (evt.key === 'ArrowUp') { evt.preventDefault(); setSceneActive(items[(cur - 1 + items.length) % items.length]); }
        else if (evt.key === 'Enter' || evt.key === ' ') {
            evt.preventDefault();
            var active = $('st-scene-menu').querySelector('.is-active');
            if (active) pickScene(active.dataset.file);
        }
    });

    /* 场景切换串行令牌：getJson 是异步的，期间重复 change（双击菜单/键盘回环/事件兜底）
       若都放行，会各自走一次 restart → 首句文字和语音播两遍。每次进入递增，await 回来
       只有最新的一次才算数，先到的旧请求一律放弃。 */
    var switchSeq = 0;
    async function switchScene(file) {
        if (!file || file === state.file) return;
        var seq = ++switchSeq;
        try {
            var scene = await getJson(file);
            if (seq !== switchSeq) return;   // 期间又发了新的切换，这次作废
            var stage = stageOf(scene, state.cast);
            /* 本场若用到尚未加载的模型，wasm 一页只能起一次，整页重载 */
            var needReload = stage.some(function (s) {
                return !state.actors[s.role] || state.actors[s.role].model !== state.cast[s.role].model;
            });
            if (needReload) {
                // 编辑页切场景仍留在编辑工作台（转剧本编辑），不跳去剧情模式；
                // 剧情页保持原样重载当前页。base href 指向 story/，故编辑页要显式 ../edit/。
                location.href = (EDIT_PAGE ? '../edit/index.html' : 'index.html')
                    + '?scene=' + encodeURIComponent(file);
                return;
            }
            state.file = file;
            state.scene = scene;
            syncScenePicker();
            stopBgm();                // 换场停掉试听/剧情 BGM
            applyScene(scene, state.cast);
            stopAllBlinks();          // 换场＝换一套站位与动作，旧眨眼表作废
            stopVoices();
            /* 静默清场：停掉上一场还在跑的打字机（clearTimers 里 seq++ 让旧 tick 早退），
               并清空文字框。否则换场对话框动画这两秒里，旧台词会继续逐字打出、一直挂在
               屏幕上，直到 restart() 落新句才被替换。名牌由 playDialogIntro 的 primeName
               重设，不动 st-name。 */
            clearTimers();
            state.typing = false;
            state.typeDone = null;
            $('st-text-txt').textContent = '';
            state.bgmSel = -1;        // 换场收起上一场的 BGM 段配置
            if (state.mode === 'play') {
                state.stale = false;
                primeStageForIntro();       // 动画期间先看到新剧本的完整场景
                state.introPending = true;
                var myIntro = beginIntro();
                var introDone = false;
                var finish = function () {
                    if (introDone || !introCurrent(myIntro)) return;
                    introDone = true;
                    state.introPending = false;
                    restart();
                };
                playDialogIntro(finish);      // 换剧本＝换一场戏：动画铺开后才落台词
                setTimeout(finish, 2000);
            } else {
                state.stale = true;
                // 编辑页换场＝转去编新剧本：回到「剧本」视图、选中首行
                if (EDIT_PAGE) { state.sel = 0; setTab('script'); renderEditor(); }
            }
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
            // auto 由播放界面的 AUTO 开关接管，不写进行数据
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

        // 浏览器 autoplay 被拦时，首次任意手势补播一次 BGM
        document.addEventListener('pointerdown', resumeBgmOnGesture, true);

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
            // 剧本行只接行重排；背景写入统一走时间轴背景轨，剧本行缩略图只读预览
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

        /* 背景图库拖放：图库项是唯一拖拽源；自定义 MIME 让外部文件拖入被拒 */
        var gallery = $('st-bg-gallery');
        gallery.addEventListener('dragstart', function (evt) {
            var item = evt.target.closest && evt.target.closest('.st-bg-item');
            if (!item) return;
            evt.dataTransfer.effectAllowed = 'copy';
            evt.dataTransfer.setData(BG_MIME, item.dataset.file);
            evt.dataTransfer.setData('text/plain', item.dataset.file);
        });

        var bgDrop = $('st-bg-drop');
        bgDrop.addEventListener('dragover', function (evt) {
            if (!isBgDrag(evt)) return;              // 外部文件：不 preventDefault → 浏览器拒绝放下
            evt.preventDefault();
            evt.dataTransfer.dropEffect = 'copy';
            bgDrop.classList.add('is-over');
        });
        bgDrop.addEventListener('dragleave', function (evt) {
            if (!bgDrop.contains(evt.relatedTarget)) bgDrop.classList.remove('is-over');
        });
        bgDrop.addEventListener('drop', function (evt) {
            bgDrop.classList.remove('is-over');
            if (!isBgDrag(evt)) return;
            evt.preventDefault();
            var name = evt.dataTransfer.getData(BG_MIME);
            if (!state.scene || !name || (state.bg || []).indexOf(name) < 0) return;
            setSceneBackground(name);
        });

        /* ---- BGM：清单拖到竖轨落段；段内拖动按句吸附（整段平移 / 边缘改长度） ---- */
        var picker = $('st-bgm-picker');
        if (picker) picker.addEventListener('dragstart', function (evt) {
            var item = evt.target.closest && evt.target.closest('.st-bgm-file');
            if (!item) return;
            evt.dataTransfer.effectAllowed = 'copy';
            evt.dataTransfer.setData(BGM_MIME, item.dataset.file);
            evt.dataTransfer.setData('text/plain', item.dataset.file);
        });
        // 声效卡片：拖到时间轴声效轨落段
        var sfxPicker = $('st-sfx-picker');
        if (sfxPicker) sfxPicker.addEventListener('dragstart', function (evt) {
            var item = evt.target.closest && evt.target.closest('.st-sfx-file-card');
            if (!item) return;
            evt.dataTransfer.effectAllowed = 'copy';
            evt.dataTransfer.setData(SFX_MIME, item.dataset.file);
            evt.dataTransfer.setData('text/plain', item.dataset.file);
        });
        var sfxSearch = $('st-sfx-search');
        if (sfxSearch) sfxSearch.addEventListener('input', filterSfxPicker);
        var sfxClear = $('st-sfx-clear');
        if (sfxClear) sfxClear.addEventListener('click', function () {
            if (sfxSearch) sfxSearch.value = '';
            filterSfxPicker();
        });
        // 语音卡片：拖到时间轴语音轨落段（携带角色，落段时决定写 voice 还是 cues.voice）
        var voicePicker = $('st-voice-picker');
        if (voicePicker) voicePicker.addEventListener('dragstart', function (evt) {
            var item = evt.target.closest && evt.target.closest('.st-sfx-file-card');
            if (!item) return;
            evt.dataTransfer.effectAllowed = 'copy';
            evt.dataTransfer.setData(VOICE_MIME, item.dataset.file);
            evt.dataTransfer.setData('text/plain', 'voice:' + (item.dataset.role || '') + ':' + item.dataset.file);
        });
        var voiceSearch = $('st-voice-search');
        if (voiceSearch) voiceSearch.addEventListener('input', filterVoicePicker);
        var voiceClear = $('st-voice-clear');
        if (voiceClear) voiceClear.addEventListener('click', function () {
            if (voiceSearch) voiceSearch.value = '';
            filterVoicePicker();
        });
        var voiceRole = $('st-voice-role');
        if (voiceRole) voiceRole.addEventListener('change', function () { wbRenderVoicePicker(); });

        var track = $('st-bgm-track');
        if (track) {
            track.addEventListener('dragover', function (evt) {
                if (!isBgmDrag(evt)) return;          // 外部文件不接，浏览器拒绝放下
                evt.preventDefault();
                evt.dataTransfer.dropEffect = 'copy';
            });
            track.addEventListener('drop', function (evt) {
                if (!isBgmDrag(evt)) return;
                evt.preventDefault();
                var name = evt.dataTransfer.getData(BGM_MIME);
                if (!state.scene || !name || (state.bgmFiles || []).indexOf(name) < 0) return;
                var row = rowAtY(evt.clientY);
                if (row < 0) return;
                addBgmAt(name, row);
            });
            /* pointer 拖动：整段＝平移，上下把手＝改端点。
               delta 优先取「鼠标所在行 - 按下时所在行」，天然一格一格；
               拖出列表范围时用平均行高兜底。监听挂在 document 上，重绘也不丢事件。 */
            track.addEventListener('pointerdown', function (evt) {
                if (state.mode !== 'edit') return;
                var seg = evt.target.closest && evt.target.closest('.st-bgm-seg');
                if (!seg) return;
                evt.preventDefault();
                var j = Number(seg.dataset.j);
                var edgeEl = evt.target.closest && evt.target.closest('[data-bgm-edge]');
                var edge = edgeEl ? edgeEl.dataset.bgmEdge : 'move';
                var b = bgmList()[j];
                if (!b) return;
                var orig = bgmRange(b);
                var ol = $('st-lines');
                var n = ol.children.length;
                if (!n) return;
                var avgH = ol.getBoundingClientRect().height / n;
                var bounds = bgmFreeBounds(j, orig, n);
                var startY = evt.clientY;
                var startRow = rowAtY(startY);
                var moved = false;
                var last = orig.slice();
                state.bgmResizing = true;
                var prevSelect = document.body.style.userSelect;
                document.body.style.userSelect = 'none';
                selectBgm(j);

                function move(e) {
                    var row = rowAtY(e.clientY);
                    var d = (row >= 0 && startRow >= 0)
                        ? row - startRow
                        : Math.round((e.clientY - startY) / Math.max(1, avgH));
                    if (!moved && !d) return;
                    moved = true;
                    var nf = orig[0], nt = orig[1];
                    if (edge === 'move') {
                        var w = orig[1] - orig[0];
                        if (bounds.hi - bounds.lo >= w) {
                            nf = Math.max(bounds.lo, Math.min(bounds.hi - w, orig[0] + d));
                            nt = nf + w;
                        }
                    } else if (edge === 'from') {
                        nf = Math.max(bounds.lo, Math.min(orig[1], orig[0] + d));
                    } else {
                        nt = Math.max(orig[0], Math.min(bounds.hi, orig[1] + d));
                    }
                    if (nf === last[0] && nt === last[1]) return;
                    last = [nf, nt];
                    setBgmRange(b, nf, nt);
                    renderBgmTrack();
                    renderBgmDetail();
                }
                function up() {
                    document.removeEventListener('pointermove', move);
                    document.removeEventListener('pointerup', up);
                    document.removeEventListener('pointercancel', up);
                    document.body.style.userSelect = prevSelect;
                    state.bgmResizing = false;
                    if (moved && (last[0] !== orig[0] || last[1] !== orig[1])) {
                        markStale();
                        msg('BGM ' + b.file + ' 覆盖第 ' + last[0] + '–' + last[1] + ' 句');
                        if (state.bgmKey && state.bgmKey.indexOf('|' + b.file) >= 0) {
                            state.bgmKey = bgmKeyOf(b);   // 正在试听：续播，不重头
                        }
                    }
                    renderBgmTrack();
                    renderBgmDetail();
                }
                document.addEventListener('pointermove', move);
                document.addEventListener('pointerup', up);
                document.addEventListener('pointercancel', up);
            });
            /* 点段＝选中并在右侧出配置；点轨道空白处＝收起。
               pointerdown 里也会选中（拖动即时高亮），这里再兜一次纯 click/键盘触发。 */
            track.addEventListener('click', function (evt) {
                if (state.mode !== 'edit') return;
                var seg = evt.target.closest && evt.target.closest('.st-bgm-seg');
                if (!seg) { clearBgmSel(); return; }
                // 点轨后让搜索框失焦，紧接着按 Backspace 才是删段而不是删搜索词
                var ae = document.activeElement;
                if (ae && ae !== document.body && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) ae.blur();
                var j = Number(seg.dataset.j);
                if (state.bgmSel !== j) selectBgm(j);
            });
        }

        /* BGM 清单搜索 */
        $('st-bgm-search').addEventListener('input', filterBgmPicker);
        $('st-bgm-clear').addEventListener('click', function () {
            $('st-bgm-search').value = '';
            filterBgmPicker();
        });

        /* 右侧段配置：只保留淡入/淡出（区间靠拖段两端，试听靠双击曲目，删除靠 Backspace） */
        [['st-bgm-fadein', 'fadeIn', '淡入'], ['st-bgm-fadeout', 'fadeOut', '淡出']].forEach(function (pair) {
            $(pair[0]).addEventListener('click', function () {
                var b = bgmList()[state.bgmSel];
                if (!b) return;
                b[pair[1]] = !b[pair[1]];
                markStale();
                renderBgmDetail();
                msg('BGM ' + b.file + ' ' + (b[pair[1]] ? '开启' : '关闭') + pair[2]);
            });
        });

        $('st-add-line').addEventListener('click', addLine);

        $('st-title').addEventListener('input', function () {
            if (!state.scene) return;
            state.scene.title = this.value;
            markStale();
        });
        [['sw-month','month'], ['sw-day','day'], ['sw-week','week'], ['sw-notify','notify']].forEach(function (pair) {
            var el = $(pair[0]);
            if (!el) return;
            el.addEventListener('input', function () {
                var line = lines()[state.sel];
                if (!line) return;
                var sw = line.subwin || (line.subwin = {});
                var v = this.value;
                if (v === '' || v == null) delete sw[pair[1]];
                else sw[pair[1]] = pair[1] === 'notify' ? v : Number(v);
                if (!Object.keys(sw).length) delete line.subwin;
                ST.setSubwin(ST.subwinAt ? ST.subwinAt(state.sel) : sw);
                markStale();
            });
        });
        $('st-bg-search').addEventListener('input', filterBgGallery);
        $('st-bg-search').addEventListener('keydown', function (evt) {
            if (evt.key !== 'Enter') return;
            // 回车只提示，不直接套用：和点击一样，插入必须靠拖动
            var hits = [].filter.call($('st-bg-gallery').children, function (x) { return !x.hidden; });
            if (hits.length === 1) { evt.preventDefault(); msg('拖到时间轴背景轨才会写入本行（拖到图库区＝场景背景）'); }
        });
        $('st-bg-clear').addEventListener('click', function () {
            if (!state.scene) return;
            delete state.scene.background;
            markStale();
            syncBgCurrent();
            msg('已清除场景背景（跟随上一场景）');
        });
        $('st-bg-gallery').addEventListener('click', function (evt) {
            var item = evt.target.closest && evt.target.closest('.st-bg-item');
            // 点击＝预览大图；不写数据，插入仍靠拖动
            if (item) {
                previewBgInGallery(item.dataset.file);
                msg('已预览，拖到时间轴背景轨才会写入本行（拖到图库区＝场景背景）');
            }
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
            wbUpdateTextCount();
            markStale();
        });
        // 台词就地编辑：聚焦时记录原值；取消还原，完成只是收起编辑态（改动已实时写入）。
        (function () {
            var t = $('st-line-text'), snapshot = '';
            if (!t) return;
            t.addEventListener('focus', function () { snapshot = this.value; });
            var cancel = $('wb-text-cancel'), done = $('wb-text-done');
            // 阻止 mousedown 抢焦点，否则编辑条会先消失、click 落不到按钮上。
            if (cancel) cancel.addEventListener('mousedown', function (e) { e.preventDefault(); });
            if (done) done.addEventListener('mousedown', function (e) { e.preventDefault(); });
            if (cancel) cancel.addEventListener('click', function () {
                t.value = snapshot;
                t.dispatchEvent(new Event('input', { bubbles: true }));
                t.blur();
            });
            if (done) done.addEventListener('click', function () { t.blur(); });
        })();
        // AUTO 停顿 −／＋：沿用既有 input 校验，步进 100ms。
        (function () {
            var dec = $('wb-wait-dec'), inc = $('wb-wait-inc');
            function step(delta) {
                var w = $('st-wait');
                if (!w) return;
                var v = Number(w.value);
                w.value = String(Math.max(0, (isFinite(v) ? v : 0) + delta));
                w.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (dec) dec.addEventListener('click', function () { step(-100); });
            if (inc) inc.addEventListener('click', function () { step(100); });
        })();
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
        /* 角色卡里的「本行」是动态生成的，用容器上的事件委托。
           data-key=action/timeline/diff1/diff2 是下拉，macro 是输入；
           语音已移到右栏「角色语音库」与语音轨，卡内不再有 voice 控件。 */
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
        $('st-fade-ms').addEventListener('input', function () {
            // 场景级淡化时长（上下场 + 背景）；留空＝回到默认 300，写 0＝瞬间
            if (this.value === '') delete state.scene.fadeMs;
            else state.scene.fadeMs = Math.max(0, Number(this.value) || 0);
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
            if (!pick) { msg('角色表里没有更多可用角色了'); return; }
            // 左右交替给个初始站位，避免新角色叠在同一侧；位置随后在角色卡第二排调
            state.baseStage.push({ role: pick,
                x: used.length ? (used.length % 2 ? 0.4 : -0.4) : 0,
                y: 0, scale: 1, z: used.length });
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
            setPasteMsg('没识别出变量，请按每行一条粘贴：名称、数值、时长。', 'err');
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
        // SYSTEM / SKIP / PHONE 暂未接功能：先做成可点——给一帧原作橙字反馈，
        // 同样不当成「点了一下画面」去推进剧本。
        var pcbtTag = target.closest && target.closest('#st-pcbt .pcbt');
        if (pcbtTag) {
            evt.stopPropagation();
            pcbtTag.classList.add('is-pressed');
            if (pcbtTag.__pressTimer) clearTimeout(pcbtTag.__pressTimer);
            pcbtTag.__pressTimer = setTimeout(function () {
                pcbtTag.classList.remove('is-pressed');
                pcbtTag.__pressTimer = null;
            }, 280);
            return;
        }
        // 即时台词面板内的点击交给面板自己处理，不推进剧本
        // 角色卡（含绑定展开、存为宏）自己处理点击，别落到剧本行的删除/移动上
        if (target.closest && target.closest('#st-stage-list')) return;
        // 角色表页内的点击交给它自己的委托处理，不落到剧本行操作
        if (target.closest && target.closest('#st-view-cast')) return;
        if (state.mode !== 'edit') {
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
            else if (op.dataset.op === 'del-bgm') {
                delBgm(Number(op.dataset.j));
            }
            else delLine(i);
            return;
        }
        var li = target.closest && target.closest('.st-line');
        if (li) selectLine(Number(li.dataset.i));
    });

    document.addEventListener('change', function (evt) {
        if (evt.target.id === 'st-scene') switchScene(evt.target.value);
    });

    /* 编辑态：选中时间轴段（背景/BGM/声效/语音/立绘）或竖轨 BGM 段后，
       按 Backspace/Delete 删除；在输入框里打字时不劫持。 */
    document.addEventListener('keydown', function (evt) {
        if (state.mode !== 'edit') return;
        if (evt.key !== 'Backspace' && evt.key !== 'Delete') return;
        var t = evt.target;
        if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
        // 优先删时间轴选中的段；否则退回竖轨 BGM 段
        if (wb.selSeg) { evt.preventDefault(); wbDeleteSelectedSeg(); return; }
        if (state.bgmSel >= 0) { evt.preventDefault(); delBgm(state.bgmSel); }
    });

    document.addEventListener('keydown', function (evt) {
        if (state.mode !== 'play') return;
        // 场景下拉展开时由它自己处理方向键/回车；顶栏已移除时不影响播放快捷键
        var sceneMenu = $('st-scene-menu');
        if (sceneMenu && !sceneMenu.hidden) return;
        // 正在文本框/面板/下拉按钮里输入时不劫持按键
        if (evt.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(evt.target.tagName) ||
            (evt.target.closest && evt.target.closest('#st-scene-picker')))) return;
        if (evt.key === ' ' || evt.key === 'Enter' || evt.key === 'ArrowRight') {
            evt.preventDefault();
            step();
        }
    });

    // ---- 把工作台函数挂到 ST.workbench，供 story.js 的转发桩调用 ----
    ST.workbench = {
        renderList: renderList,
        stageNumInput: stageNumInput,
        flagOf: flagOf,
        renderRoster: renderRoster,
        actorCard: actorCard,
        modelShort: modelShort,
        mkSelect: mkSelect,
        mkLabelSelect: mkLabelSelect,
        effectiveStage: effectiveStage,
        lineMove: lineMove,
        setLineMove: setLineMove,
        clearLineMove: clearLineMove,
        setBasePos: setBasePos,
        castKeys: castKeys,
        syncBlinkRole: syncBlinkRole,
        onBlinkGlobalChange: onBlinkGlobalChange,
        wbLoadLaneOrder: wbLoadLaneOrder,
        wbSaveLaneOrder: wbSaveLaneOrder,
        wbCaptionShow: wbCaptionShow,
        wbPreviewPerform: wbPreviewPerform,
        wbPreviewTogglePlay: wbPreviewTogglePlay,
        wbSnapshot: wbSnapshot,
        wbHistoryLabel: wbHistoryLabel,
        wbPushHistory: wbPushHistory,
        wbScheduleHistory: wbScheduleHistory,
        wbFlushHistory: wbFlushHistory,
        wbUpdateHistButtons: wbUpdateHistButtons,
        wbRenderHistory: wbRenderHistory,
        wbGotoHistory: wbGotoHistory,
        wbApplySnapshot: wbApplySnapshot,
        wbUndo: wbUndo,
        wbRedo: wbRedo,
        wbRenderScenes: wbRenderScenes,
        wbNewScene: wbNewScene,
        wbDeleteScene: wbDeleteScene,
        wbMirrorDraw: wbMirrorDraw,
        wbPreviewSync: wbPreviewSync,
        wbPreviewSyncPump: wbPreviewSyncPump,
        wbPreviewApplyZoom: wbPreviewApplyZoom,
        wbSfxList: wbSfxList,
        wbRenderTimeline: wbRenderTimeline,
        wbSetRunField: wbSetRunField,
        wbRippleRun: wbRippleRun,
        wbRippleField: wbRippleField,
        wbResizeBackground: wbResizeBackground,
        wbResizeVoice: wbResizeVoice,
        wbResizeStage: wbResizeStage,
        wbRippleBgm: wbRippleBgm,
        wbSelectSeg: wbSelectSeg,
        wbClearSegSel: wbClearSegSel,
        wbDeleteSelectedSeg: wbDeleteSelectedSeg,
        wbClearRunField: wbClearRunField,
        wbClearStageSeg: wbClearStageSeg,
        wbRenderPlayhead: wbRenderPlayhead,
        wbLineDuration: wbLineDuration,
        wbPlayheadSweep: wbPlayheadSweep,
        wbPlayheadStop: wbPlayheadStop,
        wbFocus: wbFocus,
        wbZoom: wbZoom,
        wbValidate: wbValidate,
        wbRenderIssues: wbRenderIssues,
        wbFocusScript: wbFocusScript,
        wbRunSearch: wbRunSearch,
        hl: hl,
        esc: esc,
        wbSearchStep: wbSearchStep,
        wbRenderSfx: wbRenderSfx,
        filterSfxPicker: filterSfxPicker,
        addSfxAt: addSfxAt,
        refreshWorkbench: refreshWorkbench,
        wbLoadLayout: wbLoadLayout,
        wbSaveLayout: wbSaveLayout,
        bindDrawers: bindDrawers,
        saveDrawerState: saveDrawerState,
        loadDrawerState: loadDrawerState,
        wbDrawers: function () { return WbDrawers; },
        wbBindSplits: wbBindSplits,
        wbBind: wbBind,
        setTab: setTab,
        castTabOn: castTabOn,
        renderDrawer: renderDrawer,
        castItemRow: castItemRow,
        castDelBtn: castDelBtn,
        renderCastRoleList: renderCastRoleList,
        renderCastActList: renderCastActList,
        edEmpty: edEmpty,
        renderCastFields: renderCastFields,
        renderCastRoleFields: renderCastRoleFields,
        renderCastActFields: renderCastActFields,
        varNamesFor: varNamesFor,
        buildVarNameCell: buildVarNameCell,
        beginVarNameEdit: beginVarNameEdit,
        renderCastVars: renderCastVars,
        parsePastedVars: parsePastedVars,
        edSpan: edSpan,
        edInput: edInput,
        edField: edField,
        edSelectField: edSelectField,
        edHint: edHint,
        selCastAct: selCastAct,
        macroOptions: macroOptions,
        optionsFor: optionsFor,
        roleLabel: roleLabel,
        cueField: cueField,
        renderProps: renderProps,
        renderNameField: renderNameField,
        renderEditor: renderEditor,
        selectLine: selectLine,
        addLine: addLine,
        shiftLine: shiftLine,
        dropLine: dropLine,
        delLine: delLine,
        pauseForEdit: pauseForEdit,
        resumePlayback: resumePlayback,
        wbSetUrlScene: wbSetUrlScene,
        syncScenePicker: syncScenePicker,
        openSceneMenu: openSceneMenu,
        setSceneActive: setSceneActive,
        pickScene: pickScene,
        switchScene: switchScene,
        saveCurrent: saveCurrent,
        indexOfLi: indexOfLi,
        bindEditor: bindEditor,
        bindCastEditor: bindCastEditor,
        createCastRole: createCastRole,
        createCastAct: createCastAct,
        onCastFieldChange: onCastFieldChange,
        onCastFieldInput: onCastFieldInput,
        onCastFieldClick: onCastFieldClick,
        setPasteMsg: setPasteMsg,
        doPasteVars: doPasteVars,
        onVarFieldInput: onVarFieldInput,
        castRefs: castRefs,
        delCastRole: delCastRole,
        delCastAct: delCastAct,
        renameKey: renameKey,
        renameCastRole: renameCastRole,
        renameCastAct: renameCastAct,
    };
    // 重新绑定到 DOMContentLoaded：bindEditor 定义已在本文件
    document.addEventListener('DOMContentLoaded', function () { bindEditor(); });
})();
