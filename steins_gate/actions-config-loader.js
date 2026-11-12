// ============================================================
//  actions-config-loader.js —— 动作配置目录（镜像 data/）
//
//  data/<角色>/<模型>.psb.m.pure.zip
//      ↓ 去掉打包后缀（与 scene-ui.js 的 stripModelExt 同源）
//  actions-config/<角色>/<模型>.json      ← 专属配置（可缺省）
//  actions-config/common.json            ← 公共 base
//
//  两条来源按优先级：own（专属，与 common 稀疏合并）> common（通用兜底）
//  「有没有专属配置」先查 actions-config/ 的 HTTP 目录索引（与 scene-ui.js 的
//  模型/背景自动发现同源）：先判断再读取，不拿 HTTP 404 当缺省信号，
//  所以正常路径根本不会发出会失败的请求。服务器不返回目录索引时才退回
//  fetch 探测，保证任意静态托管下功能不变。
//  配置在 resolveModelUrl() 之后与模型并行 fetch；
//  引用校验必须等 ModelLoader.attach() 之后才有 player 的真实清单，
//  所以 reconcile() 在 attach 的 .then() 里、new InteractionManager 之前调用。
// ============================================================
(function (root) {
    'use strict';

    var CONFIG_ROOT = '../actions-config/';

    // 与 scene-ui.js:44 的 RAW_PSB_EXT 完全同源；两处必须同步修改。
    var RAW_PSB_EXT = /\.(?:psb\.m\.pure\.psb|psb\.m\.pure|psb\.m\.psb|pure\.psb|psb\.m|psb|pure)$/i;

    /** 去掉打包后缀，得到「造型词」。优先复用 scene-ui.js 暴露的唯一实现。 */
    function stripModelExt(name) {
        var fn = root.SGStripModelExt;
        if (typeof fn === 'function') return fn(name);
        return String(name).replace(/\.zip$/i, '').replace(RAW_PSB_EXT, '');
    }

    function decodeSafe(s) {
        try { return decodeURIComponent(s); } catch (_) { return s; }
    }

    /** 日志用：把 %E7%89%A7… 还原成中文；按 / 分段解码，保留路径分隔语义 */
    function showPath(url) {
        return String(url).split('/').map(decodeSafe).join('/');
    }

    /** 从 modelUrl 推导专属配置路径；不依赖任何目录索引。 */
    function configPath(modelUrl) {
        var clean = String(modelUrl || '').split('?')[0].split('#')[0];
        var parts = clean.split('/').filter(Boolean).map(decodeSafe);
        var i = parts.lastIndexOf('data');
        var rest = i >= 0 ? parts.slice(i + 1) : parts.slice(-2);
        var file = rest.pop() || '';
        var folder = rest.join('/');
        var stem = stripModelExt(file);
        var segs = [];
        if (folder) segs.push(folder);
        segs.push(stem + '.json');
        var ownUrl = CONFIG_ROOT + segs.map(encodeURIComponent).join('/');
        return {
            folder: folder, file: file, stem: stem,
            ownUrl: ownUrl, commonUrl: CONFIG_ROOT + 'common.json'
        };
    }

    async function fetchJson(url) {
        try {
            var r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) return null;          // 仅降级路径会走到：服务器不给目录索引时
            return await r.json();
        } catch (_) { return null; }         // file:// / 断网 / 无目录权限
    }

    async function fetchText(url) {
        try {
            var r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) return null;
            return await r.text();
        } catch (_) { return null; }
    }

    /** 解析 HTTP 目录索引里的 <a href>；names=文件、dirs=子目录，均为解码后的名字。 */
    function parseDirListing(html) {
        if (typeof html !== 'string' || html.indexOf('href') < 0) return null;
        var names = [], dirs = [];
        var re = /href\s*=\s*["']([^"']+)["']/gi, m;
        while ((m = re.exec(html)) !== null) {
            var raw = m[1].split('?')[0].split('#')[0];
            if (!raw || raw === '../' || raw === './' || raw.charAt(0) === '/') continue;
            var isDir = /\/$/.test(raw);
            var name = decodeSafe(raw.replace(/\/$/, ''));
            if (!name) continue;
            (isDir ? dirs : names).push(name);
        }
        return { names: names, dirs: dirs };
    }

    /**
     * 先判断专属配置是否存在，再决定要不要发请求。
     * 返回 true / false；返回 null = 服务器不支持目录索引，交给调用方退回 fetch 探测。
     * 根目录本身一定存在（common.json 就在里面），因此正常路径不会产生 404。
     */
    async function probeOwn(p) {
        var root = parseDirListing(await fetchText(CONFIG_ROOT));
        // 用 common.json 当特征锚，避免把「任意路径都返回同一个 index.html」误当目录索引
        if (!root || root.names.indexOf('common.json') < 0) return null;
        if (!p.folder) return root.names.indexOf(p.stem + '.json') >= 0;
        if (p.folder.indexOf('/') >= 0 || p.folder.indexOf('\\') >= 0) return null;
        // 兼容目录项带尾斜杠（dirs）与不带（某些服务器列进 names）两种写法
        if (root.dirs.indexOf(p.folder) < 0 && root.names.indexOf(p.folder) < 0) {
            return false;   // 角色文件夹都没有，不必再问
        }

        var subUrl = CONFIG_ROOT + p.folder.split('/').map(encodeURIComponent).join('/') + '/';
        var sub = parseDirListing(await fetchText(subUrl));
        if (!sub) return null;
        return sub.names.indexOf(p.stem + '.json') >= 0;
    }

    // 只用于文档 / 继承定位，不进入生效配置；命名统一不带下划线。
    var META_KEYS = { doc: 1, extends: 1, model: 1 };

    /** 稀疏继承：对象递归合并，数组整体替换（pool / variables 不该拼接）。 */
    function mergeSparse(base, own) {
        if (!own || typeof own !== 'object') return clone(base);
        if (!base || typeof base !== 'object') return clone(own);
        var out = {};
        Object.keys(base).forEach(function (k) {
            if (!META_KEYS[k]) out[k] = clone(base[k]);
        });
        Object.keys(own).forEach(function (k) {
            if (META_KEYS[k]) return;
            var v = own[k];
            if (v && typeof v === 'object' && !Array.isArray(v)
                && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
                out[k] = mergeSparse(out[k], v);
            } else {
                out[k] = clone(v);
            }
        });
        return out;
    }

    function clone(v) {
        if (Array.isArray(v)) return v.map(clone);
        if (v && typeof v === 'object') {
            var o = {};
            Object.keys(v).forEach(function (k) { o[k] = clone(v[k]); });
            return o;
        }
        return v;
    }

    /**
     * 并行加载公共 base 与专属配置。
     * 两者都取不到时返回 config=null / source='none'，由调用方明确报错。
     * @returns {Promise<{config:Object|null, source:String, info:Object}>}
     */
    async function load(modelUrl) {
        var p = configPath(modelUrl);
        var commonPromise = fetchJson(p.commonUrl);   // 必定存在，与目录探测并行发起
        var exists = await probeOwn(p);               // true / false / null(索引不可用)
        var ownPromise;
        if (exists === false) {
            ownPromise = Promise.resolve(null);       // 确定没有专属配置：根本不发请求
        } else {
            ownPromise = fetchJson(p.ownUrl);         // 确认存在，或降级时退回探测
        }
        var pair = await Promise.all([commonPromise, ownPromise]);
        var common = pair[0], own = pair[1];
        var base = common || null, extendsUrl = '', extendsOk = false;

        // 专属配置可显式继承同目录的另一份（例如同角色不同造型共用一套演出）。
        // 只支持一层、只允许同目录文件名：杜绝路径穿越与循环继承。
        // 主路径仍是 common + own 并行；只有声明了非默认 extends 才多一次请求。
        if (own && typeof own.extends === 'string' && own.extends !== 'common.json'
            && !/[/\\]/.test(own.extends) && own.extends !== p.stem + '.json') {
            var segs = [];
            if (p.folder) segs.push(p.folder);
            segs.push(own.extends);
            extendsUrl = CONFIG_ROOT + segs.map(encodeURIComponent).join('/');
            var ext = await fetchJson(extendsUrl);
            if (ext) { base = mergeSparse(base || {}, ext); extendsOk = true; }
            else if (root.console) {
                console.warn('[ActionsConfig] extends 指向的文件不存在，已退回 common.json：' + showPath(extendsUrl));
            }
        }

        var source, config;
        if (own && base) { config = mergeSparse(base, own); source = 'own'; }
        else if (own) { config = clone(own); source = 'own'; }
        else if (base) { config = clone(base); source = 'common'; }
        else { config = null; source = 'none'; }
        var info = {
            source: source, modelUrl: modelUrl, folder: p.folder, stem: p.stem,
            ownUrl: p.ownUrl, commonUrl: p.commonUrl,
            hasOwn: !!own, hasCommon: !!common,
            ownProbe: exists === null ? 'fetch-降级' : '目录索引', ownExists: exists,
            extendsUrl: extendsUrl, extendsOk: extendsOk
        };
        root.SGActionsConfigLoad = info;   // 供控制台 / 验收脚本查看推导路径
        if (source === 'none' && root.console) {
            console.error('[ActionsConfig] common.json 与专属配置都没读到：' + showPath(p.commonUrl));
        }
        if (root.console && console.info) {
            console.info('[ActionsConfig] 来源=' + source
                + (own ? ' | 专属 ' + p.folder + '/' + p.stem + '.json' : ' | 无专属配置')
                + ' | ' + showPath(p.ownUrl));
        }
        return { config: config, source: source, info: info };
    }

    // ---------- 词干归一化：让「表情_驚き00 / 驚きＡ / びっくり」可以互认 ----------
    function stemOf(s) {
        var n = String(s || '').normalize('NFKC').trim();
        n = n.replace(/^(?:表情|sample|差分)_/, '');
        n = n.replace(/[（(][^)）]*[)）]/g, '');
        n = n.replace(/_(?:固定|fixed|long)$/i, '');
        n = n.replace(/(?:[0-9]{1,2})?[A-Za-z]$/, '');
        n = n.replace(/[0-9]{1,2}$/, '');
        return n;
    }

    var JUNK = /(?:-----|<.*?>|^\s*---|sample_|_test|確認|全自動)/i;
    function usable(label) { return !!label && !JUNK.test(label); }

    // 精简意图词典：只用于「配置里写的名字在当前模型不存在」时兜底求解
    var INTENTS = [
        { core: ['驚き', '驚く', 'びっくり', 'きょとん', 'ガーン', '慌て', '焦り', '呆然'], alias: ['驚', 'びっくり'] },
        { core: ['困る', '困り', '悩み', '戸惑い', '不安'], alias: ['困', '悩', '戸惑'] },
        { core: ['笑う', '笑顔', '楽しい', '喜ぶ', '微笑み', 'にっこり'], alias: ['笑', '楽', '喜'] },
        { core: ['照れる', '照れ', '頬染め', 'はじらい'], alias: ['照れ', '頬染'] },
        { core: ['怒る', '怒り', '睨む', 'ぷんぷん'], alias: ['怒', '睨'] },
        { core: ['普通', '平常', '待機', '通常'], alias: ['普通', '平常', '待機'] }
    ];

    /** 把一个配置里的名字求解成当前模型真实存在的名字；无解返回 null。 */
    function solveName(name, labels) {
        if (!name) return null;
        if (labels.indexOf(name) >= 0) return name;
        var s = stemOf(name);
        var exact = labels.filter(function (l) { return usable(l) && stemOf(l) === s; });
        if (exact.length) return exact[0];
        for (var i = 0; i < INTENTS.length; i++) {
            var it = INTENTS[i];
            var hit = it.core.some(function (c) { return s.indexOf(c) >= 0 || c.indexOf(s) >= 0 && s.length > 1; });
            if (!hit) continue;
            var found = labels.filter(function (l) {
                return usable(l) && it.core.some(function (c) { return l.indexOf(c) >= 0; });
            });
            if (found.length) return found[0];
        }
        return null;
    }

    function solveNeutral(labels) {
        var preferred = ['普通', '平常', '待機', '通常', '初期化'];
        for (var i = 0; i < preferred.length; i++) {
            var hit = labels.filter(function (l) { return usable(l) && l.indexOf(preferred[i]) >= 0; });
            if (hit.length) return hit[0];
        }
        var first = labels.filter(usable);
        return first.length ? first[0] : '';
    }

    /**
     * attach 之后、InteractionManager 之前：把配置和当前模型清单对齐。
     * 直接原地修改 config（createConfig 返回的对象已被各层共享引用）。
     * @param {Function} [canPlace] (key) => 布尔，部位能否定位；
     *        不给时退回「charaProfile 里必须有同名 marker」的旧判定。
     */
    function reconcile(config, player, source, canPlace) {
        var mains = (player.mainTimelineLabels || []).slice();
        var diffs = (player.diffTimelineLabels || []).slice();
        var vars = (player.variableList || []).map(function (v) {
            return (v && typeof v === 'object') ? (v.label || v.name || '') : String(v);
        });
        var markers = Object.keys(player.charaProfile || {});
        var report = {
            source: source, neutral: solveNeutral(mains),
            resolvedTimelines: {}, removedParts: [], removedVariables: [],
            clearedDiffs: [], clearedAudio: 0, warnings: []
        };

        // ---- defaultState ----
        var def = config.defaultState || (config.defaultState = {});
        if (def.timeline && mains.indexOf(def.timeline) < 0) {
            var solved = solveName(def.timeline, mains);
            if (solved) {
                report.resolvedTimelines['defaultState: ' + def.timeline] = solved;
                def.timeline = solved;
            } else {
                report.warnings.push('defaultState.timeline "' + def.timeline + '" 不存在，改用 ' + report.neutral);
                def.timeline = report.neutral;
            }
        } else if (!def.timeline) {
            def.timeline = report.neutral;
        }
        ['diffSlot1', 'diffSlot2'].forEach(function (k) {
            if (def[k] && diffs.indexOf(def[k]) < 0) { report.clearedDiffs.push('defaultState.' + k + ': ' + def[k]); def[k] = ''; }
        });
        if (Array.isArray(def.variables)) {
            var before = def.variables.length;
            def.variables = def.variables.filter(function (v) { return v && vars.indexOf(v.name) >= 0; });
            if (before !== def.variables.length) {
                report.removedVariables.push('defaultState.variables: ' + (before - def.variables.length) + ' 项');
            }
        }

        // ---- reactions ----
        var reactions = config.reactions || {};
        var placeable = typeof canPlace === 'function' ? canPlace : null;
        Object.keys(reactions).forEach(function (key) {
            var part = reactions[key];
            // marker 名对不上不再等于「点不到」：矩形锚点、上下界比例都能定位，
            // 交给调用方的 canPlace 判断（不给则沿用旧判定）
            var ok = placeable ? !!placeable(key) : markers.indexOf(key) >= 0;
            if (!ok) {
                delete reactions[key];
                report.removedParts.push(key + '（无锚点且无法推导）');
                return;
            }
            if (!part || !Array.isArray(part.pool)) return;
            part.pool = part.pool.map(function (action) {
                var a = clone(action);
                if (a.timeline && mains.indexOf(a.timeline) < 0) {
                    var solved = solveName(a.timeline, mains);
                    if (solved) {
                        report.resolvedTimelines[key + ': ' + a.timeline] = solved;
                        a.timeline = solved;
                    } else {
                        report.warnings.push(key + ' 的时间线 "' + a.timeline + '" 无解，已移除（变量仍生效）');
                        delete a.timeline;
                    }
                }
                ['diffSlot1', 'diffSlot2'].forEach(function (k) {
                    if (a[k] && diffs.indexOf(a[k]) < 0) {
                        report.clearedDiffs.push(key + '.' + k + ': ' + a[k]);
                        a[k] = '';
                    }
                });
                if (Array.isArray(a.variables)) {
                    a.variables = a.variables.filter(function (v) { return v && vars.indexOf(v.name) >= 0; });
                }
                if (Array.isArray(a.recovery)) {
                    a.recovery = a.recovery.filter(function (v) {
                        return v && (String(v.name).indexOf('__') === 0 || vars.indexOf(v.name) >= 0);
                    });
                }
                // 语音只认专属配置，避免通用兜底串到别的角色台词
                if (source !== 'own' && a.audio) { delete a.audio; report.clearedAudio++; }
                return a;
            });
            if (!part.pool.length) {
                delete reactions[key];
                report.removedParts.push(key + '（动作池为空）');
            }
        });

        // 生效摘要：既能给控制台排查，也能让验收脚本 / 侧边栏直接读取
        report.defaultTimeline = def.timeline;
        report.effectiveParts = Object.keys(reactions).map(function (key) {
            var part = reactions[key] || {};
            var pool = part.pool || [];
            return {
                key: key, radius: part.radius, pool: pool.length,
                audio: pool.filter(function (a) { return !!a.audio; }).length,
                timelines: pool.map(function (a) { return a.timeline || null; })
            };
        });
        root.SGConfigInfo = report;
        if (root.console) {
            console.info('[ActionsConfig] 库存对齐完成：neutral=' + (report.neutral || '(无)')
                + '，部位 ' + Object.keys(reactions).length + ' 个'
                + '，求解 ' + Object.keys(report.resolvedTimelines).length + ' 个时间线'
                + '，剔除部位 ' + report.removedParts.length + ' 个');
            report.warnings.forEach(function (w) { console.warn('[ActionsConfig] ' + w); });
            if (report.removedParts.length) {
                console.warn('[ActionsConfig] 剔除部位：' + report.removedParts.join(' / '));
            }
        }
        return report;
    }

    var api = {
        CONFIG_ROOT: CONFIG_ROOT,
        stripModelExt: stripModelExt,
        configPath: configPath,
        mergeSparse: mergeSparse,
        stemOf: stemOf,
        solveName: solveName,
        solveNeutral: solveNeutral,
        load: load,
        reconcile: reconcile
    };
    root.SGActionsConfig = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
