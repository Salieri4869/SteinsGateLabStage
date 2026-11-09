// ============================================================
//  动作配置 —— 基于牧瀬紅莉栖ab_白衣.psb.m.json
//
//  reactions: { 部位key(marker名) → { radius, pool[] } }
//    · 部位 key = charaProfile 字典的 key（eye/mouth/bust/top…）
//    · radius  : 占画布高度的比例（0.03~0.15），运行时自动换算像素
//    · pool[]  : 动作数组，命中后随机抽取一条执行
//
//  单条动作字段：
//    timeline / diffSlot1 / diffSlot2  — 时间线 & 差分槽
//    audio                              — 音频路径（可选）
//    duration                           — 保持时长 ms（与音频时长取 max）
//    variables[]                        — { name, value, duration } 对齐 readme setVariable(label, value, ms)
//    recovery[]                         — 特例复位变量（覆盖 defaultState，可选）
//
//  恢复优先级：动作级 recovery > defaultState 全局兜底
// ============================================================
const ACTIONS_CONFIG = {
    debug: true,

    reactions: {
        // ----- 眼睛 -----
        eye: {
            radius: 0.06,
            pool: [
                {
                    timeline: '表情_驚き00',
                    diffSlot1: '悩み',
                    diffSlot2: '悩み',
                    audio: '../sounds/krs/resg10_10k_krs0046.xwma.opus',
                    variables: [
                        { name: 'face_eye_open_l', value: 30, duration: 500 },
                        { name: 'face_eye_open_r', value: 30, duration: 500 },
                        { name: 'face_eye_LR', value: -30, duration: 400 },
                        { name: 'face_eye_UD', value: 10, duration: 350 },
                        { name: 'body_LR', value: 30, duration: 350 },
                        { name: 'face_eye_hi', value: 0, duration: 200 },
                    ],
                    duration: 1200,
                    recovery: [
                        { name: 'face_eye_open_l', value: 20, duration: 300 },
                        { name: 'face_eye_open_r', value: 20, duration: 300 },
                    ],
                },
                {
                    timeline: '表情_困る00',
                    diffSlot1: 'ひく',
                    diffSlot2: 'ひく_固定',
                    audio: '../sounds/krs/resg01_13_krs0040.xwma.opus',
                    variables: [
                        { name: 'face_eyebrow', value: 10, duration: 800 },
                    ],
                    duration: 2800,
                },
            ],
        },

        // ----- 嘴巴 -----
        mouth: {
            radius: 0.04,
            pool: [
                {
                    timeline: '表情_笑う',
                    diffSlot1: 'ひく',
                    diffSlot2: '表情_照れる',
                    audio: '../sounds/krs/resg10_10k_krs0054.xwma.opus',
                    variables: [
                        { name: 'face_mouth', value: 30, duration: 500 },
                        { name: 'face_eye_open_l', value: 5, duration: 30 },
                        { name: 'face_eye_open_r', value: 5, duration: 30 },
                        { name: 'face_eye_hi', value: 10, duration: 300 },
                        { name: 'face_eye_LR', value: 10, duration: 350 },
                        { name: 'face_eye_UD', value: 10, duration: 350 },
                        { name: 'face_eyebrow_sp', value: 10, duration: 700 },
                    ],
                    duration: 6200,
                },
            ],
        },

        // ----- 胸部 -----
        bust: {
            radius: 0.10,
            pool: [
                {
                    timeline: '表情_照れる',
                    diffSlot1: 'ぶりっこ',
                    diffSlot2: '',
                    audio: '../sounds/krs/resg10_11k_krs0000.xwma.opus',
                    variables: [
                        { name: 'face_cheek', value: 1, duration: 250 },
                        { name: 'head_slant', value: 2, duration: 400 },
                        { name: 'head_UD', value: 2, duration: 380 },
                        { name: 'head_LR', value: 2, duration: 390 },
                        { name: 'body_slant', value: 2, duration: 420 },
                        { name: 'face_eye_sp', value: 10, duration: 350 },
                        { name: 'face_hitomi_sp', value: 10, duration: 360 },
                        { name: 'face_eyebrow', value: 10, duration: 370 },
                        { name: 'face_mouth', value: 10, duration: 340 },
                    ],
                    duration: 1500,
                },
            ],
        },

        // ----- 头顶 -----
        top: {
            radius: 0.07,
            pool: [
                {
                    timeline: '表情_頬染め01n',
                    diffSlot1: 'いやいや',
                    diffSlot2: '戸惑い',
                    audio: '../sounds/krs/resg11_08_krs0010.xwma.opus',
                    variables: [
                        { name: 'head_LR', value: 15, duration: 400 },
                        { name: 'head_UD', value: -10, duration: 430 },
                        { name: 'head_slant', value: 30, duration: 550 },
                        { name: 'face_talk', value: 3, duration: 0 },
                    ],
                    duration: 1200,
                },
            ],
        },
    },

    // 全局复位兜底：覆盖所有动作变量（未被 recovery 声明的走这里）
    // 手臂姿势由修复版模型资源决定，不再通过 arm_type 变量切换。
    defaultState: {
        timeline: '表情_普通',
        diffSlot1: '',
        diffSlot2: '',
        variables: [
            { name: 'face_eye_open_l', value: 0, duration: 240 },
            { name: 'face_eye_open_r', value: 0, duration: 230 },
            { name: 'face_eye_LR', value: 0, duration: 220 },
            { name: 'face_eye_UD', value: 0, duration: 220 },
            { name: 'face_eye_hi', value: 0, duration: 210 },
            { name: 'face_eye_sp', value: 0, duration: 240 },
            { name: 'face_mouth', value: 0, duration: 320 },
            { name: 'face_talk', value: 0, duration: 0 },
            { name: 'face_eyebrow_sp', value: 0, duration: 310 },
            { name: 'face_eyebrow', value: 0, duration: 300 },
            { name: 'face_tears', value: 0, duration: 290 },
            { name: 'face_cheek', value: 0, duration: 255 },
            { name: 'face_hitomi_sp', value: 0, duration: 245 },
            { name: 'head_LR', value: 0, duration: 270 },
            { name: 'head_UD', value: 0, duration: 265 },
            { name: 'head_slant', value: 0, duration: 275 },
            { name: 'body_slant', value: 0, duration: 285 },
            { name: 'body_LR', value: 0, duration: 295 },
            { name: 'body_UD', value: 0, duration: 305 },
        ],
    },
};

if (typeof window !== 'undefined') window.ACTIONS_CONFIG = ACTIONS_CONFIG;
if (typeof module !== 'undefined' && module.exports) module.exports = { ACTIONS_CONFIG };
