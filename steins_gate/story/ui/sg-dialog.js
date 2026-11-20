/* sg-dialog.js —— 剧情模式的对话框，用从 main.psb.m 拆出的 MSGWIN / name 还原
 *
 *  素材：main.psb/tex#000-texture.png 里上下排着 5 块 1920×290 的对话框层，
 *        全部按原矩形切出、无损转 webp（ui/msgwin_1..5_*.webp），开场 60 帧里都用上：
 *          1_lines 白色电路线（線のみ / 線のみ反転 两次擦除用的同一张）
 *          2_grad  灰渐变窗底（ベースグラデ 下的 ウィンドウ）
 *          3_dark  深色窗芯（中间那块黑色区域）
 *          4_dim   暗灰电路线（常态留在窗口上的装饰）
 *          5_mid   中间调电路线（白线转灰的过渡）
 *        另有 nameplate_* / namedeco_* / auto_* 等小件来自 tex#000 / tex#001。
 *
 *  数据来源：main.psb.m 的 MSGWIN.show（88 帧）与 name.wipe_*（30 帧）
 *    MSGWIN.show 0–59 帧：白线两侧擦入（0–29）、反向擦出（30–59）；窗底渐变 0–59 擦入
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
    var MEASURE_PX = 240;             // 量字体度量用的字号：够大，按比例缩回小字号时误差 < 0.05px
    var PLATE_H = 59;                 // 底板素材高度（四档一样）
    var PLATE_MID = 25.5;
    var NAME_FAMILY = '"Source Han Sans SC","Noto Sans SC","Microsoft YaHei",sans-serif';
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

    /* 两侧向中间的对称擦入：reveal 0 全隐 / 1 全显。
       录像里白线是从左右两头往中间铺（第 1 帧只有边框和角标、第 2 帧才铺满），
       单向的 linear wipe 会从最左边一路推到右，完全不是那个形状。 */
    function wipeSides(node, reveal) {
        if (!node) return;
        if (reveal >= 0.999) {                 // 完全合拢时撤掉遮罩，别在正中留一条透明缝
            node.style.webkitMaskImage = 'none';
            node.style.maskImage = 'none';
            node.style.visibility = 'visible';
            return;
        }
        var a = clamp01(reveal) * 50;
        var f = Math.min(3, Math.max(0, 50 - a) * 2 + 0.2);   // 快合拢时收窄软边，别在正中留一条缝
        var css = 'linear-gradient(90deg, #000 0%, #000 ' + Math.max(0, a - f) + '%,'
            + ' rgba(0,0,0,0) ' + a + '%, rgba(0,0,0,0) ' + (100 - a) + '%,'
            + ' #000 ' + Math.min(100, 100 - a + f) + '%, #000 100%)';
        node.style.webkitMaskImage = css;
        node.style.maskImage = css;
        node.style.visibility = reveal <= 0.0015 ? 'hidden' : 'visible';
    }

    /* 整层淡入（不做擦除），用于窗芯与常态电路线 */
    function fadeLayer(node, alpha, max) {
        if (!node) return;
        var a = clamp01(alpha) * (max == null ? 1 : max);
        node.style.opacity = String(a);
        node.style.visibility = a <= 0.002 ? 'hidden' : 'visible';
    }

    /* 中间那块深色窗芯：从正中向左右撑开（录像第 3→4 帧黑色区域由窄变宽） */
    function openCenter(node, reveal, max) {
        if (!node) return;
        var r = clamp01(reveal);
        var x = (1 - r) * 50;
        node.style.clipPath = 'inset(0 ' + x + '% 0 ' + x + '%)';
        fadeLayer(node, r, max);
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

    /* 60 帧窗口开场，5 层素材全部参与（都是 tex#000 里同一张 1920×290 的五个变体）：
         0–18   白色电路线从左右两头往中间擦入（录像第 1→2 帧：先是稀疏边框/角标，再铺满）
         14–34  中间调电路线淡入，把纯白线过渡成灰白（第 3 帧）
         20–46  深色窗芯从正中向两侧撑开、暗灰电路线随后亮起（第 3→4 帧的黑窗口与倒 V 装饰）
         46–59  四层电路线/窗芯陆续淡出，窗口回到 MSGWIN.normal 的干净常态（第 5 帧）
         50–58  装饰线与名牌淡入
       PSB 的 MSGWIN.show 里 線のみ / 線のみ反転 是同一张 white 用两个内置遮罩擦入、擦出；
       MSGWIN.normal 只留 ウィンドウ 一层 —— 所以常态不该有铺满的电路线。 */
    function paintWindow(t) {
        st.open = t;

        wipeSides(el.win, clamp01(t / 59));                 // 灰渐变窗底：0–59 擦入，与 PSB ベースグラデ 同长

        var lineIn = clamp01(t / 18);
        var lineOut = clamp01((t - 26) / 20);
        var lineReveal = t <= 26 ? lineIn : 1 - lineOut;
        wipeSides(el.lines, lineReveal);                    // 白线：先对称擦入，再对称擦出
        fadeLayer(el.lines, lineReveal * 0.9, 1);

        var midIn = clamp01((t - 14) / 12);
        var midOut = clamp01((t - 34) / 14);
        fadeLayer(el.mid, Math.min(midIn, 1 - midOut) * 0.85, 1);   // 中间调线：白转灰的过渡

        var dimIn = clamp01((t - 28) / 12);
        var dimOut = clamp01((t - 44) / 14);
        fadeLayer(el.dim, Math.min(dimIn, 1 - dimOut) * 0.9, 1);     // 暗灰线：第 4 帧的倒 V 装饰

        var darkIn = clamp01((t - 20) / 20);
        var darkOut = clamp01((t - 44) / 14);
        openCenter(el.dark, darkIn, 0.92);                  // 深色窗芯：从正中撑开
        if (el.dark) el.dark.style.opacity = String(darkIn * 0.92 * (1 - darkOut));

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

    /* 线性补间：起点用调用时刻的 performance.now()，不用 rAF 的 ts。
       原因：模型加载会把主线程堵住一两秒，期间 rAF 队列里积压的帧带着
       「阻塞之前」的旧时间戳（实测首帧 ts 比真正调用早 1.08s）。
       拿它当 t0，第二帧算出的进度就已经 >1，1.1 秒的开场被一帧跳到底——
       表现就是「进剧情模式时对话框已经铺好了」。 */
    function run(from, to, dur, fn, done) {
        if (st.raf) cancelAnimationFrame(st.raf);
        var t0 = performance.now();
        fn(from);
        st.raf = requestAnimationFrame(function step() {
            var k = Math.min(1, (performance.now() - t0) / dur);
            fn(from + (to - from) * k);
            if (k < 1) st.raf = requestAnimationFrame(step);
            else { st.raf = 0; if (done) done(); }
        });
    }

    /* ---------- 名牌尺寸：按字数选档，放不下再缩字号 ---------- */

    var mctx = null;
    function metrics(text, size) {
        if (!mctx) mctx = document.createElement('canvas').getContext('2d');
        mctx.font = NAME_WEIGHT + ' ' + size + 'px ' + NAME_FAMILY;
        return mctx.measureText(text);
    }
    function measure(text, size) { return metrics(text, size).width; }

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
        /* 文字盒 = 整块底板：水平居中交给 flex，位置就恒等于底板中心 */
        el.nameText.style.left = left + 'px';
        el.nameText.style.width = spec.width + 'px';
        el.nameText.style.top = PLATE_TOP + 'px';
        el.nameText.style.fontSize = spec.font + 'px';
        /* 竖直方向不再试凑行高，直接把「字形墨迹的中心」摆到六边形中线上。
           line-height:1 时行盒只有 1em，而字体盒（fontBoundingBox）比 1em 高，
           浏览器把字体盒在行盒里居中，于是基线位置可以算出来：
             行盒顶 = (盒子高 - 字号) / 2
             基线   = 行盒顶 + (字号 - 字体盒高) / 2 + 字体盒上沿
             墨迹中心 = 基线 + (墨迹下沿 - 墨迹上沿) / 2
           与 PLATE_MID 的差就是要抬的量：随字号等比，缩字号、长名字都成立。
           度量统一在 MEASURE_PX 上取再按比例缩 —— canvas 给的字体度量是整数，
           小字号直接量会被取整吃掉半个像素（26px 实测差 0.5px）。 */
        var txt = el.nameText.textContent || '';
        var m = metrics(txt, MEASURE_PX);
        var shift;
        if (m.fontBoundingBoxAscent && m.actualBoundingBoxAscent != null) {
            var k = spec.font / MEASURE_PX;
            var fbAsc = m.fontBoundingBoxAscent * k, fbDesc = m.fontBoundingBoxDescent * k;
            var lineTop = (PLATE_H - spec.font) / 2;
            var baseline = lineTop + (spec.font - (fbAsc + fbDesc)) / 2 + fbAsc;
            var inkMid = baseline + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) * k / 2;
            shift = PLATE_MID - inkMid;
        } else {
            shift = -spec.font * 0.183;     // 拿不到字体度量时的退路：30px ≈ 抬 5.5px
        }
        el.nameText.style.transform = 'translateY(' + shift.toFixed(2) + 'px)';
    }

    /* 名字文字挂一层 span：flex 容器里只有一个 item 才能被精确居中，
       样式里的负右边距也正好抵掉 letter-spacing 的末字空隙 */
    function setNameText(text) {
        if (!el.nameText) return;
        var span = el.nameText.firstElementChild;
        if (!span || span.tagName !== 'SPAN') {
            el.nameText.textContent = '';
            span = document.createElement('span');
            el.nameText.appendChild(span);
        }
        span.textContent = text;
    }

    /* 换名字：空名字就把名牌整块收起来（与游戏里没记名字的行一致） */
    function setName(text) {
        if (!el.hud) return;
        var name = (text == null ? '' : String(text)).trim();
        if (!name) {
            st.name = '';
            setNameText('');
            paintPlate(0);
            if (el.deco) el.deco.style.opacity = '0';
            st.decoRun = false;
            return;
        }
        var changed = name !== st.name;
        st.name = name;
        setNameText(name);
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
        el.dark = el.hud.querySelector('[data-hud="dark"]');
        el.dim = el.hud.querySelector('[data-hud="dim"]');
        el.mid = el.hud.querySelector('[data-hud="mid"]');
        el.lines = el.hud.querySelector('[data-hud="lines"]');
        el.deco = el.hud.querySelector('[data-hud="deco"]');
        el.name = el.hud.querySelector('[data-hud="name"]');
        el.nameWhite = el.hud.querySelector('[data-hud="name-white"]');
        el.nameImg = el.name.querySelector('img');
        el.nameWhiteImg = el.nameWhite.querySelector('img');
        el.nameText = $('st-name');
        el.caret = $('st-caret');

        /* 先摆一次名牌（哪怕此刻还没有名字）：底板/白闪层/文字盒的 left·width
           只在 layoutPlate 里写，开头不摆的话它们停在默认位置（left:auto → x=0），
           等开场第 50 帧 paintPlate 把底板擦出来时，就会在**左下角**闪出一块
           没字、尺寸也不对的空底板（"错误贴图"）。 */
        layoutPlate(pickPlate(st.name || ''));

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
