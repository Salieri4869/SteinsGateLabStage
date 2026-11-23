/* sg-dialog.js —— 剧情模式的对话框，用从 main.psb.m 拆出的 MSGWIN / name 还原
 *
 *  素材：游戏的对话框层，全部按原矩形切出、无损转 webp：
 *          1_lines 白色电路线（線のみ / 線のみ反転 两次擦除用的同一张）
 *          2_grad  灰渐变窗底（ベースグラデ 下的 ウィンドウ）
 *          3_dark  深色窗芯（中间那块黑色区域）
 *          4_dim   暗灰电路线（常态留在窗口上的装饰）
 *          5_mid   中间调电路线（白线转灰的过渡）
 *
 *  数据来源：main.psb 的 MSGWIN.show（88 帧）/ deco_show（30 帧）与 name.wipe_*（30 帧）
 *   开屏是三段【串行】动画，PSB 里靠 t=59 的子运动触发串起来：
 *   ① MSGWIN.show 0–59 帧：白线两侧擦入（0–29）、反向擦出（30–59）；窗底渐变 0–59 擦入。
 *      t=59 同时触发 deco_show / name_on / state —— 所以装饰线和名牌都在对话框铺好之后才动。
 *   ② MSGWIN.deco_show 0–29 帧：装饰线白亮层（名前飾りwhite = deco_lit）以 #mask/6
 *      （tex#000 0353，1049×52，originX=525 正中）从【中间向两边】擦入亮起（wrt 1→0，0–19 帧）；
 *      暗态底图（名前飾り = deco_dim）t=19 出现；白亮层 t=19–29 淡出 opa→0，恢复暗态常亮。
 *      这就是「亮起→恢复」那一下。→ AUTO 打开后另有循环「充能」：上排左→右扫、下排中心→两侧展开。
 *   ③ name 20 帧：名牌底板走 mesh 形变 —— 正菱形→横向纺锤→六边形（纯白形变层展开，
 *                    末段淡出交接给带网点纹理的正式底板，文字随后浮现）。截图实测三态：
 *                    菱形≈终态 1/7 宽、四角皆尖；纺锤左右拉到全宽、上下仍尖；
 *                    六边形顶边展开到约 82%、左右斜切 19px（正是底板素材轮廓）。
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
    var PLATE_X = { s: 0, m: 226, l: 592, ll: 1058 };   // 各档在 nameplate_sheet.webp 里的横向偏移
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
    var st = { open: 0, ready: false, plate: 1, plateW: 0, name: null, raf: 0, fitRaf: 0, caret: true, decoRun: false, auto: false,
               introMarks: [] };   // 开场三段起止时间戳，供验收精确判定串行时序

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

    /* 中间向两边的对称擦入：reveal 0 全隐 / 1 全显。
       原作 deco_show 的 #mask/6（0353）是 originX 居中的纺锤遮罩，
       擦除从正中向两侧展开 —— 和窗口白线的「两侧向中间合拢」（wipeSides）正好相反。
       这里用对称软边渐变近似：reveal 越大，中间不透明带越宽、向两端扩张。 */
    function wipeCenterOut(node, reveal) {
        if (!node) return;
        if (reveal >= 0.999) {
            node.style.webkitMaskImage = 'none';
            node.style.maskImage = 'none';
            node.style.visibility = 'visible';
            return;
        }
        var r = clamp01(reveal);
        var half = r * 50;                                   // 每侧从中心扩张的半宽
        var f = Math.min(3, Math.max(0, 50 - half) * 2 + 0.2);
        var css = 'linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ' + (50 - half - f) + '%,'
            + ' #000 ' + (50 - half) + '%, #000 ' + (50 + half) + '%,'
            + ' rgba(0,0,0,0) ' + (50 + half + f) + '%, rgba(0,0,0,0) 100%)';
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

        /* 开屏专用亮起层（deco_show）：与 AUTO 循环扫光完全分开的一套。
           对话框铺好后，白亮图从正中向两边擦入亮起、再淡出恢复暗态底图，只播一次。 */
        var intro = document.createElement('div');
        intro.className = 'deco-intro';
        intro.style.backgroundImage = 'url("' + litSrc + '")';
        el.deco.appendChild(intro);

        el.decoBase = base;
        el.decoLit = wrap;
        el.decoChg = halves;
        el.decoIntro = intro;
    }

    /* 开屏装饰线亮起（对应 MSGWIN.deco_show，30 帧 = 1s）：
       0–19 帧白亮层以 #mask/6 从中间向两边擦入；19–29 帧白亮淡出、
       露出一直在底下的暗态 deco_dim —— 即「亮起→恢复」。此后暗态常亮，
       AUTO 的循环扫光另走 .deco-lit/.deco-chg，两者不打架。
       动画期间临时关掉 is-auto，免得 AUTO 的 CSS 扫光叠在这一下上头。 */
    var DECO_LIT_END = 19 / 30;
    function paintDecoShow(v) {
        v = clamp01(v);
        if (!el.deco) return;
        if (el.decoIntro) {
            if (v <= DECO_LIT_END) {
                wipeCenterOut(el.decoIntro, v / DECO_LIT_END);
                el.decoIntro.style.opacity = '1';
            } else {
                wipeCenterOut(el.decoIntro, 1);
                el.decoIntro.style.opacity = String(1 - (v - DECO_LIT_END) / (1 - DECO_LIT_END));
            }
        }
    }
    function runDecoShow(done) {
        if (!el.deco || !el.decoIntro) { if (done) done(); return; }
        var wasAuto = st.auto;
        el.deco.classList.remove('is-auto');
        el.deco.style.opacity = '1';              // 暗态底图全程在场
        run(0, 1, (30 / FPS) * 1000 / (opt.speed * opt.openSpeed), paintDecoShow, function () {
            wipeCenterOut(el.decoIntro, 0);
            el.decoIntro.style.opacity = '0';
            if (wasAuto) el.deco.classList.add('is-auto');
            if (done) done();
        });
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

    /* 窗口开场 —— 严格照 PSB 的 MSGWIN.show（main.psb.m.json 实测）复现：
       可见贴图只有 2 张（sourceIconRenameMap 铁证）：
         main/white     → tex#000 icon 0008 = msgwin_1_lines.webp（白电路线）
         main/ウィンドウ → tex#000 icon 0009 = msgwin_2_grad.webp（灰渐变窗底）
       而 0348/0355/0356（旧代码当"深色窗芯/暗灰线/中间调线"叠上去的）= #mask/1/#mask/8/#mask/9，
       是 e-mote 的内置擦除遮罩图案，show 根本没把它们当可见层 —— 旧代码把遮罩当贴图叠，是错的。

       三个擦除层与 stc.wrt（mask=2 → #mask/2 = 0349，一个"中间亮、两侧暗"的纺锤形 alpha）：
         ベースグラデ（窗底 ウィンドウ）  wrt 1→0  t=0..59  擦入
         線のみ     （白线 white）        wrt 1→0  t=0..29  擦入
         線のみ反転 （白线 white，同一张） wrt 0→1  t=30..59 擦出
       wrt 是线性插值（show 三层都没引用缓动曲线，easing 全文只出现 1 次且是定义），
       所以这里也用线性。#mask/2 的位移算法在 e-mote 引擎内部，PSB 只给了 0349 图案纹理、
       没有位移规则，无法精确还原；这里保留已验证的 wipeSides 对称软边近似"两侧点亮、中间合拢"。
       50–58 帧装饰线/名牌淡入（deco_show/name_on 段）。 */
    function paintWindow(t) {
        st.open = t;

        /* 窗底 ウィンドウ：t 0–59 擦入，与 PSB ベースグラデ wrt 1→0 一致。
           mask 图案挂在 CSS 的 .hud-win img 上，这里只驱动线性 reveal 进度。 */
        wipeSides(el.win, clamp01(t / 59));

        /* 白线 white：t 0–29 擦入（線のみ wrt 1→0）、t 30–59 擦出（線のみ反転 wrt 0→1）。
           两张层共用同一张 white 贴图，正/反两个擦除方向 —— 用一个 reveal 曲线表达：
           reveal 先 0→1 再 1→0，两侧对称擦入擦出。 */
        var lineReveal = t <= 29 ? clamp01(t / 29) : clamp01(1 - (t - 30) / 29);
        wipeSides(el.lines, lineReveal);
        fadeLayer(el.lines, lineReveal, 1);

        /* 0348/0355/0356 是遮罩图案，不是可见层：旧实现叠的 dark/dim/mid 三层全部熄灭，
           它们保留在 DOM 里只为兼容旧版探针/调试对照，不参与画面。 */
        fadeLayer(el.dark, 0);
        fadeLayer(el.dim, 0);
        fadeLayer(el.mid, 0);

        /* 装饰线和名牌不再由本函数驱动 —— 原作是 show 播完（t=59）才触发
           deco_show → name，三段【串行】。见 open() 与 runDecoShow()。
           setWindow(t) 是验收用的调试接口，要能独立摆出对话框某一帧，这里保持只铺窗底/白线。 */
        if (el.hud) el.hud.classList.toggle('is-open', t > 58);
    }

    /* ---------- 名牌 mesh 形变：菱形 → 横向纺锤 → 六边形 ----------
       素材实测轮廓（s 档 226×59 盒，四档同比）：中腰 y≈25.5、x=2..W-2；
       顶边 y=6、x=21..W-21；底边 y=45、x=23..W-23。
       截图三态：菱形宽≈19高≈20（四角皆尖、近正方）；纺锤顶边仅 13px、左右拉满；
       六边形顶边≈82%（正是素材）。
       6 顶点统一为「左上、右上、右中、右下、左下、左中」顺时针六点，三段插值，
       中间给纺锤一个停留段（原作录像里它是独立存在的中间帧，不该一闪而过）：
         0→0.45    拉宽：菱形→纺锤（左右尖从中心拉到 x=2..W-2，上下短边仍窄）
         0.45→0.60 纺锤停留
         0.60→1    压平：纺锤→六边形（上下短边展开到素材的 21px）
       菱形/纺锤的上下边收缩成尖点时，相邻两点重合，得到真菱形。
       终态六边形与底板素材轮廓重合，末段交接无跳变。 */
    var MORPH_WIDEN = 0.45, MORPH_HOLD = 0.60;
    function lerp(a, b, t) { return a + (b - a) * t; }
    function morphPolygon(v, W) {
        var cx = W / 2, mid = 25.5;
        var r0 = 16;     // 菱形水平半宽（截图≈19/2，近正方）
        var narrow = 7;  // 纺锤上下短边半宽（截图顶边 13px 的一半）
        // 六点：左上、右上、右中、右下、左下、左中
        var k0 = [[cx, 9.5], [cx, 9.5], [cx + r0, mid],
                  [cx, 41.5], [cx, 41.5], [cx - r0, mid]];
        var k1 = [[cx - narrow, 10], [cx + narrow, 10], [W - 2, mid],
                  [cx + narrow, 41], [cx - narrow, 41], [2, mid]];
        var k2 = [[21, 6], [W - 21, 6], [W - 2, mid],
                  [W - 23, 45], [23, 45], [2, mid]];
        var from, to, t;
        if (v <= MORPH_WIDEN) { from = k0; to = k1; t = clamp01(v / MORPH_WIDEN); }
        else if (v <= MORPH_HOLD) { from = k1; to = k1; t = 0; }
        else { from = k1; to = k2; t = clamp01((v - MORPH_HOLD) / (1 - MORPH_HOLD)); }
        var pts = [];
        for (var i = 0; i < 6; i++) {
            pts.push(lerp(from[i][0], to[i][0], t).toFixed(1) + 'px ' + lerp(from[i][1], to[i][1], t).toFixed(1) + 'px');
        }
        return 'polygon(' + pts.join(',') + ')';
    }

    /* 名牌底板 + mesh 形变：形变层在前 84% 从菱形展开到六边形（纯白），
       末段 84%→100% 形变层淡出、正式底板淡入（两者六边形轮廓重合），文字随后浮现。 */
    function paintPlate(v) {
        st.plate = clamp01(v);
        var p = st.plate;
        var W = st.plateW || PLATE.s;
        if (el.nameMorph) {
            el.nameMorph.style.clipPath = morphPolygon(clamp01(p / 0.84), W);
            el.nameMorph.style.webkitClipPath = el.nameMorph.style.clipPath;
            el.nameMorph.style.opacity = String(1 - clamp01((p - 0.84) / 0.16));
            el.nameMorph.style.visibility = p <= 0.001 ? 'hidden' : 'visible';
        }
        fadeLayer(el.name, clamp01((p - 0.84) / 0.16));
        if (el.nameText) el.nameText.style.opacity = String(clamp01((p - 0.7) / 0.3));
        if (el.nameWhite) el.nameWhite.style.opacity = '0';
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
        [el.name, el.nameWhite, el.nameMorph].forEach(function (n) {
            if (!n) return;
            n.style.left = left + 'px';
            n.style.width = spec.width + 'px';
            n.style.top = PLATE_TOP + 'px';
            n.style.backgroundPosition = (-PLATE_X[spec.size]) + 'px 0';   // 雪碧图按档位取片
            n.__wipeW = 0;                  // 宽度换档了：让 wipe 下次重新量一次
        });
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

    /* 换名字：空名字就把名牌整块收起来（与游戏里没记名字的行一致）。
       prime=true 只把名字文字与底板档位摆好、不触发擦入 —— 开场动画开始前预置首句名字用：
       名牌的擦入由 open() 的第 50–58 帧统一负责，预置后 renderLine 的首个 setName
       看到名字没变就不会再擦一遍（否则名牌动画会播两次）。 */
    function setName(text, prime) {
        if (!el.hud) return;
        var name = (text == null ? '' : String(text)).trim();
        if (!name) {
            st.name = '';
            setNameText('');
            paintPlate(0);
            // 只收起名牌（底板+文字）：装饰线是独立元素，旁白行也照常显示
            if (el.deco) el.deco.style.opacity = '1';
            return;
        }
        var changed = name !== st.name;
        st.name = name;
        setNameText(name);
        layoutPlate(pickPlate(name));
        if (prime) return;   // 预置：只摆文字与尺寸，显隐交给开场/后续 setName
        if (!st.ready) return;   // 开场三段还没播完：名牌显隐由 open() 的阶段③自己推，别抢
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
            /* transform 变了：齿轮是按屏幕坐标量出来贴句末的，缩放后要重贴一次 */
            if (el.gear && !el.gear.classList.contains('is-off')) alignGear();
        });
    }

    function setCaret(on) {
        st.caret = !!on;
        if (!el.hud) return;
        if (el.caret) el.caret.classList.toggle('is-off', !st.caret);
    }

    /* 把句末齿轮贴到台词最后一个字符的右边：用 Range 量出最后一个字符的屏幕矩形，
       和 #st-text 的屏幕矩形相减，再除以 hud 的缩放比，得到 #st-text 内的局部坐标。
       打字机每写一个字都会调一次，所以齿轮始终跟着末尾走；长句换行也贴最后一行行尾，
       不会像 inline 元素那样被挤到下一行行首。取不到字符/字体未就绪时静默跳过。 */
    function alignGear() {
        if (!el.gear || !el.textRun || !el.text) return;
        var txt = el.textRun.firstChild;
        if (!txt || !txt.nodeValue) return;
        var range = document.createRange();
        try { range.selectNodeContents(el.textRun); } catch (_) { return; }
        var rects = range.getClientRects();
        if (!rects || !rects.length) return;
        var last = rects[rects.length - 1];              // 最后一个字符（换行时是最后一行行尾）
        var host = el.text.getBoundingClientRect();
        /* hud 用 transform: scale(s) 缩放：屏幕矩形差要除以 s 才是 #st-text 的局部像素。
           s 用 hud 的实宽 / 设计宽（1920）算，transform-origin 不影响宽度的比例。 */
        var s = el.hud.getBoundingClientRect().width / W || 1;
        var gap = 8;                                     // 齿轮与末字之间的小间距
        var x = (last.right - host.left) / s + gap;
        var y = (last.top + last.height / 2 - host.top) / s - 16;   // 32px 齿轮中心对齐字中线
        el.gear.style.left = x.toFixed(2) + 'px';
        el.gear.style.top = y.toFixed(2) + 'px';
    }

    /* 句末齿轮逐帧播放。原作 main.psb.m 的 MSGWIN/wait：
         frameList 0–36 共 37 帧，loopTime=17 —— 0–16 是变形进入段（齿轮从一条线张开成圆），
         只播一次；17–36 是完整不变形的旋转帧，循环。帧内已烘焙旋转造型，不用 CSS rotate。
         注意不能用单条 CSS steps 从 0 循环全部帧：那样每轮都会把「一条线」的变形帧播一遍。
       所以 JS 驱动：frame 从 0 递增，到 36 后跳回 17，进入段自然只走一次。 */
    var GEAR_FRAMES = 37, GEAR_LOOP_FROM = 17, GEAR_FRAME_MS = 1000 / 60;
    var GEAR_FW = 32;   // 每帧宽度（雪碧图 1850×50 → 缩到 1184×32）
    var gearRaf = 0, gearFrame = 0, gearLast = 0;
    var gearReduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    function gearStep(now) {
        if (!el.gear || el.gear.classList.contains('is-off')) { gearRaf = 0; return; }
        if (!gearLast) gearLast = now;
        if (now - gearLast >= GEAR_FRAME_MS) {
            gearLast = now;
            el.gear.style.backgroundPosition = (-gearFrame * GEAR_FW).toFixed(0) + 'px 0';
            gearFrame = gearFrame >= GEAR_FRAMES - 1 ? GEAR_LOOP_FROM : gearFrame + 1;
        }
        gearRaf = requestAnimationFrame(gearStep);
    }

    /* 打字完成后出现、一直转到翻页。显隐由剧情状态判定；这里管播放与句末定位。
       幂等：已经处于目标状态就只重贴位置、不重启动画——打完一帧内 onTyped 与 typeText
       会各调一次 setGear(true)，重复重置会让进入帧从头闪一下。 */
    function setGear(on) {
        if (!el.gear) return;
        on = !!on;
        var wasOn = !el.gear.classList.contains('is-off');
        el.gear.classList.toggle('is-off', !on);
        if (!on) {
            if (gearRaf) { cancelAnimationFrame(gearRaf); gearRaf = 0; }
            return;
        }
        alignGear();
        if (wasOn) return;   // 已开着：只更新位置，不动播放进度
        gearFrame = 0; gearLast = 0;   // 刚出现：从变形进入帧重播
        if (gearReduce) {
            el.gear.style.backgroundPosition = (-GEAR_LOOP_FROM * GEAR_FW) + 'px 0';  // 静态：定在完整帧
            return;
        }
        gearRaf = requestAnimationFrame(gearStep);
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
        el.nameMorph = el.hud.querySelector('[data-hud="name-morph"]');
        el.nameText = $('st-name');
        el.caret = $('st-caret');
        el.gear = $('st-gear');
        el.text = $('st-text');          // 句末齿轮定位用：量文字末尾 rect
        el.textRun = $('st-text-txt');
        if (el.gear) el.gear.classList.add('is-off');   // 默认隐藏，打字完成才出现

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
                if (st.ready) paintPlate(1);
            });
        }
        return api;
    }

    var api = {
        init: init,
        /* 开屏三段串行，照 main.psb.m 的 show → deco_show → name 触发顺序：
           ① 0–59 铺对话框（窗底擦入 + 白线擦入擦出）
           ② deco_show 30 帧：装饰线从中间向两边亮起再恢复暗态
           ③ name 20 帧：名牌 mesh 形变（菱形→纺锤→六边形）
           done 在名牌就位后才回调，剧情首句的打字/语音此时才启动。 */
        open: function (done) {
            st.open = 0; st.ready = false;
            paintPlate(0);
            if (el.deco) el.deco.style.opacity = '0';
            st.introMarks = [{ phase: 'win', t: performance.now() }];
            run(0, 59, (60 / FPS) * 1000 / (opt.speed * opt.openSpeed), paintWindow, function () {
                st.introMarks.push({ phase: 'deco', t: performance.now() });
                runDecoShow(function () {
                    st.introMarks.push({ phase: 'name', t: performance.now() });
                    // 装饰线独立于名牌：不管首行有没有说话者都照常点亮、AUTO 时照常跑充能
                    if (el.deco) el.deco.style.opacity = '1';
                    if (el.deco && st.auto && !st.decoRun) { st.decoRun = true; runDeco(); }
                    paintPlate(0);
                    /* 首行是旁白（无说话者）时 primeName 收到空串，st.name 为空：
                       只跳过名牌的擦入，避免闪出一块空名牌；装饰线仍按上面正常显示。 */
                    if (!st.name) {
                        st.introMarks.push({ phase: 'done', t: performance.now() });
                        st.ready = true;
                        if (done) done();
                        return;
                    }
                    run(0, 1, (20 / FPS) * 1000 / opt.speed, paintPlate, function () {
                        st.introMarks.push({ phase: 'done', t: performance.now() });
                        st.ready = true;
                        if (done) done();
                    });
                });
            });
        },
        close: function (done) {
            /* 反向收起：名牌先灭、装饰线再灭，最后对话框擦出；次序与开屏相反。 */
            run(1, 0, (20 / FPS) * 1000 / opt.speed, function (v) {
                paintPlate(v);
                if (el.deco) el.deco.style.opacity = String(v);
            }, function () {
                wipeCenterOut(el.decoIntro, 0);
                run(59, 0, (60 / FPS) * 1000 / (opt.speed * opt.openSpeed), paintWindow, done);
            });
            st.open = 0; st.ready = false;
        },
        setName: setName,
        /* 开场前预置首句名牌（只摆文字/档位，不擦入）：避免名牌动画播两次 */
        primeName: function (text) { setName(text, true); },
        /* AUTO 开关：只有开着的时候装饰线才跑「充能」，关掉退回静态暗态 */
        setAuto: setAuto,
        /* 直接跳到开场动画的第 t 帧（0–59），调试/验收用。
           为兼容原有探针：同时按老的 t=39→59 映射摆出名牌三态、按 t≥50 摆出装饰线。
           正常播放不走这里 —— open() 里三段是串行的。 */
        setWindow: function (t) {
            t = Math.max(0, Math.min(59, t));
            paintWindow(t);
            paintPlate(clamp01((t - 39) / 20));
            if (el.deco) el.deco.style.opacity = String(clamp01((t - 50) / 8));
        },
        showName: function () { run(st.plate, 1, (20 / FPS) * 1000, paintPlate); },
        hideName: function () { run(st.plate, 0, (20 / FPS) * 1000, paintPlate); },
        setCaret: setCaret,
        setGear: setGear,
        /* 调试/验收：直接摆开屏第②段的装饰线帧（0–1），读中间亮带与白亮层形态。
           不影响正常播放，也不改 st.ready/isOpen。 */
        setDecoShow: function (v) { paintDecoShow(Math.max(0, Math.min(1, v))); },
        introMarks: function () { return st.introMarks.slice(); },
        setSpeed: function (v) { opt.speed = v > 0 ? v : 1; },
        options: opt,
        fit: fit,
        /* 整个开屏三段是否全部就位（对话框 + 装饰线亮起 + 名牌形变）。
           剧情页据此决定何时启动打字/语音，验收也据此等开场结束。 */
        isOpen: function () { return st.ready; }
    };

    global.SGDialog = api;
})(window);
