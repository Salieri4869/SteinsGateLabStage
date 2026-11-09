// ============================================================
//  model-loader.js —— 模型加载 + PSB 解析 + 手臂姿势配置（单文件）
//
//  本文件独立承担三件事，不再依赖 emote-meta/ 下的任何模块：
//    ① 下载并解压 pure.zip，得到原始 PSB 字节（fflate）
//    ② 直接从这份字节里解析 PSB v4 结构区（约 1 MB），还原
//       metadata / object / source 对象树
//    ③ 从对象树算出互斥手臂组的贴图矩形、atlas 高度与姿势映射
//  配置交给 gl-arm-pose.js，在 atlas 上传 GPU 时擦掉不用的那套手臂。
//
//  SDK 三步契约（严格顺序，中间不改 canvas 尺寸）：
//    ① EmotePlayer.createRenderCanvas(w, h)   // 固定字面量
//    ② const player = new EmotePlayer(canvas)  // GL 就绪
//    ③ player.loadData([psbBytes])             // 最后加载
//
//  模型若本来只有一套手臂（没有互斥选择器），会自动跳过补丁、
//  正常显示且不显示切换按钮，而不是抛错。
//
//  浏览器 + Node 通用：Node 里 require() 得到
//  { ModelLoader, PsbReader, ArmPoseConfig }，供回归测试复用。
//
//  注意：交给 SDK 的是**未经任何修改**的原始 PSB，两套手臂 sprite
//  仍在贴图里，由 gl-arm-pose.js 在纹理上传时贴补丁。
// ============================================================

// ============================================================
//  ① PSB v4 结构解析器
//
//  为什么必须自己解析：SDK 公开的 69 个 EmotePlayer_* / EmoteDevice_*
//  接口只提供 charaProfile 标签与 charaBounds（见 emoteplayer.js），
//  不暴露图集矩形、source 表与 customSelectorList。互斥手臂在 SDK 层
//  根本无法枚举，只能在字节层面读出来，这是本模块存在的唯一理由。
//
//  只读文件前面的「结构区」（头 + 名称表 + 条目树 + 字符串表），
//  跳过其后约 200 MB 贴图数据。这里是调用方会用到的最小约定；
//  完整字段与解码规则见 docs/手臂姿势修复技术路线.md 第 14 节。
//    header 56 B：Signature / Version(u16) / Encrypt(u16)
//      + 11 个 u32 偏移 + checksum
//    PsbArray：type(0x0D..0x14) -> N = type-0x0D+1，count 占 N 字节紧凑 uint
//    Entries：0x20=List，0x21=Objects，0x15..0x18=字符串索引
// ============================================================
var PsbReader = (function () {
    'use strict';

    var T_NULL = 0x01, T_FALSE = 0x02, T_TRUE = 0x03;
    var T_NUM0 = 0x04, T_NUM8 = 0x0C;
    var T_ARRAY1 = 0x0D, T_ARRAY8 = 0x14;
    var T_STRING1 = 0x15, T_STRING4 = 0x18;
    var T_RES1 = 0x19, T_RES4 = 0x1C;
    var T_FLOAT0 = 0x1D, T_FLOAT = 0x1E, T_DOUBLE = 0x1F;
    var T_LIST = 0x20, T_OBJECTS = 0x21;
    var T_EXTRA1 = 0x22, T_EXTRA4 = 0x25;

    function Reader(bytes) {
        this.b = bytes;
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = 0;
    }
    Reader.prototype.u8 = function () { return this.dv.getUint8(this.pos++); };
    Reader.prototype.u16 = function () {
        var v = this.dv.getUint16(this.pos, true); this.pos += 2; return v;
    };
    Reader.prototype.u32 = function () {
        var v = this.dv.getUint32(this.pos, true); this.pos += 4; return v;
    };
    /** n 字节紧凑无符号整数（小端） */
    Reader.prototype.compact = function (n) {
        var v = 0, f = 1;
        for (var i = 0; i < n; i++) {
            v += this.dv.getUint8(this.pos + i) * f;
            f *= 256;
        }
        this.pos += n;
        return v;
    };
    /** 有符号紧凑整数：不足 4/8 字节时按补码符号扩展 */
    Reader.prototype.compactSigned = function (n) {
        if (n === 0) return 0;
        var v = this.compact(n);
        var bits = n * 8;
        if (bits < 32 && v >= Math.pow(2, bits - 1)) v -= Math.pow(2, bits);
        return v;
    };
    /** PsbArray：紧接当前位置读取（含 type byte），返回 uint 数组 */
    Reader.prototype.array = function () {
        var t = this.u8();
        if (t < T_ARRAY1 || t > T_ARRAY8) {
            throw new Error('[PSB] 非 PsbArray 类型字节 0x' + t.toString(16) + ' @' + this.pos);
        }
        var n = t - T_ARRAY1 + 1;
        var count = this.compact(n);
        var marker = this.u8();
        var entryLength = marker - T_NUM8;   // marker = 0x0C + L
        if (entryLength < 0 || entryLength > 8) {
            throw new Error('[PSB] 非法 entryLength ' + entryLength + ' @' + this.pos);
        }
        var out = new Array(count);
        for (var i = 0; i < count; i++) out[i] = this.compact(entryLength);
        return out;
    };

    function decodeNames(r) {
        var charset = r.array();
        var namesData = r.array();
        var nameIndexes = r.array();
        var dec = new TextDecoder('utf-8');
        var names = new Array(nameIndexes.length);
        for (var i = 0; i < nameIndexes.length; i++) {
            var list = [];
            var chr = namesData[nameIndexes[i]];
            var guard = 0;
            while (chr !== 0 && guard++ < 4096) {
                var code = namesData[chr];
                var d = charset[code];
                list.push((chr - d) & 0xFF);
                chr = code;
            }
            list.reverse();
            names[i] = dec.decode(new Uint8Array(list));
        }
        return names;
    }

    /**
     * 解析 PSB 结构区，返回 { root, header, nameCount, stringCount }。
     * @param {Uint8Array} bytes  pure.psb 完整字节（只读前约 1 MB）
     * @param {object} [opts]     { resourceMode:'stub'|'index' }
     */
    function parse(bytes, opts) {
        opts = opts || {};
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
        var r = new Reader(bytes);
        var sig = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
        if (sig.slice(0, 3) !== 'PSB') throw new Error('[PSB] 不是 pure.psb（签名 ' + sig + '）');
        var version = r.u16();
        if (version !== 4) throw new Error('[PSB] 目前只支持 v4，实际 v' + version);
        r.u16();                       // HeaderEncrypt
        var h = {
            headerLength: r.u32(), offsetNames: r.u32(),
            offsetStrings: r.u32(), offsetStringsData: r.u32(),
            offsetChunkOffsets: r.u32(), offsetChunkLengths: r.u32(),
            offsetChunkData: r.u32(), offsetEntries: r.u32(),
            checksum: r.u32(),
            offsetExtraChunkOffsets: r.u32(), offsetExtraChunkLengths: r.u32(),
            offsetExtraChunkData: r.u32(),
        };
        if (!h.offsetNames || h.offsetNames >= bytes.byteLength) {
            throw new Error('[PSB] 头部可能被加密，无法解析');
        }

        /* Names */
        r.pos = h.offsetNames;
        var names = decodeNames(r);

        /* String offsets */
        r.pos = h.offsetStrings;
        var stringOffsets = r.array();
        var dec = new TextDecoder('utf-8');
        var stringCache = {};
        function readString(idx) {
            if (Object.prototype.hasOwnProperty.call(stringCache, idx)) return stringCache[idx];
            var start = h.offsetStringsData + stringOffsets[idx];
            if (start == null || start >= bytes.byteLength) return '';
            var end = start;
            while (end < bytes.byteLength && bytes[end] !== 0) end++;
            var s = dec.decode(bytes.subarray(start, end));
            stringCache[idx] = s;
            return s;
        }

        /* Entries */
        function unpack() {
            var t = r.u8();
            if (t === T_NULL) return null;
            if (t === T_FALSE) return false;
            if (t === T_TRUE) return true;
            if (t === T_NUM0) return 0;
            if (t >= T_NUM0 + 1 && t <= T_NUM8) return r.compactSigned(t - T_NUM0);
            if (t >= T_ARRAY1 && t <= T_ARRAY8) {
                r.pos--;                 // 回退 type byte，交给 array()
                return r.array();
            }
            if (t >= T_STRING1 && t <= T_STRING4) {
                return readString(r.compact(t - T_STRING1 + 1));
            }
            if (t >= T_RES1 && t <= T_RES4) {
                var ri = r.compact(t - T_RES1 + 1);
                return opts.resourceMode === 'index' ? ri : { __psbResource: ri };
            }
            if (t >= T_EXTRA1 && t <= T_EXTRA4) {
                var ei = r.compact(t - T_EXTRA1 + 1);
                return opts.resourceMode === 'index' ? ei : { __psbExtraResource: ei };
            }
            if (t === T_FLOAT0) return 0;
            if (t === T_FLOAT) { var f = r.dv.getFloat32(r.pos, true); r.pos += 4; return f; }
            if (t === T_DOUBLE) { var d = r.dv.getFloat64(r.pos, true); r.pos += 8; return d; }
            if (t === T_LIST) {
                var offs = r.array();
                var base = r.pos;
                var arr = new Array(offs.length);
                for (var i = 0; i < offs.length; i++) {
                    r.pos = base + offs[i];
                    arr[i] = unpack();
                }
                return arr;
            }
            if (t === T_OBJECTS) {
                var nameIdx = r.array();
                var valOffs = r.array();
                var pos = r.pos;
                var obj = {};
                for (var j = 0; j < nameIdx.length; j++) {
                    var key = names[nameIdx[j]];
                    if (key === undefined) continue;
                    if (j < valOffs.length) {
                        r.pos = pos + valOffs[j];
                        obj[key] = unpack();
                    }
                }
                return obj;
            }
            throw new Error('[PSB] 未知值类型 0x' + t.toString(16) + ' @' + r.pos);
        }

        r.pos = h.offsetEntries;
        var root = unpack();
        return { root: root, header: h, nameCount: names.length, stringCount: stringOffsets.length };
    }

    return { parse: parse };
})();

