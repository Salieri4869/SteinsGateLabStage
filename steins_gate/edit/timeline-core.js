// ============================================================
//  timeline-core.js —— 时间轴纯算法模块（不碰 DOM、不碰全局 state）
//
//  这里只做「数据进、数据出」的变换：分段、挤开、BGM 归属重排、历史栈。
//  供 story.js（播放核心）与 edit/edit.js（工作台）共用，也可直接被 node 单测：
//      const core = require('./timeline-core.js');
//
//  约定：所有「句号」对外都是 1-based 闭区间 [from,to]；数组本身 0-based。
//  纯函数不修改入参，返回新值（需要时就地写回由调用方决定）。
// ============================================================
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else if (typeof define === 'function' && define.amd) define([], function () { return api; });
    else root.TimelineCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // 行字段「整段值」：立绘段把 enter/exit/move/cues 当作一个值整体搬移。
    var STAGE_KEYS = ['enter', 'exit', 'move', 'cues'];
    function stageKeys() { return STAGE_KEYS.slice(); }

    /* 把连续若干句里「取同一值」的句子合并成段。
       getter(line, i) 返回 null/undefined/'' 表示该句不产生段。
       段：{ key, from, to, idx }（from/to 1-based 闭区间，idx 段首 0-based）。 */
    function runsOf(lines, getter) {
        var out = [];
        lines.forEach(function (line, i) {
            var v = getter(line, i);
            if (v == null || v === '') return;
            var last = out[out.length - 1];
            if (last && last.key === v && last.to === i) last.to = i + 1;
            else out.push({ key: v, from: i + 1, to: i + 1, idx: i });
        });
        return out;
    }

    /* 通用「挤开」：给定每句的当前值 values[0..n-1]（1-based 句 i → values[i-1]），
       把原段 [oldF,oldT] 搬到 [f,t]，返回新的每句值数组。
       语义：被拖段的样子取段首句的值；相邻段整体让位、长度不变、首尾相接；
       行数固定，右侧被挤出末尾的丢弃（补 undefined），左侧空出的补 undefined。
       背景/语音/立绘/BGM 都套用这一个算法，只是「值」和「写回」不同。 */
    function ripple(values, oldF, oldT, f, t) {
        var n = values.length;
        var val = values[oldF - 1];
        var seq = values.slice(0, oldF - 1).concat(values.slice(oldT)); // 摘除原段
        return insertRun(seq, val, f, t, n);
    }

    /* BGM 变体：owner 数组里每个值是段下标（唯一标识一段），段中间可能夹 null 空档。
       原 wbRippleBgm 是「摘除所有等于段首值的句子」而非按区间摘除，这里忠实还原。 */
    function rippleByValue(values, oldF, oldT, f, t) {
        var n = values.length;
        var val = values[oldF - 1];
        var seq = [];
        for (var i = 0; i < n; i++) if (values[i] !== val) seq.push(values[i]);
        return insertRun(seq, val, f, t, n);
    }

    /* 整段「交换」：把原段 [oldF,oldT] 与 f 所在的另一整段 [bf,bt] 互换区间。
       与 ripple（摘除+插入、邻居整体让位）不同，swap 不切分块、不推挤无关段：
       两段各自完整搬到对方原来的位置，块长跟着对方走（短段伸长、长段收短）。
       bounds(f) 可选：返回覆盖第 f 句的段 [起,止]；不传则按「值相等」向两侧扩展
       找段边界（逐行字段/BGM owner 都适用；立绘动作对象需要调用方传 bounds）。
       目标处没有别的段（空白）时退化为「原段整体平移到 f」，保持长度不变。 */
    function swap(values, oldF, oldT, f, t, bounds) {
        var n = values.length;
        var out = values.slice();
        if (f === oldF || oldT < oldF) return out;
        var bf = f, bt = f, b = bounds && bounds(f);
        if (b && b[1] >= b[0]) { bf = b[0]; bt = b[1]; }
        else {
            var bVal = values[f - 1];
            while (bf > 1 && values[bf - 2] === bVal) bf--;
            while (bt < n && values[bt] === bVal) bt++;
        }
        // f 落在自己段内（或目标段就是原段）→ 无需交换
        if (bf <= oldT && bt >= oldF) return out;
        var aVal = values[oldF - 1], bVal = values[f - 1];
        /* 落点是空白：退化为「原段整段平移到 f，长度不变」。
           这里不能沿用上面按「值相等」扩出来的 [bf,bt]——空白值（背景默认为 ''）
           会被连成一大片，1 格块拖到空白处就被写成好几格。段长只由左右拉决定，
           整段拖动只换位置不改长度。目标区间按原段长度 (oldT-oldF) 取。 */
        if (bVal == null || bVal === '') {
            // 清原段用与落点一致的空值：背景轨 getter 给出 ''（显式空串防止回退场景默认），
            // 其它轨给 null/undefined 则原样保留，避免把通用数据污染成空串。
            var empty = bVal;
            for (var k = oldF - 1; k < oldT; k++) out[k] = empty;
            var len = oldT - oldF;                               // 0 = 1 格
            var tf = Math.max(1, Math.min(f, n - len));
            for (k = tf; k <= tf + len && k <= n; k++) out[k - 1] = aVal;
            return out;
        }
        for (var i = oldF - 1; i < oldT; i++) out[i] = bVal;
        for (i = bf - 1; i < bt; i++) out[i] = aVal;
        return out;
    }

    /* 段长调整（拖左右手柄）——与 swap/ripple 都不同的第三套语义：
       · 向右拉长：后续内容整体右移，长度与顺序都不变；被推出末尾的内容直接丢弃，
         剧本行数始终固定（不自动增句）。
       · 向左收短：让出的句子留空，其它块保持原位、不补位、不回弹。
       · 向左拉长：左侧内容整体左移，溢出开头的部分丢弃。
       块本身最终精确覆盖 [f,t]，来回拖不会累积变长。 */
    function stretch(values, oldF, oldT, f, t) {
        var n = values.length, val = values[oldF - 1];
        var i, src, dst;
        var out = new Array(n);
        for (i = 0; i < n; i++) out[i] = undefined;
        /* 往返拖动的关键：左收会让出空档，右拉时必须先填掉这些空档，
           再把剩余格数推给后面的块。否则「右拉一格→左收回一格→再右拉一格」
           会把上次的空档一路推到末尾，看起来中间空一格、最右的块被退远。 */
        var dR = 0, dL = 0;
        if (t > oldT) {
            var gapR = 0;
            for (i = oldT + 1; i <= n && (values[i - 1] == null || values[i - 1] === ''); i++) gapR++;
            dR = Math.max(0, (t - oldT) - gapR);
        }
        if (oldF > f) {
            var gapL = 0;
            for (i = oldF - 1; i >= 1 && (values[i - 1] == null || values[i - 1] === ''); i--) gapL++;
            dL = Math.max(0, (oldF - f) - gapL);
        }
        function moved(s) {
            var d = s;
            if (dR > 0 && s > oldT) d += dR;
            if (dL > 0 && s < oldF) d -= dL;
            return d;
        }
        for (i = 0; i < n; i++) {
            src = i + 1;
            if (src >= oldF && src <= oldT) continue;   // 原段由新区间整体重写
            dst = moved(src);
            if (dst >= 1 && dst <= n) out[dst - 1] = values[i];  // 越界丢弃，不增句
        }
        for (i = f; i <= t && i <= n; i++) out[i - 1] = val;
        return out;
    }

    /* 段数组版整段交换：BGM/声效的区间直接存在段项上（range / at-to），
       和逐行字段的 swap 不同，这里两段互换 from/to，段项自带的其它字段不动。
       落空白退化为平移、保持长度。返回 [{index,from,to}]，数组顺序不变。 */
    function swapSegments(segs, oldF, oldT, f, t) {
        var out = segs.map(function (s, i) { return { index: i, from: s.from, to: s.to }; });
        var ai = -1, bi = -1, i;
        for (i = 0; i < out.length; i++) if (out[i].from === oldF && out[i].to === oldT) ai = i;
        if (ai < 0) return out;
        for (i = 0; i < out.length; i++) {
            if (i !== ai && f >= out[i].from && f <= out[i].to) { bi = i; break; }
        }
        if (bi >= 0) {
            var bf = out[bi].from, bt = out[bi].to;
            out[ai].from = bf; out[ai].to = bt;
            out[bi].from = oldF; out[bi].to = oldT;
        } else {
            var len = oldT - oldF;
            out[ai].from = f; out[ai].to = f + len;
        }
        return out;
    }

    /* ripple 位移量：向右伸长时，先填掉右侧紧邻的连续空格，只有「盖过」空格
       碰到真实块之后，剩余格数才推着邻块走；空格存在时绝不提前推远块。
       occupied(k) 判断第 k 句是否被某个段占用（不含被拖段自身）。
       返回 { dR, dL }：本段伸长后，右侧/左侧邻块实际该平移的格数。 */
    function rippleShift(segs, oldF, oldT, f, t, occupied) {
        function isUsed(k) {
            if (occupied) return !!occupied(k);
            for (var j = 0; j < segs.length; j++) {
                var s = segs[j];
                if (s.from === oldF && s.to === oldT) continue;   // 被拖段自身的原范围不算占用
                if (s.from <= k && k <= s.to) return true;
            }
            return false;
        }
        var dR = t - oldT, dL = oldF - f, gap, k;
        if (dR > 0) {
            gap = 0;
            for (k = oldT + 1; k <= t; k++) { if (isUsed(k)) break; gap++; }
            dR = Math.max(0, dR - gap);   // 先填空格，剩下的才推块
        }
        if (dL > 0) {
            gap = 0;
            for (k = oldF - 1; k >= f; k--) { if (isUsed(k)) break; gap++; }
            dL = Math.max(0, dL - gap);
        }
        return { dR: dR, dL: dL };
    }

    /* 段数组版（BGM/声效的 range 直接存在段项上，不走逐句 owner 展开）。
       伸长时用 rippleShift 先扣空格：有间隔的邻块不推，盖到了才推。 */
    function stretchSegments(segs, oldF, oldT, f, t) {
        var sh = rippleShift(segs, oldF, oldT, f, t);
        var dR = sh.dR, dL = sh.dL;
        return segs.map(function (s, i) {
            if (s.from === oldF && s.to === oldT) return { index: i, from: f, to: t };
            var o = { index: i, from: s.from, to: s.to };
            if (dR > 0 && s.from > oldT) { o.from += dR; o.to += dR; }
            if (dL > 0 && s.to < oldF) { o.from -= dL; o.to -= dL; }
            return o;
        });
    }

    /* 段数组版「伸长让位 / 缩短留空」：BGM/声效的区间存在段项上（不是逐行值），
       拖一块的边界时：
         · 本段伸长 → 只让紧邻的那块缩短让位（最小 1 格），更远的段不动；
         · 本段缩短 → 让出的格留空，紧邻块保持原位、不伸长补上。
       与 neighborStretch（逐行 keys 版）语义一致，也和拖动时的预渲染预览一致。
       返回 [{index,from,to}]，数组顺序与段项身份不变；不修改入参。 */
    function neighborStretchSegments(segs, oldF, oldT, f, t, edge) {
        var out = segs.map(function (s, i) { return { index: i, from: s.from, to: s.to }; });
        var ai = -1, i;
        for (i = 0; i < out.length; i++) if (out[i].from === oldF && out[i].to === oldT) ai = i;
        if (ai < 0) return out;

        if (edge === 'r') {
            // 右侧紧邻段：from 最小且 > oldT 的那段
            var bi = -1;
            for (i = 0; i < out.length; i++) {
                if (i !== ai && out[i].from > oldT && (bi < 0 || out[i].from < out[bi].from)) bi = i;
            }
            if (bi < 0) { out[ai].to = Math.max(f, t); return out; }  // 右侧无邻块：自由伸缩
            if (t > oldT) {
                // 本段伸长：右邻块缩短让位，最少留 1 格
                var maxT = out[bi].to - 1;
                var nt = Math.max(f, Math.min(t, maxT));
                out[ai].to = nt;
                out[bi].from = nt + 1;
                if (out[bi].from > out[bi].to) out[bi].to = out[bi].from;  // 兜底
            } else {
                // 本段缩短：让出的格留空，右邻块保持原位、不伸长补上
                out[ai].to = Math.max(f, t);
            }
            return out;
        }

        // edge === 'l'：左侧紧邻段，镜像处理
        var li = -1;
        for (i = 0; i < out.length; i++) {
            if (i !== ai && out[i].from < oldF && (li < 0 || out[i].from > out[li].from)) li = i;
        }
        if (li < 0) { out[ai].from = Math.max(1, Math.min(f, oldT)); return out; }
        if (f < oldF) {
            // 本段伸长：左邻块缩短让位，最少留 1 格
            var minF = out[li].from + 1;
            var nf = Math.max(minF, Math.min(f, oldT));
            out[ai].from = nf;
            out[li].to = nf - 1;
            if (out[li].to < out[li].from) out[li].to = out[li].from;
        } else {
            // 本段缩短：让出的格留空，左邻块保持原位、不伸长补上
            out[ai].from = Math.min(f, oldT);
        }
        return out;
    }

    /* 【历史算法，已不再被编辑态调用，保留仅供旧脚本/回退参考】
       立绘/背景/语音轨「伸长让位 · 缩短留空」：拖的是一块与紧邻块之间的分界线。
       keys[i-1] = 第 i 句的段标识（同字符串＝同一段）；oldF/oldT = 被拖段原范围；
       f/t = 目标新范围；edge='l'|'r' 指拖的是左边缘还是右边缘。
       · 目标段伸长 → 只有紧邻块缩短让位（最小 1 格），更远的块完全不动；
       · 目标段缩短 → 让出的句子留空，紧邻块保持原位、不伸长补上。
       目标段最终精确覆盖 [result.f, result.t]；返回 { keys, f, t }；不修改入参。 */
    function neighborStretch(keys, oldF, oldT, f, t, edge) {
        var n = keys.length, out = keys.slice(), i;
        var aKey = keys[oldF - 1];
        var res = { keys: out, f: f, t: t };
        if (aKey == null || aKey === '' || oldT < oldF) return res;

        if (edge === 'r') {
            // 右侧紧邻段：从 oldT+1 起第一个非空且不同 key 的段
            var bs = -1;
            for (i = oldT + 1; i <= n; i++) {
                if (keys[i - 1] != null && keys[i - 1] !== '' && keys[i - 1] !== aKey) { bs = i; break; }
            }
            if (bs < 0) {
                // 右边没有别的段：目标段可伸到末尾，缩短则留空
                var at = Math.max(f, Math.min(t, n));
                for (i = oldF; i <= n; i++) out[i - 1] = undefined;
                for (i = f; i <= at; i++) out[i - 1] = aKey;
                res.t = at;
                return res;
            }
            var bKey = keys[bs - 1], be = bs;
            while (be + 1 <= n && keys[be] === bKey) be++;
            if (t > oldT) {
                // 本段伸长：右邻块缩短让位（最小 1 格），更远的块不动
                var nt = Math.max(f, Math.min(t, be - 1));
                for (i = oldF; i <= be; i++) out[i - 1] = undefined;
                for (i = f; i <= nt; i++) out[i - 1] = aKey;
                for (i = nt + 1; i <= be; i++) out[i - 1] = bKey;
                res.t = nt;
            } else {
                // 本段缩短：让出的句子清空留空，右邻块保持原位、不伸长补上
                for (i = t + 1; i <= oldT; i++) out[i - 1] = undefined;
                for (i = f; i <= t; i++) out[i - 1] = aKey;
                res.t = t;
            }
            return res;
        }

        // edge === 'l'：左侧紧邻段，镜像处理
        var le = -1;
        for (i = oldF - 1; i >= 1; i--) {
            if (keys[i - 1] != null && keys[i - 1] !== '' && keys[i - 1] !== aKey) { le = i; break; }
        }
        if (le < 0) {
            var af = Math.max(1, Math.min(f, oldT));
            for (i = 1; i <= oldT; i++) out[i - 1] = undefined;
            for (i = af; i <= t; i++) out[i - 1] = aKey;
            res.f = af;
            return res;
        }
        var lKey = keys[le - 1], lls = le;
        while (lls - 1 >= 1 && keys[lls - 2] === lKey) lls--;
        if (f < oldF) {
            // 本段伸长：左邻块缩短让位（最小 1 格），更远的块不动
            var nf = Math.max(lls + 1, Math.min(f, t));
            for (i = lls; i <= oldT; i++) out[i - 1] = undefined;
            for (i = lls; i <= nf - 1; i++) out[i - 1] = lKey;
            for (i = nf; i <= t; i++) out[i - 1] = aKey;
            res.f = nf;
        } else {
            // 本段缩短：让出的句子清空留空，左邻块保持原位、不伸长补上
            for (i = oldF; i < f; i++) out[i - 1] = undefined;
            for (i = f; i <= t; i++) out[i - 1] = aKey;
            res.f = f;
        }
        return res;
    }

    function insertRun(seq, val, f, t, n) {
        var ins = [];
        for (var i = 0; i < t - f + 1; i++) ins.push(val);
        Array.prototype.splice.apply(seq, [Math.max(0, Math.min(seq.length, f - 1)), 0].concat(ins));
        var out = [];
        for (i = 0; i < n; i++) out.push(i < seq.length ? seq[i] : undefined);
        return out;
    }

    /* 立绘分段键 = 在台阵容 + 本句动作签名。
       stageRoles: 场景声明的登场角色 role 列表（顺序无关）。
       有过 enter 的角色开场先隐藏，到 enter 那句才上；之后一直在台直到 exit。
       动作签名取「说话者行级 action」+ cues.action + move。
       不再做状态延续继承：每句按自己显式写的动作独立成段，段长由人工拖手柄决定
       （台词 1「平常」、台词 2「微笑」必须是两段，不能被继承合并）。
       连续几句都没写动作时签名相同，runsOf 自然合并成一段。空阵容返回空 key。 */
    function stageKeysOf(lines, stageRoles) {
        var late = {};
        lines.forEach(function (l) {
            [].concat((l && l.enter) || []).forEach(function (r) { if (r) late[r] = true; });
        });
        var on = {};
        stageRoles.forEach(function (r) { if (!late[r]) on[r] = true; });
        return lines.map(function (l) {
            // 编辑态拖短立绘段时，让出的句子写 stageHidden=true：
            // 显式「本句无立绘段落」，否则在台角色无动作仍会算出同一段键，
            // runsOf 又把它并回立绘块——看起来就是「缩短后又被补上」。
            if (l && l.stageHidden) return { roster: '', act: '', key: '' };
            [].concat((l && l.exit) || []).forEach(function (r) { if (r) delete on[r]; });
            [].concat((l && l.enter) || []).forEach(function (r) { if (r) on[r] = true; });
            var roster = Object.keys(on).filter(function (r) { return on[r]; }).sort().join('+');
            if (!roster) return { roster: '', act: '', key: '' };
            var acts = [];
            // 说话者行级 action（demo 第 1 句「平常」/ 第 2 句「微笑」就写在这里）
            if (l && l.action !== undefined && l.action !== null && l.action !== '') {
                acts.push((l.role || '说话者') + ':act:' +
                    (typeof l.action === 'string' ? l.action : JSON.stringify(l.action)));
            }
            var cues = (l && l.cues) || {};
            Object.keys(cues).forEach(function (r) {
                var a = cues[r] && cues[r].action;
                if (a !== undefined && a !== null && a !== '') {
                    acts.push(r + ':' + (typeof a === 'string' ? a : JSON.stringify(a)));
                }
            });
            var mv = (l && l.move) || {};
            Object.keys(mv).forEach(function (r) { acts.push(r + ':move'); });
            var act = acts.sort().join('/');
            return { roster: roster, act: act, key: roster + '\u0001' + act };
        });
    }

    /* 行级背景的有效值：显式写了 background（含空串）就用它，否则回退场景默认。
       空串＝这一行明确不要背景，不能再回退到场景背景。 */
    function bgOfLine(line, sceneBackground) {
        if (line && Object.prototype.hasOwnProperty.call(line, 'background')) return line.background || '';
        return sceneBackground || '';
    }

    /* BGM 每句归属：owner[i] = 覆盖第 i+1 句的段下标（0-based），无 BGM 为 null。
       ranges: [[f,t],...]（1-based 闭区间）。重叠时靠后的段优先（与 bgmAt 一致）。 */
    function bgmOwners(ranges, n) {
        var owner = new Array(n);
        for (var i = 0; i < n; i++) owner[i] = null;
        ranges.forEach(function (r, k) {
            var f = Math.max(1, Number(r && r[0]) || 1);
            var t = Math.max(f, Number(r && r[1]) || f);
            for (var x = Math.max(1, f); x <= Math.min(n, t); x++) owner[x - 1] = k;
        });
        return owner;
    }

    /* 由每句归属反推每段 range（1-based）。返回 [{index, from, to}]，
       index 是原段下标；某段被完全挤出则返回 from/to 为 0（调用方删掉它）。 */
    function bgmRangesFromOwners(owner, segCount) {
        var lo = new Array(segCount), hi = new Array(segCount), i, k;
        for (i = 0; i < segCount; i++) { lo[i] = 0; hi[i] = 0; }
        for (i = 0; i < owner.length; i++) {
            k = owner[i];
            if (k == null || k < 0 || k >= segCount) continue;
            if (!lo[k]) lo[k] = i + 1;
            hi[k] = i + 1;
        }
        var out = [];
        for (k = 0; k < segCount; k++) {
            if (lo[k]) out.push({ index: k, from: lo[k], to: hi[k] });
        }
        return out;
    }

    /* ============================ 历史栈（纯数据） ============================
       只管帧数组与游标，不碰 DOM、不读 state。序列化/应用快照由调用方负责。
       帧：{ snap, label, act }。 */
    function createHistory(limit) {
        return {
            frames: [], labels: [], acts: [],
            idx: -1, limit: limit || 60,
            pendingAct: '改动', frameAct: '改动', dirty: false, batching: false
        };
    }
    /* 立即提交当前快照一帧。返回 true 表示真的入栈了（去重/批处理会返回 false）。 */
    function historyPush(h, snap, label, act) {
        if (h.batching) return false;
        if (h.idx >= 0 && h.frames[h.idx] === snap) { h.dirty = false; return false; }
        h.frames.length = h.idx + 1;
        h.labels.length = h.idx + 1;
        h.acts.length = h.idx + 1;
        h.frames.push(snap);
        h.labels.push(label);
        h.acts.push(act || h.pendingAct || '改动');
        if (h.frames.length > h.limit) { h.frames.shift(); h.labels.shift(); h.acts.shift(); }
        h.idx = h.frames.length - 1;
        h.dirty = false;
        return true;
    }
    function historyCanUndo(h) { return h.frames.length > 0; }
    function historyCanRedo(h) { return h.idx < h.frames.length - 1; }
    function historyUndo(h) {
        if (h.idx <= 0) return null;
        h.idx--;
        return h.frames[h.idx];
    }
    function historyRedo(h) {
        if (h.idx >= h.frames.length - 1) return null;
        h.idx++;
        return h.frames[h.idx];
    }
    function historyGoto(h, i) {
        if (i < 0 || i >= h.frames.length) return null;
        h.idx = i;
        return h.frames[i];
    }
    // 动作强度：同一防抖窗内升级标签（改动 < 重排 < 新增/删除）
    var ACT_RANK = { '改动': 0, '重排': 1, '新增': 2, '删除': 2 };
    function historyUpgradeAct(h, act) {
        if (act && act !== '改动') h.pendingAct = act;
        if ((ACT_RANK[act] || 0) > (ACT_RANK[h.frameAct] || 0)) h.frameAct = act;
    }

    return {
        stageKeys: stageKeys,
        runsOf: runsOf,
        ripple: ripple,
        swap: swap,
        stretch: stretch,
        rippleShift: rippleShift,
        swapSegments: swapSegments,
        stretchSegments: stretchSegments,
        neighborStretch: neighborStretch,
        neighborStretchSegments: neighborStretchSegments,
        rippleByValue: rippleByValue,
        stageKeysOf: stageKeysOf,
        bgOfLine: bgOfLine,
        bgmOwners: bgmOwners,
        bgmRangesFromOwners: bgmRangesFromOwners,
        createHistory: createHistory,
        historyPush: historyPush,
        historyCanUndo: historyCanUndo,
        historyCanRedo: historyCanRedo,
        historyUndo: historyUndo,
        historyRedo: historyRedo,
        historyGoto: historyGoto,
        historyUpgradeAct: historyUpgradeAct
    };
});
