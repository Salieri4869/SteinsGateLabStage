// ============================================================
//  gl-arm-pose.js —— 互斥选项通用自动 hook（WebGL 纹理层补丁，配置驱动）
//
//  为什么需要它：
//    SDK 3.9.8 不支持 E-mote 4.0 的 customPartsList +
//    emote.extension.command.insert/delete，模型里所有互斥「追加部件」
//    会被同时画出来（4 个袖子 / 5 个拇指）。wasm 导出里没有任何显隐 API。
//
//  做法（本版：通用自动 hook 互斥选项）：
//    model-loader.js 从 PSB 结构区自动识别模型里所有「互斥追加部件选择器」
//    （customSelectorList 的选项挂在 customPartsList 追加部件上），算出每个
//    选项需要的 icon 矩形。本文件在 atlas 经 texImage2D 上传时备份这些矩形
//    的原始像素，再按「每个选择器当前选中的选项」逐个矩形决定保留还是
//    写成全 0 —— 矩形级 keep/erase，天然处理被多个选项共用的 icon。
//    2 选项、5 选项（拇指差分）或任意多个选择器都走同一套逻辑：
//      - 不重建模型、不调 loadData、不复制整份 PSB、不碰 wasm
//      - 单次切换约 0.1s，动画 / 物理 / 时间线连续
//
//  模型无关化：
//    贴图尺寸、选择器名、选项数、矩形坐标、姿势语义全部来自运行时注入的
//    配置；model-loader.js 直接从模型 zip 的 PSB 字节算出（单文件、纯 JS）。
//    换一个 zip 即可，本文件不用改。贴图高度不要求唯一：同高的多张 atlas
//    靠上传像素在该贴图 icon 矩形内的非透明命中率识别。
//    未调用 configure() 时会在 info().errors 里明确报错；模型没有任何互斥
//    追加部件选择器时由 ModelLoader 调 disable() 主动关闭补丁。
//
//  必须在任何 WebGL 上下文创建之前引入（index.html 里的第一个 script）。
// ============================================================
(function () {
    'use strict';

    var RGBA = 0x1908;             // gl.RGBA
    var UNSIGNED_BYTE = 0x1401;    // gl.UNSIGNED_BYTE

    var cfg = null;                // 由 configure() 注入的模型配置
    var records = {};              // tex#N -> 最近一次上传的记录
    var uploads = [];              // 上传历史（诊断用，最多 32 条）
    var errors = [];
    var selectors = [];            // [{label, options:[...]}]，模型自动识别
    var state = {};                // selector.label -> 当前选中的 option
    var rectOwners = {};           // tex#N -> [{r, owners:[{sel,opt}]}]
    var pose = null;               // 最近一次 setPose 的姿势名（兼容旧 API）
    var applyCount = 0;
    var lastMs = 0;
    var zero = null;               // 复用的全 0 像素缓冲
    var hooked = false;
    var warnedNoConfig = false;
    var disabled = false;          // 模型没有任何互斥组时，彻底跳过补丁
    var contextSeen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;

    function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

    /** 需要贴补丁的贴图（配置里带矩形的那些） */
    function activeKeys() {
        if (!cfg) return [];
        if (cfg.activeAtlases && cfg.activeAtlases.length) return cfg.activeAtlases.slice();
        var keys = [], g, t;
        for (g in cfg.groups) {
            if (!hasOwn(cfg.groups, g)) continue;
            for (t in cfg.groups[g]) {
                if (hasOwn(cfg.groups[g], t) && keys.indexOf(t) < 0) keys.push(t);
            }
        }
        return keys;
    }

    function zeroBuf(n) {
        if (!zero || zero.length < n) zero = new Uint8Array(n);
        return zero.subarray(0, n);
    }

    /** 当前所有选择器状态的签名，用于幂等判断 */
    function stateSignature() {
        var parts = [];
        for (var i = 0; i < selectors.length; i++) {
            parts.push(selectors[i].label + '=' + state[selectors[i].label]);
        }
        return parts.join('|');
    }

    /** 主姿势选择器当前选中的选项名。
        面板按钮的 dataset.pose 就是选项名，两者保持一致才能正确高亮；
        不再反查 crossed / hanging 这类自造别名。 */
    function currentPoseName() {
        if (!cfg || !selectors.length) return null;
        var sel = cfg.primarySelector || selectors[0].label;
        var cur = state[sel];
        for (var i = 0; i < selectors.length; i++) {
            if (selectors[i].label === sel && selectors[i].options.indexOf(cur) >= 0) return cur;
        }
        for (var p in cfg.poses) {
            if (hasOwn(cfg.poses, p) && cfg.poses[p] === cur) return p;
        }
        return cur;
    }

    /**
     * 从上传数据中抠出一个矩形，并按 GPU 行序保存。
     * 上传时若 UNPACK_FLIP_Y_WEBGL=true，GPU 行 y_off+j 对应源图
     * 第 (H-1-y_off-j) 行，且矩形落在 y_off = H-top-h 处；
     * texSubImage2D 写入时强制 flipY=false，所以数据本身就必须是 GPU 行序。
     */
    function snapshotRect(src, q, texH, flipY) {
        var left = q[0], top = q[1], w = q[2], h = q[3];
        var W = cfg.width;
        var yOffset = flipY ? (texH - top - h) : top;
        var out = new Uint8Array(w * h * 4);
        for (var y = 0; y < h; y++) {
            var sy = flipY ? (texH - 1 - (yOffset + y)) : (top + y);
            var s = (sy * W + left) * 4;
            out.set(src.subarray(s, s + w * 4), y * w * 4);
        }
        return { left: left, top: yOffset, w: w, h: h, pixels: out };
    }

    /* ---- 同高 atlas 的内容识别 ----------------------------------------
       PSB 只给出贴图高度，但一个模型可能有多张同高 atlas。上传时能拿到完整
       RGBA8 像素，于是用每张贴图自己的 icon 矩形当「指纹」：正确贴图的图标
       区域几乎都有非透明像素，错误贴图在这些坐标上会落在空白或别的 sprite，
       命中率明显更低。不依赖上传顺序，也不读 PSB 的贴图像素区。 */
    var fingerprints = {};
    var activeKeySet = {};      // 真正带互斥组矩形、需要贴补丁的 tex#N

    function isActiveKey(k) { return !!activeKeySet[k]; }

    /** 某个 tex 的识别矩形：优先同高组内「独有」矩形，区分度最高 */
    function rectsFor(key) {
        if (hasOwn(fingerprints, key) && fingerprints[key].length) return fingerprints[key];
        if (cfg.texRects && cfg.texRects[key] && cfg.texRects[key].length) return cfg.texRects[key];
        var out = [];
        for (var g in cfg.groups) {
            if (!hasOwn(cfg.groups, g)) continue;
            var list = cfg.groups[g][key];
            if (list) out = out.concat(list);
        }
        return out;
    }

    /** 矩形内 3×3 采样，统计 alpha != 0 的比例 */
    function contentScore(src, rects, W, H, flipY) {
        if (!rects || !rects.length) return 0;
        var step = Math.max(1, Math.ceil(rects.length / 96));
        var hit = 0, total = 0;
        for (var i = 0; i < rects.length; i += step) {
            var q = rects[i], l = q[0], t = q[1], rw = q[2], rh = q[3];
            if (l < 0 || t < 0 || rw <= 0 || rh <= 0 || l + rw > W || t + rh > H) continue;
            for (var gy = 0; gy < 3; gy++) {
                for (var gx = 0; gx < 3; gx++) {
                    var dx = Math.min(rw - 1, Math.floor((gx + 0.5) * rw / 3));
                    var dy = Math.min(rh - 1, Math.floor((gy + 0.5) * rh / 3));
                    // icon.top 是源图坐标：flipY 上传时 GPU 行 = H-top-h+dy，
                    // 对应源行 H-1-GPU行 = top+h-1-dy（与 snapshotRect 一致）。
                    var sy = flipY ? (t + rh - 1 - dy) : (t + dy);
                    var sx = l + dx;
                    if (sy < 0 || sy >= H || sx < 0 || sx >= W) continue;
                    total++;
                    if (src[(sy * W + sx) * 4 + 3] !== 0) hit++;
                }
            }
        }
        return total ? hit / total : 0;
    }

    /** 本次上传对应哪个 tex#N；返回 {key, by, score} */
    function identifyTex(src, w, h, flipY, candidates) {
        if (candidates.length === 1) return { key: candidates[0], by: 'height', score: 1 };
        var best = null, second = 0;
        candidates.forEach(function (k) {
            var score = contentScore(src, rectsFor(k), w, h, flipY);
            if (!best || score > best.score) {
                second = best ? best.score : 0;
                best = { key: k, score: score };
            } else if (score > second) {
                second = score;
            }
        });
        if (!best || best.score < 0.05) {
            return { key: null, by: 'no-content', score: best ? best.score : 0 };
        }
        /* 布局几乎一样、分数分不开时：优先分给还没有记录的候选，保证同高的
           每张贴图最终各有一条 record，isReady() 不会永远卡在 false。 */
        if (best.score - second < 0.02) {
            for (var j = 0; j < candidates.length; j++) {
                if (!records[candidates[j]]) {
                    return { key: candidates[j], by: 'order-tie', score: best.score };
                }
            }
        }
        return { key: best.key, by: 'content', score: best.score };
    }

    /** configure 时预计算同高组内互相「独有」的矩形，提高区分度 */
    function buildFingerprints() {
        var fp = {}, byH = cfg.atlases || {};
        Object.keys(byH).forEach(function (h) {
            var list = Array.isArray(byH[h]) ? byH[h] : [byH[h]];
            if (list.length < 2) return;
            list.forEach(function (k) {
                var others = {};
                list.forEach(function (o) {
                    if (o === k) return;
                    ((cfg.texRects && cfg.texRects[o]) || []).forEach(function (r) {
                        others[r.join(',')] = 1;
                    });
                });
                fp[k] = ((cfg.texRects && cfg.texRects[k]) || []).filter(function (r) {
                    return !hasOwn(others, r.join(','));
                });
            });
        });
        return fp;
    }

    /**
     * 按当前 state 重贴一张已捕获的 atlas。
     * 每个矩形只写一次：被「任一当前选中的选项」拥有 -> 还原原始像素，
     * 否则 -> 全 0。共用矩形因此不会被误擦。
     */
    function applyRecord(rec) {
        var gl = rec.gl;
        if (typeof gl.isContextLost === 'function' && gl.isContextLost()) return false;

        var prevUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
        var prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
        var prevFlip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
        var prevPremult = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);

        try {
            gl.activeTexture(rec.unit);
            gl.bindTexture(gl.TEXTURE_2D, rec.tex);

            // 备份数据是 GPU 行序、源语义（未预乘）：flipY 必须关掉，
            // premultiply 与上传时保持一致，写回结果才与原始一致。
            if (prevFlip !== false) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            if (prevPremult !== rec.premult) {
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, rec.premult);
            }

            for (var i = 0; i < rec.rects.length; i++) {
                var s = rec.rects[i];
                var keep = false;
                for (var j = 0; j < s.owners.length; j++) {
                    if (state[s.owners[j].sel] === s.owners[j].opt) { keep = true; break; }
                }
                var px = keep ? s.pixels : zeroBuf(s.w * s.h * 4);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, s.left, s.top, s.w, s.h,
                                 gl.RGBA, gl.UNSIGNED_BYTE, px);
            }
        } finally {
            if (prevPremult !== rec.premult) {
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevPremult);
            }
            if (prevFlip !== false) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlip);
            gl.bindTexture(gl.TEXTURE_2D, prevTex);
            gl.activeTexture(prevUnit);
        }
        return true;
    }

    function clearRecords() { records = {}; }

    /** context lost / restored 时清掉失效的纹理记录，等重新上传自动重贴 */
    function installContextEvents(ctx) {
        try {
            var canvas = ctx.canvas;
            if (!canvas || typeof canvas.addEventListener !== 'function') return;
            if (contextSeen) {
                if (contextSeen.has(canvas)) return;
                contextSeen.add(canvas);
            }
            canvas.addEventListener('webglcontextlost', function () {
                clearRecords();
                errors.push('webglcontextlost: 纹理记录已清空，等待重建后自动重贴');
            }, false);
            canvas.addEventListener('webglcontextrestored', function () {
                clearRecords();
            }, false);
        } catch (e) { /* 非 HTMLCanvasElement 时忽略 */ }
    }

    function onTexImage2D(orig, ctx, args) {
        var result = orig.apply(ctx, args);
        try {
            if (disabled) return result;
            if (!cfg) {
                if (!warnedNoConfig) {
                    warnedNoConfig = true;
                    errors.push('未调用 configure()：缺少模型配置，纹理补丁未生效');
                }
                return result;
            }
            if (args.length < 9) return result;
            var target = args[0] | 0, level = args[1] | 0;
            var w = args[3] | 0, h = args[4] | 0;
            var fmt = args[6] | 0, typ = args[7] | 0, data = args[8];
            var byH = cfg.atlases[String(h)];       // 高度 -> [tex#N, ...]
            if (target !== 0x0DE1 || level !== 0) return result;   // TEXTURE_2D / level 0
            if (!byH || w !== cfg.width || fmt !== RGBA || typ !== UNSIGNED_BYTE) return result;
            if (!data || typeof data.byteLength !== 'number' || data.byteLength !== w * h * 4) {
                return result;
            }

            // 只处理「确实带互斥组矩形」的贴图：同高但不参与补丁的贴图
            // 直接放过，不建立记录、不产生错误的 key。
            var all = Array.isArray(byH) ? byH : [byH];   // 兼容旧的单值契约
            var candidates = all.filter(isActiveKey);
            if (!candidates.length) return result;
            var src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            var flipY = !!ctx.getParameter(ctx.UNPACK_FLIP_Y_WEBGL);
            var matched = identifyTex(src, w, h, flipY, candidates);
            if (!matched.key) {
                uploads.push({
                    key: null, w: w, h: h, matchedBy: matched.by,
                    score: Math.round(matched.score * 1000) / 1000,
                    candidates: candidates, at: Math.round(performance.now()),
                });
                if (uploads.length > 32) uploads.shift();
                return result;
            }
            var key = matched.key;
            var texObj = ctx.getParameter(ctx.TEXTURE_BINDING_2D);
            if (!texObj) return result;

            installContextEvents(ctx);
            var premult = !!ctx.getParameter(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
            var owned = rectOwners[key] || [];
            var rec = {
                gl: ctx, tex: texObj, w: w, h: h,
                unit: ctx.getParameter(ctx.ACTIVE_TEXTURE),
                flipY: flipY, premult: premult,
                rects: owned.map(function (e) {
                    var s = snapshotRect(src, e.r, h, flipY);
                    s.owners = e.owners;
                    return s;
                }),
                appliedSig: null,
            };
            records[key] = rec;   // 重复上传会覆盖，重新贴补丁
            var perOption = {};
            Object.keys(cfg.groups).forEach(function (g) {
                perOption[g] = ((cfg.groups[g] && cfg.groups[g][key]) || []).length;
            });
            uploads.push({
                key: key, w: w, h: h, bytes: data.byteLength,
                flipY: flipY, premult: premult,
                matchedBy: matched.by,
                score: Math.round(matched.score * 1000) / 1000,
                options: perOption, ownedRects: rec.rects.length,
                at: Math.round(performance.now()),
            });
            if (uploads.length > 32) uploads.shift();

            // 关键：新上传的纹理没有补丁。立刻按当前 state 就地重贴，
            // 这样首帧以及 loadData 重新上传后都不会闪出多余部件。
            if (selectors.length) {
                try {
                    if (applyRecord(rec)) rec.appliedSig = stateSignature();
                } catch (e) {
                    errors.push('auto-apply ' + key + ': ' + String(e));
                }
            }
        } catch (e) {
            errors.push('texImage2D: ' + String(e));
        }
        return result;
    }

    function onDeleteTexture(orig, ctx, args) {
        var result = orig.apply(ctx, args);
        try {
            var texObj = args[0];
            for (var key in records) {
                if (hasOwn(records, key) &&
                    records[key].gl === ctx && records[key].tex === texObj) {
                    delete records[key];
                }
            }
        } catch (e) { /* 忽略 */ }
        return result;
    }

    function installHooks() {
        var protos = [];
        if (typeof WebGLRenderingContext !== 'undefined') protos.push(WebGLRenderingContext.prototype);
        if (typeof WebGL2RenderingContext !== 'undefined') protos.push(WebGL2RenderingContext.prototype);
        if (!protos.length) {
            errors.push('当前环境没有 WebGLRenderingContext，无法安装纹理 hook');
            return;
        }
        protos.forEach(function (proto) {
            // 必须用 own-property 判定：部分浏览器里 WebGL2.prototype 继承自
            // WebGL1.prototype，直接读继承值会漏装或重复包裹。
            if (hasOwn(proto, '__armPoseHooked')) return;
            var origImage = proto.texImage2D;
            if (typeof origImage !== 'function' || origImage.__armPoseWrapped) return;

            var imageWrapper = function () { return onTexImage2D(origImage, this, arguments); };
            imageWrapper.__armPoseWrapped = true;
            proto.texImage2D = imageWrapper;

            var origDelete = proto.deleteTexture;
            if (typeof origDelete === 'function' && !origDelete.__armPoseWrapped) {
                var deleteWrapper = function () { return onDeleteTexture(origDelete, this, arguments); };
                deleteWrapper.__armPoseWrapped = true;
                proto.deleteTexture = deleteWrapper;
            }
            Object.defineProperty(proto, '__armPoseHooked', {
                value: true, enumerable: false, writable: false, configurable: true,
            });
        });
        hooked = true;
    }

    /** 注入模型配置。换模型时重新调用即可；纹理会随 loadData 重新上传并自动重贴。 */
    function configure(c) {
        if (!c || !c.atlases || !c.groups || !c.poses || !c.width) {
            throw new Error('[ArmPoseGL] 配置不完整：需要 width / atlases / groups / poses');
        }
        cfg = c;

        selectors = (c.selectors && c.selectors.length)
            ? c.selectors.map(function (s) {
                return { label: s.label, options: s.options.slice() };
              })
            : [{ label: c.primarySelector || c.selector || 'default',
                 options: Object.keys(c.groups) }];

        state = {};
        selectors.forEach(function (s) {
            state[s.label] = (c.defaultOptions && c.defaultOptions[s.label])
                || s.options[0] || null;
        });

        /* 矩形 -> 拥有它的 (选择器, 选项)。同一矩形可被多个选项共用，
           此时只要任一拥有者是当前选中项就保留，绝不会被误擦。
           只有这些矩形会被 hook 触及，其它 sprite 一律原样保留。 */
        rectOwners = {};
        var index = {};
        selectors.forEach(function (s) {
            s.options.forEach(function (o) {
                var per = c.groups[o] || {};
                Object.keys(per).forEach(function (tex) {
                    (per[tex] || []).forEach(function (r) {
                        var k = tex + '\u0000' + r.join(',');
                        var e = index[k];
                        if (!e) {
                            e = { tex: tex, r: r, owners: [] };
                            index[k] = e;
                            if (!rectOwners[tex]) rectOwners[tex] = [];
                            rectOwners[tex].push(e);
                        }
                        e.owners.push({ sel: s.label, opt: o });
                    });
                });
            });
        });
        Object.keys(rectOwners).forEach(function (t) {
            rectOwners[t].sort(function (a, b) {
                return a.r.join(',').localeCompare(b.r.join(','));
            });
        });

        activeKeySet = {};
        Object.keys(rectOwners).forEach(function (t) { activeKeySet[t] = 1; });
        (c.activeAtlases || []).forEach(function (t) { activeKeySet[t] = 1; });
        fingerprints = buildFingerprints();
        disabled = false;
        warnedNoConfig = false;
        pose = c.defaultPose || Object.keys(c.poses)[0] || null;
        // SDK 初始化时（configure 之前）也会上传非 atlas 纹理，那条提示是误报，清掉
        errors = errors.filter(function (e) { return e.indexOf('未调用 configure()') < 0; });
        clearRecords();     // 旧模型的纹理对象已失效，等新上传重建

        var texTotal = Object.keys(c.atlases).reduce(function (n, h) {
            return n + (Array.isArray(c.atlases[h]) ? c.atlases[h].length : 1);
        }, 0);
        var ownedTotal = Object.keys(rectOwners).reduce(function (n, t) {
            return n + rectOwners[t].length;
        }, 0);
        return {
            model: c.model,
            selectors: selectors.map(function (s) {
                return { label: s.label, options: s.options.slice() };
            }),
            state: Object.assign({}, state),
            atlases: texTotal,
            heights: Object.keys(c.atlases).length,
            ownedRects: ownedTotal,
            poses: Object.keys(c.poses),
        };
    }

    /** 模型没有任何互斥追加部件组：关掉补丁，让页面正常显示且不误报「未配置」。 */
    function disable(reason) {
        disabled = true;
        cfg = null;
        selectors = [];
        state = {};
        rectOwners = {};
        fingerprints = {};
        activeKeySet = {};
        pose = null;
        warnedNoConfig = true;
        errors = [];
        clearRecords();
        return { disabled: true, reason: reason || '' };
    }

    function normalizePose(p) {
        if (!cfg || !hasOwn(cfg.poses, p)) {
            var opts = cfg ? Object.keys(cfg.poses).join(' / ') : '（尚未 configure）';
            throw new Error('[ArmPoseGL] 未知姿势: ' + p + '（可选 ' + opts + '）');
        }
        return p;
    }

    /** 把所有已捕获 atlas 重贴到当前 state（同步、幂等）。 */
    function applyAll() {
        var t0 = performance.now();
        var sig = stateSignature();
        var changed = 0;
        for (var key in records) {
            if (!hasOwn(records, key)) continue;
            var rec = records[key];
            if (rec.appliedSig === sig) continue;
            try {
                if (applyRecord(rec)) { rec.appliedSig = sig; changed++; }
            } catch (e) {
                rec.appliedSig = null;
                errors.push('apply ' + key + ': ' + String(e));
            }
        }
        lastMs = Math.round(performance.now() - t0);
        if (changed > 0) applyCount++;
        return {
            pose: pose, state: Object.assign({}, state),
            atlases: changed, ms: lastMs, ready: isReady(),
        };
    }

    /** 兼容旧 API + 通用入口：p 可以是 crossed / hanging 这类兼容别名，
        也可以是任意一个选项名。选项名会反查它属于哪个互斥选择器，
        因此多选择器模型（帽子 + 手臂）也能用同一个入口切换。 */
    function setPose(p) {
        p = normalizePose(p);
        var opt = cfg.poses[p];
        var sel = cfg.primarySelector || selectors[0].label;
        for (var i = 0; i < selectors.length; i++) {
            if (selectors[i].options.indexOf(opt) >= 0) { sel = selectors[i].label; break; }
        }
        state[sel] = opt;
        pose = currentPoseName();
        return applyAll();
    }

    /** 通用 API：给任意互斥选择器指定当前选项。 */
    function setOption(sel, opt) {
        var found = null;
        for (var i = 0; i < selectors.length; i++) {
            if (selectors[i].label === sel) { found = selectors[i]; break; }
        }
        if (!found) {
            throw new Error('[ArmPoseGL] 未知互斥选择器: ' + sel
                + '（可选 ' + selectors.map(function (s) { return s.label; }).join(' / ') + '）');
        }
        if (found.options.indexOf(opt) < 0) {
            throw new Error('[ArmPoseGL] 未知选项: ' + opt
                + '（可选 ' + found.options.join(' / ') + '）');
        }
        state[sel] = opt;
        pose = currentPoseName();
        return applyAll();
    }

    function isReady() {
        if (disabled) return true;              // 无需补丁的模型不存在「未就绪」
        if (!cfg || !selectors.length) return false;
        var sig = stateSignature();
        var keys = activeKeys();
        if (!keys.length) return false;
        for (var i = 0; i < keys.length; i++) {
            var rec = records[keys[i]];
            if (!rec || rec.appliedSig !== sig) return false;
        }
        return true;
    }

    function getSelectors() {
        return selectors.map(function (s) {
            return { label: s.label, options: s.options.slice() };
        });
    }

    function getPoseList() {
        if (!cfg) return [];
        return Object.keys(cfg.poses).map(function (p) {
            return {
                name: p,
                label: (cfg.poseLabels && cfg.poseLabels[p]) || p,
            };
        });
    }

    function info() {
        var list = [];
        for (var key in records) {
            if (!hasOwn(records, key)) continue;
            var r = records[key];
            list.push({
                tex: key, w: r.w, h: r.h, unit: r.unit,
                flipY: r.flipY, premult: r.premult,
                ownedRects: r.rects.length,
                appliedSig: r.appliedSig,
            });
        }
        return {
            supported: hooked, configured: !!cfg, disabled: disabled,
            model: cfg ? cfg.model : null,
            pose: currentPoseName(), ready: isReady(),
            selectors: getSelectors(), state: Object.assign({}, state),
            poses: cfg ? Object.keys(cfg.poses) : [],
            poseList: getPoseList(),
            applyCount: applyCount, lastMs: lastMs,
            expectedAtlases: activeKeys(),
            uploads: uploads.slice(), records: list, errors: errors.slice(),
        };
    }

    installHooks();

    window.ArmPoseGL = {
        configure: configure,
        disable: disable,
        setPose: setPose,
        setOption: setOption,
        getPose: currentPoseName,
        getPoses: function () { return cfg ? Object.keys(cfg.poses) : []; },
        getPoseList: getPoseList,
        getSelectors: getSelectors,
        getOptions: function (sel) {
            for (var i = 0; i < selectors.length; i++) {
                if (selectors[i].label === sel) return selectors[i].options.slice();
            }
            return [];
        },
        getState: function () { return Object.assign({}, state); },
        isReady: isReady,
        info: info,
        get supported() { return hooked; },
        get POSES() { return cfg ? Object.keys(cfg.poses) : []; },
    };
})();
