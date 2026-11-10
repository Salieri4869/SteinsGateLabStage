// ============================================================
//  config-validator.js —— 动作配置校验（纯函数，环境无关）
//
//  reactions: { 部位key(=charaProfile 的 marker 名) → { radius, pool[] } }
//  radius   : 占画布高度的比例（正数），运行时换算像素
//
//  恢复机制：defaultState 兜底 + 动作级 recovery 覆盖
//  → 任何动作变量必须能被 defaultState 或本动作 recovery 覆盖
//
//  用法：
//    1) 浏览器 <script>      : window.validateActionsConfig
//    2) Node require/import  : require('./config-validator.js')
//    3) CLI 自测             : node config-validator.js
//                             （直接校验 ../actions-config/ 下的 JSON，含 extends 合并）
// ============================================================

/** 扁平化 reactions → 动作数组 */
function _flattenActions(reactions) {
    const list = [];
    if (!reactions || typeof reactions !== 'object') return list;
    Object.keys(reactions).forEach((key) => {
        const part = reactions[key];
        if (part && Array.isArray(part.pool)) {
            part.pool.forEach((action) => list.push(action));
        }
    });
    return list;
}

/** 取动作 recovery 声明的变量名集合 */
function _recoveryVarNames(action) {
    const set = new Set();
    (action && action.recovery || []).forEach((v) => {
        if (v && v.name) set.add(v.name);
    });
    return set;
}

/**
 * 校验动作配置
 * @param {Object} config
 * @returns {true} 通过返回 true，失败抛 Error
 */
function validateActionsConfig(config) {
    if (!config || typeof config !== 'object') {
        throw new Error('[validateActionsConfig] config 必须是一个对象');
    }

    const defaultVars = (config.defaultState && config.defaultState.variables) || [];
    const defaultNames = new Set(defaultVars.map((v) => v && v.name));
    const reactions = config.reactions;

    // reactions 必须是对象（按部位分组），不再兼容旧数组格式
    if (reactions != null && typeof reactions !== 'object') {
        throw new Error('[validateActionsConfig] reactions 必须是对象（按部位分组）');
    }
    if (Array.isArray(reactions)) {
        throw new Error(
            '[validateActionsConfig] reactions 不再支持数组格式，' +
            '请改用 { 部位key: { radius, pool[] } }'
        );
    }

    // 禁止显式 marker 字段（key 本身就是 marker 名）
    const hasExplicitMarker = Object.keys(reactions).some((key) =>
        reactions[key] && Object.prototype.hasOwnProperty.call(reactions[key], 'marker')
    );
    if (hasExplicitMarker) {
        throw new Error(
            '[validateActionsConfig] 部位配置中不再需要 marker 字段，' +
            '「部位 key」本身就是模型里的 marker 名称'
        );
    }

    // 虚拟部位（非真实 marker）
    const VIRTUAL_KEYS = ['eye_left', 'eye_right', 'bust_left', 'bust_right', 'belly'];

    Object.keys(reactions).forEach((key) => {
        if (VIRTUAL_KEYS.includes(key)) {
            throw new Error(`[validateActionsConfig] 部位 key "${key}" 是虚拟部位，请改用真实 marker 名`);
        }
        const part = reactions[key];
        if (!part || typeof part !== 'object') {
            throw new Error(`[validateActionsConfig] reactions.${key} 必须是对象`);
        }
        if (typeof part.radius !== 'number' || part.radius <= 0) {
            throw new Error(
                `[validateActionsConfig] reactions.${key}.radius 必须是正数 ` +
                '（占画布高度的比例，如 0.06）'
            );
        }
        if (!Array.isArray(part.pool)) {
            throw new Error(`[validateActionsConfig] reactions.${key}.pool 必须是数组`);
        }
    });

    // 每个动作的变量必须有复位来源（defaultState 或 recovery）
    const allActions = _flattenActions(reactions);
    allActions.forEach((action, idx) => {
        const covered = new Set([...defaultNames, ..._recoveryVarNames(action)]);

        (action && action.variables || []).forEach((v) => {
            if (!v || !v.name) return;
            if (!covered.has(v.name)) {
                throw new Error(
                    `[validateActionsConfig] 动作 #${idx + 1} (${action.timeline || '未命名'}) 的变量 "${v.name}" ` +
                    '既不在 defaultState 中，也不在本动作 recovery 中，无法复位'
                );
            }
        });

        (action.recovery || []).forEach((v, ri) => {
            if (!v || typeof v.name !== 'string') {
                throw new Error(`[validateActionsConfig] 动作 #${idx + 1} 的 recovery[${ri}] 缺少 name`);
            }
        });
    });

    // debug 可选，若存在必须为布尔值
    if (config.debug !== undefined && typeof config.debug !== 'boolean') {
        throw new Error('[validateActionsConfig] debug 必须为布尔值 (true / false)');
    }

    return true;
}

