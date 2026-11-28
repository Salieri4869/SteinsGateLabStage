/* 系统菜单组件（menu.psb.m）。
   独立文件：不写进 story.js，只暴露 window.SysMenu；点击 SYSTEM 标签开关菜单。
   图集：11 张 ui/menu_row_XX.webp 竖排 25 帧 + 一张 ui/menu_static.webp（文字/图标 off/on）。
   逐帧只改 transform（视口 translateX + 精灵条 translateY），不写 background-position；
   数据内联，不读 JSON，不依赖运行时脚本。 */
(function () {
    'use strict';

    var A = {"stripW":560,"stripH":7000,"frameH":280,"frames":25,"staticW":10920,"staticH":144,"textY":0,"iconY":64,"textW":420,"textH":64,"iconW":80,"iconH":80};
    /* 每行：[组 key, 行首 y, 文字项[key, off/on 格号, off 矩形, on 矩形]..., 图标[格号, 矩形]]。
       坐标来自 menu.psb.m.json 的 normal/off/on 关键帧；save/load 各自是独立文字项，与 quick 项共用底座和图标。 */
    var R = [{"k":"backlog","y":84,"t":[["backlog",[0,1],[165,56,244,40],[158,52,317,55]]],"i":[[0,1],[450,8,70,68]]},{"k":"observer","y":168,"t":[["observer",[2,3],[138,45,267,40],[132,41,341,71]]],"i":[[2,3],[451,14,68,68]]},{"k":"qsave","y":262,"t":[["qsave",[4,5],[109,21,225,30],[91,17,264,46]],["save",[6,7],[292,55,138,40],[285,51,188,55]]],"i":[[4,5],[450,8,70,68]]},{"k":"qload","y":319,"t":[["qload",[8,9],[109,53,225,30],[91,49,264,46]],["load",[10,11],[291,87,140,40],[285,83,188,55]]],"i":[[6,7],[450,40,70,68]]},{"k":"tips","y":349,"t":[["tips",[12,13],[186,124,252,40],[183,120,317,55]]],"i":[[8,9],[476,76,70,68]]},{"k":"config","y":410,"t":[["config",[14,15],[241,146,194,40],[234,142,266,55]]],"i":[[10,11],[476,98,70,68]]},{"k":"fullscreen","y":474,"t":[["fullscreen",[16,17],[117,165,350,40],[110,161,390,55]]],"i":[[12,13],[476,117,70,68]]},{"k":"help","y":523,"t":[["help",[18,19],[298,199,140,40],[291,195,209,55]]],"i":[[14,15],[476,151,70,68]]},{"k":"title","y":710,"t":[["title",[20,21],[95,95,372,40],[88,91,412,55]]],"i":[[16,17],[476,48,70,68]]},{"k":"close","y":793,"t":[["close",[22,23],[95,95,324,40],[88,91,385,55]]],"i":[[18,19],[450,48,70,68]]},{"k":"exit","y":916,"t":[["exit",[24,25],[130,55,290,40],[123,51,351,55]]],"i":[[20,21],[450,8,70,68]]}];

    /* 25 帧按原作 30fps 采样，但以 60fps 播放（整体约 0.75s，不再像慢动作）；
       逐行错开 2 播放帧，横移 -30→0 用 29 帧，擦入 14 帧，白闪到 24 帧。 */
    var T = { fps: 60, stagger: 2, slide: 29, wipe: 14, flash: 24 };

    var wrap = null;
    var stage = null;
    var rows = [];
    var items = [];
    var open = false;
    var raf = 0;
    var seq = 0;

    /* 菜单是完整 1920×1080 画面，按 contain 等比缩放并贴画面左上角。
       HUD 用 800 基准贴底（对话框专用）会裁掉菜单顶部；居中又会在左边留黑边，故单独适配。 */
    function fit() {
        if (!stage) return 1;
        var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
        if (!isFinite(s) || s <= 0) s = 1;
        stage.style.transform = 'scale(' + s + ')';
        return s;
    }

    function mount() {
        if (wrap && wrap.isConnected) return true;
        wrap = document.getElementById('st-sysmenu');
        if (!wrap) return false;
        wrap.setAttribute('data-menu-version', '20261127-strip-v4-left');
        wrap.innerHTML = '<div class="mn-scrim" aria-hidden="true"></div><div class="mn-stage"></div>';
        stage = wrap.querySelector('.mn-stage');
        fit();
        var built = [];
        var hits = [];
        for (var i = 0; i < R.length; i++) {
            var r = R[i];
            var row = document.createElement('div');
            row.className = 'mn-row';
            row.setAttribute('data-row-key', r.k);
            row.style.top = r.y + 'px';

            var viewport = document.createElement('div');
            viewport.className = 'mn-viewport';
            var strip = document.createElement('div');
            strip.className = 'mn-strip';
            strip.style.backgroundImage = 'url(ui/menu_row_' + (i < 10 ? '0' : '') + i + '.webp)';
            strip.style.backgroundSize = A.stripW + 'px ' + A.stripH + 'px';
            strip.style.transform = 'translateY(' + (-(A.frames - 1) * A.frameH) + 'px)';
            viewport.appendChild(strip);
            row.appendChild(viewport);

            /* 图标不叠高亮层：原作只有文字变黄，on 图标的锚点与底座不一致，叠上去会在上一行留下橙线。 */

            var texts = [];
            for (var j = 0; j < r.t.length; j++) {
                var t = r.t[j];
                var box = document.createElement('span');
                box.className = 'mn-text';
                box.setAttribute('data-item-key', t[0]);
                var on = document.createElement('span');
                on.className = 'mn-on mn-text-on';
                on.style.left = t[3][0] + 'px';
                on.style.top = t[3][1] + 'px';
                on.style.width = t[3][2] + 'px';
                on.style.height = t[3][3] + 'px';
                on.style.backgroundPosition = (-t[1][1] * A.textW) + 'px ' + (-A.textY) + 'px';
                box.appendChild(on);
                row.appendChild(box);

                var hit = document.createElement('button');
                hit.type = 'button';
                hit.className = 'mn-hit';
                hit.setAttribute('aria-label', t[0] === 'close' ? 'close' : t[0]);
                hit.style.left = Math.max(0, t[2][0] - 6) + 'px';
                hit.style.top = Math.max(0, t[2][1] - 6) + 'px';
                hit.style.width = (t[2][2] + 12) + 'px';
                hit.style.height = (t[2][3] + 12) + 'px';
                /* 组的第一个文字项兼管图标命中区。 */
                if (j === 0) {
                    var right = Math.max(t[2][0] + t[2][2], r.i[1][0] + r.i[1][2]);
                    hit.style.width = (right - Math.max(0, t[2][0] - 6) + 6) + 'px';
                }
                row.appendChild(hit);
                texts.push({ box: box, hit: hit, key: t[0] });
                hits.push(hit);
                bindHover(hit, box);
            }
            stage.appendChild(row);
            built.push({ row: row, viewport: viewport, strip: strip, texts: texts, frame: -1, dx: null });
        }
        rows = built;
        items = hits;
        return true;
    }

    function bindHover(hit, box) {
        var enter = function () { box.classList.add('is-over'); };
        var leave = function () { box.classList.remove('is-over'); };
        hit.addEventListener('mouseenter', enter);
        hit.addEventListener('mouseleave', leave);
        hit.addEventListener('focus', enter);
        hit.addEventListener('blur', leave);
    }

    function draw(i, frame, dx) {
        var r = rows[i];
        if (r.frame !== frame) {
            r.strip.style.transform = 'translateY(' + (-frame * A.frameH) + 'px)';
            r.frame = frame;
        }
        if (r.dx === null || Math.abs(r.dx - dx) > 0.005) {
            r.viewport.style.transform = 'translateX(' + dx.toFixed(2) + 'px)';
            r.dx = dx;
        }
    }

    function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    }

    /* 展开按 show 关键帧正放；收起反向播放同一批帧（hide 与之对称）。 */
    function animate(showing) {
        stop();
        var id = ++seq;
        var start = null;
        function tick(now) {
            if (id !== seq) return;
            if (start === null) start = now;
            var f = (now - start) / (1000 / T.fps);
            var done = true;
            for (var i = 0; i < rows.length; i++) {
                var local = f - i * T.stagger;
                if (local < 0) local = 0;
                var frame, dx;
                if (showing) {
                    frame = Math.min(A.frames - 1, Math.floor(local));
                    dx = -30 * Math.max(0, 1 - local / T.slide);
                } else {
                    frame = Math.max(0, (A.frames - 1) - Math.floor(local));
                    dx = -30 * Math.min(1, local / T.slide);
                }
                draw(i, frame, dx);
                if (local < T.slide || local < T.flash) done = false;
            }
            if (!done) raf = requestAnimationFrame(tick);
            else {
                raf = 0;
                for (var j = 0; j < rows.length; j++) draw(j, showing ? A.frames - 1 : 0, 0);
                if (!showing) finishClose();
            }
        }
        raf = requestAnimationFrame(tick);
    }

    function finishClose() {
        wrap.classList.remove('is-open');
        wrap.setAttribute('aria-hidden', 'true');
        var sys = document.querySelector('#st-pcbt .pcbt-system');
        if (sys) { sys.classList.remove('is-on'); sys.setAttribute('aria-pressed', 'false'); }
        closeScenePanel();
        resumeStory();
    }

    /* 打开菜单时冻结当前句：语音暂停在播放位置、打字 timer 与 AUTO 定时都清掉，
       但不切 mode、不隐藏 HUD，关闭后从原处继续。 */
    var storyPaused = false;
    function pauseStory() {
        var wb = window.ST && window.ST.workbench;
        if (!wb || !wb.pauseForEdit || storyPaused) return;
        try { wb.pauseForEdit(); storyPaused = true; } catch (_) {}
    }
    function resumeStory() {
        var wb = window.ST && window.ST.workbench;
        if (!wb || !wb.resumePlayback || !storyPaused) return;
        try { wb.resumePlayback(); } catch (_) {}
        storyPaused = false;
    }

    function setOpen(next) {
        if (!mount()) return false;
        if (next === open) return open;
        open = next;
        if (open) {
            pauseStory();
            wrap.classList.add('is-open');
            wrap.setAttribute('aria-hidden', 'false');
            var sys = document.querySelector('#st-pcbt .pcbt-system');
            if (sys) { sys.classList.add('is-on'); sys.setAttribute('aria-pressed', 'true'); }
        }
        animate(open);
        return open;
    }

    function pressSystem() {
        var sys = document.querySelector('#st-pcbt .pcbt-system');
        if (!sys) return;
        sys.classList.add('is-pressed');
        if (sys.__pressTimer) clearTimeout(sys.__pressTimer);
        sys.__pressTimer = setTimeout(function () {
            sys.classList.remove('is-pressed');
            sys.__pressTimer = null;
        }, 280);
    }

    /* OBSERVER：用与系统菜单同一套视觉语言展示剧本列表。 */
    var scenePanel = null;
    function ensureScenePanel() {
        if (scenePanel && scenePanel.isConnected) return scenePanel;
        var p = document.createElement('div');
        p.className = 'mn-scene';
        p.setAttribute('aria-hidden', 'true');
        p.innerHTML = '<div class="mn-scene-head"><span class="mn-scene-mark">OBSERVER</span>' +
            '<span class="mn-scene-title">剧本选择</span></div><div class="mn-scene-list"></div>' +
            '<button type="button" class="mn-scene-close" aria-label="close">CLOSE</button>';
        stage.appendChild(p);
        scenePanel = p;
        return p;
    }
    function openScenePanel() {
        var p = ensureScenePanel();
        var list = p.querySelector('.mn-scene-list');
        var st = window.ST || {};
        var scenes = (st.state && st.state.scenes) || [];
        var current = st.state && st.state.file;
        list.innerHTML = '';
        scenes.forEach(function (s) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'mn-scene-item' + (s.file === current ? ' is-active' : '');
            b.setAttribute('data-file', s.file);
            b.innerHTML = '<span class="mn-scene-name"></span><span class="mn-scene-file"></span>';
            b.querySelector('.mn-scene-name').textContent = s.title || s.file;
            b.querySelector('.mn-scene-file').textContent = s.file;
            list.appendChild(b);
        });
        p.classList.add('is-open');
        p.setAttribute('aria-hidden', 'false');
    }
    function closeScenePanel() {
        if (!scenePanel) return;
        scenePanel.classList.remove('is-open');
        scenePanel.setAttribute('aria-hidden', 'true');
    }
    function scenePanelOpen() { return !!(scenePanel && scenePanel.classList.contains('is-open')); }

    function activate(key) {
        if (key === 'close') { setOpen(false); return; }
        if (key === 'fullscreen') {
            if (document.fullscreenElement) {
                if (document.exitFullscreen) document.exitFullscreen();
            } else if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen();
            }
            setOpen(false);
            return;
        }
        if (key === 'title') { location.href = '../../index.html'; return; }
        if (key === 'config') {
            var f = (window.ST && window.ST.state && window.ST.state.file) || '';
            location.href = '../edit/index.html' + (f ? '?scene=' + encodeURIComponent(f) : '');
            return;
        }
        if (key === 'observer') { openScenePanel(); return; }
    }

    function onClick(e) {
        var t = e.target;
        if (t.closest && t.closest('#st-pcbt .pcbt-system')) {
            e.preventDefault();
            e.stopPropagation();
            pressSystem();
            setOpen(!open);
            return;
        }
        if (!open) return;
        if (t.closest && t.closest('#st-sysmenu .mn-scene')) {
            e.preventDefault();
            e.stopPropagation();
            var item = t.closest('.mn-scene-item');
            if (item) {
                var wb = window.ST && window.ST.workbench;
                if (wb && wb.switchScene) {
                    try { wb.switchScene(item.getAttribute('data-file')); } catch (_) {}
                }
                setOpen(false);
            } else if (t.closest('.mn-scene-close')) closeScenePanel();
            return;
        }
        if (t.closest && t.closest('#st-sysmenu .mn-hit')) {
            e.preventDefault();
            e.stopPropagation();
            var hit = t.closest('#st-sysmenu .mn-hit');
            var key = hit.getAttribute('aria-label');
            if (key === 'close') setOpen(false);
            else {
                hit.classList.add('is-pressed');
                setTimeout(function () { hit.classList.remove('is-pressed'); }, 280);
                activate(key);
            }
            return;
        }
        /* 菜单打开时画面上任何其它位置都只关菜单，不推进剧本。 */
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
    }

    function onKey(e) {
        if (open && e.key === 'Escape') {
            e.preventDefault();
            if (scenePanelOpen()) closeScenePanel();
            else setOpen(false);
        }
    }

    function init() {
        mount();
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', fit);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.SysMenu = {
        mount: mount,
        open: function () { return setOpen(true); },
        close: function () { return setOpen(false); },
        toggle: function () { return setOpen(!open); },
        isOpen: function () { return open; },
        fit: fit,
        data: { atlas: A, rows: R, timing: T },
        items: function () { return items.slice(); },
        observer: openScenePanel,
        scenePanelOpen: scenePanelOpen,
        isStoryPaused: function () { return storyPaused; }
    };
})();
