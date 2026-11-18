/* sg-dialog.js —— 剧情模式的对话框，用从 main.psb.m 拆出的 MSGWIN / name 还原
 *
 *  数据来源：main.psb.m 的 MSGWIN.show（88 帧）与 name.wipe_*（30 帧）
 *    MSGWIN.show 0–59 帧：窗口底色擦入
 *                 0–29 帧：电路线擦入，30–59 帧反向擦出
 *                 50–58 帧：装饰线与名牌淡入
 *    MSGWIN.deco_show：装饰线从中心向外擦开（29 帧），白线闪层收尾
 *                      → AUTO 打开时装饰线跑「充能」：上排从左往右铺满、下排从名牌中心向两侧展开，
 *                        都亮起后下排先收、上排再从左往右收走；AUTO 关掉只是静止的淡描边
 *    name      20 帧：名牌底板擦入（白闪层领先半个身位，收尾时淡掉）
 *
 *  坐标系：一律 1920×1080，跟游戏的 UI 画布一致；整层按视口缩放居中，
 *          #st-hud 上挂 transform，内部元素全部写绝对像素。
 *
 *  限制：擦除遮罩是 E-mote 内置图案（PSB 里 src="#mask" 没有对应贴图），
 *        这里只能还原比例曲线，边界用「线性 + 软边」近似。
 */
