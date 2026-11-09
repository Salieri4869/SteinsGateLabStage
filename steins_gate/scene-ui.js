// ============================================================
//  scene-ui.js —— 研究所页面场景控制条
//
//  ① 顶部控制条：默认固定展开，与鼠标位置无关。整条从左到右是
//     「← 主页」（独立槽位，与角色 tab 同排同尺寸，**不在滚动容器里**，
//      所以横向滚动时模型 tab 永远不会压到它）→ 角色 tab → 切换背景 / ▲ 隐藏。
//     角色 tab 一人一个，名字直接取 data/ 下的**角色文件夹名**：
//       往 data/<角色>/ 里丢模型，这个角色就会出现在 tab 上；
//       压缩包（任何 *.zip，内部含 .psb 即可）与未压缩的裸 PSB
//       （*.psb / *.psb.m / *.pure.psb / *.psb.m.pure.psb）都认；
//       点角色 tab 展开造型面板，列出该文件夹下的全部模型，点造型才切换
//       （写 ?model=<角色/文件名>，重载页面）。同名角色只占一个 tab。
//     角色文件夹是运行时读 ../data/ 的 HTTP 目录索引发现的；直接丢在
//     data/ 根目录的 zip 仍按文件名前缀归入同名角色（兼容旧布局），
//     服务器不返回目录索引时回退到内置 6 个角色 / 10 个造型。
//     新放进 data/ 的造型标 NEW，打开过该角色面板即视为已读、角标消失（跨刷新记忆）；
//     tab 横向溢出时滚轮、触控板横滑、Shift+滚轮都能左右浏览，
//     滚动条刻意隐藏以保留 tab 的 41px 尺寸与间距。
//     右侧「切换背景」旁边是「▲ 隐藏」：点一下收起整条；
//       收起 → 鼠标移到页面顶端，右上角滑出「← 主页 ／ ▼ 显示控制条」。
//  ② 「切换背景」：右侧预览面板，缩略图网格 + 大图预览，点击即应用，
//     选择记入 localStorage。**零构建、零 Python、零清单文件**：
//       运行时直接读 background/ 的 HTTP 目录索引（Live Server /
//       nginx autoindex 等静态服务都支持），文件名即元数据（分组 / 标签）；
//       缩略图优先用可选的 thumbs/ 缓存文件，没有就用 canvas 现场裁一张
//       240×135 并存进 localStorage，下次秒开；「↻ 重新扫描」随时重读目录。
//       服务器不返回目录索引时，面板出现「导入文件夹」按钮，用浏览器选目录即可。
//  ③ 与右侧「控制台」协调：控制台面板在 main.js 里从 top:56px 起，避开顶部控制条；
//     背景面板右侧留 56px 给控制台竖条，两个面板互斥打开；ESC 按
//     「背景面板 → 控制台 → 顶部控制条」逐层收起，不会一次触发好几个。
//
//  只做 UI，不碰 E-mote 渲染、canvas 与交互逻辑。
// ============================================================
(function () {
    'use strict';

    // 模型 tab 不再是手写清单：运行时读 ../data/ 的 HTTP 目录索引，往目录里
    // 丢文件就会自动出现。下面这份 KNOWN_MODELS 只用于两件事：
    //   ① 已知模型的中文短标签（新模型由文件名自动推断，无需维护）；
    //   ② 服务器不返回目录索引时的兜底，保证控制条始终有 tab 可用。
    /* 裸 PSB（不压缩，直接把文件丢进角色文件夹，如 柳木詩夢/shi_45.pure.psb）。
       备选分支必须由长到短，否则 ".psb" 会抢先匹配、只剥掉一层后缀，
       剩下的 ".psb.m.pure" 会被当成造型名。 */
    var RAW_PSB_EXT = /\.(?:psb\.m\.pure\.psb|psb\.m\.pure|psb\.m\.psb|pure\.psb|psb\.m|psb|pure)$/i;
    var AUX_PSB_EXT = /\.resx\.psb$/i;             // 附属资源（图标 / 余项），不是可加载模型
    function isRawModel(name) { return !AUX_PSB_EXT.test(name) && RAW_PSB_EXT.test(name); }
    /* data/ 里放的就是模型，所以**任何 .zip 都算**（内部只要有一个 .psb，
       ModelLoader 就能按 magic 解出来）。这样 *.pure.zip / *.psb.zip /
       *.psb.m.pure.zip 乃至以后的新命名都不用再改代码。 */
    function isModelFile(name) {
        return /\.zip$/i.test(name) || isRawModel(name);
    }
    /** 去掉打包后缀，得到「角色名 / 造型词」的原始部分 */
    function stripModelExt(name) {
        return String(name).replace(/\.zip$/i, '').replace(RAW_PSB_EXT, '');
    }
    var MODEL_KNOWN_KEY = 'sg-models-known-v1';    // 上次扫描到的全部造型路径（基线）
    var MODEL_UNREAD_KEY = 'sg-models-unread-v1';  // 新增、但还没打开看过的造型路径
    var KNOWN_MODELS = [
        { file: '牧瀬紅莉栖ab.psb.m.pure.zip',              name: '牧瀬紅莉栖',   sub: '制服' },
        { file: '牧瀬紅莉栖ab_白衣.psb.m.pure.zip',          name: '牧瀬紅莉栖',   sub: '白衣' },
        { file: '椎名まゆりac.psb.m.pure.zip',                name: '椎名まゆり',   sub: '制服' },
        { file: '桐生萌郁a.psb.m.pure.zip',                   name: '桐生萌郁',     sub: '制服' },
        { file: '桐生萌郁a_ライダースーツ.psb.m.pure.zip',     name: '桐生萌郁',     sub: '机车夹克' },
        { file: 'フェイリスac_私服.psb.m.pure.zip',           name: 'フェイリス',   sub: '私服' },
        { file: 'フェイリスac_イベント衣装.psb.m.pure.zip',    name: 'フェイリス',   sub: '活动服装' },
        { file: '漆原るかac_巫女.psb.m.pure.zip',             name: '漆原るか',     sub: '巫女' },
        { file: '漆原るかac_雷ネット.psb.m.pure.zip',         name: '漆原るか',     sub: '雷ネット' },
        { file: '綯a.psb.m.pure.zip',                         name: '天王寺綯',     sub: '制服' }
    ];
    // 文件名里的角色简称与已知服装名的显示优化；未知名字原样显示
    var NAME_ALIAS = { '綯': '天王寺綯' };
    // 造型名别名：日文服装名沿用旧标签；拉丁命名（chocola-casual 等）翻成中文
    var COSTUME_ALIAS = {
        'ライダースーツ': '机车夹克', 'イベント衣装': '活动服装',
        'casual': '便服', 'dress': '连衣裙', 'koneko': '小猫',
        'lolita': '洛丽塔', 'maid': '女仆', 'pajama': '睡衣',
        'santa': '圣诞', 'teenage': '少女', 'winter': '冬装',
        'wintermaid': '冬装女仆', 'winter maid': '冬装女仆', 'yukata': '浴衣'
    };
    var KNOWN_INFO = {}, ROLE_ORDER = {};
    KNOWN_MODELS.forEach(function (m, i) {
        KNOWN_INFO[m.file] = m;
        if (!(m.name in ROLE_ORDER)) ROLE_ORDER[m.name] = i;
    });

    var groups = [];               // 角色组（tab 数据）：{ folder, label, models, isNew }
    var models = [];               // 全部造型的扁平列表，保持 SGSceneUI.models 旧契约
    var modelSource = 'builtin';   // 'http-directory' | 'builtin'
    var MODEL_INDEX_KEY = 'sg-model-index-v1';   // 纯文件名 → 角色/文件名（给 main.js 早期解析用）
    var modelPanelOpen = false, activeFolder = '';
    var readyScan = null;          // 首轮扫描的 promise：main.js 靠它决定默认模型

    var GROUPS = [
        { key: 'new',     label: '新加入' },   // 刚放进来的图排最前，一打开面板就看得见
        { key: 'default', label: '默认场景' },
        { key: 'event',   label: '事件 CG' },
        { key: 'scene',   label: '场景背景' }
    ];

    var IMG_EXTS = /\.(png|jpe?g|webp|gif|bmp)$/i;
    // 浏览器自己维护的两份状态：缩略图缓存、上次扫描到的文件名（用来标 NEW）
    var THUMB_KEY = 'sg-bg-thumbs-v1';
    var KNOWN_KEY = 'sg-bg-known-v1';

    var CSS = [
        // ---- 顶部感应带：收起后 hover 顶端才滑出「显示控制条」----
        '#sg-top{position:fixed;top:0;left:0;width:100%;height:36px;z-index:74;',
        ' pointer-events:none;font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif}',
        'body:not(.sg-bar-pinned) #sg-top{pointer-events:auto;cursor:pointer}',
        '#sg-hot{position:absolute;top:0;left:0;width:100%;height:24px;z-index:1;pointer-events:auto}',
        '#sg-hot::after{content:"";position:absolute;left:0;right:0;top:0;height:2px;',
        ' background:linear-gradient(90deg,rgba(99,214,196,.62),rgba(99,214,196,.16) 34%,transparent 74%);',
        ' opacity:.42;transition:opacity .2s ease}',
        'body:not(.sg-bar-pinned) #sg-top:hover #sg-hot::after{opacity:1}',
        'body.sg-bar-pinned #sg-hot{pointer-events:none}',
        'body.sg-bar-pinned #sg-hot::after{opacity:0}',

        // ---- 收起时右上角原位滑出的提示条：主页入口 + 显示控制条 ----
        // 主页主体已并入控制条（见 .sg-home-tab）；这里只在收起态补一个轻量入口
        '#sg-peek{position:absolute;right:16px;top:0;z-index:3;height:36px;',
        ' display:flex;align-items:center;gap:8px;padding:0 14px;',
        ' border:1px solid rgba(99,214,196,.45);border-top:0;',
        ' border-radius:0 0 7px 7px;background:#0b1419;color:#a9f0e3;',
        ' font:11px/1 system-ui,-apple-system,"Segoe UI",sans-serif;',
        ' letter-spacing:.06em;white-space:nowrap;cursor:pointer;pointer-events:auto;',
        ' transform:translateY(-100%);opacity:0;',
        ' transition:transform .3s cubic-bezier(.2,.8,.2,1),opacity .2s ease;',
        ' box-shadow:0 4px 14px rgba(0,0,0,.5)}',
        'body:not(.sg-bar-pinned) #sg-top:hover #sg-peek{transform:none;opacity:1}',
        'body.sg-bar-pinned #sg-peek{transform:translateY(-100%);opacity:0;pointer-events:none}',
        '#sg-peek:hover{background:#14242b;border-color:#63d6c4}',
        '#sg-peek-home{color:#f0d9ac;text-decoration:none;cursor:pointer;',
        ' padding-right:8px;border-right:1px solid rgba(233,185,110,.32)}',
        '#sg-peek-home:hover{color:#ffe9bd}',
        '#sg-peek-btn{padding:0;border:0;background:none;color:inherit;',
        ' font:inherit;letter-spacing:inherit;cursor:pointer}',
        '#sg-peek i{font-style:normal;color:#63d6c4}',

        // ---- 控制条：默认固定展开 ----
        '#sg-bar{position:fixed;top:0;left:0;width:100%;height:56px;z-index:72;',
        ' transform:translateY(-100%);opacity:0;pointer-events:none;',
        ' transition:transform .34s cubic-bezier(.2,.8,.2,1),opacity .22s ease}',
        'body.sg-bar-pinned #sg-bar{transform:translateY(0);opacity:1;pointer-events:auto}',
        '#sg-bar-inner{height:56px;display:flex;align-items:center;gap:14px;',
        ' padding:0 16px;background:#0b1419;',
        ' border-bottom:1px solid rgba(99,214,196,.32);',
        ' box-shadow:0 8px 26px rgba(0,0,0,.5);color:#e6f1ef}',
        // 主页独立槽位：与滚动容器并排、等高，但绝不在它里面 → 滚动不重叠
        '#sg-home-slot{flex:none;display:flex;align-items:stretch;height:100%;padding:7px 0;',
        ' position:relative;z-index:3}',
        '#sg-models{flex:1;min-width:0;display:flex;align-items:stretch;gap:6px;',
        ' overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;',
        ' scrollbar-width:none;height:100%;padding:7px 0}',
        // 滚轮 / 触控板横滑已能浏览，隐藏横向滚动条：它原本会吃掉 11px 高度，
        // 把 tab 从旧版的 41px 压成 31px。隐藏后高度与间距都能完整还原。
        '#sg-models::-webkit-scrollbar{display:none}',
        // 主页按钮与角色 tab 共用同一套尺寸规则（同一个选择器组），但分处不同容器；
        // 不带 .sg-model 类名，避免被「按 .sg-model 取模型」的逻辑误当成一个模型。
        // 尺寸沿用旧版：padding 4px 12px / 行距 3px / 字号 12、10；
        // 只把 min-width 换成定宽 width，保证 19 个 tab 与主页严格等宽，
        // 并保留 b/i 的 flex:none + 省略号，避免长副标撑破或被压成 0 高。
        '.sg-model,.sg-home-tab{flex:none;width:96px;height:100%;padding:4px 12px;',
        ' box-sizing:border-box;overflow:hidden;position:relative;',
        ' display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;',
        ' border:1px solid rgba(255,255,255,.13);border-radius:5px;',
        ' background:#14242b;color:#cfe0dd;cursor:pointer;text-align:left;',
        ' white-space:nowrap;transform:translateY(-12px);opacity:0;',
        ' transition:background .18s,border-color .18s,transform .3s cubic-bezier(.2,.8,.2,1),opacity .28s}',
        'body.sg-bar-pinned .sg-model,body.sg-bar-pinned .sg-home-tab{transform:none;opacity:1}',
        '.sg-model b,.sg-home-tab b{flex:none;font-size:12px;font-weight:600;',
        ' letter-spacing:.02em;max-width:100%;overflow:hidden;',
        ' text-overflow:ellipsis;white-space:nowrap}',
        '.sg-model i,.sg-home-tab i{flex:none;font-style:normal;font-size:10px;color:#7c959a;',
        ' max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.sg-model:hover,.sg-home-tab:hover{background:#1d3540;border-color:rgba(99,214,196,.45)}',
        '.sg-model.is-current{background:#173b36;border-color:#63d6c4;color:#eafff9}',
        '.sg-model.is-current i{color:#8fd8cd}',
        '.sg-model.is-current::before{content:"●";position:absolute;right:5px;top:4px;',
        ' color:#63d6c4;font-size:9px;line-height:1}',
        // 刚放进 data/ 的模型：金色描边 + 右上角 NEW 角标，排在最前，一眼能找到
        '.sg-model.is-new{border-color:rgba(233,185,110,.6);background:#241f16}',
        '.sg-model.is-new i{color:#c9a76e}',
        '.sg-model.is-new::after{content:"NEW";position:absolute;right:3px;top:3px;',
        ' padding:1px 3px;border-radius:2px;background:rgba(233,185,110,.92);',
        ' color:#15232a;font:700 8px/1 ui-monospace,Consolas,monospace}',
        // 「← 主页」只在配色上区分成琥珀金；独立槽位已保证不与滚动的 tab 重叠
        '.sg-home-tab{background:#191a17;border-color:rgba(233,185,110,.42);',
        ' color:#f0d9ac;text-decoration:none}',
        '.sg-home-tab b{letter-spacing:.06em}',
        '.sg-home-tab i{color:#c9a76e}',
        '.sg-home-tab:hover{background:#2a251b;border-color:#e9b96e}',
        '.sg-home-tab:focus-visible{outline:2px solid #e9b96e;outline-offset:2px}',
        '#sg-bar-tools{flex:none;display:flex;align-items:center;gap:8px}',
        '.sg-tool{height:34px;padding:0 13px;border:1px solid rgba(255,255,255,.18);',
        ' border-radius:5px;background:#14242b;color:#e6f1ef;cursor:pointer;',
        ' font:12px/1 system-ui,sans-serif;white-space:nowrap;transition:background .18s,border-color .18s}',
        '.sg-tool:hover{background:#1d3540;border-color:rgba(99,214,196,.5)}',
        '.sg-tool.is-on{background:#173b36;border-color:#63d6c4;color:#a9f0e3}',
        '.sg-tool small{display:block;margin-top:2px;font-size:9px;opacity:.65;letter-spacing:.08em}',
        // 隐藏／显示：与「切换背景」同规格、紧挨着放，不再是左上角那块悬空大按钮
        '#sg-hint{min-width:80px;color:#a9f0e3;border-color:rgba(99,214,196,.34)}',
        '#sg-hint:hover{border-color:#63d6c4}',
        '#sg-hint small{color:#7c959a}',

        // ---- 角色造型面板：点角色 tab 展开，列出该文件夹下的全部模型 ----
        '#sg-model-panel{position:fixed;top:60px;left:16px;width:276px;',
        ' max-height:min(68vh,560px);z-index:84;display:none;flex-direction:column;',
        ' background:#0b1419;border:1px solid rgba(99,214,196,.45);border-radius:6px;',
        ' box-shadow:0 14px 38px rgba(0,0,0,.62);overflow:hidden;',
        ' font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6f1ef}',
        'body.sg-mp-open #sg-model-panel{display:flex}',
        '#sg-mp-head{flex:none;display:flex;align-items:center;gap:10px;padding:10px 12px;',
        ' border-bottom:1px solid rgba(99,214,196,.22);background:#102027}',
        '#sg-mp-head b{flex:1;font-size:12px;font-weight:600;letter-spacing:.04em;',
        ' color:#eafff9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '#sg-mp-close{flex:none;height:26px;padding:0 9px;',
        ' border:1px solid rgba(255,255,255,.18);border-radius:4px;',
        ' background:#14242b;color:#e6f1ef;cursor:pointer;font-size:11px}',
        '#sg-mp-close:hover{background:#1d3540}',
        '#sg-mp-list{flex:1;min-height:0;overflow-y:auto;padding:8px;',
        ' display:flex;flex-direction:column;gap:6px;scrollbar-width:thin;',
        ' scrollbar-color:rgba(99,214,196,.35) transparent}',
        '.sg-mp-item{position:relative;flex:none;display:flex;flex-direction:column;gap:2px;',
        ' width:100%;padding:7px 10px;text-align:left;',
        ' border:1px solid rgba(255,255,255,.13);border-radius:5px;',
        ' background:#14242b;color:#cfe0dd;cursor:pointer}',
        '.sg-mp-item:hover{background:#1d3540;border-color:rgba(99,214,196,.45)}',
        '.sg-mp-item b{font-size:12px;font-weight:600;overflow:hidden;',
        ' text-overflow:ellipsis;white-space:nowrap}',
        '.sg-mp-item i{font-style:normal;font-size:10px;color:#7c959a;overflow:hidden;',
        ' text-overflow:ellipsis;white-space:nowrap}',
        '.sg-mp-item.is-current{background:#173b36;border-color:#63d6c4;color:#eafff9}',
        '.sg-mp-item.is-current i{color:#8fd8cd}',
        '.sg-mp-item.is-current b::after{content:" ●";color:#63d6c4;font-size:9px}',
        '.sg-mp-item.is-new{border-color:rgba(233,185,110,.6);background:#241f16}',
        '.sg-mp-item.is-new::after{content:"NEW";position:absolute;right:6px;top:6px;',
        ' padding:1px 3px;border-radius:2px;background:rgba(233,185,110,.92);',
        ' color:#15232a;font:700 8px/1 ui-monospace,Consolas,monospace}',
        '#sg-mp-foot{flex:none;padding:7px 12px;border-top:1px solid rgba(99,214,196,.18);',
        ' font-size:10px;color:#7c959a;letter-spacing:.04em}',
        '.sg-model.is-expanded{background:#1d3540;border-color:#63d6c4}',

        // ---- 背景预览面板 ----
        // 右侧留 56px 给「控制台」竖条（收起态贴屏幕右缘），别把它压在面板底下
        '#sg-bg-panel{position:fixed;top:64px;right:56px;width:min(548px,92vw);',
        ' max-height:min(76vh,720px);z-index:80;display:flex;flex-direction:column;',
        ' background:#0b1419;border:1px solid rgba(99,214,196,.34);border-radius:8px;',
        ' box-shadow:0 18px 48px rgba(0,0,0,.62);color:#e6f1ef;overflow:hidden;',
        ' opacity:0;transform:translateY(-12px);pointer-events:none;',
        ' transition:opacity .22s ease,transform .28s cubic-bezier(.2,.8,.2,1)}',
        '#sg-bg-panel.is-open{opacity:1;transform:none;pointer-events:auto}',
        '#sg-bg-head{flex:none;display:flex;align-items:center;gap:12px;',
        ' padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.12);',
        ' background:#0e1c22}',
        '#sg-bg-head b{font-size:13px;font-weight:600;letter-spacing:.04em}',
        '#sg-bg-current{min-width:0;font-size:11px;color:#8fd8cd;overflow:hidden;',
        ' text-overflow:ellipsis;white-space:nowrap}',
        '#sg-bg-rescan,#sg-bg-close,#sg-bg-import{flex:none;height:28px;padding:0 11px;',
        ' border:1px solid rgba(255,255,255,.18);border-radius:5px;background:#14242b;',
        ' color:#e6f1ef;cursor:pointer;font-size:11px;line-height:1;white-space:nowrap}',
        '#sg-bg-rescan{margin-left:auto;color:#a9f0e3}',
        '#sg-bg-import{color:#f0d9ac;border-color:rgba(233,185,110,.42)}',
        '#sg-bg-rescan:hover,#sg-bg-close:hover,#sg-bg-import:hover{background:#1d3540}',
        '#sg-bg-rescan.is-busy{opacity:.55;pointer-events:none}',
        '#sg-bg-preview{position:relative;flex:none;height:150px;background:#050b0e;',
        ' border-bottom:1px solid rgba(255,255,255,.1);overflow:hidden}',
        '#sg-bg-preview img{width:100%;height:100%;object-fit:cover;display:block}',
        '#sg-bg-preview::after{content:"";position:absolute;inset:0;',
        ' background:linear-gradient(to top,rgba(5,11,14,.88),transparent 62%);pointer-events:none}',
        '#sg-bg-preview span{position:absolute;left:14px;bottom:10px;z-index:1;',
        ' font-size:12px;letter-spacing:.06em;color:#eafff9;text-shadow:0 1px 6px rgba(0,0,0,.9)}',
        '#sg-bg-grid{flex:1;min-height:0;overflow-y:auto;display:grid;',
        ' grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:max-content;',
        ' gap:8px;padding:12px 14px;align-content:start;align-items:start;scrollbar-width:thin}',
        '#sg-bg-grid::-webkit-scrollbar{width:6px}',
        '#sg-bg-grid::-webkit-scrollbar-thumb{background:rgba(99,214,196,.35);border-radius:6px}',
        '.sg-group-title{grid-column:1/-1;margin:4px 0 0;font-size:10px;',
        ' letter-spacing:.14em;color:#7c959a;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:5px}',
        '.sg-bg-card{display:block;width:100%;height:94px;position:relative;padding:0;',
        ' border:2px solid transparent;border-radius:5px;background:#14242b;',
        ' cursor:pointer;overflow:hidden;transition:border-color .18s,transform .18s}',
        '.sg-bg-card:hover{border-color:rgba(99,214,196,.65);transform:translateY(-2px)}',
        '.sg-bg-card.is-current{border-color:#63d6c4}',
        '.sg-bg-card img{width:100%;height:68px;object-fit:cover;display:block}',
        '.sg-bg-card span{display:block;height:22px;line-height:22px;padding:0 5px;',
        ' font-size:10px;color:#cfe0dd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.sg-bg-card.is-current span{color:#a9f0e3}',
        '.sg-bg-card.is-new{border-color:rgba(233,185,110,.55)}',
        '.sg-bg-card.is-new::after{content:"NEW";position:absolute;right:3px;top:3px;',
        ' padding:2px 4px;border-radius:3px;background:rgba(233,185,110,.92);',
        ' color:#15232a;font:700 9px/1 ui-monospace,Consolas,monospace}',
        '#sg-bg-foot{flex:none;padding:9px 14px;border-top:1px solid rgba(255,255,255,.1);',
        ' font-size:10px;line-height:1.6;letter-spacing:.06em;color:#7c959a;background:#0e1c22}',

        '@media (max-width:720px){',
        ' #sg-top{height:34px}',
        ' #sg-peek{right:10px;height:34px;padding:0 10px;font-size:10px;gap:6px}',
        ' #sg-peek-home{padding-right:6px}',
        ' #sg-bar-inner{gap:8px;padding:0 10px}',
        ' .sg-model,.sg-home-tab{width:86px;padding:4px 9px}',
        ' #sg-bg-toggle{padding:0 9px;font-size:11px}',
        ' #sg-bg-toggle small{display:none}',
        ' #sg-hint{min-width:0;padding:0 9px;font-size:11px}',
        ' #sg-hint small{display:none}',
        ' #sg-bg-panel{top:62px;right:50px;left:8px;width:auto}',
        ' #sg-bg-head{gap:6px;padding:10px 8px}',
        ' #sg-bg-rescan,#sg-bg-close,#sg-bg-import{padding:0 7px;font-size:10px}',
        ' #sg-bg-grid{grid-template-columns:repeat(3,minmax(0,1fr))}',
        ' #sg-model-panel{top:58px;left:8px;right:8px;width:auto}',
        '}',
        '@media (prefers-reduced-motion:reduce){',
        ' #sg-bar,.sg-model,.sg-home-tab,#sg-peek,#sg-bg-panel,#sg-model-panel{',
        ' transition-duration:.01ms!important}',
        '}'
    ].join('\n');

    var top, hot, home, homeSlot, peek, peekHome, hint, bar, modelsEl, bgToggle, bgCloseBtn;
    var panel, grid, previewImg, previewLabel, currentLabel;
    var modelPanel, modelPanelTitle, modelPanelList;
    var pinned = false, bgOpen = false;
    var items = [], currentBg = 'background.jpg', currentModel = '';
    var scanSeq = 0, newCount = 0, directoryOk = false, manualCount = 0;
    var thumbCache = {}, manualItems = [], knownFiles = null, previewFallback = '';

    function el(tag, id, cls) {
        var n = document.createElement(tag);
        if (id) n.id = id;
        if (cls) n.className = cls;
        return n;
    }

    /* 文件名即元数据：
       · 站内原格式 <角色名><版本码>[_<造型>].psb.m.pure.zip
         例如 阿万音鈴羽b_軍服 → 阿万音鈴羽 / 軍服 · B；
       · 文件夹内命名（zip 或裸 PSB 都走这条）：角色名一律取文件夹名，
         造型名由文件名推断——
           chocola-casual → 巧克力 / 便服（造型词查 COSTUME_ALIAS）
           shi_45         → 柳木詩夢 / shi 45（纯编号，保留前缀便于区分）
           柳木詩夢_私服   → 柳木詩夢 / 私服（文件名自带角色名时只留后半段）
       已知模型沿用原来的中文短标签；其余由文件名自动推断，无需维护。 */
    function describeModel(file, folder) {
        var known = KNOWN_INFO[file];
        if (known) return { file: file, name: known.name, sub: known.sub };
        var stem = stripModelExt(file);
        // 站内原格式（中文角色名 + 版本码 + 造型）仍按老规则解析；
        // 其余（裸 PSB、拉丁 / 编号命名）一律以文件夹为角色名。
        var latin = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(stem);
        if (folder && (isRawModel(file) || latin)) {
            var sub = stem;
            if (stem.indexOf(folder) === 0) {
                sub = stem.slice(folder.length).replace(/^[_\-\s]+/, '') || stem;
            }
            var seg = sub.split(/[-_]/).filter(Boolean);
            if (seg.length > 1) {
                var word = seg.slice(1).join('-');
                // 纯编号（shi-45）保留前缀；造型词（casual）走中文别名
                sub = /^\d+$/.test(word)
                    ? seg.join(' ')
                    : (COSTUME_ALIAS[word.toLowerCase()] || word);
            }
            return { file: file, name: folder, sub: sub || stem };
        }
        var parts = stem.split('_');
        var base = parts[0];
        var costume = parts.slice(1).join('_');
        var m = /^(.*?)([a-z]+)$/i.exec(base);
        var role = (m && m[1]) ? m[1] : base;
        var code = (m && m[1]) ? m[2].toUpperCase() : '';
        var sub = (costume ? (COSTUME_ALIAS[costume] || costume) : '制服')
            + (code ? ' · ' + code : '');
        return { file: file, name: NAME_ALIAS[role] || role, sub: sub };
    }

    /* 唯一数据源：../data/ 的 HTTP 目录索引。目录里一层角色文件夹，
       每个文件夹内是模型——任何 *.zip 或未压缩的裸 PSB 都认。
       不同静态服务器给目录链接加不加
       尾斜杠不一致，所以除 zip 外的条目都当作「候选文件夹」探测一次，
       能读到 zip 的才算角色组，读不到就静默忽略（普通文件 / 父目录链接）。
       返回 null 表示服务器不支持列目录或没有可用模型 → 回退内置清单。 */
    function fetchIndex(url) {
        return fetch(url + (url.indexOf('?') < 0 ? '?t=' : '&t=') + Date.now(),
                     { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.text() : null; })
            .catch(function () { return null; });
    }

    function parseIndex(text) {
        var links = [], m;
        var re = /href\s*=\s*["']([^"']+)["']/gi;
        while ((m = re.exec(text))) {
            var raw = m[1].split(/[?#]/)[0];
            if (!raw) continue;
            var f;
            try { f = decodeURIComponent(raw); } catch (_) { f = raw; }
            var isDir = /\/$/.test(raw) || /\/$/.test(f);
            f = f.replace(/\/+$/, '').replace(/^.*\//, '');
            if (!f || f === '.' || f === '..') continue;
            links.push({ name: f, isDir: isDir });
        }
        return links;
    }

    function fetchModelTree() {
        return fetchIndex('../data/').then(function (rootText) {
            if (rootText == null) return null;
            var links = parseIndex(rootText);
            var rootFiles = links.filter(function (l) {
                return !l.isDir && isModelFile(l.name);
            }).map(function (l) { return l.name; });
            var candidates = links.filter(function (l) { return !isModelFile(l.name); });
            return Promise.all(candidates.map(function (c) {
                var url = '../data/' + encodeURIComponent(c.name) + '/';
                return fetchIndex(url)
                    .then(function (t) { return t == null ? fetchIndex(url) : t; }) // 一次重试，抗瞬时漏读
                    .then(function (t) {
                        if (t == null) return null;
                        var sub = parseIndex(t).filter(function (l) {
                            return !l.isDir && isModelFile(l.name);
                        }).map(function (l) { return l.name; });
                        return sub.length ? { folder: c.name, files: sub } : null;
                    });
            })).then(function (res) {
                var dirs = res.filter(Boolean);
                return (dirs.length || rootFiles.length)
                    ? { dirs: dirs, rootFiles: rootFiles } : null;
            });
        });
    }

    // 服务器不给目录索引时的兜底：内置 10 个造型仍按角色归组
    function builtinTree() {
        var byFolder = {};
        KNOWN_MODELS.forEach(function (m) {
            var folder = describeModel(m.file).name;
            (byFolder[folder] || (byFolder[folder] = [])).push(m.file);
        });
        return {
            dirs: Object.keys(byFolder).map(function (f) {
                return { folder: f, files: byFolder[f] };
            }),
            rootFiles: []
        };
    }

    function modelEntry(file, path, folder) {
        var d = describeModel(file, folder);
        return { file: file, path: path, folder: folder, name: d.name,
                 sub: d.sub, isNew: false };
    }

    /* 组装角色组：tree.dirs 是「一个角色一个文件夹」。直接丢在 data/
       根目录的 zip 仍按文件名前缀的角色名并入同名组（路径保持纯文件名，
       兼容旧链接）；找不到同名文件夹的根目录文件归到「其他」。 */
    function buildGroups(tree) {
        var map = {}, list = [];
        function groupFor(folder, label) {
            var key = folder || '__other__';
            if (!map[key]) {
                map[key] = { folder: folder, label: label, models: [], isNew: false };
                list.push(map[key]);
            }
            return map[key];
        }
        tree.dirs.forEach(function (d) {
            var g = groupFor(d.folder, d.folder);
            d.files.forEach(function (f) {
                g.models.push(modelEntry(f, d.folder + '/' + f, d.folder));
            });
        });
        tree.rootFiles.forEach(function (f) {
            var role = describeModel(f).name;
            var folder = map[role] ? role : '';
            var g = groupFor(folder, folder ? role : '其他');
            g.models.push(modelEntry(f, f, folder));
        });
        list.forEach(function (g) {
            // numeric:true —— 裸 PSB 常按编号命名（shi_6 / shi_45 / shi_50），
            // 按字符排会得到 45 < 6，按自然数排才是 6 < 45 < 50
            g.models.sort(function (a, b) {
                return a.sub.localeCompare(b.sub, 'ja', { numeric: true })
                    || a.file.localeCompare(b.file, 'ja', { numeric: true });
            });
        });
        return sortGroups(list);
    }

    /* 有新造型的组排最前，其余按内置角色顺序。isNew 会随「已读」变化，
       所以每次扫描后重排；点开 / 收起面板的当下只改角标、不重排，
       免得用户正在点的 tab 突然移位、造型面板贴错地方。 */
    function sortGroups(list) {
        list.sort(function (a, b) {
            if (!!a.isNew !== !!b.isNew) return a.isNew ? -1 : 1;
            var ra = (a.label in ROLE_ORDER) ? ROLE_ORDER[a.label] : 900;
            var rb = (b.label in ROLE_ORDER) ? ROLE_ORDER[b.label] : 900;
            if (ra !== rb) return ra - rb;
            return a.label.localeCompare(b.label, 'ja');
        });
        return list;
    }

    function readModelKnown() {
        try { return JSON.parse(localStorage.getItem(MODEL_KNOWN_KEY)) || null; }
        catch (_) { return null; }
    }
    function writeModelKnown(files) {
        try { localStorage.setItem(MODEL_KNOWN_KEY, JSON.stringify(files)); } catch (_) {}
    }
    function readModelUnread() {
        try {
            var o = JSON.parse(localStorage.getItem(MODEL_UNREAD_KEY));
            return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
        } catch (_) { return {}; }
    }
    function writeModelUnread(o) {
        try { localStorage.setItem(MODEL_UNREAD_KEY, JSON.stringify(o)); } catch (_) {}
    }

    /* 纯文件名 → 真实路径。main.js 在页面最早期（tab 还没扫描）就要决定
       加载哪个模型，没法回头问这里，所以每次扫描后落一份索引；下次再用
       旧版「只存纯文件名」的 localStorage 或收藏链接，就能直接对上真实文件夹，
       不必再维护「角色名 → 文件夹」的硬编码表，新增角色文件夹不用改代码。 */
    function writeModelIndex(list) {
        var map = {};
        list.forEach(function (g) {
            g.models.forEach(function (m) { map[m.file] = m.path; });
        });
        try { localStorage.setItem(MODEL_INDEX_KEY, JSON.stringify(map)); } catch (_) {}
    }

    /* NEW 只表示「相对上次扫描新出现、且还没打开看过」：
       - 第一次访问只建立基线，不把仓库里已有的模型误标成新加入；
       - 新出现的路径进未读表，打开该角色面板即标记已读并持久化；
       - 收起面板时角标当场撤掉，之后刷新 / 重扫都不会再冒出来。
       角标一律由造型的未读状态聚合，不再用「角色名在不在内置清单」硬编码，
       否则不在清单里的角色（例如 阿万音鈴羽）会永远挂着 NEW。 */
    function applyUnread(list, unread) {
        list.forEach(function (g) {
            var any = false;
            g.models.forEach(function (m) {
                m.isNew = !!unread[m.path];
                if (m.isNew) any = true;
            });
            g.isNew = any;
        });
    }

    /* 打开面板 = 已读：立刻撤掉 tab 角标 + 清持久化状态；
       造型本身的 NEW 留到面板里让人看清是哪些，收起面板时再清干净。 */
    function markGroupRead(g) {
        if (!g) return false;
        var unread = readModelUnread(), changed = false;
        g.models.forEach(function (m) {
            if (unread[m.path]) { delete unread[m.path]; changed = true; }
        });
        if (changed) writeModelUnread(unread);
        if (g.isNew) { g.isNew = false; paintTabNew(g); }
        return changed;
    }

    function paintTabNew(g) {
        if (!modelsEl || !g) return;
        var key = g.folder || g.label;
        Array.prototype.forEach.call(modelsEl.querySelectorAll('.sg-model'), function (b) {
            if (b.dataset.folder === key) b.classList.toggle('is-new', !!g.isNew);
        });
    }

    // 收起面板时把这一组的角标撤掉（tab + 面板项），不重排 tab
    function dismissGroupNew(g) {
        if (!g) return;
        g.isNew = false;
        g.models.forEach(function (m) { m.isNew = false; });
        paintTabNew(g);
        if (modelPanelOpen && modelPanelList && activeFolder === (g.folder || g.label)) {
            Array.prototype.forEach.call(modelPanelList.querySelectorAll('.sg-mp-item'),
                function (b) { b.classList.remove('is-new'); });
        }
    }

    function flattenModels(list) {
        var flat = [];
        list.forEach(function (g) { Array.prototype.push.apply(flat, g.models); });
        return flat;
    }

    function findGroup(folder) {
        for (var i = 0; i < groups.length; i++) {
            if ((groups[i].folder || groups[i].label) === folder) return groups[i];
        }
        return null;
    }
    function groupHasCurrent(g) {
        return g.models.some(function (m) { return m.file === currentModel; });
    }

    function refreshModels() {
        return fetchModelTree().then(function (tree) {
            var list = buildGroups(tree || builtinTree());
            modelSource = tree ? 'http-directory' : 'builtin';
            // NEW 以「角色/文件名」为单位：没见过、且还没打开看过的才算新
            var paths = [];
            list.forEach(function (g) {
                g.models.forEach(function (m) { paths.push(m.path); });
            });
            // 基线只增不减：目录索引偶发漏读某个角色文件夹时，不会把已有模型
            // 写丢，下一轮扫描也就不会把整组误判成「刚加进来」
            var known = readModelKnown();
            if (!Array.isArray(known)) known = [];   // 兼容异常/旧格式数据
            var seen = {};
            known.forEach(function (p) { seen[p] = true; });
            var firstVisit = known.length === 0;
            var unread = readModelUnread();
            if (!firstVisit) {
                paths.forEach(function (p) { if (!seen[p]) unread[p] = true; });
            }
            // 确认目录索引可读时，才把已删掉的造型从未读表里清掉；
            // 回退内置清单的那一轮不做清理，免得误删未读标记
            if (modelSource === 'http-directory') {
                Object.keys(unread).forEach(function (p) {
                    if (paths.indexOf(p) < 0) delete unread[p];
                });
            }
            var merged = known.slice();
            paths.forEach(function (p) {
                if (!seen[p]) { seen[p] = true; merged.push(p); }
            });
            writeModelKnown(merged);
            writeModelUnread(unread);
            applyUnread(list, unread);
            sortGroups(list);
            groups.length = 0;                       // 原地更新，外部引用不会失效
            Array.prototype.push.apply(groups, list);
            models.length = 0;
            Array.prototype.push.apply(models, flattenModels(list));
            writeModelIndex(list);                   // 供 main.js 解析纯文件名旧链接
            renderModelTabs();
            if (modelPanelOpen) renderModelPanel();
            return modelSource;
        });
    }

    function renderModelTabs() {
        if (!modelsEl) return;
        var scroll = modelsEl.scrollLeft;
        modelsEl.innerHTML = '';        // 主页在独立槽位，这里只放角色 tab
        groups.forEach(function (g, i) {
            var key = g.folder || g.label;
            var cur = groupHasCurrent(g);
            var expanded = modelPanelOpen && activeFolder === key;
            var b = el('button', '', 'sg-model' + (cur ? ' is-current' : '')
                + (g.isNew ? ' is-new' : '') + (expanded ? ' is-expanded' : ''));
            b.type = 'button';
            b.title = (g.folder ? g.folder + '/' : g.label) + ' · ' + g.models.length + ' 造型';
            b.dataset.folder = key;
            b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', String(cur));
            b.setAttribute('aria-expanded', String(expanded));
            b.style.transitionDelay = (Math.min(i, 12) * 0.028) + 's';
            var nm = el('b'); nm.textContent = g.label;
            var sb = el('i'); sb.textContent = g.models.length + ' 造型';
            b.appendChild(nm); b.appendChild(sb);
            b.addEventListener('click', function (e) {
                e.stopPropagation(); toggleGroup(g, b);
            });
            modelsEl.appendChild(b);
        });
        modelsEl.scrollLeft = scroll;   // 重扫后别把用户滚到的位置弹回开头
    }

    function findModel(file) {
        for (var i = 0; i < models.length; i++) if (models[i].file === file) return models[i];
        return null;
    }

    function readModel() {
        var raw = window.SG_CURRENT_MODEL || '';
        if (!raw) {
            try {
                raw = new URLSearchParams(location.search).get('model')
                    || localStorage.getItem('sg-model') || '';
            } catch (_) { raw = ''; }
        }
        return raw.split('/').pop();   // ?model=<角色/文件名> → 纯文件名
    }

    function currentModelInfo() { return findModel(currentModel); }

    /* 角色 → 造型：点角色 tab 只展开面板，点造型才真正切换模型（重载页面）。 */
    function buildModelPanel() {
        modelPanel = el('div', 'sg-model-panel');
        modelPanel.setAttribute('aria-hidden', 'true');
        var head = el('div', 'sg-mp-head');
        modelPanelTitle = el('b');
        modelPanelTitle.textContent = '角色造型';
        var close = el('button', 'sg-mp-close');
        close.type = 'button';
        close.textContent = '关闭';
        close.title = '关闭造型列表';
        close.addEventListener('click', function (e) {
            e.stopPropagation(); setModelPanelOpen(false);
        });
        head.appendChild(modelPanelTitle); head.appendChild(close);
        modelPanelList = el('div', 'sg-mp-list');
        var foot = el('div', 'sg-mp-foot');
        foot.textContent = '点击造型切换模型 · 选择会被记住';
        modelPanel.appendChild(head);
        modelPanel.appendChild(modelPanelList);
        modelPanel.appendChild(foot);
        document.body.appendChild(modelPanel);
        modelPanel.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        modelPanel.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    function renderModelPanel() {
        var g = findGroup(activeFolder);
        if (!g || !modelPanelList) return;
        modelPanelTitle.textContent = g.label + ' · ' + g.models.length + ' 造型';
        modelPanelList.innerHTML = '';
        g.models.forEach(function (m) {
            var b = el('button', '', 'sg-mp-item' + (m.file === currentModel ? ' is-current' : '')
                + (m.isNew ? ' is-new' : ''));
            b.type = 'button';
            b.title = m.path;
            b.dataset.path = m.path;
            var nm = el('b'); nm.textContent = m.sub;
            var sb = el('i'); sb.textContent = m.file;
            b.appendChild(nm); b.appendChild(sb);
            b.addEventListener('click', function (e) {
                e.stopPropagation(); switchModel(m.path);
            });
            modelPanelList.appendChild(b);
        });
    }

    function setModelPanelOpen(v) {
        var next = !!v;
        // 收起造型面板 = 这一组的新造型看过了：角标当场撤掉
        if (modelPanelOpen && !next && activeFolder) dismissGroupNew(findGroup(activeFolder));
        modelPanelOpen = next;
        document.body.classList.toggle('sg-mp-open', modelPanelOpen);
        if (modelPanel) modelPanel.setAttribute('aria-hidden', String(!modelPanelOpen));
        if (modelPanelOpen && bgOpen) setBgOpen(false);   // 右侧只留一块面板
        if (modelPanelOpen) setPinned(true);
        if (modelsEl) {
            Array.prototype.forEach.call(modelsEl.querySelectorAll('.sg-model'), function (b) {
                var on = modelPanelOpen && b.dataset.folder === activeFolder;
                b.classList.toggle('is-expanded', on);
                b.setAttribute('aria-expanded', String(on));
            });
        }
    }

    function toggleGroup(g, btn) {
        var key = g.folder || g.label;
        if (modelPanelOpen && activeFolder === key) { setModelPanelOpen(false); return; }
        activeFolder = key;
        markGroupRead(g);      // 打开即已读：tab 角标当场撤掉，面板里仍标 NEW 供辨认
        renderModelPanel();
        if (btn && modelPanel) {
            // 桌面贴合被点的 tab；移动端交给 CSS 的 left/right:8px 自适应
            if (window.innerWidth > 720) {
                var left = btn.getBoundingClientRect().left;
                modelPanel.style.left = Math.max(8, Math.min(window.innerWidth - 292, left)) + 'px';
            } else {
                modelPanel.style.left = '';
            }
        }
        setModelPanelOpen(true);
    }

    // 显示 / 隐藏：右侧「切换背景」旁的同一个按钮，只换文案
    function setPinned(v) {
        pinned = !!v;
        document.body.classList.toggle('sg-bar-pinned', pinned);
        hot.classList.toggle('sg-pinned', pinned);   // 兼容旧验收脚本
        if (pinned) {
            hint.innerHTML = '▲ 隐藏<small>CONTROL</small>';
            hint.title = '隐藏控制条（或按 ESC）';
        } else {
            hint.innerHTML = '▼ 显示<small>CONTROL</small>';
            var cur = currentModelInfo();
            hint.title = '显示控制条 · 当前：' + (cur ? cur.name + ' · ' + cur.sub : '默认')
                + '（或按 ESC）';
        }
        hint.setAttribute('aria-expanded', String(pinned));
        hint.setAttribute('aria-label', pinned ? '隐藏控制条' : '显示控制条');
    }

    function switchModel(path) {
        var file = String(path).split('/').pop();
        if (file === currentModel) { setModelPanelOpen(false); return; }
        if (activeFolder) markGroupRead(findGroup(activeFolder));  // 选过造型也算看过
        try { localStorage.setItem('sg-model', path); } catch (_) { /* ignore */ }
        var info = findModel(file);
        var target = info ? info.name + ' · ' + info.sub : '';
        try { sessionStorage.setItem('sg-loading-target', target); } catch (_) { /* ignore */ }
        // 重载前立刻显示遮罩：wasm 需重建，中间有 1–2s 空窗
        if (window.SG_LOADING) {
            window.SG_LOADING.show(target ? '正在再构筑 ' + target + ' 的世界线…'
                                          : '正在载入角色…');
        }
        var url = new URL(location.href);
        url.searchParams.set('model', path);   // 带角色文件夹：data/<角色>/<文件>.zip
        // 留一帧给浏览器把遮罩画出来，再触发导航
        setTimeout(function () { location.href = url.toString(); }, 80);
    }

    function bgUrl(file) { return 'background/' + encodeURIComponent(file); }

    // thumbs/ 只是**可选缓存**：有就用，没有浏览器自己生成，删掉整个目录也能跑
    function thumbPath(file) {
        return 'background/thumbs/' + encodeURIComponent(file.replace(/\.[^.]+$/, '') + '.jpg');
    }
    function previewOf(it) {
        return thumbCache[it.file] || it.blob || thumbPath(it.file);
    }

    function applyBg(file, persist) {
        var found = findItem(file);
        // 手动导入的是 blob URL，刷新后失效，所以不写进 localStorage
        var src = (found && found.blob) ? found.blob : bgUrl(file);
        document.body.style.backgroundImage = "url('" + src + "')";
        currentBg = file;
        if (currentLabel) currentLabel.textContent = '当前：' + (found ? found.label : file);
        Array.prototype.forEach.call(grid.querySelectorAll('.sg-bg-card'), function (c) {
            c.classList.toggle('is-current', c.dataset.file === file);
        });
        if (found) showPreview(found);
        if (persist && !(found && found.isManual)) {
            try { localStorage.setItem('sg-bg', file); } catch (_) { /* ignore */ }
        }
    }

    function findItem(file) {
        for (var i = 0; i < items.length; i++) if (items[i].file === file) return items[i];
        return null;
    }

    function showPreview(item) {
        if (!item) return;
        previewFallback = item.blob || bgUrl(item.file);
        if (previewImg.dataset.sgFallback) delete previewImg.dataset.sgFallback;
        previewImg.src = previewOf(item);
        previewLabel.textContent = item.label + '  ·  ' + item.groupLabel;
    }

    // 右侧同一时间只放一个面板：背景预览与「控制台」互斥，避免两块叠在一起
    function devPanelOpen() {
        try { return !!(window.getDevPanel && window.getDevPanel().open); }
        catch (_) { return false; }
    }
    function closeDevPanel() {
        try {
            if (window.closeDevPanel) { window.closeDevPanel(); return; }
        } catch (_) { /* ignore */ }
        // 模型还没加载完时 installDevPanel 尚未执行，直接兜底改 DOM
        var p = document.getElementById('emote-dev-panel');
        if (p) {
            p.classList.remove('open');
            p.setAttribute('aria-hidden', 'true');
            var t = document.getElementById('emote-dev-tab');
            if (t) t.setAttribute('aria-expanded', 'false');
        }
    }

    function setBgOpen(v) {
        bgOpen = v;
        panel.classList.toggle('is-open', v);
        panel.setAttribute('aria-hidden', String(!v));
        bgToggle.classList.toggle('is-on', v);
        if (v) { closeDevPanel(); setModelPanelOpen(false); setPinned(true); loadBackgrounds(); }
    }

    /* 没有清单、没有构建步骤：文件名本身就是元数据。 */
    function classify(file) {
        var stem = file.replace(/\.[^.]+$/, '');
        var low = stem.toLowerCase();
        if (low === 'background') {
            return { label: '未来道具研究所', group: 'default', groupLabel: '默认场景' };
        }
        if (/^ev[_\-\s]/.test(low)) {
            return { label: 'EVENT ' + stem.replace(/^ev[_\-\s]+/i, '')
                        .replace(/[_\-]+/g, ' ').toUpperCase().trim(),
                     group: 'event', groupLabel: '事件 CG' };
        }
        return { label: stem.replace(/[_\-]+/g, ' ').toUpperCase().slice(0, 28),
                 group: 'scene', groupLabel: '场景背景' };
    }

    /* 缩略图缓存：内存 + localStorage，刷新后仍在，不写任何服务器文件。 */
    function loadThumbCache() {
        try {
            var raw = localStorage.getItem(THUMB_KEY);
            thumbCache = raw ? (JSON.parse(raw) || {}) : {};
        } catch (_) { thumbCache = {}; }
    }
    var thumbSaveTimer = 0;
    function saveThumbCache() {
        clearTimeout(thumbSaveTimer);
        thumbSaveTimer = setTimeout(function () {
            try { localStorage.setItem(THUMB_KEY, JSON.stringify(thumbCache)); }
            catch (_) {
                // 配额满就丢一半，绝不影响主流程
                var keys = Object.keys(thumbCache);
                keys.slice(0, Math.ceil(keys.length / 2)).forEach(function (k) {
                    delete thumbCache[k];
                });
                try { localStorage.setItem(THUMB_KEY, JSON.stringify(thumbCache)); } catch (_) {}
            }
        }, 600);
    }

    /* 用已加载的原图在 canvas 上裁一张 240×135 的 cover 缩略图。
       同源 HTTP / blob URL 都不会污染 canvas；失败就静默继续用原图。 */
    function makeThumb(img) {
        try {
            var w = 240, h = 135;
            var c = document.createElement('canvas');
            c.width = w; c.height = h;
            var ctx = c.getContext('2d');
            var s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
            var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
            ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
            return c.toDataURL('image/jpeg', 0.72);
        } catch (_) { return null; }
    }

    /* 卡片缩略图三级回退：浏览器缓存 → 可选 thumbs/ 文件 → 原图 + canvas 现场生成。
       img 带 loading=lazy，只有进入视口的卡片才会真的去拉大图。 */
    function attachThumb(img, it) {
        var cached = thumbCache[it.file];
        if (cached) { img.src = cached; return; }
        var original = it.blob || bgUrl(it.file);
        var fallback = false;
        img.addEventListener('error', function () {
            if (fallback) return;
            fallback = true;
            img.src = original;
        });
        img.addEventListener('load', function () {
            if (!fallback || thumbCache[it.file] || !img.naturalWidth) return;
            var data = makeThumb(img);
            if (!data) return;
            thumbCache[it.file] = data;
            saveThumbCache();
            fallback = false;
            img.src = data;   // 换成本地缩略图，滚动时不必再解码大图
        });
        img.src = thumbPath(it.file);
    }

    /* 唯一数据源：HTTP 目录索引。返回 null 表示服务器不支持列目录。 */
    function fetchDirectory() {
        return fetch('background/?t=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (text) {
                if (text == null) return null;
                var found = {}, m;
                var re = /href\s*=\s*["']([^"']+)["']/gi;
                while ((m = re.exec(text))) {
                    var raw = m[1].split(/[?#]/)[0];
                    if (!raw || /\/$/.test(raw)) continue;   // 跳过 thumbs/ 之类的目录项
                    var f;
                    try { f = decodeURIComponent(raw); } catch (_) { f = raw; }
                    f = f.replace(/^.*\//, '');
                    if (IMG_EXTS.test(f)) found[f] = true;
                }
                return Object.keys(found);
            })
            .catch(function () { return null; });
    }

    function readKnown() {
        if (knownFiles) return knownFiles;
        try { knownFiles = JSON.parse(localStorage.getItem(KNOWN_KEY)) || null; }
        catch (_) { knownFiles = null; }
        return knownFiles;
    }
    function writeKnown(files) {
        knownFiles = files.slice();
        try { localStorage.setItem(KNOWN_KEY, JSON.stringify(knownFiles)); } catch (_) {}
    }

    function loadBackgrounds() {
        var seq = ++scanSeq;
        var btn = document.getElementById('sg-bg-rescan');
        if (btn) { btn.classList.add('is-busy'); btn.textContent = '扫描中…'; }
        return fetchDirectory().then(function (files) {
            if (seq !== scanSeq) return;   // 丢弃过期结果，避免重复点击时乱序
            directoryOk = Array.isArray(files);
            var fromDir = directoryOk ? files : [];
            var known = readKnown();
            var firstScan = !known || !known.length;
            var inDir = {};
            fromDir.forEach(function (f) { inDir[f] = true; });
            // 手动导入的图片在当前会话内一直保留
            var list = manualItems.filter(function (it) { return !inDir[it.file]; });
            fromDir.forEach(function (f) {
                var meta = classify(f);
                var isNew = !firstScan && known && known.indexOf(f) < 0;
                list.push({
                    file: f,
                    label: meta.label,
                    group: isNew ? 'new' : meta.group,
                    groupLabel: isNew ? '新加入' : meta.groupLabel,
                    isNew: !!isNew,
                    isManual: false
                });
            });
            if (directoryOk) writeKnown(fromDir);
            items = list;
            newCount = list.filter(function (i) { return i.isNew; }).length;
            manualCount = manualItems.length;
            var def = 'background.jpg';
            var saved = findItem(currentBg) ? currentBg
                : (findItem(def) ? def : (items[0] ? items[0].file : def));
            renderGrid();
            applyBg(saved, false);
            renderFoot();
            var imp = document.getElementById('sg-bg-import');
            if (imp) imp.style.display = directoryOk ? 'none' : '';
        }).then(function () {
            if (seq !== scanSeq) return;
            if (btn) { btn.classList.remove('is-busy'); btn.textContent = '↻ 重新扫描'; }
        });
    }

    function renderFoot() {
        var foot = document.getElementById('sg-bg-foot');
        if (!foot) return;
        var s = '共 ' + items.length + ' 张 · 悬停查看预览 · 点击即应用 · 选择自动记忆';
        if (!directoryOk) {
            s += ' ｜ 当前服务未返回目录索引，点「导入文件夹」手动选择 background/';
        } else if (newCount) {
            s += ' ｜ ' + newCount + ' 张新图，缩略图由浏览器自动生成';
        } else {
            s += ' ｜ 新图直接放进 background/ 后点「↻ 重新扫描」';
        }
        if (manualCount) s += ' ｜ ' + manualCount + ' 张为本次会话导入（刷新后需重新选择）';
        foot.textContent = s;
    }

    function renderGrid() {
        grid.innerHTML = '';
        if (!items.length) {
            var empty = el('div', '', 'sg-group-title');
            empty.textContent = directoryOk
                ? 'background/ 里还没有图片'
                : '未读到目录索引：请用本地 HTTP 服务打开本页，或点「导入文件夹」选择 background/';
            grid.appendChild(empty);
            return;
        }
        GROUPS.forEach(function (g) {
            var list = items.filter(function (it) { return it.group === g.key; });
            if (!list.length) return;
            var title = el('div', '', 'sg-group-title');
            title.textContent = g.label + ' · ' + list.length;
            grid.appendChild(title);
            list.forEach(function (it) {
                var card = el('button', '', 'sg-bg-card' + (it.isNew ? ' is-new' : ''));
                card.type = 'button';
                card.dataset.file = it.file;
                card.title = it.file + (it.isNew ? '（新加入）' : '');
                var img = el('img');
                img.alt = it.label;
                img.loading = 'lazy';
                attachThumb(img, it);
                var span = el('span');
                span.textContent = it.label;
                card.appendChild(img);
                card.appendChild(span);
                card.addEventListener('mouseenter', function () { showPreview(it); });
                card.addEventListener('focus', function () { showPreview(it); });
                card.addEventListener('mouseleave', function () { showPreview(findItem(currentBg)); });
                card.addEventListener('click', function (e) {
                    e.stopPropagation();
                    applyBg(it.file, true);
                });
                grid.appendChild(card);
            });
        });
    }

    /* 鼠标滚轮横向浏览角色 tab。
       #sg-models 只有横向可滚，竖向滚轮默认会去滚页面；这里把 deltaY 映射成
       scrollLeft，鼠标停在顶部控制条任意位置都能左右翻模型。
         · 触控板横向手势（|deltaX| > |deltaY|）交给浏览器原生，不叠加；
         · 滚到两端就放行，不锁住页面滚动；
         · Ctrl / Cmd + 滚轮是浏览器缩放，绝不拦截；
         · 监听挂在 #sg-bar 而不是 #sg-models，renderModelTabs() 重建子节点不会丢。 */
    function onModelWheel(e) {
        if (!modelsEl || !pinned || e.ctrlKey || e.metaKey) return;
        var max = modelsEl.scrollWidth - modelsEl.clientWidth;
        if (max <= 1) return;                       // 没溢出就别抢滚轮
        var dx = e.deltaX || 0, dy = e.deltaY || 0;
        if (!dy || Math.abs(dx) > Math.abs(dy)) return;
        var unit = e.deltaMode === 1 ? 16
            : (e.deltaMode === 2 ? modelsEl.clientWidth : 1);
        var cur = modelsEl.scrollLeft;
        var next = Math.max(0, Math.min(max, cur + dy * unit));
        if (Math.abs(next - cur) < 0.5) return;    // 到边界，把滚轮还给页面
        modelsEl.scrollLeft = next;
        e.preventDefault();
    }

    function buildTop() {
        top = el('div', 'sg-top');
        hot = el('div', 'sg-hot');
        hot.title = '移到页面顶端显示控制条';
        top.appendChild(hot);

        // 收起态提示条：保留一个轻量的「← 主页」入口，右侧仍是「显示控制条」
        peek = el('div', 'sg-peek');
        peek.innerHTML = '<a id="sg-peek-home" href="../index.html" title="返回主页 · STEINS;GATE">'
            + '← 主页</a><button id="sg-peek-btn" type="button" aria-controls="sg-bar" '
            + 'title="显示控制条（或按 ESC）"><i>▼</i> 显示控制条</button>';
        top.appendChild(peek);
        peekHome = peek.querySelector('#sg-peek-home');   // 此时 top 还没进 document

        bar = el('div', 'sg-bar');
        var inner = el('div', 'sg-bar-inner');

        // 主页独立槽位：与角色 tab 同一排、同高、同一套尺寸规则，
        // 但不在滚动容器里 —— 横向滚动时模型 tab 永远不会压到它。
        homeSlot = el('div', 'sg-home-slot');
        home = el('a', 'sg-home', 'sg-home-tab');
        home.href = '../index.html';
        home.title = '返回主页 · STEINS;GATE';
        home.setAttribute('aria-label', '返回主页');
        home.innerHTML = '<b>← 主页</b><i>HOME</i>';
        homeSlot.appendChild(home);
        inner.appendChild(homeSlot);

        modelsEl = el('div', 'sg-models');
        modelsEl.setAttribute('role', 'tablist');
        modelsEl.setAttribute('aria-label', '角色');
        renderModelTabs();          // 先用内置分组铺满，异步扫描到目录再原地替换
        inner.appendChild(modelsEl);

        var tools = el('div', 'sg-bar-tools');
        bgToggle = el('button', 'sg-bg-toggle', 'sg-tool');
        bgToggle.type = 'button';
        bgToggle.innerHTML = '切换背景<small>BACKGROUND</small>';
        bgToggle.title = '打开背景预览并切换';
        bgToggle.addEventListener('click', function (e) {
            e.stopPropagation(); setBgOpen(!bgOpen);
        });
        tools.appendChild(bgToggle);

        // 隐藏按钮紧挨「切换背景」，与它同高同款
        hint = el('button', 'sg-hint', 'sg-tool');
        hint.type = 'button';
        hint.setAttribute('aria-controls', 'sg-bar');
        hint.addEventListener('click', function (e) {
            e.stopPropagation();
            setPinned(!pinned);
        });
        tools.appendChild(hint);
        inner.appendChild(tools);

        bar.appendChild(inner);
        document.body.appendChild(top);
        document.body.appendChild(bar);

        // 提示条任意处（含整条感应带）都能一键切回展开，成本降到一次点击
        peek.addEventListener('click', function (e) {
            e.stopPropagation();
            setPinned(true);
        });
        peekHome.addEventListener('click', function (e) {
            e.stopPropagation();   // 收起态的主页入口只负责导航
        });
        home.addEventListener('click', function (e) {
            e.stopPropagation();   // 控制条里的主页只负责导航，不在这里切状态
        });
        top.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!pinned) setPinned(true);
        });
        top.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        bar.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        bar.addEventListener('click', function (e) {
            e.stopPropagation();
            // 角色 tab / 造型按钮都 stopPropagation，能到这里的是控制条其它区域
            if (modelPanelOpen) setModelPanelOpen(false);
        });
        bar.addEventListener('wheel', onModelWheel, { passive: false });
    }

    function buildBgPanel() {
        panel = el('div', 'sg-bg-panel');
        panel.setAttribute('aria-hidden', 'true');

        var head = el('div', 'sg-bg-head');
        var t = el('b'); t.textContent = '切换背景';
        currentLabel = el('span', 'sg-bg-current');
        currentLabel.textContent = '当前：' + currentBg;
        var rescan = el('button', 'sg-bg-rescan');
        rescan.type = 'button';
        rescan.textContent = '↻ 重新扫描';
        rescan.title = '重新读取 background/ 目录，刚丢进去的新图立刻出现';
        rescan.addEventListener('click', function (e) { e.stopPropagation(); loadBackgrounds(); });
        // 服务器不返回目录索引时的纯前端兜底：让用户选一次文件夹
        var importBtn = el('button', 'sg-bg-import');
        importBtn.type = 'button';
        importBtn.textContent = '导入文件夹';
        importBtn.title = '手动选择 background/ 文件夹（仅本次会话有效，刷新后需重新选择）';
        importBtn.style.display = 'none';
        var picker = el('input', 'sg-bg-picker');
        picker.type = 'file';
        picker.multiple = true;
        picker.setAttribute('webkitdirectory', '');
        picker.style.display = 'none';
        importBtn.addEventListener('click', function (e) { e.stopPropagation(); picker.click(); });
        picker.addEventListener('change', function () {
            var added = 0;
            Array.prototype.forEach.call(picker.files || [], function (f) {
                if (!IMG_EXTS.test(f.name)) return;
                if ((f.webkitRelativePath || '').split('/').length > 2) return;  // 跳过 thumbs/ 子目录
                var meta = classify(f.name);
                manualItems.push({
                    file: f.name, label: meta.label, group: meta.group,
                    groupLabel: meta.groupLabel, isNew: false, isManual: true,
                    blob: URL.createObjectURL(f)
                });
                added++;
            });
            picker.value = '';
            if (added) loadBackgrounds();
        });
        bgCloseBtn = el('button', 'sg-bg-close');
        bgCloseBtn.type = 'button';
        bgCloseBtn.textContent = '关闭';
        bgCloseBtn.title = '关闭背景面板';
        bgCloseBtn.addEventListener('click', function (e) { e.stopPropagation(); setBgOpen(false); });
        head.appendChild(t); head.appendChild(currentLabel);
        head.appendChild(rescan); head.appendChild(importBtn); head.appendChild(bgCloseBtn);

        var preview = el('div', 'sg-bg-preview');
        previewImg = el('img');
        previewImg.alt = '背景预览';
        previewImg.addEventListener('error', function () {
            if (previewImg.dataset.sgFallback || !previewFallback) return;
            previewImg.dataset.sgFallback = '1';
            previewImg.src = previewFallback;   // thumbs/ 缓存不存在时退回原图
        });
        previewLabel = el('span');
        preview.appendChild(previewImg);
        preview.appendChild(previewLabel);

        grid = el('div', 'sg-bg-grid');
        var foot = el('div', 'sg-bg-foot');
        foot.textContent = '悬停查看预览 · 点击即应用 · 选择自动记忆';

        panel.appendChild(head);
        panel.appendChild(preview);
        panel.appendChild(grid);
        panel.appendChild(foot);
        panel.appendChild(picker);
        document.body.appendChild(panel);

        panel.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        panel.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    function init() {
        var st = el('style');
        st.id = 'sg-scene-ui-style';
        st.textContent = CSS;
        document.head.appendChild(st);

        currentModel = readModel();
        Array.prototype.push.apply(groups, buildGroups(builtinTree()));
        Array.prototype.push.apply(models, flattenModels(groups));
        try {
            currentBg = localStorage.getItem('sg-bg') || 'background.jpg';
        } catch (_) { currentBg = 'background.jpg'; }

        loadThumbCache();
        buildTop();
        buildBgPanel();
        buildModelPanel();
        applyBg(currentBg, false);
        var curMeta = classify(currentBg);
        showPreview({ file: currentBg, label: curMeta.label, groupLabel: curMeta.groupLabel });
        setPinned(true);   // 默认固定展开，不依赖鼠标位置

        // 异步把内置列表换成 ../data/ 的真实目录；成功与否都不影响控制条可用。
        // 这个 promise 也交给 main.js：首次访问本地还没有索引时，靠它决定默认模型。
        readyScan = refreshModels();

        // 浏览器后退会从 bfcache 恢复这一页。点造型时是先亮遮罩、再导航，
        // 被冻结的这一刻遮罩还挂着，而恢复不会重跑加载流程 —— 必须在这里撤掉，
        // 否则会一直卡在 loading 界面。万一恢复后播放器已不可用，就重新加载一次。
        window.addEventListener('pageshow', function (e) {
            if (!e.persisted) return;
            var alive = false;
            try { alive = (typeof ModelLoader !== 'undefined') && !!ModelLoader._player; } catch (_) {}
            if (!alive) { location.reload(); return; }
            // 恢复的是「点造型之前」的那一页：把当时展开的造型面板一起收起，
            // 否则会出现「面板停在香草、当前模型却是上一个角色」的错位观感
            setModelPanelOpen(false);
            if (window.SG_LOADING) window.SG_LOADING.hide();
        });

        // 从文件管理器切回页面时静默重扫：页面开着往 data/ 丢模型也会自己出现
        var rescanTimer = 0;
        function scheduleRescan() {
            if (window.SG_LOADING && typeof SG_LOADING.isVisible === 'function'
                && SG_LOADING.isVisible()) return;   // 正在切模型，别打断重载
            clearTimeout(rescanTimer);
            rescanTimer = setTimeout(refreshModels, 120);
        }
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) scheduleRescan();
        });
        window.addEventListener('focus', scheduleRescan);

        // 展开控制台时先把背景面板收掉；反过来 setBgOpen() 会收起控制台
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!bgOpen || !t || !t.closest || !t.closest('#emote-dev-tab')) return;
            setBgOpen(false);
        }, true);

        // 点造型面板 / 角色 tab 以外的地方收起（两者的 click 已 stopPropagation）
        document.addEventListener('click', function (e) {
            if (!modelPanelOpen) return;
            var t = e.target;
            if (t && t.closest && (t.closest('#sg-model-panel') || t.closest('.sg-model'))) return;
            setModelPanelOpen(false);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            // 逐层收起：造型面板 → 背景面板 → 控制台 → 顶部控制条
            if (modelPanelOpen) { setModelPanelOpen(false); return; }
            if (bgOpen) { setBgOpen(false); return; }
            // 控制台展开时 ESC 只负责收起它，顶部控制条不要跟着一起动
            if (devPanelOpen()) { closeDevPanel(); return; }
            setPinned(!pinned);
        });

        window.SGSceneUI = {
            // 兼容旧契约：models 是文件名数组；用 getter 让重扫后的内容自动可见
            get models() { return models.map(function (m) { return m.file; }); },
            modelList: function () {
                return models.map(function (m) {
                    return { file: m.file, path: m.path, folder: m.folder,
                             name: m.name, sub: m.sub, isNew: !!m.isNew };
                });
            },
            groups: function () {
                return groups.map(function (g) {
                    return { folder: g.folder, label: g.label, isNew: g.isNew,
                             count: g.models.length,
                             models: g.models.map(function (m) {
                                 return { file: m.file, path: m.path, sub: m.sub, isNew: m.isNew };
                             }) };
                });
            },
            activeGroup: function () { return modelPanelOpen ? activeFolder : null; },
            openGroup: function (f) {
                var g = findGroup(f);
                if (!g) return false;
                activeFolder = f;
                markGroupRead(g);
                renderModelPanel();
                setModelPanelOpen(true);
                return true;
            },
            closeGroup: function () { setModelPanelOpen(false); },
            isModelPanelOpen: function () { return modelPanelOpen; },
            panelItems: function () {
                return Array.prototype.map.call(
                    modelPanelList ? modelPanelList.querySelectorAll('.sg-mp-item') : [],
                    function (b) {
                        return { path: b.dataset.path, label: b.querySelector('b').textContent,
                                 current: b.classList.contains('is-current'),
                                 isNew: b.classList.contains('is-new') };
                    });
            },
            modelSource: function () { return modelSource; },
            refreshModels: refreshModels,
            ready: readyScan,       // 首轮扫描 promise（main.js 用来定默认模型）
            /* 默认模型是扫描完成才确定的：让主脚本把「当前模型」回写过来并刷新高亮 */
            setCurrent: function (f) {
                currentModel = f || readModel();
                renderModelTabs();
                if (modelPanelOpen) renderModelPanel();
                return currentModel;
            },
            modelInfo: function (f) {
                var m = findModel(f);
                return m ? { file: m.file, path: m.path, folder: m.folder,
                             name: m.name, sub: m.sub, isNew: !!m.isNew } : null;
            },
            currentModel: currentModel,
            getBackground: function () { return currentBg; },
            setBackground: function (f) { applyBg(f, true); },
            openBackgrounds: function () { setBgOpen(true); },
            refreshBackgrounds: loadBackgrounds,
            backgrounds: function () {
                return items.map(function (i) {
                    return { file: i.file, group: i.group, isNew: i.isNew,
                             isManual: !!i.isManual, preview: previewOf(i) };
                });
            },
            source: 'http-directory',
            directoryOk: function () { return directoryOk; },
            thumbCacheSize: function () { return Object.keys(thumbCache).length; },
            homeHref: function () { return home ? home.getAttribute('href') : null; },
            modelScroll: function () {
                if (!modelsEl) return null;
                return { left: Math.round(modelsEl.scrollLeft),
                         max: Math.round(modelsEl.scrollWidth - modelsEl.clientWidth),
                         tabs: modelsEl.querySelectorAll('.sg-model').length };
            },
            isBarOpen: function () { return pinned; },
            isPinned: function () { return pinned; },
            setPinned: setPinned,
            isBgPanelOpen: function () { return bgOpen; }
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