// ============================================================
//  CLI 自测入口：直接校验 actions-config/ 下的 JSON
// ============================================================
function _runCliSelfTest() {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', 'actions-config');
    const { mergeSparse } = require('./actions-config-loader.js');

    const readJson = (p) => {
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (e) { console.error('⚠️ 无法读取 ' + p + '：' + e.message); return null; }
    };

    const common = readJson(path.join(root, 'common.json'));
    if (!common) {
        console.error('❌ 缺少 actions-config/common.json');
        process.exitCode = 1;
        return;
    }

    // 与运行时一致：先校验公共 base，再把每份专属配置按 extends 稀疏合并后校验
    const targets = [{ label: 'common.json', config: common }];
    fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .forEach((d) => {
            const dir = path.join(root, d.name);
            fs.readdirSync(dir).filter((f) => f.endsWith('.json')).forEach((f) => {
                const own = readJson(path.join(dir, f));
                if (!own) return;
                let base = common;
                if (typeof own.extends === 'string' && own.extends !== 'common.json'
                    && !/[/\\]/.test(own.extends)) {
                    const ext = readJson(path.join(dir, own.extends));
                    if (ext) base = mergeSparse(common, ext);
                }
                targets.push({ label: d.name + '/' + f, config: mergeSparse(base, own) });
            });
        });

    let failed = 0;
    targets.forEach(({ label, config }) => {
        console.log('\n=== ' + label + ' ===');
        try {
            validateActionsConfig(config);
            console.log('✅ 校验通过');
        } catch (e) {
            console.error('❌ ' + e.message);
            failed++;
        }
        const parts = config.reactions || {};
        Object.keys(parts).forEach((key) => {
            const pool = parts[key].pool || [];
            console.log(`部位 "${key}", radius=${parts[key].radius}, 动作池条数=${pool.length}`);
            pool.forEach((action, i) => {
                const recoveryNames = _recoveryVarNames(action);
                const vars = (action.variables || []).map((v) => v.name);
                const viaRecovery = vars.filter((n) => recoveryNames.has(n));
                const viaDefault = vars.filter((n) => !recoveryNames.has(n));
                console.log(`  [${i + 1}] ${action.timeline || '(无timeline)'}`);
                console.log(`      recovery 复位 : [${viaRecovery.join(', ') || '无'}]`);
                console.log(`      defaultState 复位: [${viaDefault.join(', ') || '无'}]`);
            });
        });
    });

    if (failed) {
        console.error('\n❌ ' + failed + ' 份配置未通过');
        process.exitCode = 1;
    } else {
        console.log('\n🎉 全部校验通过（共 ' + targets.length + ' 份配置）');
    }
}

if (typeof require !== 'undefined' && require.main === module) {
    _runCliSelfTest();
}

if (typeof window !== 'undefined') window.validateActionsConfig = validateActionsConfig;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validateActionsConfig, _flattenActions };
}
