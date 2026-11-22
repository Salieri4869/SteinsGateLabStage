// ============================================================
//  variable_transition.js —— 主时间线切换的变量级平滑
//
//  意义：切主时间线时，新时间线首帧会把 head_UD 等变形变量瞬间拍到
//  新值 → 头部瞬移。原作引擎会平滑这些变量，Web SDK不会。本外挂补上平滑。
//
//  用到 PSB 的两份数据：
//    transitionControl —— 白名单，指定哪些变量要平滑（40 条）；
//    timelineControl   —— 每条时间线各变量的首帧值，作为渐变目标。
//
//  效果：切表后用原生 setVariable(首帧值, 300ms) 插值，head_UD 沿
//  16→32→50→66 平滑到位，终态与硬切一致；差分槽不碰。
//
//  用法：ModelLoader.attach() 后 VariableTransition.attach(player)；
//  variableFadeMs 调时长（默认 300，设 0 关闭）；uninstall() 回退到原生硬切。
//  依赖 PsbReader / ModelLoader，输出 window.VariableTransition。
// ============================================================
(function (root) {
    'use strict';

    var DEFAULT_FADE_MS = 300;

    function reader() {
        if (typeof PsbReader !== 'undefined') return PsbReader;
        return root.PsbReader || null;
    }

    /* 从同一份 PSB 字节里读 transitionControl 白名单 + 每条时间线首帧变量值。
       只解析结构区（约 16ms），不碰贴图。 */
    function buildTable(rawPsb) {
        var R = reader();
        if (!R || !rawPsb || typeof R.parse !== 'function') return null;
        var parsed, meta;
        try {
            parsed = R.parse(rawPsb);
            meta = parsed && parsed.root && (parsed.root.metadata || parsed.root['metadata']);
        } catch (e) {
            console.warn('[VarTransition] PSB 结构解析失败，跳过：' + (e && e.message ? e.message : e));
            return null;
        }
        if (!meta) return null;

        // 白名单完全取自当前 PSB 的 transitionControl（每个模型变量名不同，不套用固定表）。
        // 若该模型没有 transitionControl，allow 为空 → 不做任何平滑，安全回落到原生硬切。
        var allow = Object.create(null);
        var tc = meta.transitionControl || meta['transitionControl'];
        if (Array.isArray(tc)) {
            tc.forEach(function (item) {
                if (item && item.label && item.enabled !== 0) allow[item.label] = true;
            });
        }

        // 首帧表：每条时间线 → { 变量: 首帧值 }（只收白名单变量、只收有明确 value 的帧）
        var frames = Object.create(null);
        var tl = meta.timelineControl || meta['timelineControl'];
        if (Array.isArray(tl)) {
            tl.forEach(function (line) {
                if (!line || !line.label) return;
                var vl = line.variableList || [];
                var vals = null;
                vl.forEach(function (v) {
                    if (!v || !v.label || !allow[v.label]) return;
                    var fl = v.frameList || [];
                    if (!fl.length) return;
                    var c = fl[0].content || {};
                    if (c.value == null) return;
                    var num = Number(c.value);
                    if (!isFinite(num)) return;
                    if (!vals) vals = Object.create(null);
                    vals[v.label] = num;
                });
                if (vals) frames[line.label] = vals;
            });
        }
        return { allow: allow, frames: frames, count: Object.keys(frames).length };
    }

    /* 取 player 上已缓存的首帧表；没有则从 ModelLoader._rawPsb 现场解析并缓存。 */
    function tableOf(player) {
        if (player.__vtTable) return player.__vtTable;
        var ML = root.ModelLoader;
        var raw = ML && ML._rawPsb;
        if (!raw) return null;
        var t = buildTable(raw);
        if (t) {
            try { Object.defineProperty(player, '__vtTable', { value: t, writable: true, configurable: true }); }
            catch (e) { player.__vtTable = t; }
        }
        return t;
    }

    function install(player) {
        if (!player || player.__vtInstalled) return !!player && player.__vtInstalled;
        // 拿原生 setter（沿原型链向上找，避开可能装过的其它补丁）
        var proto = Object.getPrototypeOf(player);
        var desc = null, p = proto;
        while (p && !desc) { desc = Object.getOwnPropertyDescriptor(p, 'mainTimelineLabel'); p = Object.getPrototypeOf(p); }
        if (!desc || typeof desc.set !== 'function') {
            console.warn('[VarTransition] 未找到 mainTimelineLabel setter，跳过安装');
            return false;
        }
        var nativeSet = desc.set;

        function patchedSet(val) {
            var old = player.mainTimelineLabel;
            if (old === val) { nativeSet.call(player, val); return; }
            var t = tableOf(player);
            var ms = player.variableFadeMs;
            if (ms == null) ms = DEFAULT_FADE_MS;
            ms = Math.max(0, Number(ms) || 0);

            // 首次设表（old 为空）或关闭淡化：直接切，不做渐变
            var vals = (t && ms > 0 && old && t.frames[val]) ? t.frames[val] : null;
            // 顺序关键：必须先切表、再启动渐变。nativeSet 里的 PlayTimeline 会重置插值状态，
            // 若在切表前 setVariable 会被冲掉；且切表当帧 getVariable 仍读旧值（wasm 的
            // 首帧 SET 要到下一帧才生效），此刻 setVariable 从旧值启动插值 → 得到平滑过渡。
            nativeSet.call(player, val);
            if (vals) {
                Object.keys(vals).forEach(function (k) {
                    try { player.setVariable(k, vals[k], ms); } catch (e) { /* 变量不存在就跳过 */ }
                });
            }
        }

        try {
            Object.defineProperty(player, 'mainTimelineLabel', {
                get: function () { return desc.get ? desc.get.call(player) : player._mainTimelineLabel; },
                set: patchedSet, configurable: true
            });
        } catch (e) {
            console.warn('[VarTransition] 安装失败：' + (e && e.message ? e.message : e));
            return false;
        }
        try { Object.defineProperty(player, '__vtInstalled', { value: true, writable: true, configurable: true }); }
        catch (e) { player.__vtInstalled = true; }
        player.__vtNativeSet = nativeSet;
        return true;
    }

    function uninstall(player) {
        if (!player || !player.__vtInstalled) return false;
        // 删掉实例自有 accessor，回落到原型链上的原生 setter
        try { delete player.mainTimelineLabel; } catch (e) { /* 忽略 */ }
        try { delete player.__vtInstalled; } catch (e) { /* 忽略 */ }
        return true;
    }

    /* attach 后一步到位：解析首帧表（若尚未缓存）+ 安装补丁 */
    function attach(player) {
        if (!player) return false;
        tableOf(player);   // 此刻 ModelLoader._rawPsb 还是当前角色的字节
        return install(player);
    }

    root.VariableTransition = {
        install: install, uninstall: uninstall, attach: attach,
        buildTable: buildTable, tableOf: tableOf, DEFAULT_FADE_MS: DEFAULT_FADE_MS
    };
})(typeof window !== 'undefined' ? window : globalThis);
