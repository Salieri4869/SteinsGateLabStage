// ============================================================
//  scene-ui.js —— 场景控制条与右侧面板（排序 / 造型 / 背景）
//
//  控制条：默认固定展开。主页槽位 → 角色 tab（横向滚动）→ ⇅ 排序 /
//  切换背景 / ▲ 隐藏；收起后鼠标移入页面顶端滑出「▼ 显示控制条」。
//
//  数据来源：
//    角色与造型  ../data/ 的目录索引，文件夹名即角色名，文件名即造型名。
//                支持 *.zip 与裸 PSB（*.psb / *.psb.m / *.pure.psb）；
//                目录索引不可用时用 localStorage 里的上次扫描结果兜底。
//    tab 顺序    actions-config/order.json 的 roles，缺省按名字排。
//    造型显示名  actions-config/<角色>/<词干>.json 的 name。
//    背景        background/ 的目录索引，文件名推断分组与标签。
//
//  右侧面板四选一：造型 / 排序 / 背景 / 控制台，开一个收掉其余。
//  ESC 逐层收起：排序 → 造型 → 背景 → 控制台 → 控制条。
//
//  写盘能力由 main.mjs 提供（响应头 X-Emote-Server: node），两个接口：
//    PUT /api/order  调序后 300ms 防抖写回 actions-config/order.json
//    PUT /api/thumb  背景生成 1280×720 缩略图写进 background/.thumbs/
//  没有写盘接口时：排序只留本次会话，缩略图只读已有文件，界面照实提示。
//
//  只做 UI，不碰 E-mote 渲染与 canvas。
// ============================================================
(function () {
    'use strict';

    // 角色与造型来自 ../data/ 的目录索引：丢文件即出现，显示名由文件名推断；
    // 要单独改名就写 actions-config/<角色>/<模型>.json 的 "name"。
    /* 裸 PSB（不压缩，直接把文件丢进角色文件夹，如 柳木詩夢/shi_45.pure.psb）。
       备选分支必须由长到短，否则 ".psb" 会抢先匹配、只剥掉一层后缀，
       剩下的 ".psb.m.pure" 会被当成造型名。 */
    var RAW_PSB_EXT = /\.(?:psb\.m\.pure\.psb|psb\.m\.pure|psb\.m\.psb|pure\.psb|psb\.m|psb|pure)$/i;
    var AUX_PSB_EXT = /\.resx\.psb$/i;             // 附属资源（图标 / 余项），不是可加载模型
    function isRawModel(name) { return !AUX_PSB_EXT.test(name) && RAW_PSB_EXT.test(name); }
    /* data/ 里的都是模型，所以任何 .zip 都算：内部含 .psb 即可，ModelLoader 按 magic 解压 */
    function isModelFile(name) {
        return /\.zip$/i.test(name) || isRawModel(name);
    }
    /** 去掉打包后缀，得到「角色名 / 造型词」的原始部分 */
    function stripModelExt(name) {
        return String(name).replace(/\.zip$/i, '').replace(RAW_PSB_EXT, '');
    }
    // 动作配置目录与模型 tab 共用同一套「去打包后缀」规则，避免两份实现漂移。
    // IIFE 执行时立即挂出，不依赖 init()，因此 onload 里的 start() 一定拿得到。
    window.SGStripModelExt = stripModelExt;
    var MODEL_KNOWN_KEY = 'sg-models-known-v1';    // 上次扫描到的全部造型路径（基线）
    var MODEL_UNREAD_KEY = 'sg-models-unread-v1';  // 新增、但还没打开看过的造型路径
    var CONFIG_ROOT = '../actions-config/';        // 造型显示名 / 角色顺序的可选来源
    var modelNames = {};           // '<角色>/<词干>' → 配置 JSON 里的 name（造型显示名）
    /* 角色 tab 顺序：只认 actions-config/order.json（写文件夹名，其余自动追加）。
       面板里调完自动写回文件；文件没有就退回纯自动序。 */
    var roleOrder = [];            // 生效顺序（order.json 的 roles + 还没写盘的调整）
    var roleOrderSource = [];      // 文件里的原始 roles，「重置」和未保存判定用它
    var orderDirty = false;        // 有还没写回文件的调整

    var groups = [];               // 角色组（tab 数据）：{ folder, label, models, isNew }
    var models = [];               // 全部造型的扁平列表，保持 SGSceneUI.models 旧契约
    var modelSource = 'builtin';   // 'http-directory' | 'builtin'
    var MODEL_INDEX_KEY = 'sg-model-index-v1';   // 纯文件名 → 角色/文件名（给 main.js 早期解析用）
    var modelPanelOpen = false, activeFolder = '', sortOpen = false;
    var readyScan = null;          // 首轮扫描的 promise：main.js 靠它决定默认模型

    var GROUPS = [
        { key: 'new',     label: '新加入' },   // 刚放进来的图排最前，一打开面板就看得见
        { key: 'default', label: '默认场景' },
        { key: 'event',   label: '事件 CG' },
        { key: 'scene',   label: '场景背景' }
    ];

    var IMG_EXTS = /\.(png|jpe?g|webp|gif|bmp)$/i;
    // 上次扫描到的文件名（用来标 NEW）；缩略图不放浏览器，全部落盘 background/.thumbs/
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

        // ---- 收起时右上角滑出的提示条：主页入口 + 显示控制条 ----
        // 主页按钮已在控制条里（.sg-home-tab），这里只补收起态的入口
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
        // 滚轮 / 触控板横滑已能浏览，所以隐藏横向滚动条：它吃掉 11px 高度，
        // 会把 tab 从 41px 压到 31px。
        '#sg-models::-webkit-scrollbar{display:none}',
        // 主页按钮与角色 tab 共用同一套尺寸规则（同一个选择器组），但分处不同容器；
        // 不带 .sg-model 类名，避免被「按 .sg-model 取模型」的逻辑误当成一个模型。
        // 定宽 width 保证每个 tab 与主页严格等宽，b/i 用 flex:none + 省略号，
        // 避免长副标撑破或被压成 0 高。
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
        // 隐藏／显示：与「切换背景」同规格，紧挨着放在控制条右端
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

        // ---- 角色顺序面板：控制条「⇅ 排序」打开，↑↓ 调 tab ----
        '#sg-sort-toggle{min-width:74px}',
        '#sg-sort-panel{position:fixed;top:60px;right:16px;left:auto;width:min(268px,92vw);',
        ' max-height:min(72vh,600px);z-index:85;display:none;flex-direction:column;',
        ' background:#0b1419;border:1px solid rgba(233,185,110,.45);border-radius:6px;',
        ' box-shadow:0 14px 38px rgba(0,0,0,.62);overflow:hidden;',
        ' font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6f1ef}',
        'body.sg-sort-open #sg-sort-panel{display:flex}',
        '#sg-sp-head{flex:none;display:flex;align-items:center;gap:10px;padding:10px 12px;',
        ' border-bottom:1px solid rgba(233,185,110,.24);background:#1a1710}',
        '#sg-sp-head b{flex:1;font-size:12px;font-weight:600;letter-spacing:.04em;color:#f6e4c4;',
        ' overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '#sg-sp-head button{flex:none;height:26px;padding:0 9px;border:1px solid rgba(255,255,255,.18);',
        ' border-radius:4px;background:#14242b;color:#e6f1ef;cursor:pointer;font-size:11px}',
        '#sg-sp-head button:hover{background:#1d3540}',
        '#sg-sp-reset{color:#a9c6c2}',
        '#sg-sp-reset:disabled{opacity:.4;cursor:default}',
        '#sg-sp-list{flex:1;min-height:0;overflow-y:auto;padding:8px;',
        ' display:flex;flex-direction:column;gap:5px;scrollbar-width:thin;',
        ' scrollbar-color:rgba(233,185,110,.35) transparent}',
        '.sg-sp-row{flex:none;display:flex;align-items:center;gap:6px;padding:5px 6px;',
        ' border:1px solid rgba(255,255,255,.1);border-radius:5px;background:#121f26}',
        '.sg-sp-row.is-new{border-color:rgba(233,185,110,.55)}',
        '.sg-sp-row.is-dragging{opacity:.26}',
        '.sg-sp-grip{flex:none;width:14px;height:22px;display:flex;align-items:center;',
        ' justify-content:center;color:#7c959a;cursor:grab;touch-action:none;user-select:none;',
        ' font-size:14px;line-height:1}',
        '.sg-sp-row:hover .sg-sp-grip{color:#a9c6c2}',
        '.sg-sp-grip:active{cursor:grabbing;color:#63d6c4}',
        'body.sg-sp-dragging{cursor:grabbing;user-select:none}',
        '.sg-sp-ghost{position:fixed;z-index:200;pointer-events:none;opacity:.94;',
        ' box-shadow:0 10px 26px rgba(0,0,0,.55);border-radius:5px;transform:rotate(-.6deg)}',
        '.sg-sp-idx{flex:none;width:16px;text-align:right;color:#7c959a;',
        ' font:10px/1 ui-monospace,Consolas,monospace}',
        '.sg-sp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;',
        ' white-space:nowrap;font-size:12px}',
        '.sg-sp-mv{flex:none;width:22px;height:22px;padding:0;border:1px solid rgba(255,255,255,.16);',
        ' border-radius:4px;background:#14242b;color:#cfe0dd;cursor:pointer;font-size:11px;line-height:1}',
        '.sg-sp-mv:hover{background:#1d3540;border-color:rgba(99,214,196,.5)}',
        '.sg-sp-mv:disabled{opacity:.28;cursor:default}',
        '#sg-sp-tip{flex:none;padding:0 10px 9px;font-size:10px;line-height:1.5;color:#7c959a}',
        '#sg-sp-tip-path{margin-top:4px;padding:3px 5px;border:1px solid rgba(99,214,196,.16);',
        ' border-radius:3px;background:#0f1b21;font:9.5px/1.45 ui-monospace,Consolas,monospace;',
        ' color:#6f8b91;white-space:nowrap;overflow:hidden;user-select:all}',
        '#sg-sp-tip-path b{color:#8fd8cd;font-weight:600}',

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
        ' #sg-sort-toggle{min-width:0;padding:0 8px;font-size:11px}',
        ' #sg-sort-toggle small{display:none}',
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
    var sortToggle, sortPanel, sortListEl, sortTipEl, sortTipMsg, sortTipPathEl, sortResetBtn;
    // 拖拽排序：dragRow 是被拖的那一行（留在列表里当占位），dragGhost 跟着指针走
    var dragRow = null, dragGhost = null, dragStartY = 0, dragOffset = 0, dragMoved = false;
    var panel, grid, previewImg, previewLabel, currentLabel;
    var modelPanel, modelPanelTitle, modelPanelList;
    var pinned = false, bgOpen = false;
    var items = [], currentBg = 'background.jpg', currentModel = '';
    var scanSeq = 0, newCount = 0, directoryOk = false, manualCount = 0;
    var thumbAvail = {}, manualItems = [], knownFiles = null;
    // 磁盘缩略图：background/.thumbs/<原名去扩展名>.jpg（1280×720）
    // 页面生成一次 → 经本地服务落盘 → 之后所有卡片和预览都读这张小图
    var thumbState = {}, thumbQueue = [], thumbBusy = false, thumbReady = {};
    var thumbServer = null;          // null 未知 / true 可写盘 / false 只能读现有文件
    var previewFile = '';

    function el(tag, id, cls) {
        var n = document.createElement(tag);
        if (id) n.id = id;
        if (cls) n.className = cls;
        return n;
    }

    /* 文件名即元数据（默认显示名）：
       · 站内原格式 <角色名><版本码>[_<造型>].psb.m.pure.zip
         例如 阿万音鈴羽b_軍服 → 阿万音鈴羽 / 軍服 · B；
       · 文件夹内命名（zip 或裸 PSB 都走这条）：角色名一律取文件夹名，
         造型名由文件名推断——
           chocola-casual → 巧克力 / casual
           shi_45         → 柳木詩夢 / shi 45（纯编号，保留前缀便于区分）
           柳木詩夢_私服   → 柳木詩夢 / 私服（文件名自带角色名时只留后半段）
       想给某个造型换个显示名，就在 actions-config/<角色>/<模型>.json 里写
       "name": "…"（见 modelNames）；没写的走这里的文件名默认值。 */
    function describeModel(file, folder) {
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
                // 纯编号（shi-45）保留前缀；造型词（casual）只留后半段
                sub = /^\d+$/.test(word) ? seg.join(' ') : word;
            }
            return { file: file, name: folder, sub: sub || stem };
        }
        var parts = stem.split('_');
        var base = parts[0];
        var costume = parts.slice(1).join('_');
        var m = /^(.*?)([a-z]+)$/i.exec(base);
        var role = (m && m[1]) ? m[1] : base;
        var code = (m && m[1]) ? m[2].toUpperCase() : '';
        var sub = (costume || '制服') + (code ? ' · ' + code : '');
        return { file: file, name: role, sub: sub };
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
            .then(function (r) {
                // 本地 node 服务（main.mjs）会带这个头：说明 /api/order 在，
                // 排序改动可以自动写盘；没有这个头就是普通静态服务，只能改内存
                if (r.headers.get('x-emote-server') === 'node') setOrderServer(true);
                else setOrderServer(false);
                return r.ok ? r.text() : null;
            })
            .catch(function () { setOrderServer(false); return null; });
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

    /* 造型显示名的唯一可配来源：actions-config/<角色>/<词干>.json 的 name 字段。
       与模型扫描一样只认目录索引里真实存在的条目——根目录 → 列出的角色子目录
       → 子目录里列出的 .json，不存在的文件/目录一次都不请求，不会产生 404。
       索引不可用返回 null（保留上一轮别名），没写 name 或写得不合法就跳过。 */
    function fetchModelNames() {
        return fetchIndex(CONFIG_ROOT).then(function (rootText) {
            if (rootText == null) return null;
            var root = parseIndex(rootText);
            var jsonFiles = root.filter(function (l) {
                return !l.isDir && /\.json$/i.test(l.name);
            }).map(function (l) { return { folder: '', name: l.name }; });
            var folders = root.filter(function (l) { return l.isDir; })
                              .map(function (l) { return l.name; });
            return Promise.all(folders.map(function (folder) {
                var url = CONFIG_ROOT + encodeURIComponent(folder) + '/';
                return fetchIndex(url).then(function (text) {
                    if (text == null) return [];
                    return parseIndex(text).filter(function (l) {
                        return !l.isDir && /\.json$/i.test(l.name);
                    }).map(function (l) { return { folder: folder, name: l.name }; });
                });
            })).then(function (lists) {
                lists.forEach(function (ls) { Array.prototype.push.apply(jsonFiles, ls); });
                return Promise.all(jsonFiles.map(function (f) {
                    var url = CONFIG_ROOT + (f.folder ? encodeURIComponent(f.folder) + '/' : '')
                        + encodeURIComponent(f.name);
                    return fetch(url, { cache: 'no-store' })
                        .then(function (r) { return r.ok ? r.json() : null; })
                        .catch(function () { return null; })
                        .then(function (cfg) {
                            if (!cfg || typeof cfg.name !== 'string' || !cfg.name.trim()) return null;
                            return {
                                key: (f.folder ? f.folder + '/' : '') + f.name.replace(/\.json$/i, ''),
                                name: cfg.name.trim()
                            };
                        })
                        .catch(function () { return null; });   // 单份 JSON 坏了不影响其他模型
                }));
            }).then(function (hits) {
                var out = {};
                hits.forEach(function (h) { if (h) out[h.key] = h.name; });
                return out;
            });
        }).catch(function () { return null; });
    }

    /* 角色 tab 顺序：actions-config/order.json 的 roles（文件夹名数组）。
       与 name 同一套 404 规避——先查根目录索引，文件不存在就一次都不请求；
       读不到返回 null，调用方保留上一轮，不误清空。 */
    function fetchModelOrder() {
        return fetchIndex(CONFIG_ROOT).then(function (text) {
            if (text == null) return null;
            var has = parseIndex(text).some(function (l) {
                return !l.isDir && l.name === 'order.json';
            });
            if (!has) return null;
            return fetch(CONFIG_ROOT + 'order.json', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () {
                    // 手改坏了（缺逗号、尾逗号）在这里几乎无声，给一条可查的线索
                    console.warn('[Sort] actions-config/order.json 不是合法 JSON，本轮退回自动顺序');
                    return null;
                })
                .then(function (cfg) {
                    if (!cfg || !Array.isArray(cfg.roles)) return null;
                    return cfg.roles.filter(function (s) {
                        return typeof s === 'string' && s.trim();
                    }).map(function (s) { return s.trim(); });
                });
        }).catch(function () { return null; });
    }

    /* 顺序只以 actions-config/order.json 为准：调完自动写回文件，刷新后按文件重建。
       不在浏览器里留任何副本，因此不存在两份顺序打架。 */

    function nameKey(file, folder) {
        return (folder ? folder + '/' : '') + stripModelExt(file);
    }

    /* 每轮扫描后并联读一次显示名，回来后原地改 sub 并重绘；
       不阻塞 readyScan，免得拖慢 main.js 决定默认模型的 2.5s 窗口。 */
    function refreshModelNames() {
        fetchModelNames().then(function (map) {
            if (!map) return;               // 索引不可用：保留上一轮，不误清空
            modelNames = map;
            var changed = false;
            models.forEach(function (m) {
                var next = modelNames[nameKey(m.file, m.folder)]
                    || describeModel(m.file, m.folder).sub;
                if (next !== m.sub) { m.sub = next; changed = true; }
            });
            if (!changed) return;
            groups.forEach(function (g) { g.models.sort(compareModels); });
            models.length = 0;             // 扁平列表顺序跟着面板一起更新
            Array.prototype.push.apply(models, flattenModels(groups));
            renderModelTabs();
            if (modelPanelOpen) renderModelPanel();
        });
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

    /* 服务器不给目录索引时的兜底：用上次扫描写下的 file → path 索引重建分组。
       首次访问且索引也读不到时是空树，控制条仍在，只是暂时没有角色 tab。 */
    function builtinTree() {
        var index = {};
        try { index = JSON.parse(localStorage.getItem(MODEL_INDEX_KEY)) || {}; }
        catch (_) { index = {}; }
        var byFolder = {}, rootFiles = [];
        Object.keys(index).forEach(function (file) {
            var path = String(index[file] || '');
            var i = path.lastIndexOf('/');
            if (i < 0) { rootFiles.push(file); return; }
            var folder = path.slice(0, i);
            (byFolder[folder] || (byFolder[folder] = [])).push(file);
        });
        return {
            dirs: Object.keys(byFolder).map(function (f) {
                return { folder: f, files: byFolder[f] };
            }),
            rootFiles: rootFiles
        };
    }

    function modelEntry(file, path, folder) {
        var d = describeModel(file, folder);
        return { file: file, path: path, folder: folder, name: d.name,
                 sub: modelNames[nameKey(file, folder)] || d.sub, isNew: false };
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
        list.forEach(function (g) { g.models.sort(compareModels); });
        return sortGroups(list);
    }

    /* numeric:true —— 裸 PSB 常按编号命名（shi_6 / shi_45 / shi_50），
       按字符排会得到 45 < 6，按自然数排才是 6 < 45 < 50。
       显示名从配置读回来后也要用同一规则重排，免得面板顺序跳变。 */
    function compareModels(a, b) {
        return a.sub.localeCompare(b.sub, 'ja', { numeric: true })
            || a.file.localeCompare(b.file, 'ja', { numeric: true });
    }

    /* 顺序规则（自上而下）：
       ① 在 order.json / 本地草稿里写了的角色，严格按数组序号——NEW 只加角标、不移位；
       ② 没写的一律垫在清单之后：自动区里 NEW 靠前，再按名称。
       这样手工排好的位置不会被新模型顶掉，也不会一排序就把 NEW 全挤没。 */
    function roleRank(g) {
        var k = g.folder || g.label;
        for (var i = 0; i < roleOrder.length; i++) if (roleOrder[i] === k) return i;
        return Infinity;
    }

    /* 有新造型的组排最前，其余按名称排序。isNew 会随「已读」变化，
       所以每次扫描后重排；点开 / 收起面板的当下只改角标、不重排，
       免得用户正在点的 tab 突然移位、造型面板贴错地方。 */
    function sortGroups(list) {
        list.sort(function (a, b) {
            var ra = roleRank(a), rb = roleRank(b);
            if (ra !== rb) return ra === Infinity ? 1 : (rb === Infinity ? -1 : ra - rb);
            if (ra === Infinity && !!a.isNew !== !!b.isNew) return a.isNew ? -1 : 1;
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
        // 顺序和目录一起拿：tab 一次成型，不会先按默认序渲染再当场跳一下
        return Promise.all([fetchModelTree(), fetchModelOrder()]).then(function (res) {
            var tree = res[0];
            // order.json 是唯一来源：文件没有就退回纯自动序
            roleOrderSource = res[1] || [];
            /* 「重置」回到的是页面打开时的那份顺序，只记第一次，后面重扫不改它 */
            if (!orderBaseline.length) orderBaseline = roleOrderSource.slice();
            /* 切窗口回来会触发重扫；有未保存的调整时保留它，别把刚拖好的顺序冲掉 */
            if (!orderDirty) roleOrder = roleOrderSource.slice();
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
            // 回退到本地索引的那一轮不做清理，免得误删未读标记
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
            // 回退轮别覆盖索引：那份索引正是下一次的兜底数据源
            if (modelSource === 'http-directory') writeModelIndex(list);
            renderModelTabs();
            if (modelPanelOpen) renderModelPanel();
            if (sortOpen) renderSortPanel();
            syncSortFoot();                          // 「重置」是否可点，取决于当前序 vs 打开时
            refreshModelNames();                     // 配置里的 name 回来后原地换显示名
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

    /* ---- 角色顺序面板（控制条「⇅ 排序」）----
       调序立刻重排 tab，并在 300ms 防抖后自动写回 order.json，没有保存按钮。
       只有 main.mjs 起的服务带写盘接口（响应头里有 X-Emote-Server）；
       没有服务时顺序只留在本次会话，提示会直说，不假装保存成功。 */
    var ORDER_REL = 'steins-gate-lab-stage/actions-config/order.json';
    var ORDER_API = '../api/order';
    var orderServer = null;          // null = 还没遇到 node 服务；true = 有写盘接口
    var orderSaving = false;
    var orderSaveTimer = 0;
    var orderFailCount = 0;

    function setOrderServer(on) {
        if (orderServer === on) return;
        orderServer = on;
        if (!orderDirty) syncSortTip();
        if (on && orderDirty) scheduleAutoSave();   // 服务晚一步才被认出来时补存一次
    }

    function sortTipBase() {
        if (orderServer === true) return '拖动 ⠿ 或点 ↑↓ 调整，松手自动写入文件';
        if (orderServer === false) {
            return '未连接本地服务：顺序只在本次浏览有效，用 run.bat 打开才能写盘';
        }
        return '拖动 ⠿ 或点 ↑↓ 调整，松手自动保存';
    }

    function buildSortPanel() {
        sortPanel = el('div', 'sg-sort-panel');
        sortPanel.setAttribute('aria-hidden', 'true');

        var head = el('div', 'sg-sp-head');
        var title = el('b'); title.textContent = '角色顺序';
        sortResetBtn = el('button', 'sg-sp-reset');
        sortResetBtn.type = 'button';
        sortResetBtn.textContent = '重置';
        sortResetBtn.title = '放弃本次调整，回到 order.json 里的顺序';
        sortResetBtn.addEventListener('click', function (e) { e.stopPropagation(); resetRoleOrder(); });
        var close = el('button', 'sg-sp-close');
        close.type = 'button'; close.textContent = '关闭';
        close.title = '关闭排序面板';
        close.addEventListener('click', function (e) { e.stopPropagation(); setSortOpen(false); });
        head.appendChild(title); head.appendChild(sortResetBtn); head.appendChild(close);

        sortListEl = el('div', 'sg-sp-list');

        sortTipEl = el('div', 'sg-sp-tip');
        sortTipMsg = el('div', 'sg-sp-tip-msg');
        sortTipMsg.textContent = sortTipBase();
        sortTipPathEl = el('div', 'sg-sp-tip-path');
        sortTipPathEl.title = '每次调序后自动写入这个文件，不需要点保存';
        /* 拆两行写，别让 268px 的窄面板把文件名断在中间 */
        sortTipPathEl.appendChild(document.createTextNode('自动保存到 steins-gate-lab-stage/'));
        sortTipPathEl.appendChild(el('br'));
        var pathFile = el('b'); pathFile.textContent = 'actions-config/order.json';
        sortTipPathEl.appendChild(pathFile);
        sortTipEl.appendChild(sortTipMsg);
        sortTipEl.appendChild(sortTipPathEl);
        syncSortTip();

        sortPanel.appendChild(head);
        sortPanel.appendChild(sortListEl);
        sortPanel.appendChild(sortTipEl);
        document.body.appendChild(sortPanel);
        sortPanel.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        sortPanel.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    /* 列「当前显示顺序」的全量角色：调一次就把全量写进草稿，
       不会再因为部分组没写进 order.json 而回落到自动序。 */
    function currentRoleNames() {
        return groups.map(function (g) { return g.folder || g.label; });
    }

    function renderSortPanel() {
        if (!sortListEl) return;
        var names = currentRoleNames();
        sortListEl.innerHTML = '';
        names.forEach(function (name, i) {
            var g = findGroup(name);
            var row = el('div', '', 'sg-sp-row' + (g && g.isNew ? ' is-new' : ''));
            row.dataset.folder = name;
            var grip = el('span', '', 'sg-sp-grip');
            grip.textContent = '⠿';            // 只从把手起手：不挡列表滚动，也不误触 ▲▼
            grip.title = '按住拖动排序';
            grip.addEventListener('pointerdown', function (e) {
                e.stopPropagation();
                e.preventDefault();
                beginDrag(e, row);
            });
            var idx = el('span', '', 'sg-sp-idx'); idx.textContent = String(i + 1);
            var nm = el('b', '', 'sg-sp-name'); nm.textContent = name;
            var up = el('button', '', 'sg-sp-mv');
            up.type = 'button'; up.textContent = '▲';
            up.dataset.dir = '-1'; up.title = '上移'; up.disabled = i === 0;
            var down = el('button', '', 'sg-sp-mv');
            down.type = 'button'; down.textContent = '▼';
            down.dataset.dir = '1'; down.title = '下移'; down.disabled = i === names.length - 1;
            [up, down].forEach(function (b) {
                b.addEventListener('click', function (e) {
                    e.stopPropagation();
                    moveRole(name, Number(b.dataset.dir));
                });
            });
            row.appendChild(grip); row.appendChild(idx); row.appendChild(nm);
            row.appendChild(up); row.appendChild(down);
            sortListEl.appendChild(row);
        });
    }

    /* 移动 = 取当前全量顺序，交换两位后整体成为新的 roleOrder */
    function moveRole(name, dir) {
        var names = currentRoleNames();
        var i = names.indexOf(name), j = i + dir;
        if (i < 0 || j < 0 || j >= names.length) return;
        var tmp = names[i]; names[i] = names[j]; names[j] = tmp;
        roleOrder = names;
        applyRoleOrder();
        afterOrderChange();
    }

    /* ---- 拖拽排序：把手起手，DOM 边拖边换位，松手才落库 ----
       不用 setPointerCapture（合成事件会抛 NotFoundError），改挂 document 级监听；
       列表行是等高的，用「指针越过某行中线就插到它前面」判断落点。 */
    function beginDrag(e, row) {
        if (dragRow) return;
        dragRow = row;
        dragMoved = false;
        dragStartY = e.clientY;
        dragOffset = e.clientY - row.getBoundingClientRect().top;
        document.addEventListener('pointermove', onDragMove, true);
        document.addEventListener('pointerup', endDrag, true);
        document.addEventListener('pointercancel', endDrag, true);
    }

    function onDragMove(e) {
        if (!dragRow) return;
        if (!dragMoved) {
            if (Math.abs(e.clientY - dragStartY) < 4) return;   // 手抖不算拖
            dragMoved = true;
            var r = dragRow.getBoundingClientRect();
            dragGhost = dragRow.cloneNode(true);
            dragGhost.className = dragRow.className.replace(' is-dragging', '') + ' sg-sp-ghost';
            dragGhost.style.width = r.width + 'px';
            dragGhost.style.left = r.left + 'px';
            dragGhost.style.top = r.top + 'px';
            document.body.appendChild(dragGhost);
            dragRow.classList.add('is-dragging');
            document.body.classList.add('sg-sp-dragging');
        }
        e.preventDefault();
        dragGhost.style.top = (e.clientY - dragOffset) + 'px';
        placeDragRow(e.clientY);
    }

    function placeDragRow(y) {
        var rows = [].slice.call(sortListEl.children).filter(function (n) { return n !== dragRow; });
        var before = null;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i].getBoundingClientRect();
            if (y < r.top + r.height / 2) { before = rows[i]; break; }
        }
        if (before) {
            if (dragRow.nextSibling !== before) sortListEl.insertBefore(dragRow, before);
        } else if (sortListEl.lastElementChild !== dragRow) {
            sortListEl.appendChild(dragRow);
        }
        renumberRows();
    }

    function renumberRows() {
        var rows = sortListEl.children, n = rows.length;
        for (var i = 0; i < n; i++) {
            rows[i].querySelector('.sg-sp-idx').textContent = String(i + 1);
            var btns = rows[i].querySelectorAll('.sg-sp-mv');
            if (btns.length === 2) {
                btns[0].disabled = i === 0;
                btns[1].disabled = i === n - 1;
            }
        }
    }

    function endDrag() {
        if (!dragRow) return;
        document.removeEventListener('pointermove', onDragMove, true);
        document.removeEventListener('pointerup', endDrag, true);
        document.removeEventListener('pointercancel', endDrag, true);
        if (dragGhost && dragGhost.parentNode) dragGhost.parentNode.removeChild(dragGhost);
        dragGhost = null;
        dragRow.classList.remove('is-dragging');
        document.body.classList.remove('sg-sp-dragging');
        dragRow = null;
        if (!dragMoved) return;                  // 只是点了一下把手，顺序没动
        var names = [].slice.call(sortListEl.children).map(function (n) { return n.dataset.folder; });
        roleOrder = names;
        applyRoleOrder();
        afterOrderChange();
    }

    function applyRoleOrder() {
        sortGroups(groups);
        models.length = 0;                 // 扁平列表跟着 tab 一起更新
        Array.prototype.push.apply(models, flattenModels(groups));
        renderModelTabs();
        renderSortPanel();
    }

    /* ---- 自动写盘：只有本地服务能写，浏览器里不留副本 ----
       拖完 / ▲▼ 之后 300ms 防抖，一次 PUT 落到 actions-config/order.json。
       没连上服务时不动文件，只在提示里说明——绝不假装保存成功。 */
    var sortTipTimer = 0;
    var orderSeq = 0;                // 每次调序 +1，用来识别「写盘期间又动了」
    var orderBaseline = [];          // 打开页面时的顺序，「重置」回到这里

    function putOrderRoles(text) {
        return fetch(ORDER_API, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: text
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (body) {
                if (!r.ok || !body || body.ok !== true) {
                    throw new Error((body && body.error) || ('HTTP ' + r.status));
                }
                return body;
            });
        });
    }

    function scheduleAutoSave() {
        if (orderServer !== true) { syncSortTip(); return; }   // 没服务：只提示，不做假动作
        clearTimeout(orderSaveTimer);
        orderSaveTimer = setTimeout(saveOrderNow, 300);
    }

    function saveOrderNow() {
        clearTimeout(orderSaveTimer);
        if (orderServer !== true || !orderDirty) return Promise.resolve(false);
        if (orderSaving) {                 // 上一笔还没写完：等它写完再补一次
            orderSaveTimer = setTimeout(saveOrderNow, 150);
            return Promise.resolve(false);
        }
        var sent = roleOrder.slice();      // 这一笔写的到底是哪份顺序
        var seq = orderSeq;
        orderSaving = true;
        syncSortTip('正在保存…');
        return putOrderRoles(JSON.stringify({ roles: sent }, null, 2) + '\n').then(function (info) {
            orderSaving = false;
            orderFailCount = 0;
            roleOrderSource = sent;        // 服务端刚写下的就是这一份
            syncSortFoot();
            if (seq === orderSeq) {
                orderDirty = false;
                syncSortTip('已保存 · ' + (info.count || 0) + ' 个角色');
            } else {
                orderSaveTimer = setTimeout(saveOrderNow, 120);   // 写盘期间又动了，接着存
            }
            return true;
        }).catch(function (err) {
            orderSaving = false;
            orderFailCount++;
            console.warn('[Sort] 自动保存失败:', (err && err.message) || err);
            /* 偶发（服务刚重启）重试两次；连续失败就停手，别把控制台刷满 */
            if (orderFailCount <= 2) {
                syncSortTip('保存失败，正在重试…');
                orderSaveTimer = setTimeout(saveOrderNow, 1200);
            } else {
                syncSortTip('保存失败：' + ((err && err.message) || '连接中断') +
                    '（顺序还在，重开 run.bat 后再动一下就会补存）');
            }
            return false;
        });
    }

    function syncSortFoot() {
        if (!sortResetBtn) return;
        var same = roleOrder.join('\u0000') === orderBaseline.join('\u0000');
        sortResetBtn.disabled = !orderBaseline.length || same;
        sortResetBtn.title = same
            ? '当前顺序就是打开页面时的那份'
            : '回到打开页面时的顺序（会一并写回 order.json）';
    }

    /* extra 是临时提示（保存中 / 已保存 / 已还原），两秒后退回常驻说明；
       路径那一行常显，不参与轮换 */
    function syncSortTip(extra) {
        if (!sortTipEl || !sortTipMsg) return;
        clearTimeout(sortTipTimer);
        sortTipMsg.textContent = extra || sortTipBase();
        if (!extra) return;
        sortTipTimer = setTimeout(function () { if (sortTipMsg) syncSortTip(); }, 2000);
    }

    /* 每次调序后：重排已由调用方做完，这里只管标脏 + 排队写盘 */
    function afterOrderChange() {
        orderDirty = true;
        orderSeq++;
        syncSortFoot();
        syncSortTip();
        scheduleAutoSave();
    }

    /* 重置：回到打开页面时的那份顺序；有写盘能力时顺手把这一份也写回去
       （说不定上一笔 PUT 还在飞，写完才算两边一致） */
    function resetRoleOrder() {
        clearTimeout(orderSaveTimer);
        if (!orderBaseline.length) return;
        roleOrder = orderBaseline.slice();
        applyRoleOrder();
        if (orderServer === true) {
            orderDirty = true;
            orderSeq++;
            syncSortFoot();
            syncSortTip('已还原，正在写回文件…');
            saveOrderNow();
        } else {
            orderDirty = false;
            syncSortFoot();
            syncSortTip('已还原到 order.json 的顺序');
        }
    }

    /* 面板贴窗口右侧、右边缘与「⇅ 排序」按钮对齐：按按钮实测位置算 right，
       窗口缩放时重算；窄屏（≤720px）改成通栏贴边，免得挤出屏幕。 */
    function positionSortPanel() {
        if (!sortPanel || !sortToggle || !bar) return;
        var btn = sortToggle.getBoundingClientRect();
        var barBox = bar.getBoundingClientRect();
        sortPanel.style.top = Math.round(barBox.bottom + 8) + 'px';
        if (window.innerWidth <= 720) {
            sortPanel.style.left = '8px';
            sortPanel.style.right = '8px';
            sortPanel.style.width = 'auto';
        } else {
            sortPanel.style.left = 'auto';
            sortPanel.style.right = Math.max(8, Math.round(window.innerWidth - btn.right)) + 'px';
            sortPanel.style.width = '';
        }
    }

    function setSortOpen(v) {
        var next = !!v;
        sortOpen = next;
        document.body.classList.toggle('sg-sort-open', sortOpen);
        if (sortPanel) sortPanel.setAttribute('aria-hidden', String(!sortOpen));
        if (sortToggle) {
            sortToggle.classList.toggle('is-on', sortOpen);
            sortToggle.setAttribute('aria-expanded', String(sortOpen));
        }
        if (sortOpen) {
            setBgOpen(false);            // 右侧面板同屏只留一块
            setModelPanelOpen(false);
            closeDevPanel();             // 控制台也占右侧，一起收掉
            setPinned(true);
            renderSortPanel();
            positionSortPanel();
        }
    }

    function setModelPanelOpen(v) {
        var next = !!v;
        // 收起造型面板 = 这一组的新造型看过了：角标当场撤掉
        if (modelPanelOpen && !next && activeFolder) dismissGroupNew(findGroup(activeFolder));
        modelPanelOpen = next;
        document.body.classList.toggle('sg-mp-open', modelPanelOpen);
        if (modelPanel) modelPanel.setAttribute('aria-hidden', String(!modelPanelOpen));
        if (modelPanelOpen && bgOpen) setBgOpen(false);   // 右侧只留一块面板
        if (modelPanelOpen && sortOpen) setSortOpen(false);
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

    function stemOf(file) { return file.replace(/\.[^.]+$/, ''); }

    /* 磁盘缩略图地址：有就返回它，没有返回 null（调用方回退原图） */
    function thumbUrlOf(file) {
        var s = stemOf(file);
        return thumbAvail[s] ? THUMB_DIR + encodeURIComponent(s) + '.jpg' : null;
    }

    // 预览唯一入口：手动导入的 blob → 磁盘 720p 缩略图 → 原图
    // 大预览、卡片、backgrounds() 都走这里，浏览器里不缓存第二份
    function previewOf(it) {
        if (it.blob) return it.blob;
        return thumbUrlOf(it.file) || bgUrl(it.file);
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

    /* 悬停防抖：鼠标快速划过一排卡片时不真的去解码，停住 120ms 才换预览。
       换的时候优先用磁盘缩略图；还没有就先用原图顶着，同时排队生成，
       生成完由 refreshThumbUsers() 换成小图。 */
    var hoverTimer = 0, hoverSeq = 0;
    function showPreview(item) {
        if (!item) return;
        var seq = ++hoverSeq;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(function () {
            if (seq === hoverSeq) paintPreview(item);
        }, 120);
    }

    function paintPreview(item) {
        previewFile = item.file;
        previewImg.src = previewOf(item);
        previewLabel.textContent = item.label + '  ·  ' + item.groupLabel;
        if (item.blob || thumbUrlOf(item.file)) return;
        var s = stemOf(item.file);
        if (thumbState[s] === 'saving' || thumbState[s] === 'done') return;
        if (thumbQueue.indexOf(item.file) < 0) thumbQueue.unshift(item.file);   // 悬停的这张优先补
        pumpThumbs();
    }

    // 右侧同一时间只放一块面板：造型 / 排序 / 背景 / 控制台，开一个收其余
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
        if (v) { closeDevPanel(); setSortOpen(false); setModelPanelOpen(false); setPinned(true); loadBackgrounds(); }
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

    /* ---- 磁盘缩略图：生成一次 → 落盘 → 之后只读小图 ----
       main.mjs 提供 GET /api/thumbs（已有清单）与 PUT /api/thumb?name=原图名。
       没有写盘接口（非 main.mjs 起的静态服务）时只读已有文件，不生成。 */
    var THUMB_DIR = 'background/.thumbs/';
    var THUMB_PUT = '../api/thumb';
    var THUMB_W = 1280, THUMB_H = 720, THUMB_Q = 0.9;

    function thumbNameList(text) {
        var out = [], m, re = /href\s*=\s*["']([^"']+)["']/gi;
        while ((m = re.exec(text || ''))) {
            var raw = m[1].split(/[?#]/)[0];
            if (!raw || /\/$/.test(raw)) continue;
            var f;
            try { f = decodeURIComponent(raw); } catch (_) { f = raw; }
            f = f.replace(/^.*\//, '');
            if (/\.jpe?g$/i.test(f)) out.push(f.replace(/\.[^.]+$/, ''));
        }
        return out;
    }

    /* 已有缩略图清单：直接读 .thumbs/ 的目录索引（node 与纯静态服务都支持），
       顺带从响应头判断有没有写盘能力——一个请求解决两件事，不额外探 404。 */
    function loadThumbIndex() {
        return fetch(THUMB_DIR + '?t=' + Date.now(), { cache: 'no-store' })
            .then(function (r) {
                thumbServer = r.headers.get('x-emote-server') === 'node';
                return r.ok ? r.text() : '';
            })
            .then(function (text) {
                thumbNameList(text).forEach(function (s) { thumbAvail[s] = true; });
            })
            .catch(function () { thumbServer = false; });
    }

    /* 把已解码的原图裁成 cover 尺寸的 JPEG dataURL（实际只用于 1280×720 缩略图）。
       同源 HTTP / blob URL 都不污染 canvas；失败返回 null，调用方回退原图。 */
    function makeThumb(img, w, h, q) {
        try {
            w = w || 240; h = h || 135; q = q || 0.72;
            var c = document.createElement('canvas');
            c.width = w; c.height = h;
            var ctx = c.getContext('2d');
            var s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
            var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
            ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
            return c.toDataURL('image/jpeg', q);
        } catch (_) { return null; }
    }

    function dataUrlToBlob(url) {
        var parts = String(url).split(',');
        var bin = atob(parts[1] || '');
        var buf = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return new Blob([buf], { type: 'image/jpeg' });
    }

    /* 生成 + 落盘。调用前已经把 thumbState 标成 saving，避免同一张并发写两遍。 */
    function saveThumb(file, img) {
        var s = stemOf(file);
        var data = makeThumb(img, THUMB_W, THUMB_H, THUMB_Q);
        if (!data) { thumbState[s] = 'fail'; return Promise.resolve(false); }
        var body;
        try { body = dataUrlToBlob(data); }
        catch (_) { thumbState[s] = 'fail'; return Promise.resolve(false); }
        return fetch(THUMB_PUT + '?name=' + encodeURIComponent(file), {
            method: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
            body: body
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            thumbAvail[s] = true;
            thumbState[s] = 'done';
            refreshThumbUsers(file);
            return true;
        }).catch(function (err) {
            thumbState[s] = 'fail';
            thumbServer = false;          // 写不了就整体停手，别刷 43 条同样的错误
            thumbQueue.length = 0;
            thumbReady = {};
            console.warn('[Bg] 缩略图落盘失败，退回原图：', (err && err.message) || err);
            return false;
        });
    }

    /* 预热队列：一次一张，排在空闲时间里做，绝不和悬停抢主线程。
       卡片已经解码过的图放在 thumbReady 里，直接拿来用，不重复下载。 */
    function pumpThumbs() {
        if (thumbBusy || !thumbQueue.length) return;
        var file = thumbQueue.shift();
        var s = stemOf(file);
        if (thumbAvail[s] || thumbState[s] === 'saving' || thumbState[s] === 'done') {
            return pumpThumbs();
        }
        if (thumbServer === false) { thumbQueue.length = 0; return; }
        var run = function () {
            thumbBusy = true;
            thumbState[s] = 'saving';
            var ready = thumbReady[file];
            delete thumbReady[file];
            if (ready) {
                saveThumb(file, ready).then(function () { thumbBusy = false; pumpThumbs(); });
                return;
            }
            var img = new Image();
            img.onload = function () {
                saveThumb(file, img).then(function () { thumbBusy = false; pumpThumbs(); });
            };
            img.onerror = function () {
                thumbState[s] = 'fail';
                thumbBusy = false;
                pumpThumbs();
            };
            img.src = bgUrl(file);
        };
        if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 1200 });
        else setTimeout(run, 40);
    }

    /* 开面板后把还没有缩略图的图排队：把解码成本放到空闲时间，
       免得悬停时才在主线程上临时解码 3072×1728 的原图。 */
    function prewarmThumbs() {
        if (thumbServer === false) return;
        items.forEach(function (it) {
            if (it.isManual || it.blob) return;
            var s = stemOf(it.file);
            if (thumbAvail[s] || thumbState[s] === 'saving' || thumbState[s] === 'done') return;
            thumbQueue.push(it.file);
        });
        pumpThumbs();
    }

    /* 缩略图刚生成好：把还在用原图的卡片和大预览换成小图 */
    function refreshThumbUsers(file) {
        var url = thumbUrlOf(file);
        if (!url) return;
        Array.prototype.forEach.call(grid.querySelectorAll('.sg-bg-card'), function (c) {
            if (c.dataset.file !== file) return;
            var im = c.querySelector('img');
            if (im && im.getAttribute('src') !== url) im.src = url;
        });
        if (previewFile === file) previewImg.src = url;
    }

    /* 卡片并发上限 2：几十张 3072×1728 原图一起拉会堵住单线程的静态服务，
       连大预览都要等好几秒。磁盘缩略图不走网络、不占原图下载槽位。 */
    var CARD_SLOTS = 2, cardActive = 0, cardWait = [];
    function pumpCards() {
        while (cardActive < CARD_SLOTS && cardWait.length) {
            cardActive++;
            cardWait.shift()();
        }
    }

    /* 卡片图：有磁盘缩略图就直读（~226KB，解码 2ms），没有才拉原图，
       拉到之后顺手从**这张已解码的图**生成 720p 落盘——不再二次下载/解码。
       原图错峰加载：同时最多 2 张。 */
    function attachThumb(img, it) {
        var s = stemOf(it.file);
        var url = it.blob || thumbUrlOf(it.file);
        var released = false;
        function release() {
            if (released) return;
            released = true;
            cardActive--;
            pumpCards();
        }
        img.addEventListener('load', function () {
            release();
            if (it.blob || !img.naturalWidth) return;
            if (thumbAvail[s] || thumbState[s] === 'saving' || thumbState[s] === 'done') return;
            thumbReady[it.file] = img;                // 这张原图已经解码好了，排队时直接复用
            if (thumbQueue.indexOf(it.file) < 0) thumbQueue.push(it.file);
            pumpThumbs();
        });
        img.addEventListener('error', release);
        if (url) { released = true; img.src = url; return; }
        cardWait.push(function () { img.src = bgUrl(it.file); });
        pumpCards();
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
                    if (!raw || /\/$/.test(raw)) continue;   // 只认根层图片，跳过子目录
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
        // 目录扫描与缩略图清单并行，两者都就绪再渲染，首屏直接用 720p 小图
        return Promise.all([fetchDirectory(), loadThumbIndex()])
        .then(function (res) {
            var files = res[0];
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
            /* 首屏那几张先让卡片自己加载（顺带生成），剩下的丢给空闲预热 */
            setTimeout(function () { if (seq === scanSeq && bgOpen) prewarmThumbs(); }, 900);
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
        } else if (thumbServer === false) {
            s += ' ｜ 缩略图只读 background/.thumbs/（用 run.bat 打开可自动生成）';
        } else if (newCount) {
            s += ' ｜ ' + newCount + ' 张新图，缩略图会自动补到 background/.thumbs/';
        } else {
            s += ' ｜ 背景图片放进 background/ 后点「↻ 重新扫描」即可';
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

        // 「⇅ 排序」紧挨在「切换背景」左边：点开就是角色 tab 顺序编辑器
        sortToggle = el('button', 'sg-sort-toggle', 'sg-tool');
        sortToggle.type = 'button';
        sortToggle.innerHTML = '⇅ 排序<small>ORDER</small>';
        sortToggle.title = '调整角色 tab 顺序';
        sortToggle.setAttribute('aria-expanded', 'false');
        sortToggle.addEventListener('click', function (e) {
            e.stopPropagation(); setSortOpen(!sortOpen);
        });
        tools.appendChild(sortToggle);

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
                if ((f.webkitRelativePath || '').split('/').length > 2) return;  // 只认根层图片
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

        buildTop();
        buildBgPanel();
        buildModelPanel();
        buildSortPanel();
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
            rescanTimer = setTimeout(function () {
                refreshModels();
                if (bgOpen) loadBackgrounds();   // 面板开着时，丢进来的新图也自动出现
            }, 120);
        }
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) scheduleRescan();
        });
        window.addEventListener('focus', scheduleRescan);

        // 展开控制台时把右侧那几块面板一起收掉：控制台、背景、排序互斥，
        // 同一时刻只留一块，免得互相盖住（反过来 setBgOpen / setSortOpen 也会收控制台）
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || !t.closest || !t.closest('#emote-dev-tab')) return;
            if (bgOpen) setBgOpen(false);
            if (sortOpen) setSortOpen(false);
        }, true);

        // 点造型面板 / 角色 tab 以外的地方收起（两者的 click 已 stopPropagation）
        document.addEventListener('click', function (e) {
            if (!modelPanelOpen) return;
            var t = e.target;
            if (t && t.closest && (t.closest('#sg-model-panel') || t.closest('.sg-model'))) return;
            setModelPanelOpen(false);
        });

        // 排序面板同理：点面板外或按钮外收起
        document.addEventListener('click', function (e) {
            if (!sortOpen) return;
            var t = e.target;
            if (t && t.closest && (t.closest('#sg-sort-panel') || t.closest('#sg-sort-toggle'))) return;
            setSortOpen(false);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            // 逐层收起：排序面板 → 造型面板 → 背景面板 → 控制台 → 顶部控制条
            if (sortOpen) { setSortOpen(false); return; }
            if (modelPanelOpen) { setModelPanelOpen(false); return; }
            if (bgOpen) { setBgOpen(false); return; }
            // 控制台展开时 ESC 只负责收起它，顶部控制条不要跟着一起动
            if (devPanelOpen()) { closeDevPanel(); return; }
            setPinned(!pinned);
        });

        // 面板贴着「⇅ 排序」定位，窗口缩放后要重算，否则会错位
        window.addEventListener('resize', function () { if (sortOpen) positionSortPanel(); });

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
            /* 角色顺序：roleOrder 是生效顺序，roleOrderSource 是 order.json 原样 */
            roleOrder: function () { return roleOrder.slice(); },
            roleOrderSource: function () { return roleOrderSource.slice(); },
            sortPanelOpen: function () { return sortOpen; },
            openSortPanel: function () { setSortOpen(true); return true; },
            closeSortPanel: function () { setSortOpen(false); },
            sortPanelItems: function () {
                return Array.prototype.map.call(
                    sortListEl ? sortListEl.querySelectorAll('.sg-sp-row') : [],
                    function (r) {
                        return { folder: r.dataset.folder,
                                 label: r.querySelector('.sg-sp-name').textContent,
                                 isNew: r.classList.contains('is-new') };
                    });
            },
            moveRole: function (name, dir) { moveRole(name, dir); return currentRoleNames(); },
            saveOrderNow: function () { return saveOrderNow(); },
            orderSaving: function () { return orderSaving; },
            orderDirty: function () { return orderDirty; },
            sortTip: function () { return sortTipMsg ? sortTipMsg.textContent : ''; },
            orderPath: function () { return ORDER_REL; },
            orderServer: function () { return orderServer === true; },
            resetRoleOrder: function () { resetRoleOrder(); return roleOrder.slice(); },
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
            thumbCacheSize: function () { return Object.keys(thumbAvail).length; },
            thumbStatus: function () {
                return { server: thumbServer, ready: Object.keys(thumbAvail).length,
                         queued: thumbQueue.length, busy: thumbBusy,
                         saving: Object.keys(thumbState).filter(function (k) {
                             return thumbState[k] === 'saving';
                         }).length };
            },
            prewarmThumbs: prewarmThumbs,
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
