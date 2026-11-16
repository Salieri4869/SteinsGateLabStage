// ============================================================
//  story.js —— 剧情模式：场景读取、播放器、可视化编辑与保存
//
//  依赖（顺序见 index.html）：common/ 下 SDK 脚本 + emote_core.js
//
//  播放：按行渲染 role / text / voice / action，背景取场景级 background；
//        行内写 background 可临时覆盖，下一行自动回到场景背景。
//  编辑：左列表选行、右面板改字段，点「保存」写盘（PUT /api/story）。
//        角色 / 背景 / 语音 / 动作全部由目录索引与 cast.json 生成下拉，
//        手打的地方只剩正文与自建动作的 timeline 名。
//
//  行字段：
//    role    cast.json 的键
//    text    正文
//    voice   cast[role].voiceDir 下的文件名，空/省略则不播
//    action  cast[role].actions 的键，或直接写 { timeline, diffSlot1, ... }
//    auto    为 true 时按 wait 毫秒自动推进，否则点击推进
//    wait    auto 行的停顿毫秒，默认 1200
// ============================================================
(function () {
    'use strict';

    var root = document.documentElement;
    var TYPE_MS = 28;             // 打字机每字间隔
    var AUTO_DEFAULT_MS = 1200;   // auto 行未写 wait 时的停顿

    var state = {
        scenes: [], cast: null, scene: null, file: '', model: '',
        ctx: null, idx: 0, mode: 'play', ended: false, stale: false,
        sel: 0, typing: false, typeTimer: null, autoTimer: null,
        typeDone: null, seq: 0, lineStart: 0,
        bg: null, models: null, voices: {},
        liveOpen: false, liveSrc: 'file', liveBusy: false, liveRole: '', voiceLib: []
    };
    var audio = null;

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
        return Object.keys(cast || {}).filter(function (k) { return k !== 'doc'; })[0] || '';
    }
    function modelOf(scene, cast) {
        var role = (scene.lines && scene.lines[0] && scene.lines[0].role) || firstRole(cast);
        return (cast[role] && cast[role].model) || '';
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
    var AUDIO_RE = /\.(opus|ogg|wav|mp3|m4a|flac)$/i;
    var MODEL_RE = /(\.zip|\.psb|\.psb\.m)$/i;

    async function loadBackgrounds() {
        var items = await listDir('../static/background/');
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
        var roots = (await listDir('../character/data/')).filter(function (x) { return x.isDir; });
        var groups = await Promise.all(roots.map(async function (d) {
            var files = await listDir('../character/data/' + encodeURIComponent(d.name) + '/');
            return {
                folder: d.name,
                models: files.filter(function (f) { return !f.isDir && MODEL_RE.test(f.name); })
                    .map(function (f) { return d.name + '/' + f.name; })
            };
        }));
        state.models = groups.filter(function (g) { return g.models.length; });
        if (state.mode === 'edit') renderCast();
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
    function setProgress() {
        var total = lines().length;
        var at = state.ended ? total : state.idx + 1;
        $('st-progress').textContent = total ? at + ' / ' + total : '';
    }

    function applyBackground(name) {
        document.body.style.backgroundImage = name
            ? 'url("../static/background/' + encodeURIComponent(name) + '")'
            : '';
    }

    /* 动作宏：timeline / diffSlot1 / diffSlot2 / variables；行内也可直接写对象 */
    function applyAction(line, role) {
        var player = state.ctx && state.ctx.player;
        if (!player || !line || !line.action) return;
        var act = line.action;
        if (typeof act === 'string') {
            var bound = state.cast && state.cast[role] && state.cast[role].actions;
            act = bound && bound[act];
        }
        if (!act || typeof act !== 'object') return;

        if (act.timeline) player.mainTimelineLabel = act.timeline;
        if (act.diffSlot1 !== undefined) player.diffTimelineSlot1 = act.diffSlot1 || '';
        if (act.diffSlot2 !== undefined) player.diffTimelineSlot2 = act.diffSlot2 || '';

        var base = Number.isFinite(act.duration) ? act.duration : 0;
        (act.variables || []).forEach(function (v) {
            if (!v || !v.name) return;
            player.setVariable(v.name, v.value, Number.isFinite(v.duration) ? v.duration : base);
        });
    }

    /* 返回 Promise<语音时长 ms>；失败或没写 voice 都 resolve(0) */
    function playVoice(line, castItem) {
        var file = line && line.voice;
        if (!file || !audio) return Promise.resolve(0);
        var url = ((castItem && castItem.voiceDir) || '') + file;
        return audio.loadAndPlay(url).then(function (buf) {
            return buf && buf.duration ? buf.duration * 1000 : 0;
        }).catch(function () { return 0; });
    }

    function typeText(text, done) {
        var el = $('st-text');
        el.textContent = '';
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

    function onTyped(line, voiceMs) {
        if (state.mode !== 'play') { setHint(''); return; }
        if (!line || !line.auto) { setHint('点击继续 ▸'); return; }
        setHint('自动推进…');
        var mySeq = state.seq;
        Promise.resolve(voiceMs).then(function (ms) {
            if (mySeq !== state.seq) return;
            var wait = Math.max(0, Number(line.wait) || 0);
            var elapsed = performance.now() - state.lineStart;
            var delay = ms > 0
                ? Math.max(0, ms - elapsed) + wait
                : (wait || AUTO_DEFAULT_MS);
            state.autoTimer = setTimeout(function () {
                if (mySeq !== state.seq) return;
                step();
            }, delay);
        });
    }

    function showEnd() {
        clearTimers();
        state.ended = true;
        state.typing = false;
        $('st-text').textContent = '— 完 —';
        setHint('点击重新开始');
        setProgress();
    }

    function renderLine(i) {
        var list = lines();
        if (i >= list.length) { showEnd(); return; }
        clearTimers();
        state.ended = false;
        state.idx = Math.max(0, i);
        state.lineStart = performance.now();

        var line = list[state.idx];
        var role = line.role || firstRole(state.cast);
        var castItem = state.cast && state.cast[role];

        $('st-name').textContent = role || '';
        applyBackground(line.background || (state.scene && state.scene.background));
        applyAction(line, role);
        setProgress();
        setHint('');

        var voiceMs = playVoice(line, castItem);
        typeText(line.text || '', function () { onTyped(line, voiceMs); });
    }

    /* 前进一步：打字中先补全，否则下一行 / 结束 / 重播 */
    function step() {
        if (state.mode !== 'play') return;
        if (skipTyping()) return;
        if (state.ended) { renderLine(0); return; }
        if (state.idx + 1 >= lines().length) { showEnd(); return; }
        renderLine(state.idx + 1);
    }

    /* ---------- 即时台词（独立于剧本，让当前立绘开口） ----------
       语音走本地服务 /api/voice：POST 导入音频（octet-stream）或文字合成 TTS（json）；
       GET?name=… 流式播放；未配 TTS 引擎时合成返回 501，前端提示降级。
       当前立绘由场景加载，角色下拉只决定动作宏集合——换造型仍走场景/剧本。 */

    function liveMsg(text, isErr) {
        var el = $('st-live-msg');
        el.textContent = text || '';
        el.classList.toggle('err', !!isErr);
    }

    function initLive() {
        // 角色下拉：来自 cast.json；默认选当前立绘对应角色
        var roles = Object.keys(state.cast || {}).filter(function (k) { return k !== 'doc'; });
        var current = '';
        var line0 = lines()[0];
        if (line0 && line0.role && roles.indexOf(line0.role) >= 0) current = line0.role;
        if (!current) current = roles[0] || '';
        state.liveRole = current;
        fillSelect($('st-live-role'), roles, current, '');
        renderLiveActions();

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
        $('st-live-refresh').addEventListener('click', loadVoiceLib);
        $('st-live-toggle').addEventListener('click', toggleLive);
        $('st-live-close').addEventListener('click', closeLive);
        $('st-live-say').addEventListener('click', liveSay);
        $('st-live-stop').addEventListener('click', liveStop);
        $('st-live-file').addEventListener('change', function () {
            liveMsg(this.files && this.files[0] ? '已选：' + this.files[0].name : '');
        });
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
        if (src === 'lib') loadVoiceLib();
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
        if (state.ctx && audio) audio.stop();
        $('st-name').textContent = state.liveRole || '';
        $('st-text').textContent = '';
        setHint('即时台词模式');
        liveMsg('');
    }
    function closeLive() {
        state.liveOpen = false;
        state.liveBusy = false;
        $('st-live').hidden = true;
        $('st-live-toggle').classList.remove('is-active');
        if (audio) audio.stop();
        // 回到剧本：重渲染当前行
        if (state.mode === 'play') renderLine(state.idx);
    }

    async function loadVoiceLib() {
        try {
            var r = await fetch('/api/voice', { cache: 'no-store' });
            var j = await r.json();
            state.voiceLib = j.files || [];
            fillSelect($('st-live-lib'), state.voiceLib, $('st-live-lib').value, '（无音频，请先导入）');
        } catch (err) {
            liveMsg('读取音频列表失败：' + err.message, true);
        }
    }

    /* 把本地文件导入到服务端 voices/，返回可播放 URL */
    function importSelectedVoice() {
        var f = $('st-live-file').files && $('st-live-file').files[0];
        if (!f) return Promise.reject(new Error('请先选择一个音频文件'));
        var ext = (f.name.split('.').pop() || 'opus').toLowerCase();
        var name = 'live-' + Date.now() + '.' + ext;
        return fetch('/api/voice?name=' + encodeURIComponent(name), {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f
        }).then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
          .then(function (x) {
              if (!x.r.ok || !x.j.ok) throw new Error(x.j.error || ('导入失败 ' + x.r.status));
              return x.j.url;
          });
    }

    function voiceUrlForPlay() {
        if (state.liveSrc === 'file') return importSelectedVoice();
        if (state.liveSrc === 'lib') {
            var name = $('st-live-lib').value;
            return Promise.resolve(name
                ? '/api/voice?name=' + encodeURIComponent(name)
                : Promise.reject(new Error('请先导入并选择音频')));
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
        if (!audio || !state.ctx) { liveMsg('立绘尚未就绪', true); return; }
        var text = $('st-live-text').value || '';
        liveStop();

        // 语音 URL（可能是异步上传/合成）；任一来源失败就只打字、不说话
        var urlPromise;
        try { urlPromise = voiceUrlForPlay(); }
        catch (err) { urlPromise = Promise.reject(err); }

        // 打字机 + 显示名字
        $('st-name').textContent = state.liveRole || '';
        var mySeq = ++state.seq;
        state.liveBusy = true;
        $('st-live-say').disabled = true;
        $('st-live-stop').disabled = false;
        liveMsg('');

        Promise.resolve(urlPromise).then(function (url) {
            if (!url || mySeq !== state.seq) return;
            liveMsg('播放中…');
            return audio.loadAndPlay(url).then(function () {
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
        if (act) applyAction({ action: act }, state.liveRole);
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
        if (audio) audio.stop();
        liveMsg('已停止');
    }

    /* ---------- 编辑器 ---------- */

    function markStale() { state.stale = true; }

    /* 重建面板时不要动正在输入的元素，否则光标会跳到末尾 */
    function setVal(el, value) {
        if (document.activeElement === el && el.value === value) return;
        el.value = value;
    }

    function fillSelect(el, values, current, emptyLabel) {
        el.innerHTML = '';
        if (emptyLabel) {
            var blank = document.createElement('option');
            blank.value = '';
            blank.textContent = emptyLabel;
            el.appendChild(blank);
        }
        (values || []).forEach(function (v) {
            var o = document.createElement('option');
            o.value = v;
            o.textContent = v;
            el.appendChild(o);
        });
        var want = current || '';
        el.value = want;
        if (want && el.value !== want) {
            var miss = document.createElement('option');
            miss.value = want;
            miss.textContent = want + '（缺失）';
            el.appendChild(miss);
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
                + '<span class="st-line-text"></span>'
                + '<span class="st-line-ops">'
                + '<button type="button" data-op="up" title="上移">▲</button>'
                + '<button type="button" data-op="down" title="下移">▼</button>'
                + '<button type="button" data-op="del" title="删除">✕</button>'
                + '</span>';
            li.querySelector('.st-line-idx').textContent = String(i + 1);
            li.querySelector('.st-line-role').textContent = line.role || '旁白';
            li.querySelector('.st-line-text').textContent = line.text || '';
            ol.appendChild(li);
        });
        if (state.sel >= lines().length) state.sel = Math.max(0, lines().length - 1);
        $('st-json-name').textContent = state.file;
        $('st-sel-idx').textContent = String(state.sel + 1);
    }

    function renderCast() {
        var box = $('st-cast-list');
        box.innerHTML = '';
        var roles = Object.keys(state.cast || {}).filter(function (k) { return k !== 'doc'; });
        if (!roles.length) {
            box.textContent = 'cast.json 为空';
            return;
        }
        roles.forEach(function (role) {
            var item = state.cast[role] || {};
            var cur = item.model || '';
            var label = document.createElement('label');
            label.className = 'st-field';
            var cap = document.createElement('span');
            cap.textContent = role;

            var sel = document.createElement('select');
            var blank = document.createElement('option');
            blank.value = '';
            blank.textContent = '（未绑定）';
            sel.appendChild(blank);
            (state.models || []).forEach(function (g) {
                var og = document.createElement('optgroup');
                og.label = g.folder;
                g.models.forEach(function (m) {
                    var o = document.createElement('option');
                    o.value = m;
                    o.textContent = m.slice(g.folder.length + 1);
                    og.appendChild(o);
                });
                sel.appendChild(og);
            });
            sel.value = cur;
            if (cur && sel.value !== cur) {
                var miss = document.createElement('option');
                miss.value = cur;
                miss.textContent = cur + '（缺失）';
                sel.appendChild(miss);
                sel.value = cur;
            }
            sel.addEventListener('change', function () {
                if (this.value) state.cast[role].model = this.value;
                else delete state.cast[role].model;
                markStale();
            });
            label.appendChild(cap);
            label.appendChild(sel);
            box.appendChild(label);
        });
    }

    function macroOptions(role) {
        var acts = (state.cast && state.cast[role] && state.cast[role].actions) || {};
        return Object.keys(acts);
    }

    function renderActionCustom(line) {
        var box = $('st-custom');
        var isObj = line.action && typeof line.action === 'object';
        box.hidden = !isObj;
        if (!isObj) return;
        $('st-macro-name').value = '';
        $('st-macro-tl').value = line.action.timeline || '';
        fillSelect($('st-macro-diff'), diffOptions(), line.action.diffSlot1 || '', '（无）');
    }

    function diffOptions() {
        var p = state.ctx && state.ctx.player;
        return (p && p.diffTimelineLabels) ? p.diffTimelineLabels.slice() : [];
    }

    function renderProps() {
        if (!state.scene) return;
        setVal($('st-title'), state.scene.title || '');
        fillSelect($('st-bg'), state.bg || [], state.scene.background || '', '（跟随上一场景）');

        var line = lines()[state.sel];
        $('st-sel-idx').textContent = String(state.sel + 1);
        if (!line) {
            $('st-role').innerHTML = '';
            $('st-voice').innerHTML = '';
            $('st-action').innerHTML = '';
            $('st-line-text').value = '';
            $('st-custom').hidden = true;
            return;
        }
        var role = line.role || firstRole(state.cast);
        fillSelect($('st-role'), Object.keys(state.cast || {}).filter(function (k) { return k !== 'doc'; }), role, '');
        setVal($('st-line-text'), line.text || '');

        var item = state.cast && state.cast[role];
        var dir = item && item.voiceDir;
        fillSelect($('st-voice'), (dir && state.voices[dir]) || [], line.voice || '', '（无语音）');
        if (dir && !state.voices[dir]) loadVoices(role);

        var acts = macroOptions(role);
        var actVal = typeof line.action === 'string' ? line.action : (line.action ? '__custom__' : '');
        var actionSel = $('st-action');
        actionSel.innerHTML = '';
        [{ v: '', t: '（不改变）' }, { v: '__custom__', t: '自定义…' }].forEach(function (o) {
            var el = document.createElement('option');
            el.value = o.v; el.textContent = o.t;
            actionSel.appendChild(el);
        });
        acts.forEach(function (name) {
            var o = document.createElement('option');
            o.value = name; o.textContent = name;
            actionSel.appendChild(o);
        });
        actionSel.value = actVal;

        renderActionCustom(line);

        $('st-auto').checked = !!line.auto;
        setVal($('st-wait'), Number.isFinite(line.wait) ? line.wait : AUTO_DEFAULT_MS);
        $('st-wait').disabled = !line.auto;
    }

    function renderEditor() {
        renderList();
        renderProps();
        renderCast();
    }

    function selectLine(i) {
        state.sel = i;
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

    function setMode(mode) {
        if (mode === 'edit' && state.liveOpen) closeLive();
        state.mode = mode;
        root.setAttribute('data-mode', mode);
        var buttons = document.querySelectorAll('.st-modes button');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-mode') === mode);
        }
        $('st-save').hidden = mode !== 'edit';
        if (mode === 'edit') {
            if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
            skipTyping();
            setHint('');
            renderEditor();
        } else if (state.stale) {
            state.stale = false;
            renderLine(0);
        } else if (state.ended) {
            setHint('点击重新开始');
        } else {
            setHint('点击继续 ▸');
        }
    }

    function applyScene(scene, cast) {
        state.sel = 0;
        if (state.mode === 'edit') renderEditor();
        return modelOf(scene, cast);
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
            var model = modelOf(scene, state.cast);
            /* wasm 一页只能起一次，换模型只能整页重载 */
            if (model && state.model && model !== state.model) {
                location.href = '?scene=' + encodeURIComponent(file);
                return;
            }
            state.file = file;
            state.scene = scene;
            applyScene(scene, state.cast);
            if (audio) audio.stop();
            if (state.mode === 'play') {
                state.stale = false;
                renderLine(0);
            } else {
                state.stale = true;
            }
            msg('已切换到 ' + file);
        } catch (err) {
            msg('切换失败：' + err.message);
        }
    }

    async function saveCurrent() {
        var btn = $('st-save');
        try {
            await putJson(state.file, state.scene);
            await putJson('cast.json', state.cast);
            var model = modelOf(state.scene, state.cast);
            state.stale = true;
            btn.textContent = '已保存';
            setTimeout(function () { btn.textContent = '保存'; }, 1600);
            if (model && model !== state.model) {
                state.model = model;
                msg('角色绑定已保存，刷新后使用新模型');
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
        $('st-voice').addEventListener('change', function () {
            var line = lines()[state.sel];
            if (!line) return;
            if (this.value) line.voice = this.value;
            else delete line.voice;
            markStale();
        });
        $('st-action').addEventListener('change', function () {
            var line = lines()[state.sel];
            if (!line) return;
            if (this.value === '__custom__') {
                line.action = { timeline: '', diffSlot1: '' };
            } else if (this.value) {
                line.action = this.value;
            } else {
                delete line.action;
            }
            markStale();
            renderProps();
            if (this.value === '__custom__') $('st-macro-name').focus();
        });
        $('st-macro-tl').addEventListener('input', function () {
            var line = lines()[state.sel];
            if (!line || typeof line.action !== 'object') return;
            line.action.timeline = this.value;
            markStale();
        });
        $('st-macro-diff').addEventListener('change', function () {
            var line = lines()[state.sel];
            if (!line || typeof line.action !== 'object') return;
            line.action.diffSlot1 = this.value;
            markStale();
        });
        $('st-macro-name').addEventListener('change', function () {
            var line = lines()[state.sel];
            if (!line || typeof line.action !== 'object') return;
            var name = this.value.trim();
            if (!name) return;
            var role = line.role || firstRole(state.cast);
            var item = state.cast[role] || (state.cast[role] = {});
            var acts = item.actions || (item.actions = {});
            acts[name] = line.action;
            line.action = name;
            markStale();
            renderProps();
            renderCast();
        });
        $('st-auto').addEventListener('change', function () {
            var line = lines()[state.sel];
            if (!line) return;
            if (this.checked) {
                line.auto = true;
                $('st-wait').disabled = false;
            } else {
                delete line.auto;
                delete line.wait;
                $('st-wait').value = AUTO_DEFAULT_MS;
                $('st-wait').disabled = true;
            }
            markStale();
        });
        $('st-wait').addEventListener('input', function () {
            var line = lines()[state.sel];
            if (!line) return;
            line.wait = Math.max(0, Number(this.value) || 0);
            markStale();
        });
    }

    /* head 里的脚本执行时控件还没解析，一律用事件委托 */
    document.addEventListener('click', function (evt) {
        var target = evt.target;
        var modeBtn = target.closest && target.closest('.st-modes button');
        if (modeBtn) { setMode(modeBtn.getAttribute('data-mode')); return; }
        if (target.closest && target.closest('#st-save')) { saveCurrent(); return; }
        // 即时台词面板内的点击交给面板自己处理，不推进剧本
        if (target.closest && target.closest('#st-live')) return;
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
        try {
            await loadIndex();
            state.cast = await getJson('cast.json');
            if (!state.file) throw new Error('story/scenes/ 下没有场景');
            state.scene = await getJson(state.file);
            state.model = modelOf(state.scene, state.cast);
            if (!state.model) throw new Error('cast.json 里没有可用模型绑定');

            $('st-save').disabled = false;
            state.ctx = await window.SGEmoteCore.create({
                canvas: $('canvas'),
                modelUrl: '../character/data/' + state.model
            });
            window.ST_CORE = state.ctx;
            /* 立绘垂直略偏上，给底部文本框让位 */
            state.layout = window.SGEmoteCore.createLayout(state.ctx.player, $('canvas'),
                { verticalOffsetRatio: 0.45 });

            audio = new window.AudioPlayer({ lipsync: { enabled: true, gain: 3.0, smoothMs: 30, updateFps: 30 } },
                function () { return state.ctx && state.ctx.player; });

            var dl = $('st-tl-list');
            (state.ctx.player.mainTimelineLabels || []).forEach(function (t) {
                var o = document.createElement('option');
                o.value = t;
                dl.appendChild(o);
            });

            applyScene(state.scene, state.cast);
            $('st-status').textContent = '';
            root.classList.add('st-ready');
            renderLine(0);
            initLive();
            loadBackgrounds();
            loadModels();
        } catch (err) {
            console.error('[Story] 启动失败', err);
            $('st-status').textContent = '载入失败：' + (err && err.message);
        }
    };
})();