(function (global) {
    'use strict';

    var W = 1920, H = 1080;
    var FPS = 30;
    var FEATHER = 46;                 // 软边宽度（1920 画布像素）

    var PLATE = { s: 226, m: 366, l: 466, ll: 646 };
    var PLATE_ORDER = ['s', 'm', 'l', 'll'];
    var PLATE_CX = 957;               // 名牌中心 = 960 + coord(-3)
    var PLATE_TOP = 1014;             // 名牌顶边（底边 1073）
    var NAME_PAD = 56;                // 左右对称留白：文字按底板几何中心居中
    var NAME_FONT = 30;               // 名牌上的字号（放不下就缩，不放大）
    var NAME_FONT_MIN = 15;
    /* 与 index.html 的 "SG Sans"（思源黑体 Medium）保持一致：
       名字在 DOM 里用什么字体，这里量宽就必须用什么字体，否则档位会选错 */
    var NAME_FAMILY = '"SG Sans","Source Han Sans SC","Noto Sans SC","Microsoft YaHei",sans-serif';
    var NAME_WEIGHT = 500;

    var el = {};
    /* openSpeed：开场 60 帧按 1.8 倍速跑（≈1.1 秒）。原速 2 秒在剧情页里太拖。 */
    var opt = { feather: FEATHER, speed: 1, openSpeed: 1.8, base: 'ui/' };
    var st = { open: 0, plate: 1, plateW: 0, name: null, raf: 0, fitRaf: 0, caret: true, decoRun: false, auto: false };

    /* 装饰线跑马灯：底图 1053×56 常亮，上面再叠一份提亮副本，
       靠 CSS 的 mask 光带 + animation 从左往右无限扫（周期 1.5s，见 index.html 的 sg-sweep）。 */
    var DECO_W = 1053, DECO_H = 56;

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function $(id) { return document.getElementById(id); }

    /* 线性擦除：reveal 0 全隐 / 1 全显，边界按 feather 像素做软过渡。
       宽度只量一次并缓存 —— 这个函数在开场 60 帧里每帧调好几次，
       每次都读 offsetWidth 会强制同步布局（layout thrashing）。 */
    function wipe(node, reveal, feather) {
        if (!node) return;
        var w = node.__wipeW;
        if (!w) {
            w = node.offsetWidth;
            if (w > 0) node.__wipeW = w;      // 还没布局完就别缓存，留到下次再量
        }
        if (!w) w = W;
        var f = ((feather == null ? opt.feather : feather) / w) * 100;
        var edge = reveal * (100 + f * 2) - f;
        var a = Math.max(-f, Math.min(100 + f, edge));
        var css = 'linear-gradient(90deg, #000 ' + a + '%, rgba(0,0,0,0) ' + (a + f) + '%)';
        node.style.webkitMaskImage = css;
        node.style.maskImage = css;
        node.style.visibility = reveal <= 0.0015 ? 'hidden' : 'visible';
    }

    /* ---------- 装饰线跑马灯 ---------- */

    /* 装饰线只搭一次骨架：暗态底图（AUTO 关闭时的常态）+ 两层高亮。
       亮/暗两态是两张烘焙好的图（deco_lit / deco_dim），不再用 filter 硬提亮。
       这 1053×56 的图里其实是两个件，动画规律不一样，必须拆开：
         上排主图案 —— 一条竖直硬边前沿从左扫到右、再扫一次收走（.deco-lit，CSS 里带 mask 动画）；
         下排居中短线 —— 从中间往两头张开再收回（.deco-chg，左右两片用 clip-path 推）。
       并且只有 .hud-deco.is-auto 时才 display，AUTO 关掉就纯静态、零动画开销。 */
    function buildDeco() {
        if (!el.deco || el.decoLit) return;
        var dimSrc = opt.base + 'deco_dim.webp';
        var litSrc = opt.base + 'deco_lit.webp';
        var base = document.createElement('img');
        base.className = 'deco-base';
        base.src = dimSrc;
        base.alt = '';
        base.width = DECO_W; base.height = DECO_H;
        el.deco.appendChild(base);

        var wrap = document.createElement('div');
        wrap.className = 'deco-lit';
        var inner = document.createElement('i');
        inner.style.backgroundImage = 'url("' + litSrc + '")';
        wrap.appendChild(inner);
        el.deco.appendChild(wrap);

        /* 下排短线：左片显示整图 0–526.5px、右片显示 526.5–1053px，
           各自从贴合中线的那一侧向外推（细节见 index.html 的 sg-chg-l / sg-chg-r） */
        var chg = document.createElement('div');
        chg.className = 'deco-chg';
        var halves = ['chg-l', 'chg-r'].map(function (cls) {
            var s = document.createElement('span');
            s.className = cls;
            s.style.backgroundImage = 'url("' + litSrc + '")';
            chg.appendChild(s);
            return s;
        });
        el.deco.appendChild(chg);

        el.decoBase = base;
        el.decoLit = wrap;
        el.decoChg = halves;
    }

    /* 打开 AUTO 时把扫光从头播一遍：清掉动画 → 强制回流 → 还回去，
       否则 CSS 动画会接着上一轮的时钟跑，可能一打开就是「暗着」的那 0.6s。
       两层要一起重启，不然上下两件会错开半个周期。 */
    function runDeco() {
        if (!el.deco || !el.decoLit) return;
        var nodes = [el.decoLit].concat(el.decoChg || []);
        nodes.forEach(function (n) { n.style.animation = 'none'; });
        void el.deco.offsetWidth;
        nodes.forEach(function (n) { n.style.animation = ''; });
    }

    /* AUTO 开关：打开才让装饰线「充能」，关掉就退回静态暗态（只有一层淡描边）。
       切换时重启动画，保证每一次打开都从「上排左→右铺满、下排中心张开」的第一帧开始。 */
    function setAuto(on) {
        st.auto = !!on;
        if (!el.deco) return;
        el.deco.classList.toggle('is-auto', st.auto);
        if (st.auto && st.open > 58) runDeco();
    }

    /* 60 帧窗口开场：底色擦入 / 电路线一闪 / 装饰与名牌跟上
       电路线（main/white）整层是纯白线稿，原速铺满会有 1 秒刺眼，
       这里压到 55% 亮度并缩成一次「扫过」的闪光（8 帧进、26 帧退）。 */
    function paintWindow(t) {
        st.open = t;
        wipe(el.win, clamp01(t / 59));
        var lines = t <= 8 ? clamp01(t / 8) : clamp01(1 - (t - 8) / 26);
        wipe(el.lines, lines);
        var a = clamp01((t - 50) / 8);
        if (el.deco) {
            el.deco.style.opacity = String(a);
            /* 装饰线在 50 帧露头，同时放跑马灯；窗口收回去时复位，下次开场能重跑 */
            if (a > 0.02 && !st.decoRun) { st.decoRun = true; runDeco(); }
            else if (a <= 0.02) st.decoRun = false;
        }
        paintPlate(a);
        if (el.hud) el.hud.classList.toggle('is-open', t > 58);
    }

    /* 名牌底板：白闪层领先 6% 擦入、随底板完成而淡掉；名字跟着底板一起显隐 */
    function paintPlate(v) {
        st.plate = clamp01(v);
        wipe(el.name, st.plate);
        if (el.nameText) el.nameText.style.opacity = String(st.plate);
        if (el.nameWhite) {
            wipe(el.nameWhite, clamp01((st.plate - 0.06) / 0.94), 12);
            el.nameWhite.style.opacity = String(1 - st.plate);
        }
    }

    function run(from, to, dur, fn, done) {
        if (st.raf) cancelAnimationFrame(st.raf);
        var t0 = 0;
        fn(from);
        st.raf = requestAnimationFrame(function step(ts) {
            if (!t0) t0 = ts;
            var k = Math.min(1, (ts - t0) / dur);
            fn(from + (to - from) * k);
            if (k < 1) st.raf = requestAnimationFrame(step);
            else { st.raf = 0; if (done) done(); }
        });
    }

    /* ---------- 名牌尺寸：按字数选档，放不下再缩字号 ---------- */

    var mctx = null;
    function measure(text, size) {
        if (!mctx) mctx = document.createElement('canvas').getContext('2d');
        mctx.font = NAME_WEIGHT + ' ' + size + 'px ' + NAME_FAMILY;
        return mctx.measureText(text).width;
    }

    function pickPlate(text) {
        var need = measure(text, NAME_FONT);
        for (var i = 0; i < PLATE_ORDER.length; i++) {
            var w = PLATE[PLATE_ORDER[i]];
            if (need <= w - NAME_PAD * 2) {
                return { size: PLATE_ORDER[i], width: w, font: NAME_FONT };
            }
        }
        // 最长那档也塞不下：用 ll，字号按比例缩到刚好
        var wMax = PLATE.ll;
        var avail = wMax - NAME_PAD * 2;
        var font = Math.max(NAME_FONT_MIN, Math.floor(NAME_FONT * avail / need));
        return { size: 'll', width: wMax, font: font };
    }

    /* 把底板 / 白闪层 / 名字文本三件套按选定档位摆好 */
    function layoutPlate(spec) {
        var left = PLATE_CX - spec.width / 2;
        st.plateW = spec.width;
        [el.name, el.nameWhite].forEach(function (n) {
            if (!n) return;
            n.style.left = left + 'px';
            n.style.width = spec.width + 'px';
            n.style.top = PLATE_TOP + 'px';
            n.__wipeW = 0;                  // 宽度换档了：让 wipe 下次重新量一次
        });
        el.nameImg.src = opt.base + 'nameplate_' + spec.size + '.webp';
        el.nameWhiteImg.src = el.nameImg.src;
        /* 文字盒 = 整块底板：居中交给 text-align，位置就恒等于底板中心 */
        el.nameText.style.left = left + 'px';
        el.nameText.style.width = spec.width + 'px';
        el.nameText.style.top = PLATE_TOP + 'px';
        el.nameText.style.fontSize = spec.font + 'px';
    }

    /* 换名字：空名字就把名牌整块收起来（与游戏里没记名字的行一致） */
    function setName(text) {
        if (!el.hud) return;
        var name = (text == null ? '' : String(text)).trim();
        if (!name) {
            st.name = '';
            el.nameText.textContent = '';
            paintPlate(0);
            if (el.deco) el.deco.style.opacity = '0';
            st.decoRun = false;
            return;
        }
        var changed = name !== st.name;
        st.name = name;
        el.nameText.textContent = name;
        layoutPlate(pickPlate(name));
        if (st.open <= 58) return;   // 开场还没铺完：显隐由 open() 的 60 帧自己推，别抢
        if (el.deco) el.deco.style.opacity = '1';
        // 换了名字就重擦一次名牌；装饰线的扫光一直在循环跑，不打断它
        if (changed) {
            st.decoRun = true;
            paintPlate(0);
            run(0, 1, (20 / FPS) * 1000 / opt.speed, paintPlate);
        } else {
            paintPlate(1);
        }
    }

    /* ---------- 缩放：以宽度铺满、底边贴视口底部 ---------- */

    function fit() {
        if (st.fitRaf) cancelAnimationFrame(st.fitRaf);
        st.fitRaf = requestAnimationFrame(function () {
            st.fitRaf = 0;
            /* 主体按宽度铺满；再用 800（窗口顶边 790 + 余量）兜底，
               极宽/超宽视口下不会把窗口条顶出画面 */
            var s = Math.min(global.innerWidth / W, global.innerHeight / 800);
            el.hud.style.transform = 'translate(-50%, 0) scale(' + s + ')';
        });
    }

    function setCaret(on) {
        st.caret = !!on;
        if (!el.hud) return;
        if (el.caret) el.caret.classList.toggle('is-off', !st.caret);
    }

    function init() {
        el.hud = $('st-hud');
        if (!el.hud) return null;
        el.win = el.hud.querySelector('[data-hud="win"]');
        el.lines = el.hud.querySelector('[data-hud="lines"]');
        el.deco = el.hud.querySelector('[data-hud="deco"]');
        el.name = el.hud.querySelector('[data-hud="name"]');
        el.nameWhite = el.hud.querySelector('[data-hud="name-white"]');
        el.nameImg = el.name.querySelector('img');
        el.nameWhiteImg = el.nameWhite.querySelector('img');
        el.nameText = $('st-name');
        el.caret = $('st-caret');

        buildDeco();
        paintWindow(0);
        paintPlate(0);
        fit();
        global.addEventListener('resize', fit);
        global.addEventListener('orientationchange', fit);
        /* 字体是异步就绪的：首帧量宽可能拿到回退字体的宽度，导致名牌档位偏大/偏小。
           字体就绪后按当前名字重新选档、重摆一次（只在窗口已铺开时重擦，不打断入场）。 */
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () {
                if (!st.name) return;
                layoutPlate(pickPlate(st.name));
                if (st.open > 58) paintPlate(1);
            });
        }
        return api;
    }

    var api = {
        init: init,
        open: function (done) {
            run(0, 59, (60 / FPS) * 1000 / (opt.speed * opt.openSpeed), paintWindow, done);
        },
        close: function (done) {
            run(59, 0, (60 / FPS) * 1000 / (opt.speed * opt.openSpeed), paintWindow, done);
        },
        setName: setName,
        /* AUTO 开关：只有开着的时候装饰线才跑「充能」，关掉退回静态暗态 */
        setAuto: setAuto,
        /* 直接跳到开场动画的第 t 帧（0–59），调试/预览用 */
        setWindow: function (t) { paintWindow(Math.max(0, Math.min(59, t))); },
        showName: function () { run(st.plate, 1, (20 / FPS) * 1000, paintPlate); },
        hideName: function () { run(st.plate, 0, (20 / FPS) * 1000, paintPlate); },
        setCaret: setCaret,
        setSpeed: function (v) { opt.speed = v > 0 ? v : 1; },
        options: opt,
        fit: fit,
        isOpen: function () { return st.open > 58; }
    };

    global.SGDialog = api;
})(window);
