// ============================================================
//  lipsync.js —— 口型同步算法 + 音频播放
//
//  LipSync        算法类：RMS / EMA 动态阈值 / 离线分析（环境无关）
//  LipSyncPlayer  播放器：fetch → decode → 离线分析 → rAF 驱动 face_talk
//                  音频不可用时明确告警并返回 null
//  AudioPlayer    兼容旧名 = LipSyncPlayer
// ============================================================

// ============================================================
//  LipSync —— 口型同步算法（纯计算）
// ============================================================
class LipSync {
    constructor({
        meanDecayTime = 0.8,
        peakDecayTime = 0.15,
        releaseDecayTime = 0.08,
        updateFps = 30,
        activationRatio = 0.3,
    } = {}) {
        const fps = updateFps <= 0 ? 1 : updateFps;
        this.meanSmoothing = Math.exp(-1 / (meanDecayTime * fps));
        this.peakSmoothing = Math.exp(-1 / (peakDecayTime * fps));
        // 音量下降时均值的快速衰减系数，见 feedFrame
        this.meanReleaseSmoothing = Math.exp(-1 / (releaseDecayTime * fps));
        this.activationRatio = activationRatio;
        this.updateFps = fps;
        this._mean = 0.0;
        this._peak = 0.0;
    }

    /** 重置状态 */
    reset() {
        this._mean = 0.0;
        this._peak = 0.0;
    }

    /**
     * 计算单帧 RMS 振幅 → 0~1 口型张开度
     * @param {Float32Array} channelData 单声道 PCM
     */
    feedFrame(channelData) {
        if (!channelData || channelData.length === 0) return 0.0;

        let sumSq = 0;
        for (let i = 0; i < channelData.length; i++) {
            sumSq += channelData[i] * channelData[i];
        }
        const rms = Math.sqrt(sumSq / channelData.length);

        // 均值走非对称 EMA：音量上升时慢跟（把底噪挡在阈值下），下降时快跟。
        // 若两侧都用 0.8s，句尾音量骤降后慢均值仍停在先前的高响度上，
        // threshold 会一直高于当前 rms，整段尾音被压成静音（闭嘴）。
        const alpha = rms > this._mean
            ? (1 - this.meanSmoothing)
            : (1 - this.meanReleaseSmoothing);
        this._mean += (rms - this._mean) * alpha;
        this._peak = Math.max(rms, this._peak * this.peakSmoothing);

        // peak 比 mean 衰减快，下降沿可能出现 peak < mean；钳到 0 避免
        // dynamicRange 为负时 threshold 失去意义。
        const dynamicRange = Math.max(this._peak - this._mean, 0);
        const threshold = this._mean + this.activationRatio * dynamicRange;

        if (rms <= threshold || dynamicRange <= 0.001) return 0.0;

        const ratio = (rms - threshold) / (this._peak - threshold + 1e-6);
        return Math.max(0, Math.min(ratio, 1));
    }

    /**
     * 离线分析整段 AudioBuffer → 口型时间序列
     * @param {AudioBuffer} audioBuffer
     * @returns {Array<{t: number, value: number}>}
     */
    analyzeAudioBuffer(audioBuffer) {
        this.reset();
        const fps = this.updateFps;
        const samplesPerFrame = Math.floor(audioBuffer.sampleRate / fps);
        const channelData = audioBuffer.getChannelData(0);
        const totalFrames = Math.floor(channelData.length / samplesPerFrame);
        const timeline = new Array(totalFrames);

        for (let frame = 0; frame < totalFrames; frame++) {
            const start = frame * samplesPerFrame;
            const end = Math.min(start + samplesPerFrame, channelData.length);
            timeline[frame] = { t: frame / fps, value: this.feedFrame(channelData.subarray(start, end)) };
        }
        return timeline;
    }

}

