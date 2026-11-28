/* 左上角日历子窗口组件（subwindow.psb.m）。
   独立文件：不写进 story.js，只暴露 window.Subwin 并接管 ST.setSubwin / ST.setSubwinFromScene。
   图集 ui/subwindow.webp 按语义重排成规整网格，坐标可算，不再逐切片记 x/y/w/h/ox/oy。
   notify 四态：none=无通知 / mail=有短信（右上角静态小信封）/ recv=来短信（大信封动画 + 整窗右移）/ phone=来电。
   有短信与来短信是两个独立状态，不能混成一个。 */
(function () {
    'use strict';

    /* 图集布局（512x336，来自原始素材重排）：
       底板        y=0    x=0    w404 h156  origin(205,78)
       通知图标    y=160  大信封 x0 / 小信封 x144 / 电话 x178 / 点 x210
       数字 0..9   y=228  每格 32x47，origin(16,23)，x = 数字 × 32
       星期 日..六 y=280  每格 72x20，origin(36,10)，x = 星期 × 72
       因此数字/星期坐标直接由值算出，日期不需要 1..31 的查表。 */
    var F = {
        base: [0,0,404,156,205,78],
        recv: [0,160,72,50,36,25],
        mail: [144,160,30,20,15,10],
        phone:[178,160,28,26,14,13],
        dot:  [210,160,9,7,4,3]
    };
    var DIGIT = { y:228, w:32, h:47, ox:16, oy:23 };
    var WEEK  = { y:280, w:72, h:20, ox:36, oy:10 };

    function digit(n) { return [n * DIGIT.w, DIGIT.y, DIGIT.w, DIGIT.h, DIGIT.ox, DIGIT.oy]; }
    function weekday(d) { return [d * WEEK.w, WEEK.y, WEEK.w, WEEK.h, WEEK.ox, WEEK.oy]; }

    var D = {
        screen: [1920,1080],
        base: { coord: [-903,-457] },
        /* 月份/日期的十位 = 个位左移一个数字格（32px）。日期整体右移，避开月份与日期之间的小数点。 */
        slots: { month: [-12,3], monthTens: [-44,3], day: [65,3], dayTens: [33,3],
                 week: [124,15], mail: [103,-10], phone: [138,-13], dot: [10,22.666666] },
        /* 来短信动效：仅 recv 态整窗从 -903 右移到 -750，圆形大信封才完整露出。
           圆形头像中心相对 base 中心 (-127,0)。 */
        recv: { coord: [-750,-457], dx: -127, dy: 0 },
        /* 动画参数内联自 subwindow.psb.m.json 的 motion 片段（30fps），按句切换时播放。
           show        -1159→-903（30f）窗口滑入
           recv_show   -903→-750（16f）来短信右滑；recv_close 反向（t15→30）
           mail_recv_show    0→peak→1，角度 -90°→20°→0°（22f，过冲在 t15）
           mail_recv_close   1→0，角度 0°→90°（16f）
           mail_recv_anim    呼吸 1→peak→1（60f 循环）
           phone_call_show   0→peak→1（20f）；phone_call_close 1→0（15f） */
        anim: {
            fps: 30,
            slideRecvFrames: 16, slideBackFrames: 15,
            mail: { show: 22, close: 16, breathe: 60, fromAngle: -90, overAngle: 20, closeAngle: 90, peak: 1.15, overAt: 15 },
            phone: { show: 20, close: 15, peak: 1.15 }
        },
        digit: DIGIT, week: WEEK, frames: F,
        digitAt: digit, weekAt: weekday
    };

    var LAYERS = ['base', 'recv', 'month-tens', 'month', 'day-tens', 'day-ones', 'dot', 'week', 'mail', 'phone'];
    var wrap = null;
    var parts = {};
    var last = null;
    var animTimers = {};       // 各通知独立的收尾定时器
    var animSeq = 0;           // 状态切换序号，作废旧动画回调
    var firstSet = true;       // 首帧直接落位，不放弹出动画

    function icon(frame) {
        return { x: frame[0], y: frame[1], w: frame[2], h: frame[3], ox: frame[4], oy: frame[5] };
    }

    function autoInt(v, lo, hi, fallback) {
        if (v === '' || v == null || v === '现实' || v === 'auto') return fallback;
        var n = Number(v);
        if (!isFinite(n)) return fallback;
        n = Math.round(n);
        return n < lo || n > hi ? fallback : n;
    }

    function cssPx(name) {
        var v = parseFloat(getComputedStyle(wrap).getPropertyValue(name));
        return isFinite(v) ? v : 0;
    }

    /* HUD 按宽度缩放并贴底；视口偏矮时顶部会被 #st-bar 盖住。
       把子窗口整体下移到顶栏下方，而不是改图集内的相对坐标。 */
    function layout() {
        if (!wrap || !wrap.parentElement) return;
        var hud = wrap.parentElement;
        var designW = hud.offsetWidth || D.screen[0];
        var designH = hud.offsetHeight || D.screen[1];
        var scale = window.innerWidth / designW;
        if (!isFinite(scale) || scale <= 0) return;
        var hudTop = window.innerHeight - designH * scale;
        var bar = document.getElementById('st-bar');
        var minTop = (bar ? bar.getBoundingClientRect().bottom : 0) + cssPx('--sw-clearance');
        var naturalTop = D.screen[1] / 2 + D.base.coord[1] - icon(F.base).oy;
        wrap.style.top = Math.max(naturalTop, Math.ceil((minTop - hudTop) / scale)) + 'px';
    }

    function mount() {
        if (wrap && wrap.isConnected) return true;
        wrap = document.getElementById('st-subwin');
        if (!wrap) return false;
        wrap.setAttribute('data-subwin-version', '20261126-atlas-v3-generated-data');
        var baseIcon = icon(F.base);
        wrap.style.left = Math.round(D.screen[0] / 2 + D.base.coord[0] - baseIcon.ox) + 'px';
        if (!wrap.querySelector('.sw-base')) {
            var html = '';
            for (var i = 0; i < LAYERS.length; i++) {
                html += '<i class="sw-part sw-' + LAYERS[i] + '" aria-hidden="true"></i>';
            }
            wrap.innerHTML = html;
        }
        parts = {};
        for (var j = 0; j < LAYERS.length; j++) {
            parts[LAYERS[j]] = wrap.querySelector('.sw-' + LAYERS[j]);
        }
        layout();
        return true;
    }

    /* 图集切片放到子窗口坐标系：frame 是 [x,y,w,h,ox,oy]，left/top 是图标左上角。 */
    function place(el, frame, left, top) {
        if (!el) return;
        var ic = icon(frame);
        el.style.width = ic.w + 'px';
        el.style.height = ic.h + 'px';
        el.style.backgroundPosition = (-ic.x) + 'px ' + (-ic.y) + 'px';
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
    }

    function placeInSlot(el, frame, slot, dx) {
        var ic = icon(frame);
        var origin = icon(F.base);
        place(el, frame,
            origin.ox + slot[0] + (dx || 0) - ic.ox,
            origin.oy + slot[1] - ic.oy);
    }

    /* 通知态切换动画：按 JSON 的 show/close 关键帧播放，收尾时把元素落到最终位置。
       recv（大信封，带旋转）与 phone（电话，纯缩放）各有独立关键帧，互不串场。 */
    function animSec(frames) { return (frames / D.anim.fps) + 's'; }

    function playNotify(el, key, spec, next, prev, seq) {
        var leaving = prev === key && next !== key;
        var entering = next === key && prev !== key;
        if (!leaving && !entering) return;
        var dur = leaving ? spec.close : spec.show;
        var angle = leaving ? spec.closeAngle : spec.enterAngle;
        el.hidden = false;
        el.style.setProperty('--sw-anim-dur', animSec(dur));
        el.style.setProperty('--sw-anim-angle', angle + 'deg');
        el.classList.remove('is-anim-in', 'is-anim-out');
        /* 强制回流，保证连续切换同一个类也能重放动画 */
        void el.offsetWidth;
        el.classList.add(entering ? 'is-anim-in' : 'is-anim-out');
        if (animTimers[key]) clearTimeout(animTimers[key]);
        animTimers[key] = setTimeout(function () {
            if (seq !== animSeq) return;
            el.classList.remove('is-anim-in', 'is-anim-out');
            el.hidden = next !== key;
        }, dur / D.anim.fps * 1000);
    }

    function set(opts) {
        opts = opts || {};
        if (!mount()) return;
        var now = new Date();
        var monthFull = autoInt(opts.month, 1, 12, now.getMonth() + 1);
        var monthTens = Math.floor(monthFull / 10);
        var day = autoInt(opts.day, 1, 31, now.getDate());
        var dayTens = Math.floor(day / 10);
        var week = autoInt(opts.week, 0, 6, now.getDay());
        var notify = opts.notify;
        if (notify === '' || notify == null) notify = 'none';   // 行里清空＝无通知
        if (notify !== 'none' && notify !== 'recv' && notify !== 'mail' && notify !== 'phone') {
            notify = 'mail';
        }

        wrap.style.display = opts.show === false ? 'none' : '';
        /* 只有来短信态才右移；有短信态是普通日历坐标，不变位置。
           整窗滑动用 CSS transition（recv_show 16 帧 / recv_close 15 帧），首帧直接落位。 */
        var coord = notify === 'recv' ? D.recv.coord : D.base.coord;
        var sliding = !firstSet && last && last.notify !== notify;
        wrap.style.setProperty('--sw-slide-dur', animSec(sliding
            ? (notify === 'recv' ? D.anim.slideRecvFrames : D.anim.slideBackFrames) : 0));
        wrap.style.left = Math.round(D.screen[0] / 2 + coord[0] - icon(F.base).ox) + 'px';

        var seq = ++animSeq;
        var prevNotify = last ? last.notify : null;
        place(parts.base, F.base, 0, 0);
        /* 来短信态：圆形头像里的大信封，静止时按 JSON 的 60 帧呼吸缩放。 */
        placeInSlot(parts.recv, F.recv, [D.recv.dx, D.recv.dy], 0);
        parts.recv.style.setProperty('--sw-recv-scale', D.anim.mail.peak);
        parts.recv.style.setProperty('--sw-recv-dur', animSec(D.anim.mail.breathe));
        parts.phone.style.setProperty('--sw-phone-peak', D.anim.phone.peak);
        if (firstSet) { parts.recv.hidden = notify !== 'recv'; parts.phone.hidden = notify !== 'phone'; }
        playNotify(parts.recv, 'recv', {
            show: D.anim.mail.show, close: D.anim.mail.close,
            enterAngle: D.anim.mail.fromAngle, closeAngle: D.anim.mail.closeAngle
        }, notify, prevNotify, seq);
        playNotify(parts.phone, 'phone', {
            show: D.anim.phone.show, close: D.anim.phone.close,
            enterAngle: 0, closeAngle: 0
        }, notify, prevNotify, seq);

        /* 数字/星期坐标 = 值 × 格宽，日期按十位/个位拆开，无需 1..31 查表。 */
        parts['month-tens'].hidden = monthTens === 0;
        if (monthTens) placeInSlot(parts['month-tens'], digit(monthTens), D.slots.monthTens, 0);
        placeInSlot(parts.month, digit(monthFull % 10), D.slots.month, 0);
        parts['day-tens'].hidden = dayTens === 0;
        if (dayTens) placeInSlot(parts['day-tens'], digit(dayTens), D.slots.dayTens, 0);
        placeInSlot(parts['day-ones'], digit(day % 10), D.slots.day, 0);
        placeInSlot(parts.dot, F.dot, D.slots.dot, 0);
        placeInSlot(parts.week, weekday(week), D.slots.week, 0);
        placeInSlot(parts.mail, F.mail, D.slots.mail, 0);
        placeInSlot(parts.phone, F.phone, D.slots.phone, 0);

        /* 有短信：只有右上角静态小信封；来短信：小信封仍在，额外叠大信封动画并右移。 */
        parts.mail.hidden = notify !== 'mail' && notify !== 'recv';
        last = { month: monthFull, day: day, week: week, notify: notify, show: opts.show !== false };
        firstSet = false;
    }

    function setFromScene(scene) {
        if (!scene) return;
        set(scene.subwin || scene.date || {});
    }

    function patchStoryApi() {
        if (!window.ST) return false;
        window.ST.setSubwin = set;
        window.ST.setSubwinFromScene = setFromScene;
        return true;
    }

    function init() {
        mount();
        window.addEventListener('resize', function () {
            if (window.requestAnimationFrame) window.requestAnimationFrame(layout);
            else layout();
        });
        if (!patchStoryApi()) {
            var tries = 0;
            var timer = setInterval(function () {
                if (patchStoryApi() || ++tries > 20) clearInterval(timer);
            }, 50);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.Subwin = {
        mount: mount,
        set: set,
        setFromScene: setFromScene,
        data: D,
        current: function () { return last; }
    };
})();
