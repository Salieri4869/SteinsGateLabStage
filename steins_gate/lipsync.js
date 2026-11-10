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
        updateFps = 30,
        activationRatio = 0.3,
    } = {}) {
        const fps = updateFps <= 0 ? 1 : updateFps;
        this.meanSmoothing = Math.exp(-1 / (meanDecayTime * fps));
        this.peakSmoothing = Math.exp(-1 / (peakDecayTime * fps));
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

        this._mean = this._mean * this.meanSmoothing + rms * (1 - this.meanSmoothing);
        this._peak = Math.max(rms, this._peak * this.peakSmoothing);

        const dynamicRange = this._peak - this._mean;
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
    }

    loadAndPlay(url) {
        if (!url) return Promise.resolve(null);
        return this._play(url).then((buffer) => buffer);
    }

    stop() {
        this.active = false;
        if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        if (this.activeSource) {
            try { this.activeSource.stop(); } catch (_) { /* 已自然结束 */ }
            this.activeSource = null;
        }
        const player = this.getPlayer();
        if (player) player.setVariable('face_talk', 0, 120);
    }

    // ---- AudioContext ----
    _context() {
        if (!this.context) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            this.context = Ctor ? new Ctor() : null;
        }
        return this.context;
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
        return this._getDecoded(url).then((decoded) => {
            if (!decoded) return null;
            const ctx = this._context();
            const source = ctx.createBufferSource();
            source.buffer = decoded;

            source.connect(ctx.destination);

            this.activeSource = source;
            this.active = true;
            this._startLipSync(decoded);

            source.onended = () => this.stop();
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
        this.startTime = this._context().currentTime;
        this.active = true;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = requestAnimationFrame(() => this._tick());
    }

    _tick() {
        if (!this.active || !this.timeline) return;
        const player = this.getPlayer();
        if (!player) return;

        const ls = this.config && this.config.lipsync || {};
        const elapsed = this._context().currentTime - this.startTime;
        const lastFrame = this.timeline[this.timeline.length - 1];

        if (elapsed >= lastFrame.t) {
            player.setVariable('face_talk', 0, 50);
            this.stop();
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