// ============================================================
//  LipSyncPlayer —— 音频播放 + 口型同步
// ============================================================
class LipSyncPlayer {
    constructor(config, getPlayer) {
        this.config = config;
        this.getPlayer = getPlayer;
        this.lipsync = new LipSync(config && config.lipsync);

        this.context = null;
        this.activeSource = null;
        this.bufferCache = new Map();
        this.timeline = null;
        this.startTime = 0;
        this.rafId = null;
        this.active = false;
        this.context = null;
        this._playSeq = 0;
        this._unlockAt = 0;
        this._ctxWaiters = [];
    }

    loadAndPlay(url) {
        if (!url) return Promise.resolve(null);
        const seq = ++this._playSeq;
        return this._whenUnlocked().then((ctx) => {
            if (!ctx || seq !== this._playSeq) return null;
            return this._play(url);
        });
    }

    /* onload 自动播放被浏览器策略挂起时，首次手势只用来解锁音频、不推进剧情，
       否则刚解锁的首句会被下一句的 stop() 掐掉。
       只在解锁后极短窗口内生效，避免误吞 AUTO 定时器的下一次推进。 */
    consumeGestureUnlock() {
        if (!this._unlockAt || performance.now() - this._unlockAt > 250) return false;
        this._unlockAt = 0;
        return true;
    }

    /** 只停口型驱动，不碰音频源：时间线走完不等于音频播完 */
    _stopLipSync(fadeMs = 50) {
        this.active = false;
        if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        const player = this.getPlayer();
        if (player) player.setVariable('face_talk', 0, fadeMs);
    }

    stop() {
        this._playSeq++;
        this._stopLipSync(120);
        const source = this.activeSource;
        this.activeSource = null;
        if (source) {
            try { source.stop(); } catch (_) { /* 已自然结束 */ }
        }
    }

