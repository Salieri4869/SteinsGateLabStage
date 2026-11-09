// ============================================================
//  emote-config.js —— E-mote 全局配置（须最先加载）
//
//  1) 必须在 emotedriver.js 之前执行（TOTAL_MEMORY 是实例化期参数）
//  2) wasm 版读 window.EmoteModule，asm.js 版读 window.Module
//     → 两个都设，兼容 driver / driver_wasm 切换
//  3) onStartEmoteAnimation / onStopEmoteAnimation 兜底
// ============================================================
(function () {
    window.EmoteModule = window.EmoteModule || {};
    window.Module = window.Module || {};

    // 1GB 足够 4K/Retina；wasm 无硬上限，受浏览器约束
    const MEM = 1073741824;
    window.EmoteModule.TOTAL_MEMORY = MEM;
    window.Module.TOTAL_MEMORY = MEM;
    window.EmoteModule.ALLOW_MEMORY_GROWTH = 1;
    window.Module.ALLOW_MEMORY_GROWTH = 1;

    /** 安全转发到 emoteAnimationController（不存在时不报错） */
    function safeHook(method) {
        return (device) => {
            if (typeof emoteAnimationController !== 'undefined' && emoteAnimationController) {
                emoteAnimationController[method](device);
            }
        };
    }

    const start = safeHook('onStartEmoteAnimation');
    const stop = safeHook('onStopEmoteAnimation');

    // wasm 版：index.html 内联钩子优先，否则用兜底
    if (!window.EmoteModule.onStartEmoteAnimation) {
        window.EmoteModule.onStartEmoteAnimation = start;
        window.EmoteModule.onStopEmoteAnimation = stop;
    }
    window.Module.onStartEmoteAnimation = start;
    window.Module.onStopEmoteAnimation = stop;
})();
