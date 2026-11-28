/* 即时台词 LIVE（研究所页）。
   独立于 main.js / scene_ui.js 的 IIFE 组件，只暴露 window.SGLive。
   口型走 common/lipsync.js 的 AudioPlayer（getPlayer → window.SGPlayer），
   台词用自建台词条打字显示；角色固定为研究所当前模型（切换角色会重载页面）。 */
(function () {
    'use strict';

    var TYPE_MS = 28;
    var AUDIO_RE = /\.(opus|ogg|wav|mp3|m4a|flac|webm)$/i;

    var dock = null, panel = null, bubble = null, bubbleName = null, bubbleText = null;
    var roleEl = null, textEl = null, noteEl = null, fileInput = null, fileLabel = null;
    var folderSel = null, fileSel = null, sayBtn = null, stopBtn = null;
    var audio = null, playing = false, open = false;
    var seq = 0, typeTimer = null, blobUrl = null, src = 'file';

    function $(id) { return document.getElementById(id); }

    /* ---------- 目录索引（与 story.js / scene_ui.js 同源） ---------- */
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

    /* ---------- 当前角色：研究所只有一个已加载模型 ---------- */
    function currentRole() {
        var s = window.SGSceneUI || {};
        var f = s.currentModel || window.SG_CURRENT_MODEL || '';
        var info = (s.modelInfo && f) ? s.modelInfo(f) : null;
        var label = (info && (info.name || info.sub)) ? (info.name || info.sub) : f;
        return { file: f, label: label || '当前角色' };
    }

    function getPlayer() {
        return window.SGPlayer || (window.SGInteraction && window.SGInteraction.player) || null;
    }

    function ensureAudio() {
        if (!window.AudioPlayer) return null;
        if (!audio) {
            audio = new window.AudioPlayer({
                lipsync: { enabled: true, gain: 3.0, smoothMs: 30, updateFps: 30 }
            }, getPlayer);
        }
        return audio;
    }

    function note(msg, err) {
        if (!noteEl) return;
        noteEl.textContent = msg || '';
        noteEl.classList.toggle('err', !!err);
    }

    /* ---------- DOM ---------- */
    function mount() {
        if (panel && panel.isConnected) return true;
        var frag = document.createElement('div');
        frag.innerHTML = '' +
            '<button type="button" id="sg-live-dock" aria-controls="sg-live-panel" aria-expanded="false" ' +
            'title="即时台词：让研究所当前角色说一段自定义台词">即时台词<span>LIVE</span></button>' +

            '<section id="sg-live-panel" hidden aria-label="即时台词">' +
              '<div class="sg-live-head"><h2>即时台词 <small>LIVE</small></h2>' +
                '<button type="button" id="sg-live-close" title="关闭">×</button></div>' +

              '<label class="sg-live-field"><span>角色（研究所当前模型）</span>' +
                '<div id="sg-live-role"></div></label>' +
              '<label class="sg-live-field"><span>文字（打字机显示，可配合语音）</span>' +
                '<textarea id="sg-live-text" rows="3" placeholder="输入台词…"></textarea></label>' +

              '<div class="sg-live-src-title">语音来源</div>' +
              '<div class="sg-live-tabs">' +
                '<button type="button" data-src="file" class="is-active">本地文件</button>' +
                '<button type="button" data-src="list">音频库</button>' +
                '<button type="button" data-src="tts">TTS</button>' +
              '</div>' +
              '<div data-sg-src-pane="file">' +
                '<div class="sg-live-file-row">' +
                  '<label class="sg-live-file-btn" for="sg-live-file">选择文件</label>' +
                  '<span id="sg-live-file-name" class="sg-live-file-name">未选择文件</span>' +
                '</div>' +
                '<input type="file" id="sg-live-file" accept="audio/*">' +
              '</div>' +
              '<div data-sg-src-pane="list" hidden>' +
                '<select id="sg-live-folder" aria-label="音频文件夹"></select>' +
                '<select id="sg-live-sound" aria-label="音频文件"></select>' +
              '</div>' +
              '<div data-sg-src-pane="tts" hidden>' +
                '<div class="sg-live-note">需要服务端配置 EMOTE_TTS_BIN 才能合成。</div>' +
              '</div>' +

              '<div class="sg-live-ops">' +
                '<button type="button" id="sg-live-say" class="is-primary">开口说话</button>' +
                '<button type="button" id="sg-live-stop" disabled>停止</button>' +
              '</div>' +
              '<div id="sg-live-note" class="sg-live-note"></div>' +
            '</section>' +

            '<div id="sg-live-bubble" hidden aria-live="polite">' +
              '<b id="sg-live-bubble-name"></b><span id="sg-live-bubble-text"></span>' +
            '</div>';
        while (frag.firstChild) document.body.appendChild(frag.firstChild);

        dock = $('sg-live-dock');
        panel = $('sg-live-panel');
        bubble = $('sg-live-bubble');
        bubbleName = $('sg-live-bubble-name');
        bubbleText = $('sg-live-bubble-text');
        roleEl = $('sg-live-role');
        textEl = $('sg-live-text');
        noteEl = $('sg-live-note');
        fileInput = $('sg-live-file');
        fileLabel = $('sg-live-file-name');
        folderSel = $('sg-live-folder');
        fileSel = $('sg-live-sound');
        sayBtn = $('sg-live-say');
        stopBtn = $('sg-live-stop');
        refreshRole();
        bind();
        loadFolders();
        return true;
    }

    function refreshRole() {
        if (!roleEl) return;
        var r = currentRole();
        roleEl.innerHTML = '';
        roleEl.appendChild(document.createTextNode(r.label));
        var small = document.createElement('small');
        small.textContent = r.file ? r.file.replace(/^.*\//, '') : '未就绪';
        roleEl.appendChild(small);
    }

    function bind() {
        dock.addEventListener('click', function (e) {
            e.stopPropagation();
            setOpen(!open);
        });
        $('sg-live-close').addEventListener('click', function (e) {
            e.stopPropagation();
            setOpen(false);
        });
        panel.addEventListener('click', function (e) { e.stopPropagation(); });

        [].forEach.call(panel.querySelectorAll('.sg-live-tabs button'), function (b) {
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                setSrc(b.getAttribute('data-src'));
            });
        });

        fileInput.addEventListener('change', function () {
            var f = fileInput.files && fileInput.files[0];
            fileLabel.textContent = f ? f.name : '未选择文件';
            fileLabel.classList.toggle('has-file', !!f);
            if (!f) return;
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            blobUrl = URL.createObjectURL(f);
            if (audio) audio.bufferCache.delete(blobUrl);
            note(f.name, false);
        });

        folderSel.addEventListener('change', function () { loadFiles(folderSel.value); });
        sayBtn.addEventListener('click', function (e) { e.stopPropagation(); say(); });
        stopBtn.addEventListener('click', function (e) { e.stopPropagation(); stop(); });

        document.addEventListener('keydown', function (e) {
            if (open && e.key === 'Escape') setOpen(false);
        });
    }

    function setSrc(next) {
        src = next;
        [].forEach.call(panel.querySelectorAll('.sg-live-tabs button'), function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-src') === next);
        });
        [].forEach.call(panel.querySelectorAll('[data-sg-src-pane]'), function (p) {
            p.hidden = p.getAttribute('data-sg-src-pane') !== next;
        });
        note('', false);
    }

    async function loadFolders() {
        var items = await listDir('../../character/sounds/');
        var names = items.filter(function (x) { return x.isDir; }).map(function (x) { return x.name; });
        folderSel.innerHTML = '';
        names.forEach(function (n) {
            var o = document.createElement('option');
            o.value = n; o.textContent = n;
            folderSel.appendChild(o);
        });
        if (names.length) loadFiles(names[0]);
    }

    async function loadFiles(folder) {
        fileSel.innerHTML = '';
        if (!folder) return;
        var items = await listDir('../../character/sounds/' + encodeURIComponent(folder) + '/');
        items.filter(function (x) { return !x.isDir && AUDIO_RE.test(x.name); })
            .forEach(function (x) {
                var o = document.createElement('option');
                o.value = x.name; o.textContent = x.name;
                fileSel.appendChild(o);
            });
    }

    /* ---------- 播放 ---------- */
    function voiceUrl() {
        if (src === 'file') {
            if (!blobUrl) return Promise.reject(new Error('请先选择音频文件'));
            return Promise.resolve(blobUrl);
        }
        if (src === 'list') {
            var f = folderSel.value, s = fileSel.value;
            if (!f || !s) return Promise.reject(new Error('音频库中没有可播放的文件'));
            return Promise.resolve('../../character/sounds/' + encodeURIComponent(f) + '/' + encodeURIComponent(s));
        }
        var text = (textEl.value || '').trim();
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

    function setBusy(v) {
        playing = v;
        sayBtn.disabled = v;
        stopBtn.disabled = !v;
        bubble.classList.toggle('is-typing', v);
    }

    function say() {
        if (playing) return;
        var text = (textEl.value || '').trim();
        if (!text) { note('请先输入台词', true); textEl.focus(); return; }
        var player = getPlayer();
        if (!player) { note('当前角色模型尚未就绪', true); return; }
        var ap = ensureAudio();
        if (!ap) { note('音频模块未加载', true); return; }

        var my = ++seq;
        refreshRole();
        bubbleName.textContent = currentRole().label;
        bubbleText.textContent = '';
        bubble.hidden = false;
        setBusy(true);
        note('', false);

        var urlPromise;
        try { urlPromise = voiceUrl(); } catch (e) { urlPromise = Promise.reject(e); }
        urlPromise.then(function (url) { return ap.loadAndPlay(url); })
            .catch(function (err) {
                if (my === seq) note(err && err.message ? err.message : String(err), true);
            });

        var i = 0;
        (function tick() {
            if (my !== seq) return;
            if (i >= text.length) { setBusy(false); return; }
            bubbleText.textContent += text.charAt(i++);
            typeTimer = setTimeout(tick, TYPE_MS);
        })();
    }

    function stop() {
        if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
        seq++;
        setBusy(false);
        if (audio) audio.stop();
        note('已停止', false);
    }

    function setOpen(next) {
        if (!mount()) return false;
        open = !!next;
        panel.hidden = !open;
        dock.classList.toggle('is-active', open);
        dock.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) refreshRole();
        else {
            stop();
            note('', false);
            bubble.hidden = true;
        }
        return open;
    }

    /* SGSceneUI.ready 在模型加载前就 resolve，角色名要等 main.js 回写 currentModel 才有。
       未就绪时短暂轮询，界面一上来就能显示当前角色，不必等用户打开面板。 */
    var roleRetry = 0;
    function refreshRoleWhenReady() {
        refreshRole();
        if (roleEl && /未就绪/.test(roleEl.textContent) && roleRetry++ < 40) {
            setTimeout(refreshRoleWhenReady, 400);
        }
    }

    function init() {
        mount();
        refreshRoleWhenReady();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.SGLive = {
        mount: mount,
        open: function () { return setOpen(true); },
        close: function () { return setOpen(false); },
        toggle: function () { return setOpen(!open); },
        isOpen: function () { return open; },
        stop: stop,
        currentRole: currentRole,
        playing: function () { return playing; }
    };
})();