    // ---- AudioContext ----
    /* 为什么「总是创建」而不是按 userActivation 预判：
       浏览器对**已经授权过自动播放的站点**（localhost 常访问、Media Engagement 达标）
       直接给 running —— 刷新后也能立刻出声、且无警告；只有从未授权过的站点才会被挂起。
       预判（hasBeenActive / 导航类型）在刷新场景一律是 false，会把已授权站点也误杀，
       表现就是「不报错、但一点声音都没有」。
       因此：建了再看 state —— running 直接用；suspended 就**不主动 resume**
       （非手势栈里的 resume 同样被拒），把手势留给 _armGestureResume。 */
    _context() {
        if (!this.context) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return null;
            this.context = new Ctor();
            this._armGestureResume();
        }
        return this.context;
    }

    _whenUnlocked() {
        const ctx = this._context();
        if (ctx && ctx.state === 'running') return Promise.resolve(ctx);
        this._armGestureResume();
        return new Promise((resolve) => { this._ctxWaiters.push(resolve); });
    }

    _flushWaiters(ctx) {
        const waiters = this._ctxWaiters;
        this._ctxWaiters = [];
        waiters.forEach((fn) => fn(ctx));
    }

    /* 浏览器是否还要求一次手势才能出声：story 据此提示「点击画面开启语音」。 */
    needsGesture() {
        return this._ctxWaiters.length > 0 || !this.context || this.context.state !== 'running';
    }

    /* 首次用户手势到达时才创建/恢复 context，并放行等待中的播放请求。
       _unlockAt 供 story 判断「这一下只用来解锁、不推进剧情」。
       resume 被拒（这一次事件不算手势）时**不放行播放**：suspended 的 context
       播放出来是静音的，放行等于让这一句凭空消失；留在队列里等下一次手势。 */
    _armGestureResume() {
        if (this._gestureResume) return;
        this._gestureResume = () => {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            const wasLocked = !this.context || this._ctxWaiters.length > 0 ||
                (this.context && this.context.state === 'suspended');
            if (!this.context && Ctor) this.context = new Ctor();
            const ctx = this.context;
            if (!ctx) return;
            if (wasLocked) this._unlockAt = performance.now();
            if (ctx.state === 'running') { this._flushWaiters(ctx); return; }
            if (ctx.resume) {
                ctx.resume().then(() => {
                    if (ctx.state === 'running') this._flushWaiters(ctx);
                }).catch(() => { /* 不是手势调用栈：保持等待，下一次手势再试 */ });
            }
        };
        window.addEventListener('pointerdown', this._gestureResume, true);
        window.addEventListener('keydown', this._gestureResume, true);
    }

    // ---- 解码（带缓存）----
    _getDecoded(url) {
        if (this.bufferCache.has(url)) return Promise.resolve(this.bufferCache.get(url));
        return fetch(url).then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.arrayBuffer();
        }).then((arrayBuffer) => {
            const ctx = this._context();
            if (!ctx) throw new Error('No AudioContext');
            return ctx.decodeAudioData(arrayBuffer.slice(0));
        }).then((decoded) => {
            this.bufferCache.set(url, decoded);
            return decoded;
        });
    }

    // ---- 主路径：WebAudio 解码 + 离线分析 ----
    _playWebAudio(url) {
        const seq = this._playSeq;
        return this._getDecoded(url).then((decoded) => {
            if (seq !== this._playSeq || !decoded) return null;
            const ctx = this._context();
            if (!ctx) return null;              // 还没解锁：不该走到这里，但别崩
            const source = ctx.createBufferSource();
            source.buffer = decoded;

            source.connect(ctx.destination);

            this.activeSource = source;
            this._startLipSync(decoded);

            source.onended = () => {
                if (this.activeSource !== source) return;
                this.stop();
            };
            source.start(0);
            return decoded;
        });
    }

    /**
     * 音频与口型只有 WebAudio 一条路径。
     * 失败时统一告警、复位并返回 null —— 必须 resolve，
     * 否则 main.js 的 _trigger().catch() 会跳过 _restore()，动作状态会卡住。
     */
    _play(url) {
        return this._playWebAudio(url).catch((err) => {
            console.warn('⚠️ 音频不可用，已跳过语音与口型:', err && err.message || err);
            this.stop();
            return null;
        });
    }

    // ---- 口型同步：离线分析 + rAF 查表 ----
    _startLipSync(audioBuffer) {
        const ls = this.config && this.config.lipsync;
        if (ls && ls.enabled === false) return;

        this.timeline = this.lipsync.analyzeAudioBuffer(audioBuffer);
        const ctx = this._context();
        this.startTime = ctx ? ctx.currentTime : 0;
        this.active = true;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = requestAnimationFrame(() => this._tick());
    }

    _tick() {
        if (!this.active || !this.timeline || this.timeline.length === 0) return;
        const player = this.getPlayer();
        if (!player) return;

        const ls = this.config && this.config.lipsync || {};
        const actx = this._context();
        const elapsed = (actx ? actx.currentTime : 0) - this.startTime;
        const lastFrame = this.timeline[this.timeline.length - 1];

        if (elapsed >= lastFrame.t) {
            // 时间线最后一帧是「帧起点」，比音频短一帧；这里只收口型，
            // 让 source 自然 onended，避免把尾音一起切断。
            this._stopLipSync();
            return;
        }

        const fps = ls.updateFps || 30;
        const gain = ls.gain != null ? ls.gain : 3.0;
        const smoothMs = ls.smoothMs != null ? ls.smoothMs : 30;
        const index = Math.floor(elapsed * fps);
        const current = this.timeline[index] || { value: 0 };
        const next = this.timeline[index + 1] || current;
        const frac = elapsed * fps - index;
        const value = current.value * (1 - frac) + next.value * frac;

        player.setVariable('face_talk', value * gain, smoothMs);
        this.rafId = requestAnimationFrame(() => this._tick());
    }
}

const AudioPlayer = LipSyncPlayer;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LipSync, LipSyncPlayer, AudioPlayer };
}
if (typeof window !== 'undefined') {
    window.LipSync = LipSync;
    window.LipSyncPlayer = LipSyncPlayer;
    window.AudioPlayer = AudioPlayer;
}