// ============================================================
//  ② 手臂姿势配置归组规则（原 emote-meta/arm-pose-config.js）
//
//  不碰二进制，只在上一步还原出的对象树里做语义归组。规则全部
//  读自模型自身，不写死模型名 / 变量名 / 矩形坐标：
//    metadata.customSelectorList[].optionList          -> 互斥组变量名
//    metadata.customPartsList[].extensions[].variable  -> 变量锚点部件
//    customPartsList 挂载树（父.customMountBaseIndex == 子.mountIndex）
//                                                     -> 把配套子部件一并纳入
//    object 树里 追加パーツプレーン_le<id> 的 frameList.content.{src,icon}
//                                                     -> 图标引用
//    source[tex#N].icon[NNNN]                          -> 擦除矩形
//    source[tex#N].texture.height                      -> atlas 高度
// ============================================================
var ArmPoseConfig = (function () {
    'use strict';

    var ATLAS_WIDTH = 4096;                       // E-mote atlas 固定宽度（GPU 实测）
    var PART_LABEL_RE = /追加パーツプレーン_le(\d+)$/;
    var HINT_RE = /arm|腕/i;
    var SEP = '\u0000';                           // (src, icon) 复合键分隔符

    function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function asInt(v) { return Math.trunc(Number(v)); }

    /* 收集一个部件节点下所有 frameList.content 的 (src, icon) 引用 */
    function collectIcons(node, out) {
        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) collectIcons(node[i], out);
        } else if (isObj(node)) {
            var frames = node.frameList;
            if (Array.isArray(frames)) {
                for (var j = 0; j < frames.length; j++) {
                    var c = isObj(frames[j]) ? frames[j].content : null;
                    if (isObj(c) && typeof c.icon === 'string' && typeof c.src === 'string') {
                        out.push(c.src + SEP + c.icon);
                    }
                }
            }
            for (var k in node) if (own(node, k)) collectIcons(node[k], out);
        }
        return out;
    }

    /* 返回 { parts: Map<部件id, Set<iconKey>>, usage: Map<iconKey, Set<部件id>> } */
    function indexParts(obj) {
        var parts = new Map(), usage = new Map();
        (function walk(n) {
            if (Array.isArray(n)) {
                for (var i = 0; i < n.length; i++) walk(n[i]);
                return;
            }
            if (!isObj(n)) return;
            var label = n.label;
            if (typeof label === 'string') {
                var m = PART_LABEL_RE.exec(label);
                if (m) {
                    var pid = parseInt(m[1], 10);
                    var icons = collectIcons(n, []);
                    var set = parts.get(pid);
                    if (!set) { set = new Set(); parts.set(pid, set); }
                    for (var j = 0; j < icons.length; j++) {
                        var ic = icons[j];
                        set.add(ic);
                        var u = usage.get(ic);
                        if (!u) { u = new Set(); usage.set(ic, u); }
                        u.add(pid);
                    }
                }
            }
            for (var k in n) if (own(n, k)) walk(n[k]);
        })(obj);
        return { parts: parts, usage: usage };
    }

    /* 通用自动识别「互斥追加部件选择器」——判据完全来自结构，不依赖命名。
       三条同时满足才算：
         ① optionList 至少 2 个非空选项
         ② 每个 option.label 都是 customPartsList[].extensions[].variable 里出现过的变量
         ③ 至少一个选项能映射到 追加パーツプレーン 的 icon（确实控制贴图）
       3.9.8 原生认识的普通差分选择器（head_type / body_type / eye_type /
       eyebrow_type / mouth_type / face_tears …）的选项不是追加部件变量，
       锚点部件数为 0，会被自然排除；它们本来就该交给 SDK 自己处理。
       旧版靠「名称含 arm/腕」猜一个，既漏掉 yubi_type，也会误中 head_type。 */
    function findSelectors(metadata, warnings, hasIcons) {
        var variables = new Set();
        (metadata.customPartsList || []).forEach(function (e) {
            (e.extensions || []).forEach(function (x) {
                if (isObj(x) && x.variable) variables.add(x.variable);
            });
        });

        var out = [];
        (metadata.customSelectorList || []).forEach(function (s) {
            var entries = (s.optionList || []).filter(isObj);
            var opts = entries.map(function (o) { return o.label; })
                .filter(function (o) { return !!o; });
            if (opts.length < 2) return;
            if (!opts.every(function (o) { return variables.has(o); })) return;
            var anchored = opts.filter(function (o) { return hasIcons(o); });
            if (!anchored.length) return;
            var values = {};
            entries.forEach(function (o) {
                if (o && o.label) {
                    values[o.label] = { on: o.onValue, off: o.offValue, lower: o.lower };
                }
            });
            out.push({ label: s.label || '', opts: opts, values: values });
        });
        if (!out.length) {
            warnings.push('未找到互斥追加部件选择器；按单套手臂模型处理，不启用纹理补丁');
        } else {
            out.forEach(function (s) {
                warnings.push('自动识别互斥选择器 ' + s.label + '（' + s.opts.length
                    + ' 个选项：' + s.opts.join(' / ') + '）');
            });
        }
        return out;
    }

    function shortPoseLabel(v) {
        return String(v).replace(/^fade_/, '').replace(/_type_/, '_');
    }

    /**
     * 由 PSB root 生成单个模型的配置（字段与 gl-arm-pose.js.configure 契约一致）
     * @param {object} d          PSB root 对象（含 metadata / object / source）
     * @param {string} modelZip   模型 zip 文件名（用于回写 cfg.model）
     */
    function build(d, modelZip) {
        var warnings = [];
        var metadata = d.metadata || {};
        var source = d.source || {};
        var obj = d.object || {};

        /* 改动②：atlas 高度 -> 候选贴图列表（不再假设高度唯一）。
           有些模型（フェイリスac_イベント衣装）7 张 atlas 里 2752/2480/2072
           各出现两次，单靠高度会把两张贴图认成同一个 tex#N。
           这里额外导出每个 tex 的全部 icon 矩形作为「内容指纹」：
           上传时 hook 直接检查传入的 RGBA 像素在这些矩形里有没有内容，
           据此判断这次上传的是哪张贴图，不依赖上传顺序、也不读贴图像素区。 */
        var atlases = {}, texHeights = {}, texRects = {}, texCount = 0;
        Object.keys(source).forEach(function (tex) {
            var v = source[tex];
            if (!isObj(v) || !isObj(v.texture)) return;
            var h = v.texture.height;
            if (h == null) return;
            var key = String(asInt(h));
            if (!own(atlases, key)) atlases[key] = [];
            atlases[key].push(tex);
            texHeights[tex] = asInt(h);
            texCount++;

            var rects = [];
            var iconMap = isObj(v.icon) ? v.icon : {};
            Object.keys(iconMap).forEach(function (ic) {
                var e = iconMap[ic];
                if (!isObj(e)) return;
                var r = [asInt(e.left), asInt(e.top), asInt(e.width), asInt(e.height)];
                if (r[2] > 0 && r[3] > 0) rects.push(r);
            });
            texRects[tex] = rects;
        });
        Object.keys(atlases).forEach(function (h) {
            if (atlases[h].length > 1) {
                warnings.push('贴图高度 ' + h + ' 下有 ' + atlases[h].length
                    + ' 张 atlas（' + atlases[h].join(' / ')
                    + '），上传时按像素内容区分');
            }
        });

        var idx = indexParts(obj);
        var cpl = metadata.customPartsList || [];

        /* 哪些变量真正挂在「有 icon 的追加部件」上 */
        var anchoredVars = new Set();
        cpl.forEach(function (e) {
            if (e.id == null) return;
            if (!(idx.parts.get(e.id) || new Set()).size) return;
            (e.extensions || []).forEach(function (x) {
                if (isObj(x) && x.variable) anchoredVars.add(x.variable);
            });
        });
        var sels = findSelectors(metadata, warnings, function (o) {
            return anchoredVars.has(o);
        });
        var opts = [];
        sels.forEach(function (s) {
            s.opts.forEach(function (o) { if (opts.indexOf(o) < 0) opts.push(o); });
        });

        /* customPartsList 内部是一棵挂载树：父.customMountBaseIndex == 子.mountIndex。
           互斥变量通常只挂在根部件上，配套的袖子 / 手 / 衣襟等子部件没有变量，
           必须沿挂载树把整棵子树纳入该组，否则只擦掉一半 sprite（残留袖子）。 */
        var byId = new Map(), children = new Map(), cmSet = new Set();
        cpl.forEach(function (e) {
            if (e.id != null) byId.set(e.id, e);
            if (e.mountIndex != null) {
                var mi = asInt(e.mountIndex);
                if (!children.has(mi)) children.set(mi, []);
                children.get(mi).push(e);
            }
            if (e.customMountBaseIndex != null) cmSet.add(asInt(e.customMountBaseIndex));
        });

        /* 反向父指针：子.mountIndex == 父.customMountBaseIndex。
           >2 选项的互斥组需要沿父链传播可见性（无变量的手指跟随手）。 */
        var parentByCmbi = new Map(), parentOf = new Map();
        cpl.forEach(function (e) {
            if (e.customMountBaseIndex != null && e.id != null) {
                parentByCmbi.set(asInt(e.customMountBaseIndex), e.id);
            }
        });
        cpl.forEach(function (e) {
            if (e.id == null || e.mountIndex == null) return;
            var p = parentByCmbi.get(asInt(e.mountIndex));
            if (p != null && p !== e.id) parentOf.set(e.id, p);
        });

        function expand(seed) {
            var got = new Set(seed), queue = Array.from(seed);
            while (queue.length) {
                var parent = byId.get(queue.pop());
                if (!parent || parent.customMountBaseIndex == null) continue;
                var cm = asInt(parent.customMountBaseIndex);
                (children.get(cm) || []).forEach(function (child) {
                    var cid = child.id;
                    if (cid != null && !got.has(cid)) { got.add(cid); queue.push(cid); }
                });
            }
            return got;
        }

        /* 互斥变量也会挂在「躯干 / 胸部」等另一棵顶层树上，那棵树含整片大衣的大矩形，
           擦掉会破图。这里只取名称与主题（arm / 腕）相关的顶层根，再向下扩展子树。 */
        function isRoot(e) {
            var mi = e.mountIndex;
            return mi == null || !cmSet.has(asInt(mi));
        }

        /* 变量表：部件 id -> 它身上出现过的全部变量 */
        var varsOf = new Map();
        cpl.forEach(function (e) {
            if (e.id == null) return;
            var vs = new Set();
            (e.extensions || []).forEach(function (x) {
                if (isObj(x) && x.variable) vs.add(x.variable);
            });
            varsOf.set(e.id, vs);
        });

        /* 每个选项对应「该选项可见时应该保留的部件」。
           两条规则都从模型自身结构读出，不写死模型名 / 变量 / 矩形：
           · 2 选项（已验证的手臂模型）：主题顶层根 + 沿挂载树向下扩展。
             名称提示 arm/腕 只用于排除「胴体 / 大衣」那棵顶层树（擦它会破图）；
             一个都没有时退化为全部锚点，陌生模型也能自动工作。
           · >2 选项（如桐生萌郁 yubi_type 的 5 个拇指）：整棵树里每个部件
             各自带一个选项变量，不能把整棵树归给某个选项。改为逐部件判定：
             带选项变量的部件只在命中该选项时可见，不带选项变量的部件
             沿父链继承可见性（手指跟随手、袖子跟随手臂）。 */
        /* 逐部件可见性传播：只在「带该选项变量」的部件上做取舍，无变量的子部件
           沿父链继承。用于 >2 选项组（桐生 5 个拇指）以及找不到主题根的组
           （椎名まゆりac 的 hat_type：部件名不含 arm/腕）。后者过去会退化成
           「全部变量锚点 + 整棵挂载树」，把 23 个部件（含躯干大图块）吞进互斥
           组，切帽子时擦出破洞；现在只擦真正带帽子变量的部件。 */
        function propagate(sel, optSet, roots) {
            var subtree = expand(roots);
            var visCache = new Map();
            function visible(pid, o, stack) {
                var key = pid + SEP + o;
                if (visCache.has(key)) return visCache.get(key);
                if (stack.has(pid)) return false;
                stack.add(pid);
                var vs = varsOf.get(pid) || new Set();
                var optVars = [];
                vs.forEach(function (v) { if (optSet.has(v)) optVars.push(v); });
                var par = parentOf.get(pid);
                var v;
                if (optVars.length) v = optVars.indexOf(o) >= 0;
                else v = par == null ? true : visible(par, o, stack);
                stack.delete(pid);
                visCache.set(key, v);
                return v;
            }
            var out = {};
            sel.opts.forEach(function (o) {
                var s = new Set();
                subtree.forEach(function (pid) {
                    if (visible(pid, o, new Set())) s.add(pid);
                });
                out[o] = s;
                warnings.push(sel.label + ' / ' + o + ': 可见性传播 -> '
                    + s.size + ' 个可见部件');
            });
            return out;
        }

        var groupIds = {};
        sels.forEach(function (sel) {
            var optSet = new Set(sel.opts);
            var anchorsOf = {}, roots = new Set();
            sel.opts.forEach(function (o) { anchorsOf[o] = new Set(); });
            cpl.forEach(function (e) {
                if (e.id == null) return;
                var vs = varsOf.get(e.id);
                if (!vs) return;
                sel.opts.forEach(function (o) {
                    if (!vs.has(o)) return;
                    anchorsOf[o].add(e.id);
                    if (isRoot(e)) roots.add(e.id);
                });
            });
            if (!roots.size) {
                sel.opts.forEach(function (o) {
                    anchorsOf[o].forEach(function (id) { roots.add(id); });
                });
            }

            var hinted = new Set();
            roots.forEach(function (id) {
                var e = byId.get(id);
                var label = String(e && e.label != null ? e.label : '');
                if (HINT_RE.test(label)) hinted.add(id);
            });

            if (sel.opts.length > 2 || !hinted.size) {
                if (!hinted.size) {
                    warnings.push(sel.label + ': 未找到主题顶层根，改用逐部件可见性传播'
                        + '（避免把无关部件吞进互斥组）');
                }
                var prop = propagate(sel, optSet, roots);
                sel.opts.forEach(function (o) { groupIds[o] = prop[o]; });
            } else {
                sel.opts.forEach(function (o) {
                    var seed = new Set();
                    hinted.forEach(function (id) {
                        var vs = varsOf.get(id);
                        if (vs && vs.has(o)) seed.add(id);
                    });
                    if (!seed.size) {
                        warnings.push(sel.label + ' / ' + o
                            + ': 主题根为空，回退到全部变量锚点');
                        seed = anchorsOf[o];
                    }
                    groupIds[o] = expand(seed);
                    warnings.push(sel.label + ' / ' + o + ': 主题根 '
                        + seed.size + ' 个 -> 挂载树扩展后 ' + groupIds[o].size + ' 个部件');
                });
            }
        });

        var groups = {}, activeAtlases = new Set(), groupIcons = {};
        opts.forEach(function (o) {
            var icons = new Set();
            groupIds[o].forEach(function (pid) {
                var s = idx.parts.get(pid);
                if (s) s.forEach(function (ic) { icons.add(ic); });
            });
            groupIcons[o] = icons;

            var rects = {}, missing = 0, total = 0;
            Array.from(icons).sort().forEach(function (ic) {
                var p = ic.indexOf(SEP);
                var srcName = ic.slice(0, p), iconName = ic.slice(p + 1);
                if (srcName.indexOf('tex#') !== 0) return;
                var ent = (isObj(source[srcName]) && isObj(source[srcName].icon)
                    ? source[srcName].icon : {})[iconName];
                if (!ent) { missing++; return; }
                var r = [asInt(ent.left), asInt(ent.top), asInt(ent.width), asInt(ent.height)];
                if (!rects[srcName]) rects[srcName] = [];
                var exists = rects[srcName].some(function (q) {
                    return q[0] === r[0] && q[1] === r[1] && q[2] === r[2] && q[3] === r[3];
                });
                if (!exists) { rects[srcName].push(r); total++; }
            });

            var g = {};
            Object.keys(rects).forEach(function (k) {
                if (rects[k].length) { g[k] = rects[k]; activeAtlases.add(k); }
            });
            groups[o] = g;

            var shared = 0;
            icons.forEach(function (ic) {
                var u = idx.usage.get(ic);
                if (!u) return;
                var outside = false;
                u.forEach(function (pid) { if (!groupIds[o].has(pid)) outside = true; });
                if (outside) shared++;
            });
            warnings.push(o + ': ' + groupIds[o].size + ' 部件 / ' + icons.size + ' icons / '
                + total + ' 矩形，' + shared + ' 个 icon 被组外部件共用'
                + (missing ? '，' + missing + ' 个 icon 在 source 中缺失' : ''));
        });

        var names = Object.keys(groupIcons);
        for (var i = 0; i < names.length; i++) {
            for (var j = i + 1; j < names.length; j++) {
                var overlap = 0;
                groupIcons[names[i]].forEach(function (ic) {
                    if (groupIcons[names[j]].has(ic)) overlap++;
                });
                if (overlap) {
                    warnings.push(names[i] + ' 与 ' + names[j] + ' 共用 ' + overlap
                        + ' 个 icon，擦除会互相影响');
                }
            }
        }

        /* 4.0 的 insert 部件在 3.9.8 里不会被删掉：两套手臂的运动层图块会一起画，
           于是「抬起」状态多出两条垂下的前臂，「放下」状态多出两条无手的断臂
           （手掌另由 customPartsList 控制，所以只有一套有手）。
           这些图块不在 customPartsList 里，而挂在 object 运动层
           「<选项变量> > 追加パーツ」的直接节点上：
             · 只有这个分支是追加部件本体；EMBED / 胴体 / ジェリー揺れ 分支画的
               是躯干、裙子和领口装饰，擦掉会破图（已逐矩形实测）。
             · 手臂贴图是细长竖条（高 >= 200 且高 >= 1.3 * 宽）；衣服大图块虽然
               也竖长，但不在「追加パーツ」直接节点上，天然被排除。
           命中的图块并入该选项的 groups，两个状态就成了严格互斥的两套完整手臂。
           判据纯结构，不写死模型名 / 变量 / 坐标。 */
        var usedRects = new Set();
        Object.keys(groups).forEach(function (o) {
            Object.keys(groups[o]).forEach(function (t) {
                groups[o][t].forEach(function (r) { usedRects.add(t + '|' + r.join(',')); });
            });
        });

        function slimMotionArms(opt) {
            var out = [], seen = new Set();
            (function walk(n, depth) {
                if (Array.isArray(n)) {
                    n.forEach(function (v) { walk(v, depth); });
                    return;
                }
                if (!isObj(n)) return;
                var label = typeof n.label === 'string' ? n.label : '';
                var next = depth;
                if (label === opt) next = 0;
                else if (depth != null) next = depth + 1;
                /* depth === 0 表示父节点就是这个选项变量节点。 */
                if (depth === 0 && /^■?追加パーツ$/.test(label) && Array.isArray(n.frameList)) {
                    n.frameList.forEach(function (f) {
                        var c = isObj(f) && isObj(f.content) ? f.content : null;
                        if (!c || typeof c.src !== 'string' || c.src.indexOf('tex#') !== 0
                            || typeof c.icon !== 'string') return;
                        var ent = (isObj(source[c.src]) && isObj(source[c.src].icon)
                            ? source[c.src].icon : {})[c.icon];
                        if (!isObj(ent)) return;
                        var q = [asInt(ent.left), asInt(ent.top),
                                 asInt(ent.width), asInt(ent.height)];
                        if (q[3] < 200 || q[3] < 1.3 * q[2]) return;
                        var k = c.src + '|' + q.join(',');
                        if (usedRects.has(k) || seen.has(k)) return;
                        seen.add(k);
                        out.push({ tex: c.src, icon: c.icon, r: q });
                    });
                }
                for (var key in n) {
                    if (own(n, key) && key !== 'frameList') walk(n[key], next);
                }
            })(obj, null);
            return out;
        }

        sels.forEach(function (sel) {
            /* 只有「每个选项都命中 >= 2 块（左右成对）、总数 >= 4」才认定为
               两套运动层手臂。桐生萌郁的 5 个拇指差分里只有 2 个各命中 1 块，
               会被排除，避免把正常的手机/拇指贴图误归组。 */
            if (sel.opts.length < 2) return;
            var hits = {}, counts = [], total = 0, dup = false, dupSeen = new Set();
            sel.opts.forEach(function (o) {
                hits[o] = slimMotionArms(o);
                counts.push(hits[o].length);
                total += hits[o].length;
                hits[o].forEach(function (x) {
                    var k = x.tex + '|' + x.r.join(',');
                    if (dupSeen.has(k)) dup = true;   // 跨选项共用 -> 互斥会互相影响
                    dupSeen.add(k);
                });
            });
            if (dup) {
                warnings.push(sel.label + ': 运动层细长图块跨选项重叠，跳过配对互斥');
                return;
            }
            if (counts.some(function (n) { return n < 2; }) || total < 4) return;
            sel.opts.forEach(function (o) {
                hits[o].forEach(function (x) {
                    if (!groups[o][x.tex]) groups[o][x.tex] = [];
                    groups[o][x.tex].push(x.r.slice());
                    activeAtlases.add(x.tex);
                });
                warnings.push(sel.label + ' / ' + o + ': 运动层配对互斥追加 '
                    + hits[o].length + ' 个细长手臂图块（'
                    + hits[o].map(function (x) { return x.tex + ':' + x.icon; }).join(' / ')
                    + '）');
            });
        });

        /* 姿势 = 「某个互斥选择器当前选中的选项」。
           crossed / hanging 只是旧版单模型 API 的兼容别名，不隐含任何视觉语义：
           显示标签一律用模型自己的选项名，不再把「抱臂 / 垂手」这种只在某一个
           模型上成立的猜测套到别的模型。
           多选择器模型（如椎名まゆりac 同时有 hat_type 与 arm_type）不能默认把
           sels[0] 当手臂，否则兼容 API 的默认姿势和面板按钮会切到帽子上去；
           优先选名称含 arm/腕 的组当主姿势选择器，其余组在面板里独立控制。
           GPU 状态机本身是 selector -> option 的多维状态，不依赖这个概念。 */
        var poses = {}, poseLabels = {}, defaultOptions = {};
        var primary = sels[0] || null;
        if (sels.length > 1) {
            for (var pi = 0; pi < sels.length; pi++) {
                if (/arm|腕/i.test(sels[pi].label)) { primary = sels[pi]; break; }
            }
            if (primary !== sels[0]) {
                warnings.push('检测到 ' + sels.length + ' 个互斥追加部件组；兼容 API 的'
                    + '主姿势选择器按语义选为 ' + primary.label
                    + '（其余组在面板中按选择器独立控制）');
            }
        }
        if (primary) {
            if (primary.opts.length === 2) {
                poses.crossed = primary.opts[1];
                poses.hanging = primary.opts[0];
                poseLabels.crossed = shortPoseLabel(primary.opts[1]);
                poseLabels.hanging = shortPoseLabel(primary.opts[0]);
                defaultOptions[primary.label] = poses.crossed;
                warnings.push('兼容别名 crossed -> ' + poses.crossed
                    + '、hanging -> ' + poses.hanging + '（标签取模型原名）');
            } else {
                primary.opts.forEach(function (o) {
                    poses[o] = o;
                    poseLabels[o] = shortPoseLabel(o);
                });
                defaultOptions[primary.label] = primary.opts[0];
            }
            sels.forEach(function (s) {
                if (s === primary) return;
                s.opts.forEach(function (o) {
                    if (!own(poses, o)) { poses[o] = o; poseLabels[o] = shortPoseLabel(o); }
                });
                if (!own(defaultOptions, s.label)) defaultOptions[s.label] = s.opts[0];
            });
        }

        return {
            model: modelZip,
            selector: primary ? primary.label : '',
            primarySelector: primary ? primary.label : '',
            // 通用契约：可以有任意多个互斥选择器、每个任意多个选项
            selectors: sels.map(function (s) {
                return { label: s.label, options: s.opts.slice(), values: s.values };
            }),
            defaultOptions: defaultOptions,
            defaultPose: Object.keys(poses)[0] || null,
            poseLabels: poseLabels,
            width: ATLAS_WIDTH,
            atlases: atlases,              // { 高度: [tex#N, ...] }
            texCount: texCount,
            texHeights: texHeights,        // tex#N -> 高度
            texRects: texRects,            // tex#N -> 全部 icon 矩形（内容识别指纹）
            activeAtlases: Array.from(activeAtlases).sort(),
            groups: groups,                // 选项名 -> { tex#N: [矩形] }
            poses: poses,                  // 姿势名 -> 「当前选中」的选项名
            warnings: warnings,
        };
    }

    /** 批量（回归测试用）：entries = [{model:'x.zip', root:{...}}] */
    function buildAll(entries) {
        var models = {};
        entries.forEach(function (e) { models[e.model] = build(e.root, e.model); });
        return { version: 1, models: models };
    }

    function asNum(v, dflt) {
        var n = Number(v);
        return isFinite(n) ? n : dflt;
    }

    /**
     * 侧面板用：列出模型里「全部」差分选择器与部件，不做任何筛选。
     * build() 只保留 GPU 需要打补丁的那一组；这里保留全部 customSelectorList
     * （含 3.9.8 原生认识的 head_type / eye_type / mouth_type …），
     * 并带上每个选项的原始 onValue / offValue，页面据此按 4.0 选择器语义写 SDK 变量。
     */
    function inventory(d) {
        var md = d.metadata || {};
        var cpl = md.customPartsList || [];
        var anchored = new Set();
        cpl.forEach(function (e) {
            (e.extensions || []).forEach(function (x) {
                if (isObj(x) && x.variable) anchored.add(x.variable);
            });
        });

        var selectors = (md.customSelectorList || []).map(function (s) {
            return {
                label: s.label || '',
                enabled: s.enabled !== 0,
                options: (s.optionList || []).filter(isObj).map(function (o, i) {
                    return {
                        index: i,
                        label: o.label || '',
                        on: asNum(o.onValue, 100),
                        off: asNum(o.offValue, 0),
                        lower: asNum(o.lower, 0),
                        upper: asNum(o.upper, 0),
                        imm: asNum(o.imm, 0),
                        anchored: !!(o.label && anchored.has(o.label)),
                    };
                }),
            };
        });

        var parts = cpl.map(function (e) {
            return {
                id: e.id == null ? null : asInt(e.id),
                label: e.label == null ? '' : String(e.label),
                variables: (e.extensions || []).filter(function (x) {
                    return isObj(x) && x.variable;
                }).map(function (x) { return x.variable; }),
                mountIndex: e.mountIndex == null ? null : asInt(e.mountIndex),
                customMountBaseIndex: e.customMountBaseIndex == null
                    ? null : asInt(e.customMountBaseIndex),
            };
        });

        return {
            version: 1,
            selectors: selectors,
            parts: parts,
            selectorCount: selectors.length,
            partCount: parts.length,
        };
    }

    return {
        version: 1,
        ATLAS_WIDTH: ATLAS_WIDTH,
        build: build,
        buildAll: buildAll,
        inventory: inventory,
    };
})();

// ============================================================
//  ③ 选择器变量兼容层 SelectorAPI
// ------------------------------------------------------------
//  3.9.8 的 iemote.h 只有 SetVariable(const char*, float) / GetVariable(float)，
//  没有 selector / customPartsList / extension 的任何接口；wasm 会把 4.0 的
//  互斥选择器当成普通数值变量存下来，却不改变追加部件的显示（实测逐像素无差异）。
//
//  这里在 player 实例上补一组「和 setVariable 同款」的 API，把 GPU 互斥选项
//  状态包装起来；同时代理 setVariable / getVariable，使原来的写法
//      player.setVariable('yubi_type', 'fade_yubi_c')   // 或索引 2
//      player.getVariable('yubi_type')                  // -> 2
//  也能真正切换画面。driver/emoteplayer.js 一行不改，随时可 uninstall()。
//
//  另外内置「时间线桥」：3.9.8 的 wasm 会按差分时间线关键帧写 selector 变量
//  （桐生萌郁的「携帯入力」写 yubi_type=1..4），但不会展开成互斥部件的显隐。
//  桥逐帧读原生变量，值发生变化时才把 GPU 状态同步过去；setSelector 也回写
//  一次原生索引变量，保证手动切换不被桥拉回。写的是索引变量而非 fade_*，
//  不会叠影。首帧只记录不动作，所以没有相关时间线的模型完全不受影响。
// ============================================================
var SelectorAPI = (function () {
    'use strict';

    function listOf(gl) {
        return (gl && gl.getSelectors) ? gl.getSelectors() : [];
    }

    function find(list, label) {
        if (typeof label === 'number' && list[label]) return list[label];
        for (var i = 0; i < list.length; i++) {
            if (list[i].label === label) return list[i];
        }
        return null;
    }

    /** 选项值支持：完整选项名 / 唯一后缀简写（'c'、'yubi_c'）/ 0-based 数字索引 */
    function resolveOption(sel, value) {
        var opts = sel.options;
        if (typeof value === 'number') {
            var i = Math.trunc(value);
            if (i === value && i >= 0 && i < opts.length) return opts[i];
            throw new Error('[SelectorAPI] ' + sel.label + ' 的索引 ' + value
                + ' 不合法（可用 0..' + (opts.length - 1) + '：' + opts.join(' / ') + '）');
        }
        var v = String(value == null ? '' : value);
        for (var j = 0; j < opts.length; j++) if (opts[j] === v) return opts[j];
        var hits = opts.filter(function (o) {
            return o === v || o.slice(-v.length) === v || o.slice(-(v.length + 1)) === '_' + v;
        });
        if (hits.length === 1) return hits[0];
        throw new Error('[SelectorAPI] ' + sel.label + ' 未知选项 ' + JSON.stringify(v)
            + '（可选 ' + opts.join(' / ') + ' 或索引 0..' + (opts.length - 1) + '）');
    }

    function install(player, gl) {
        if (!player) throw new Error('[SelectorAPI] 需要 player 实例');
        if (player.__emoteSelector) return player.__emoteSelector.refresh();

        var nativeSet = player.setVariable;
        var nativeGet = player.getVariable;
        var ownSet = Object.prototype.hasOwnProperty.call(player, 'setVariable');
        var ownGet = Object.prototype.hasOwnProperty.call(player, 'getVariable');
        var hasRaf = typeof requestAnimationFrame === 'function'
            && typeof cancelAnimationFrame === 'function';

        /** 真正改 GPU 状态 + 通知面板，不碰 wasm 变量（外部调用与时间线桥共用） */
        function setOptionCore(label, opt) {
            gl.setOption(label, opt);
            // 同步 ModelLoader 的兼容姿势字段，避免 getArmPose() 读到旧值
            if (typeof ModelLoader !== 'undefined' && ModelLoader._armPose) {
                var p = gl.getPose && gl.getPose();
                if (p) ModelLoader._armPose = p;
            }
            // 时间线驱动 GPU 状态时，让侧边栏 ① 的按钮高亮跟着走
            if (typeof window !== 'undefined' && window.dispatchEvent
                && typeof window.CustomEvent === 'function') {
                try {
                    window.dispatchEvent(new window.CustomEvent('emote-selector-change',
                        { detail: { label: label, option: opt } }));
                } catch (e) { /* 面板尚未安装时忽略 */ }
            }
            return opt;
        }

        /**
         * 时间线桥：wasm 按时间线关键帧写 selector 变量，但 JS 侧拿不到回调，
         * 只能逐帧读原生 GetVariable。首帧只记录基线；之后只有值「发生变化」
         * 才同步 GPU 状态 —— 这样没有相关时间线的模型（如红莉栖 arm_type）
         * 不会被一个恒定的 0 覆盖掉默认姿势。手动 setSelector 会 noteManual()
         * 并抑制 3 帧，避开 wasm 写值延迟造成的回弹；面板按钮 / 旧 setArmPose
         * 直接改 gl 状态时，桥检测到「GPU 状态被外部改变」就重对齐基线，不拉回。
         */
        var bridge = {
            running: false, raf: 0, ticks: 0, syncCount: 0, changes: [], last: {}, gpu: {}, suppress: 0,
            noteManual: function (label, idx) {
                bridge.last[label] = idx;
                var st = (gl.getState && gl.getState()) || {};
                bridge.gpu[label] = st[label];
                bridge.suppress = 3;
            },
            tickOnce: function () {
                bridge.ticks++;
                var list = listOf(gl);
                var st = (gl.getState && gl.getState()) || {};
                var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
                for (var i = 0; i < list.length; i++) {
                    var s = list[i];
                    var raw = nativeGet.call(player, s.label);
                    if (!isFinite(raw)) continue;
                    var v = Math.round(raw);
                    if (v < 0 || v >= s.options.length) continue;
                    var curGpu = st[s.label];
                    var external = has(bridge.gpu, s.label) && curGpu !== bridge.gpu[s.label];
                    bridge.gpu[s.label] = curGpu;
                    if (!has(bridge.last, s.label)) { bridge.last[s.label] = v; continue; }
                    if (external) {                  // 外部改了 GPU 状态：只重对齐基线
                        bridge.last[s.label] = v;
                        bridge.suppress = Math.max(bridge.suppress, 2);
                        continue;
                    }
                    if (v === bridge.last[s.label]) continue;
                    bridge.last[s.label] = v;        // 抑制期内也更新基线，只不动作
                    if (bridge.suppress > 0) continue;
                    var want = s.options[v];
                    if (curGpu !== want) {
                        bridge.syncCount++;
                        bridge.changes.push({ label: s.label, index: v });
                        if (bridge.changes.length > 64) bridge.changes.shift();
                        setOptionCore(s.label, want);
                        bridge.gpu[s.label] = want;   // 桥自己改的，下一帧别误判为外部
                    }
                }
                if (bridge.suppress > 0) bridge.suppress--;
                return bridge.ticks;
            },
            loop: function () {
                if (!bridge.running) return;
                try { bridge.tickOnce(); } catch (e) { /* 不让轮询打断动画循环 */ }
                bridge.raf = requestAnimationFrame(bridge.loop);
            },
            start: function () {
                if (bridge.running || !hasRaf) return false;
                bridge.running = true;
                bridge.raf = requestAnimationFrame(bridge.loop);
                return true;
            },
            stop: function () {
                bridge.running = false;
                if (bridge.raf && hasRaf) cancelAnimationFrame(bridge.raf);
                bridge.raf = 0;
                return true;
            },
        };

        var api = {
            /** 本模型自动识别出的互斥选择器（含当前选项，风格类似 CountVariables/GetVariableLabelAt） */
            getSelectors: function () {
                var state = (gl.getState && gl.getState()) || {};
                return listOf(gl).map(function (s) {
                    var cur = state[s.label] != null ? state[s.label] : s.options[0];
                    return {
                        label: s.label,
                        options: s.options.slice(),
                        option: cur,
                        index: s.options.indexOf(cur),
                    };
                });
            },
            countSelectors: function () { return listOf(gl).length; },
            getSelectorLabelAt: function (i) {
                var l = listOf(gl); return (l[i] && l[i].label) || null;
            },
            getSelectorOptions: function (label) {
                var s = find(listOf(gl), label);
                return s ? s.options.slice() : [];
            },
            getSelector: function (label) {
                var s = find(listOf(gl), label);
                if (!s) return null;
                var st = (gl.getState && gl.getState()) || {};
                return st[s.label] != null ? st[s.label] : s.options[0];
            },
            getSelectorIndex: function (label) {
                var s = find(listOf(gl), label);
                if (!s) return -1;
                return s.options.indexOf(api.getSelector(s.label));
            },

            /** 核心：像 setVariable 一样设置互斥选择器；返回实际生效的选项名 */
            setSelector: function (label, option, ms, easing) {
                var list = listOf(gl);
                var s = find(list, label);
                if (!s) {
                    throw new Error('[SelectorAPI] 未知互斥选择器 ' + JSON.stringify(label)
                        + '（本模型可选：' + (list.map(function (x) { return x.label; }).join(' / ') || '无')
                        + '；没有互斥组时请直接用原生 setVariable 控制 3.9.8 部位）');
                }
                var opt = resolveOption(s, option);
                setOptionCore(s.label, opt);    // 同步、幂等；首帧前调用也会在上传时生效
                var idx = s.options.indexOf(opt);
                // 让 3.9.8 的原生数值与 GPU 状态一致：时间线桥才不会把手动选择拉回。
                // 写的是 selector 索引变量（不是 fade_* 底层变量），实测不会叠影。
                try { nativeSet.call(player, s.label, idx, 0, 0); } catch (e) { /* 原生不认识就忽略 */ }
                bridge.noteManual(s.label, idx);
                // ms / easing 仅为对齐 setVariable 的调用签名保留：
                // 3.9.8 没有互斥选项的过渡动画，切换是即时生效的。
                return opt;
            },

            /** setVariable 代理：选择器名 → GPU 互斥选项；其它变量原样交给 3.9.8 */
            setVariable: function (label, value, ms, easing) {
                var s = find(listOf(gl), label);
                if (!s) return nativeSet.call(player, label, value, ms, easing);
                // 字符串 / 合法索引才拦截；0..100 这类原生 fade 数值保持旧语义，
                // 避免动作配置里的数值变量被误当成选项索引。
                if (typeof value === 'string') return api.setSelector(label, value, ms, easing);
                if (typeof value === 'number' && Number.isInteger(value)
                    && value >= 0 && value < s.options.length) {
                    return api.setSelector(label, value, ms, easing);
                }
                console.warn('[SelectorAPI] ' + label + ' 是互斥选择器；'
                    + 'setVariable 传入 ' + JSON.stringify(value)
                    + ' 不是选项名或索引，已按 3.9.8 原生变量处理。'
                    + '请用 setSelector("' + label + '", 选项名) 或索引 0..'
                    + (s.options.length - 1) + ' 来切换。');
                return nativeSet.call(player, label, value, ms, easing);
            },

            /** getVariable 代理：选择器名 → 当前选项索引（数值，对齐 GetVariable(float)） */
            getVariable: function (label) {
                if (find(listOf(gl), label)) return api.getSelectorIndex(label);
                return nativeGet.call(player, label);
            },

            /** 手动跑一次「时间线 → GPU 状态」同步（无 rAF 的环境 / 测试用） */
            syncSelectorsNow: function () { return bridge.tickOnce(); },
            enableTimelineBridge: function () { return bridge.start(); },
            disableTimelineBridge: function () { return bridge.stop(); },
            isTimelineBridgeEnabled: function () { return bridge.running; },
            timelineBridgeInfo: function () {
                return {
                    enabled: bridge.running, supported: hasRaf,
                    ticks: bridge.ticks, syncCount: bridge.syncCount, suppress: bridge.suppress,
                    changes: bridge.changes.slice(-16),
                };
            },

            refresh: function () { return api; },   // 换模型后配置由 gl 动态提供，无需重建

            /** 卸载，恢复 3.9.8 原生方法 */
            uninstall: function () {
                bridge.stop();
                if (ownSet) player.setVariable = nativeSet; else delete player.setVariable;
                if (ownGet) player.getVariable = nativeGet; else delete player.getVariable;
                ['setSelector', 'getSelector', 'getSelectorIndex', 'countSelectors',
                 'getSelectorLabelAt', 'getSelectorOptions', 'getSelectors',
                 'syncSelectorsNow', 'enableTimelineBridge', 'disableTimelineBridge',
                 'isTimelineBridgeEnabled', 'timelineBridgeInfo',
                 '__emoteSelector'].forEach(function (k) { delete player[k]; });
                if (typeof window !== 'undefined') {
                    delete window.EmoteSelector;
                    delete window.setSelector;
                    delete window.getSelector;
                }
                return true;
            },
        };

        // 只在实例上包一层，遮蔽原型方法；SDK 内部直接调 EmotePlayer_SetVariable，不受影响
        ['setSelector', 'getSelector', 'getSelectorIndex', 'countSelectors',
         'getSelectorLabelAt', 'getSelectorOptions', 'getSelectors',
         'syncSelectorsNow', 'enableTimelineBridge', 'disableTimelineBridge',
         'isTimelineBridgeEnabled', 'timelineBridgeInfo'].forEach(function (name) {
            player[name] = api[name];
        });
        player.setVariable = api.setVariable;
        player.getVariable = api.getVariable;
        Object.defineProperty(player, '__emoteSelector', {
            value: api, enumerable: false, writable: true, configurable: true,
        });

        // 控制台短别名（main.js 里的 setOption / getSelectors 不受影响）
        if (typeof window !== 'undefined') {
            window.EmoteSelector = api;
            window.setSelector = api.setSelector;
            window.getSelector = api.getSelector;
        }
        bridge.start();     // 浏览器里自动开跑；Node / 单测无 rAF 时由 syncSelectorsNow() 驱动
        return api;
    }

    return { install: install, resolveOption: resolveOption, version: 1 };
})();

// ============================================================
//  ④ ModelLoader：下载 / 解压 / 算配置 / 交给 SDK
// ============================================================
const ModelLoader = {
    /** ZIP 格式检测（本地文件头 0x04034B50） */
    _isZipBuffer(buf) {
        if (!buf || buf.byteLength < 4) return false;
        const h = new Uint8Array(buf, 0, 4);
        return h[0] === 0x50 && h[1] === 0x4B && h[2] === 0x03 && h[3] === 0x04;
    },

    /** 从 ZIP 提取首个 .psb / .psb.m */
    _extractPsbFromZip(buf) {
        const fflateLib = typeof fflate !== 'undefined' ? fflate
            : (typeof window !== 'undefined' ? window.fflate : null);
        if (!fflateLib) throw new Error('[ModelLoader] fflate 未加载！请先引入 fflate.js');

        const files = fflateLib.unzipSync(new Uint8Array(buf));
        const psbKey = Object.keys(files).find((k) => /\.psb(\.m)?$/i.test(k));
        if (!psbKey) throw new Error('[ModelLoader] zip 中未找到 .psb / .psb.m');

        const file = files[psbKey];
        return new Uint8Array(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    },

    _fetchArrayBuffer(url) {
        return fetch(url).then((res) => {
            if (!res.ok) throw new Error(`[ModelLoader] 模型下载失败: ${url} (HTTP ${res.status})`);
            return res.arrayBuffer();
        });
    },

    /**
     * 下载并解压模型，得到交给 SDK 的原始 PSB 字节
     * @returns {Promise<Uint8Array>}
     */
    fetchPsbData(url) {
        if (!url) return Promise.reject(new Error('[ModelLoader] 必须提供 url'));
        return this._fetchArrayBuffer(url).then((buf) => {
            return this._isZipBuffer(buf) ? this._extractPsbFromZip(buf) : new Uint8Array(buf);
        });
    },

    // ---- 手臂姿势：委托 gl-arm-pose.js -------------------------

    _rawPsb: null,      // 交给 SDK 的那一份原始字节（仅引用，不做副本）
    _player: null,
    _armPose: null,     // 单套手臂模型为 null
    _poseConfigSource: null,
    _inventory: null,   // 侧面板用：全部差分 + 部件清单（惰性生成）

    getArmPose() {
        if (!this._armPose) return null;
        const gl = typeof window !== 'undefined' ? window.ArmPoseGL : null;
        return (gl && gl.getPose()) || this._armPose;
    },

    _requireGL() {
        const gl = typeof window !== 'undefined' ? window.ArmPoseGL : null;
        if (!gl || !gl.supported) {
            throw new Error('[ModelLoader] gl-arm-pose.js 未加载或当前环境无 WebGL');
        }
        return gl;
    },

    /** 诊断用：配置来源与解析耗时 */
    getPoseConfigInfo() {
        return this._poseConfigSource ? Object.assign({}, this._poseConfigSource) : null;
    },

    /**
     * 侧面板用：模型「全部」差分选择器 + 部件清单。
     * 惰性解析（只在面板首次打开时读一次结构区，约 10 ms），结果缓存。
     * 每组 selector 会标注 gpu：true 表示由 gl-arm-pose.js 接管（用 setSelector），
     * false 表示是 3.9.8 原生认识的 fade 差分（用 setVariable 写 on/off 值）。
     */
    getModelInventory() {
        if (this._inventory) return this._inventory;
        if (!this._rawPsb) return null;
        const t0 = performance.now();
        let root;
        try { root = PsbReader.parse(this._rawPsb).root; }
        catch (e) {
            console.warn('[ModelLoader] 部件清单跳过：' + (e && e.message ? e.message : e));
            return null;
        }
        const inv = ArmPoseConfig.inventory(root);
        const gpu = {};
        (this.getSelectorInfo() || []).forEach(function (s) { gpu[s.label] = true; });
        inv.selectors.forEach(function (s) {
            s.gpu = !!gpu[s.label];
        });
        inv.model = this._poseConfigSource ? this._poseConfigSource.model : null;
        inv.parseMs = Math.round((performance.now() - t0) * 10) / 10;
        this._inventory = inv;
        console.info('[ModelLoader] 部件清单: ' + inv.partCount + ' 个部件 / '
            + inv.selectorCount + ' 组差分（GPU 接管 '
            + Object.keys(gpu).length + ' 组）| 结构解析 ' + inv.parseMs + ' ms');
        return inv;
    },

    /**
     * 从同一份 PSB 字节里现场算出姿势配置。
     * 只读结构区（约 1 MB），不复制 200 MB 贴图；耗时约十几毫秒。
     * 模型没有互斥手臂组时返回 null，由 attach() 走「无需补丁」降级路径。
     */
    _buildPoseConfig(psb, name) {
        const t0 = performance.now();
        let parsed, cfg, t1, t2;
        try {
            parsed = PsbReader.parse(psb);          // 结构解析目前只认 PSB v4
            t1 = performance.now();
            cfg = ArmPoseConfig.build(parsed.root, name);
            t2 = performance.now();
        } catch (e) {
            // 结构区读不懂（例如老版 PSB v3）不代表模型不能显示：解析结果只用于
            // 手臂姿势补丁，这里降级为「不补丁」，原始字节照样交给 SDK loadData，
            // 由 wasm 自己决定支不支持这个版本；差分清单同步降级为空。
            const reason = 'PSB 结构无法解析（' + (e && e.message ? e.message : e)
                + '），跳过手臂姿势补丁';
            this._poseConfigSource = { source: 'none', model: name, reason: reason,
                                       structBytes: 0, names: 0, strings: 0 };
            console.warn('[ModelLoader] ' + name + ': ' + reason);
            return null;
        }

        const common = {
            model: name,
            structBytes: parsed.header.offsetChunkData,
            names: parsed.nameCount,
            strings: parsed.stringCount,
            parseMs: Math.round((t1 - t0) * 10) / 10,
            buildMs: Math.round((t2 - t1) * 10) / 10,
        };

        if (!cfg.poses || !Object.keys(cfg.poses).length) {
            const reason = '模型没有互斥手臂选择器（本来只有一套手臂），无需纹理补丁';
            this._poseConfigSource = Object.assign({ source: 'none', reason: reason }, common);
            console.info(`[ModelLoader] ${name}: ${reason} | `
                + `结构区 ${common.structBytes} B | 解析 ${common.parseMs} ms + 归组 ${common.buildMs} ms`);
            return null;
        }

        this._poseConfigSource = Object.assign({ source: 'psb-bytes' }, common);
        console.info(`[ModelLoader] 手臂配置由模型字节直接算出: ${name} | `
            + `结构区 ${common.structBytes} B | `
            + `PSB 解析 ${common.parseMs} ms + 归组 ${common.buildMs} ms | `
            + `atlas ${cfg.texCount} 张 / ${Object.keys(cfg.atlases).length} 种高度 / `
            + `互斥选择器 ${cfg.selectors.map(function (s) {
                return s.label + '(' + s.options.length + '选项)';
            }).join(', ')} / ${Object.keys(cfg.groups).length} 组矩形`);
        return cfg;
    },

    _normalizePose(pose) {
        const poses = this._requireGL().getPoses();
        if (!poses.includes(pose)) {
            throw new Error(`[ModelLoader] 未知手臂姿势: ${pose}（可选 ${poses.join(' / ')}）`);
        }
        return pose;
    },

    /**
     * 首次加载：抓取原始完整模型 → 从同一份字节算配置 → 注入 hook → 交给 SDK。
     * 顺序很重要 —— configure + setPose 必须在 loadData 之前，这样 texImage2D
     * 一上传 atlas 就会就地贴补丁，首帧不会闪出多余手臂。
     * 无互斥手臂组的模型会跳过补丁，正常显示（返回 null）。
     * @returns {Promise<string|null>} 实际生效的姿势
     */
    async attach(player, url, pose = 'crossed') {
        if (!player) throw new Error('[ModelLoader] attach 需要 player 实例');
        const gl = this._requireGL();
        const name = url.split('/').pop().split('?')[0];

        const psb = await this.fetchPsbData(url);       // ① 唯一的输入：模型 zip
        this._rawPsb = psb;
        this._player = player;
        this._inventory = null;                         // 换模型时让部件清单失效

        // ② 给 player 装上「选择器变量」兼容 API（无论本模型有没有互斥组）
        //    setSelector / getSelector / setVariable / getVariable 代理
        SelectorAPI.install(player, gl);

        const cfg = this._buildPoseConfig(psb, name);    // ③ 同一份字节里读结构区

        if (!cfg) {                                      // ④ 单套手臂：无需补丁
            gl.disable(this._poseConfigSource.reason);
            player.loadData([psb]);
            this._armPose = null;
            return null;
        }

        gl.configure(cfg);                              // ⑤ 注入配置
        var available = gl.getPoses();
        if (available.indexOf(pose) < 0) {              // ⑥ 默认姿势按模型自适应
            var fallback = available[0];
            console.warn('[ModelLoader] 默认姿势 ' + JSON.stringify(pose)
                + ' 不在当前模型姿势集合，自动改用 ' + JSON.stringify(fallback));
            pose = fallback;
        }
        pose = this._normalizePose(pose);

        gl.setPose(pose);                               // ⑦ 定目标（此时还没有纹理记录）
        player.loadData([psb]);                         // ⑧ 原始未补丁模型，上传时自动贴补丁
        const result = gl.setPose(pose);                // ⑨ 幂等兜底
        this._armPose = pose;

        if (!result.ready) {
            console.warn('[ModelLoader] 部分 atlas 尚未捕获，姿势可能不完整:', result);
        }
        return pose;
    },

    /**
     * 运行时切换姿势：只在 GPU 纹理上重写互斥组矩形，
     * 不调 loadData、不重建模型实例，动画 / 物理 / 时间线保持连续。
     * @returns {Promise<string>}
     */
    async setArmPose(pose) {
        if (!this._armPose) {
            throw new Error('[ModelLoader] 当前模型没有互斥手臂组，无法切换姿势');
        }
        pose = this._normalizePose(pose);
        const gl = this._requireGL();
        if (!gl.isReady()) {
            throw new Error('[ModelLoader] 模型贴图尚未就绪，请等 attach() 完成后再切换');
        }
        gl.setPose(pose);
        this._armPose = pose;
        return pose;
    },

    /** 通用 API：本模型自动识别出的互斥选择器（[{label, options}]） */
    getSelectorInfo() {
        const gl = typeof window !== 'undefined' ? window.ArmPoseGL : null;
        return gl && gl.getSelectors ? gl.getSelectors() : [];
    },

    /** 切换面板用：[{name, label}]，完全由模型自身的选项决定 */
    getPoseList() {
        const gl = typeof window !== 'undefined' ? window.ArmPoseGL : null;
        return gl && gl.getPoseList ? gl.getPoseList() : [];
    },

    /** 通用 API：直接给任意互斥选择器指定当前选项。
        优先走 SelectorAPI.setSelector —— 它会回写原生索引变量并重对齐时间线桥
        的基线。否则面板按钮只改 GPU 状态、原生 arm_type 停留在上一次的值，
        接着播放「腕切替AC / CA」这类过渡时间线时可能不产生值变化，
        桥就无从同步（实测过：AC 停在 A、CA 才动）。 */
    async setOption(selector, option) {
        if (!this._armPose) {
            throw new Error('[ModelLoader] 当前模型没有互斥追加部件组，无法切换选项');
        }
        const gl = this._requireGL();
        if (!gl.isReady()) {
            throw new Error('[ModelLoader] 模型贴图尚未就绪，请等 attach() 完成后再切换');
        }
        const player = this._player;
        let result;
        if (player && typeof player.setSelector === 'function') {
            const opt = player.setSelector(selector, option);
            result = { pose: gl.getPose(), option: opt, state: gl.getState(),
                atlases: 0, ms: 0, ready: gl.isReady() };
        } else {
            result = gl.setOption(selector, option);
        }
        const p = gl.getPose();
        if (p) this._armPose = p;
        return result;
    },

    /** 一站式兼容旧用法（不注入姿势配置，仅供不需要切换的调用方） */
    load(opts) {
        return new Promise((resolve, reject) => {
            try {
                if (!opts || !opts.canvas) throw new Error('[ModelLoader] 必须提供 canvas');
                if (!opts.url) throw new Error('[ModelLoader] 必须提供 url');
                if (typeof EmotePlayer === 'undefined') {
                    throw new Error('[ModelLoader] EmotePlayer 未加载！请先引入 emoteplayer.js');
                }

                const w = opts.width || 1280;
                const h = opts.height || 720;
                if (typeof EmotePlayer.createRenderCanvas === 'function') {
                    EmotePlayer.createRenderCanvas(w, h);
                }

                const player = new EmotePlayer(opts.canvas);
                if (typeof opts.scale === 'number') player.scale = opts.scale;

                this.fetchPsbData(opts.url)
                    .then((psbData) => { player.loadData([psbData]); resolve(player); })
                    .catch((err) => reject(err));
            } catch (e) { reject(e); }
        });
    },
};

if (typeof window !== 'undefined') {
    window.ModelLoader = ModelLoader;
    window.SelectorAPI = SelectorAPI;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ModelLoader: ModelLoader, PsbReader: PsbReader,
        ArmPoseConfig: ArmPoseConfig, SelectorAPI: SelectorAPI,
    };
}
