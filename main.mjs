/* STEINS;GATE E-mote —— 本地服务（零依赖，Node 18+）

   用法：
     node main.mjs                     # 默认 127.0.0.1:8899
     node main.mjs --port 8000
     node main.mjs --port 8000 --open  # 起完自动开浏览器（run.bat / run.sh 走的就是这条）
     node main.mjs --root .            # 换静态根目录，默认本文件所在目录
     ./run.sh 8000                     # macOS / Linux / Git Bash 启动脚本
     run.bat 8000                      # Windows 启动脚本

   在静态托管之外多几个 /api 接口，响应头都带 X-Emote-Server: node，
   前端据此判断有没有写盘能力：
     GET  /api/order              读 character/actions_config/order.json
     PUT  /api/order              写回角色顺序 {"roles": [...]}
     GET  /api/thumbs             static/background/.thumbs/ 里已有的缩略图
     PUT  /api/thumb?name=原图名  收 1280×720 JPEG，落成 .thumbs/<原名>.jpg
     GET  /api/story              steins_gate/story/scenes/ 下的场景清单
     GET/PUT /api/story?name=…     读/写剧本与 cast.json（点保存时调用）
     GET  /api/voice               列出 steins_gate/story/voices/ 下的音频
     GET  /api/voice?name=…        流式播放音频（支持 Range）
     POST /api/voice               导入音频（octet-stream）或文字 → TTS（json，需 EMOTE_TTS_BIN，未配返回 501）
   探测不到（python / file:// / 别人的机器）时前端只改内存、只读已有缩略图，
   提示会直说没连上服务，不假装保存成功。

   写盘边界：
     · 只写 order.json、.thumbs/<原名>.jpg、steins_gate/story/voices/<白名单名> 三类路径，全部重新拼，不接受目录成分；
     · order.json 只收 {"roles": [...]} 并逐项校验；缩略图只收 JPEG（FFD8FF）且原图必须存在；
       音频只收白名单扩展名、上限 12MB；
     · 先写 .tmp 再 rename，写坏了也不会留下半份文件；
     · 默认只监听 127.0.0.1，局域网访问不到，也就没有外部写入面。 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, rename, unlink, readdir, stat, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
function argOf(name, dflt) {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const PORT = Number(argOf('--port', process.env.PORT || 8899));
const HOST = argOf('--host', '127.0.0.1');
const ROOT = resolve(argOf('--root', HERE));
const ORDER_FILE = join(ROOT, 'character', 'actions_config', 'order.json');
const ORDER_REL = 'character/actions_config/order.json';
const MAX_BODY = 256 * 1024;         // 200 个角色名远用不到这么多，超了按异常请求处理

/* 背景缩略图落盘目录：static/background/.thumbs/<原名去扩展名>.jpg（1280×720）
   页面用 canvas 生成一次，之后所有预览都读这张小图，不再反复解码 3072×1728 原图。 */
const BG_DIR = join(ROOT, 'static', 'background');
const THUMB_DIR = join(BG_DIR, '.thumbs');
const THUMB_REL = 'static/background/.thumbs';
const THUMB_MAX = 2 * 1024 * 1024;   // 实测 720p JPEG 约 120~220KB，2MB 兜底
const IMG_EXT = /\.(jpe?g|png|webp|bmp|gif|avif)$/i;

/* 剧情数据：只写 steins_gate/story/cast.json 与 steins_gate/story/scenes/<slug>.json，文件名一律 ASCII slug */
const STORY_DIR = join(ROOT, 'steins_gate', 'story');
const SCENE_DIR = join(STORY_DIR, 'scenes');
const CAST_FILE = join(STORY_DIR, 'cast.json');
const SCENE_NAME = /^[a-z0-9][a-z0-9-]*\.json$/;

/* 即时语音：导入 / TTS 合成的音频都落 steins_gate/story/voices/；TTS 走可选外部引擎（默认关闭）
   /api/voice             GET 列出 / GET?name= 流式播放（Range，供 <audio> 拖动）
   /api/voice POST        octet-stream 导入音频；application/json {text} 文字 → TTS
                          未配置引擎时 TTS 返回 501，前端据此降级 */
const VOICE_DIR = join(STORY_DIR, 'voices');
const VOICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(opus|ogg|wav|mp3|m4a|flac|webm)$/i;
const VOICE_MAX = 12 * 1024 * 1024;   // 单段语音上限 12MB
const TTS_BIN = process.env.EMOTE_TTS_BIN || '';   // 例：edge-tts；留空即未配置
const TTS_VOICE = process.env.EMOTE_TTS_VOICE || 'zh-CN-XiaoxiaoNeural';

/* ---------- MIME ---------- */
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.zip': 'application/zip',
    '.psb': 'application/octet-stream',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.wasm': 'application/wasm'
};

/* ---------- 小工具 ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function send(res, code, body, headers = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.writeHead(code, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': buf.length,
        'X-Emote-Server': 'node',        // 前端靠这个响应头判断「有写盘能力」
        'Cache-Control': 'no-store',
        ...headers
    });
    res.end(buf);
}

const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj) + '\n',
    { 'Content-Type': 'application/json; charset=utf-8' });

/* 把 URL 路径映射到磁盘路径；任何越界一律 403，不做「尽力而为」
   URL 与物理目录一一对应：页面在 steins_gate/stage/ 与 steins_gate/story/，
   对外就是 /steins_gate/stage/ 与 /steins_gate/story/，没有任何别名重写。
   这样换成任意静态服务器也能直接跑，不存在只有本项目认识的前缀规则。 */
function toDisk(urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath.split('?')[0]); } catch (_) { return null; }
    if (p.includes('\0')) return null;
    const abs = resolve(join(ROOT, p));
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
    return abs;
}

/* 目录索引：前端 parseIndex() 只认 href，按「以 / 结尾 = 目录」判断，
   所以这里必须给目录补尾斜杠，否则角色文件夹会被当成普通文件跳过。 */
async function listDir(abs, urlPath) {
    const items = await readdir(abs, { withFileTypes: true });
    const dirs = [], files = [];
    for (const it of items) {
        if (it.name.startsWith('.')) continue;          // .git / .workbuddy 之类不列
        if (it.isDirectory()) dirs.push(it.name);
        else if (it.isFile()) files.push(it.name);
    }
    dirs.sort(); files.sort();
    const rows = [];
    if (urlPath !== '/') rows.push('<li><a href="../">../</a></li>');
    for (const d of dirs) {
        const href = encodeURIComponent(d) + '/';
        rows.push(`<li><a href="${href}">${esc(d)}/</a></li>`);
    }
    for (const f of files) {
        const href = encodeURIComponent(f);
        rows.push(`<li><a href="${href}">${esc(f)}</a></li>`);
    }
    return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">`
        + `<title>${esc(urlPath)}</title></head><body><ul>${rows.join('')}</ul></body></html>`;
}

/* ---------- order.json 读写 ---------- */
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

function cleanRoles(input) {
    if (!Array.isArray(input)) throw new Error('roles 必须是数组');
    if (input.length > 200) throw new Error('roles 条目过多');
    const seen = new Set();
    const out = [];
    for (const raw of input) {
        if (typeof raw !== 'string') throw new Error('roles 里必须全是字符串');
        const s = raw.trim();
        if (!s) continue;
        if (s.length > 64) throw new Error('角色名过长: ' + s.slice(0, 20) + '…');
        if (s === '.' || s === '..' || s.startsWith('.')) throw new Error('非法角色名: ' + s);
        if (BAD_CHARS.test(s)) throw new Error('角色名含非法字符: ' + s);
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    if (!out.length) throw new Error('roles 为空');
    return out;
}

async function readOrder() {
    try {
        const text = await readFile(ORDER_FILE, 'utf8');
        return { exists: true, text };
    } catch (err) {
        if (err.code === 'ENOENT') return { exists: false, text: null };
        throw err;
    }
}

/* 先写 .tmp 再 rename：中途出错不会留下半份 order.json */
async function writeOrder(roles) {
    const text = JSON.stringify({ roles }, null, 2) + '\n';
    await writeFile(ORDER_FILE + '.tmp', text, 'utf8');
    try {
        await rename(ORDER_FILE + '.tmp', ORDER_FILE);
    } catch (err) {
        await unlink(ORDER_FILE + '.tmp').catch(() => {});
        throw err;
    }
    return text;
}

function readBody(req) {
    return new Promise((resolvePromise, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/* ---------- 背景缩略图（static/background/.thumbs） ---------- */
function readRawBody(req, limit) {
    return new Promise((resolvePromise, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('请求体过大（缩略图上限 2MB）')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolvePromise(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/* 返回已有的缩略图名（不含 .jpg），前端拿它判断哪张还要生成 */
async function listThumbs() {
    try {
        const names = await readdir(THUMB_DIR);
        return names.filter((n) => /\.jpe?g$/i.test(n)).map((n) => n.replace(/\.[^.]+$/, '')).sort();
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

/* 只接受「static/background/ 里真实存在的那张原图」的 720p JPEG，写到 .thumbs/<原名去扩展名>.jpg。
   路径全部重新拼，不接受任何目录成分；先写 .tmp 再 rename，不会留半张图。 */
async function writeThumb(name, buf) {
    const base = String(name || '');
    if (!base || base.length > 200) throw new Error('缺少 name');
    if (base !== base.replace(/^.*[\\/]/, '') || base.startsWith('.')) throw new Error('name 只能是文件名');
    if (BAD_CHARS.test(base)) throw new Error('name 含非法字符');
    if (!IMG_EXT.test(base)) throw new Error('name 必须带图片扩展名');

    let info;
    try { info = await stat(join(BG_DIR, base)); }
    catch (_) { throw new Error('static/background/ 里没有这个文件：' + base); }
    if (!info.isFile()) throw new Error('不是文件：' + base);

    // JPEG 头 FFD8FF：接口只收 JPEG，避免被当成任意文件写入口
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
        throw new Error('只接受 JPEG 数据');
    }

    const stem = base.replace(/\.[^.]+$/, '');
    const target = join(THUMB_DIR, stem + '.jpg');
    await mkdir(THUMB_DIR, { recursive: true });
    const tmp = target + '.tmp';
    await writeFile(tmp, buf);
    try {
        await rename(tmp, target);
    } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
    }
    return { file: base, thumb: stem + '.jpg', bytes: buf.length };
}

/* ---------- 剧情剧本 ---------- */
function storyTarget(name) {
    if (!name) throw new Error('缺少 name');
    if (name.length > 64 || BAD_CHARS.test(name) || name.includes('..') || name.startsWith('.')) {
        throw new Error('非法文件名');
    }
    if (name === 'cast.json') return { abs: CAST_FILE, rel: 'steins_gate/story/cast.json', kind: 'cast' };
    if (!SCENE_NAME.test(name)) throw new Error('场景名须为小写字母/数字/连字符 + .json');
    return { abs: join(SCENE_DIR, name), rel: 'steins_gate/story/scenes/' + name, kind: 'scene' };
}

function validateStory(kind, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('必须是 JSON 对象');
    if (kind === 'cast') {
        for (const [role, entry] of Object.entries(data)) {
            if (role === 'doc') continue;
            if (!entry || typeof entry !== 'object' || typeof entry.model !== 'string' || !entry.model) {
                throw new Error('角色「' + role + '」缺少 model');
            }
            if (entry.name !== undefined && typeof entry.name !== 'string') {
                throw new Error('角色「' + role + '」的 name（显示名）须为字符串');
            }
        }
        return;
    }
    if (typeof data.title !== 'string') throw new Error('场景缺少 title');
    if (data.background !== undefined && typeof data.background !== 'string') throw new Error('background 须为字符串');
    if (data.stage !== undefined) {
        if (!Array.isArray(data.stage) || data.stage.length > 64) throw new Error('stage 须为数组（最多 64 人）');
        data.stage.forEach((slot, i) => {
            if (!slot || typeof slot !== 'object' || Array.isArray(slot)) throw new Error('stage 第 ' + (i + 1) + ' 项不是对象');
            if (typeof slot.role !== 'string' || !slot.role) throw new Error('stage 第 ' + (i + 1) + ' 项缺少 role');
            for (const k of ['x', 'scale', 'z']) {
                if (slot[k] !== undefined && !Number.isFinite(slot[k])) throw new Error('stage 第 ' + (i + 1) + ' 项 ' + k + ' 须为数字');
            }
        });
    }
    if (!Array.isArray(data.lines)) throw new Error('lines 必须是数组');
    if (data.lines.length > 2000) throw new Error('行数过多');
    data.lines.forEach((line, i) => {
        const at = '第 ' + (i + 1) + ' 行';
        if (!line || typeof line !== 'object' || Array.isArray(line)) throw new Error(at + '不是对象');
        if (typeof line.text !== 'string') throw new Error(at + '缺少 text');
        for (const k of ['role', 'model', 'voice', 'name']) {
            if (line[k] !== undefined && typeof line[k] !== 'string') throw new Error(at + k + ' 须为字符串');
        }
        if (line.action !== undefined) {
            if (typeof line.action === 'string') { /* 宏名 */ }
            else if (!line.action || typeof line.action !== 'object' || Array.isArray(line.action)) {
                throw new Error(at + 'action 须为宏名字符串或动作对象');
            }
        }
        if (line.cues !== undefined) {
            if (!line.cues || typeof line.cues !== 'object' || Array.isArray(line.cues)) {
                throw new Error(at + 'cues 须为对象：{ 角色: { action, voice } }');
            }
            for (const [role, cue] of Object.entries(line.cues)) {
                if (!role) throw new Error(at + 'cues 里有空角色名');
                if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
                    throw new Error(at + 'cues.' + role + ' 须为对象');
                }
                if (cue.voice !== undefined && typeof cue.voice !== 'string') {
                    throw new Error(at + 'cues.' + role + '.voice 须为字符串');
                }
                if (cue.action !== undefined && typeof cue.action !== 'string'
                    && (!cue.action || typeof cue.action !== 'object' || Array.isArray(cue.action))) {
                    throw new Error(at + 'cues.' + role + '.action 须为宏名字符串或动作对象');
                }
            }
        }
        for (const k of ['enter', 'exit']) {
            if (line[k] === undefined) continue;
            const v = Array.isArray(line[k]) ? line[k] : [line[k]];
            if (!v.every((r) => typeof r === 'string')) throw new Error(at + k + ' 须为角色名或数组');
        }
        if (line.move !== undefined) {
            if (!line.move || typeof line.move !== 'object' || Array.isArray(line.move)) {
                throw new Error(at + 'move 须为对象：{ 角色: 位置 }');
            }
            for (const [role, v] of Object.entries(line.move)) {
                if (!role) throw new Error(at + 'move 里有空角色名');
                if (typeof v === 'number') {
                    if (!Number.isFinite(v)) throw new Error(at + 'move.' + role + ' 须为数字');
                    continue;
                }
                if (!v || typeof v !== 'object' || Array.isArray(v)) {
                    throw new Error(at + 'move.' + role + ' 须为数字或 { x, scale, z }');
                }
                for (const k of ['x', 'scale', 'z']) {
                    if (v[k] !== undefined && !Number.isFinite(v[k])) {
                        throw new Error(at + 'move.' + role + '.' + k + ' 须为数字');
                    }
                }
            }
        }
        // auto 字段已废弃（自动推进改成播放界面的开关），旧文件仍可读，只校验 wait
        if (line.wait !== undefined && (!Number.isFinite(line.wait) || line.wait < 0)) {
            throw new Error(at + 'wait 须为非负数');
        }
    });
}

async function listScenes() {
    let names;
    try { names = await readdir(SCENE_DIR); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const out = [];
    for (const name of names.sort()) {
        if (!SCENE_NAME.test(name)) continue;
        let title = name;
        try {
            const data = JSON.parse(await readFile(join(SCENE_DIR, name), 'utf8'));
            if (data && typeof data.title === 'string' && data.title) title = data.title;
        } catch (_) { /* 坏文件仍列出，用文件名当标题 */ }
        out.push({ file: name, title });
    }
    return out;
}

async function readStory(target) {
    try { return await readFile(target.abs, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

/* 先写 .tmp 再 rename：中途出错不会留下半份剧本 */
async function writeStory(target, data) {
    const text = JSON.stringify(data, null, 2) + '\n';
    await mkdir(target.kind === 'cast' ? STORY_DIR : SCENE_DIR, { recursive: true });
    await writeFile(target.abs + '.tmp', text, 'utf8');
    try {
        await rename(target.abs + '.tmp', target.abs);
    } catch (err) {
        await unlink(target.abs + '.tmp').catch(() => {});
        throw err;
    }
    return text;
}

/* ---------- 即时语音 ---------- */
function voiceTarget(name) {
    if (!name || name.length > 120 || !VOICE_NAME.test(name) || name.includes('..')) {
        throw new Error('非法音频名（只允许字母数字与 . _ -，且带音频扩展名）');
    }
    return { abs: join(VOICE_DIR, name), name };
}

async function listVoices() {
    try {
        const names = await readdir(VOICE_DIR);
        return names.filter((n) => VOICE_NAME.test(n)).sort();
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

/* 先写 .tmp 再 rename；名字全部重拼，不接受目录成分 */
async function writeVoice(name, buf) {
    const t = voiceTarget(name);
    await mkdir(VOICE_DIR, { recursive: true });
    const tmp = t.abs + '.tmp';
    await writeFile(tmp, buf);
    try { await rename(tmp, t.abs); }
    catch (err) { await unlink(tmp).catch(() => {}); throw err; }
    return t;
}

/* TTS 预留：配了 EMOTE_TTS_BIN 就调外部命令，把文字写成音频文件返回。
   没配则抛「未配置」，路由回 501，前端据此提示降级。 */
async function synthVoice(text, outName) {
    if (!TTS_BIN) throw Object.assign(new Error('未配置 TTS 引擎（EMOTE_TTS_BIN）'), { code: 'NO_TTS' });
    const text2 = String(text || '').trim();
    if (!text2) throw new Error('缺少 text');
    if (text2.length > 500) throw new Error('文字过长（上限 500 字）');
    const t = voiceTarget(outName);
    await mkdir(VOICE_DIR, { recursive: true });
    const tmp = t.abs + '.tmp';
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    try {
        // 约定：外部命令支持 --voice <名> --text <文字> --write-media <文件>
        await run(TTS_BIN, ['--voice', TTS_VOICE, '--text', text2, '--write-media', tmp],
            { timeout: 60000, maxBuffer: 1024 * 1024 });
        await stat(tmp);
        await rename(tmp, t.abs);
    } catch (err) {
        await unlink(tmp).catch(() => {});
        if (err && err.code === 'NO_TTS') throw err;
        throw new Error('TTS 合成失败：' + (err && err.message));
    }
    return t;
}

/* Range：只处理单段 bytes=a-b，返回 {start,end,total} 或 null（从头） */
function parseRange(header, size) {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (!m[1] && !m[2])) return null;
    let start, end;
    if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : size - 1;
    } else {
        // bytes=-N：末尾 N 字节
        const n = Number(m[2]);
        start = Math.max(0, size - n);
        end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) return null;
    return { start, end: Math.min(end, size - 1), total: size };
}

/* 流式发音频：支持 Range（206）与 HEAD，带 X-Emote-Server 头 */
async function streamVoice(req, res, abs, info) {
    const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
    const range = parseRange(req.headers.range, info.size);
    const base = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'X-Emote-Server': 'node',
        'Cache-Control': 'no-store'
    };
    if (range) {
        const len = range.end - range.start + 1;
        res.writeHead(206, { ...base,
            'Content-Length': len,
            'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`
        });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(abs, { start: range.start, end: range.end })
            .on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
    }
    res.writeHead(200, { ...base, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(abs)
        .on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
}

/* ---------- 路由 ---------- */
async function handleApi(req, res, pathname) {
    if (pathname === '/api/thumbs') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('Allow', 'GET, HEAD');
            return sendJson(res, 405, { ok: false, error: '只支持 GET' });
        }
        let files;
        try { files = await listThumbs(); }
        catch (err) { return sendJson(res, 500, { ok: false, error: err.message }); }
        return sendJson(res, 200, { ok: true, dir: THUMB_REL, files });
    }

    if (pathname === '/api/thumb') {
        if (req.method !== 'PUT') {
            res.setHeader('Allow', 'PUT');
            return sendJson(res, 405, { ok: false, error: '只支持 PUT' });
        }
        const name = (new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '');
        let buf;
        try { buf = await readRawBody(req, THUMB_MAX); }
        catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
        try {
            const out = await writeThumb(name, buf);
            const when = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            console.log(`[thumb] ${when} ${out.thumb} ← ${Math.round(out.bytes / 1024)}KB`);
            return sendJson(res, 200, { ok: true, ...out });
        } catch (err) {
            return sendJson(res, 400, { ok: false, error: err.message });
        }
    }

    if (pathname === '/api/story') {
        const name = (new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '').trim();
        let target = null;
        if (name) {
            try { target = storyTarget(name); }
            catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
            if (!target) {
                try { return sendJson(res, 200, { ok: true, scenes: await listScenes() }); }
                catch (err) { return sendJson(res, 500, { ok: false, error: err.message }); }
            }
            let text;
            try { text = await readStory(target); }
            catch (err) { return sendJson(res, 500, { ok: false, error: err.message }); }
            if (text === null) return sendJson(res, 404, { ok: false, error: target.rel + ' 不存在' });
            return send(res, 200, text, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        if (req.method !== 'PUT') {
            res.setHeader('Allow', 'GET, HEAD, PUT');
            return sendJson(res, 405, { ok: false, error: '只支持 GET / PUT' });
        }
        if (!target) return sendJson(res, 400, { ok: false, error: 'PUT 需要 name 参数' });
        let data;
        try { data = JSON.parse(await readBody(req)); }
        catch (err) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON：' + err.message }); }
        try { validateStory(target.kind, data); }
        catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
        try {
            const text = await writeStory(target, data);
            const when = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            console.log(`[story] ${when} 写入 ${target.rel} ← ${Math.round(Buffer.byteLength(text) / 1024)}KB`);
            return sendJson(res, 200, { ok: true, path: target.rel, bytes: Buffer.byteLength(text) });
        } catch (err) {
            console.error('[story] 写盘失败:', err.message);
            return sendJson(res, 500, { ok: false, error: '写盘失败：' + err.message });
        }
    }

    /* /api/voice —— 列出 / 导入 / 流式播放 / 文字合成（TTS）
       GET  无 name 列目录，带 name 流式播放（Range / 206）
       POST Content-Type: application/json → 文字合成；否则按原始音频字节导入 */
    if (pathname === '/api/voice') {
        const url = new URL(req.url, 'http://127.0.0.1');
        const name = (url.searchParams.get('name') || '').trim();

        if (req.method === 'GET' || req.method === 'HEAD') {
            if (!name) {
                try { return sendJson(res, 200, { ok: true, files: await listVoices() }); }
                catch (err) { return sendJson(res, 500, { ok: false, error: err.message }); }
            }
            let t;
            try { t = voiceTarget(name); }
            catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
            let info;
            try { info = await stat(t.abs); }
            catch (err) {
                if (err.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: '音频不存在' });
                return sendJson(res, 500, { ok: false, error: err.message });
            }
            if (!info.isFile()) return sendJson(res, 404, { ok: false, error: '不是文件' });
            return streamVoice(req, res, t.abs, info);
        }

        if (req.method !== 'POST' && req.method !== 'PUT') {
            res.setHeader('Allow', 'GET, HEAD, POST, PUT');
            return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
        }

        // 文字合成：JSON 体 {text, name?}，调可选 TTS 引擎
        const ctype = String(req.headers['content-type'] || '').toLowerCase();
        if (ctype.includes('application/json')) {
            let payload;
            try { payload = JSON.parse(await readBody(req)); }
            catch (err) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON：' + err.message }); }
            const text = String((payload && payload.text) || '').trim();
            if (!text) return sendJson(res, 400, { ok: false, error: '缺少 text' });
            const outName = String((payload && payload.name) || '').trim()
                || 'tts-' + Date.now() + '.mp3';
            try {
                const t = await synthVoice(text, outName);
                const when = new Date().toLocaleTimeString('zh-CN', { hour12: false });
                console.log(`[voice] ${when} TTS ${t.name} ← ${text.slice(0, 20)}…`);
                return sendJson(res, 200, { ok: true,
                    name: t.name, url: '/api/voice?name=' + encodeURIComponent(t.name), text });
            } catch (err) {
                if (err.code === 'NO_TTS') {
                    return sendJson(res, 501, { ok: false, code: 'NO_TTS',
                        error: 'TTS 未配置：请在即时台词面板选择音频，或设置 EMOTE_TTS_BIN 启用语音合成' });
                }
                return sendJson(res, 500, { ok: false, error: err.message });
            }
        }

        // 原始音频导入：名字参数优先，否则用请求头，再否则按时间生成
        let outName = (url.searchParams.get('name') || req.headers['x-voice-name'] || '').trim();
        let buf;
        try { buf = await readRawBody(req, VOICE_MAX); }
        catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
        if (!buf.length) return sendJson(res, 400, { ok: false, error: '音频数据为空' });
        if (!outName) {
            const ext = (url.searchParams.get('ext') || 'opus').replace(/[^a-z0-9]/gi, '') || 'opus';
            outName = 'live-' + Date.now() + '.' + ext;
        }
        try {
            const t = await writeVoice(outName, buf);
            const when = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            console.log(`[voice] ${when} 导入 ${t.name} ← ${Math.round(buf.length / 1024)}KB`);
            return sendJson(res, 200, { ok: true, name: t.name, url: '/api/voice?name=' + encodeURIComponent(t.name), bytes: buf.length });
        } catch (err) {
            return sendJson(res, 400, { ok: false, error: err.message });
        }
    }

    if (pathname !== '/api/order') return sendJson(res, 404, { ok: false, error: '未知接口' });

    if (req.method === 'GET' || req.method === 'HEAD') {
        const { exists, text } = await readOrder();
        if (!exists) return sendJson(res, 404, { ok: false, error: 'order.json 不存在' });
        return send(res, 200, text, { 'Content-Type': 'application/json; charset=utf-8' });
    }

    if (req.method !== 'PUT') {
        res.setHeader('Allow', 'GET, HEAD, PUT');
        return sendJson(res, 405, { ok: false, error: '只支持 GET / PUT' });
    }

    let payload;
    try {
        payload = JSON.parse(await readBody(req));
    } catch (err) {
        return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON：' + err.message });
    }

    let roles;
    try {
        roles = cleanRoles(payload && payload.roles);
    } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
    }

    try {
        await writeOrder(roles);
    } catch (err) {
        console.error('[order] 写盘失败:', err.message);
        return sendJson(res, 500, { ok: false, error: '写盘失败：' + err.message });
    }

    const when = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[order] ${when} 写入 ${ORDER_REL} ← ${roles.length} 个角色`);
    return sendJson(res, 200, { ok: true, path: ORDER_REL, count: roles.length, roles });
}

/* 单个文件：ETag（大小 + 修改时间）做 304，改代码刷新就能拿到新的 */
async function serveFile(req, res, abs, info) {
    const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'X-Emote-Server': 'node' });
        return res.end();
    }
    res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
        'Last-Modified': info.mtime.toUTCString(),
        ETag: etag,
        'X-Emote-Server': 'node'
    });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(abs);
    stream.on('error', () => { try { res.destroy(); } catch (_) {} });
    stream.pipe(res);
}

async function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return send(res, 405, '只支持 GET / HEAD\n');
    }

    const abs = toDisk(pathname);
    if (!abs) return send(res, 403, '403 路径越界\n');

    let info;
    try { info = await stat(abs); }
    catch (err) { return send(res, 404, '404 ' + (err.code === 'ENOENT' ? '没有这个文件' : err.message) + '\n'); }

    if (info.isDirectory()) {
        if (!pathname.endsWith('/')) {         // 补尾斜杠，否则相对路径会算错一层
            res.writeHead(301, { Location: pathname + '/' + (urlSearchOf(req)), 'X-Emote-Server': 'node' });
            return res.end();
        }
        /* 目录里有 index.html 就当首页（项目根 = 角色档案主页，steins_gate/stage/ = 场景页）；
           模型目录没有 index.html，照旧列目录给前端 parseIndex 用 */
        const idxAbs = join(abs, 'index.html');
        let idxInfo = null;
        try { idxInfo = await stat(idxAbs); } catch (_) { idxInfo = null; }
        if (idxInfo && idxInfo.isFile()) return serveFile(req, res, idxAbs, idxInfo);
        const html = await listDir(abs, pathname);
        return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    return serveFile(req, res, abs, info);
}

function urlSearchOf(req) {
    const i = req.url.indexOf('?');
    return i >= 0 ? req.url.slice(i + 1) : '';
}

/* ---------- 启动 ---------- */
/* --open：起完自动开浏览器（run.bat / run.sh 走这条） */
function openBrowser(url) {
    const win = process.platform === 'win32';
    const cmd = win ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = win ? ['/c', 'start', '', url] : [url];
    try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
        child.on('error', () => {});   // 无 xdg-open / open 时别让未捕获的 ENOENT 带崩服务
        child.unref();
    } catch (_) { /* 地址已经打印出来了 */ }
}
const server = createServer(async (req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    try {
        if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
        return await handleStatic(req, res, pathname);
    } catch (err) {
        console.error('[500]', req.method, pathname, err && err.message);
        if (!res.headersSent) send(res, 500, '500 ' + (err && err.message) + '\n');
        else res.destroy();
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${PORT} 被占用了，换一个：node main.mjs --port 8901`);
    } else {
        console.error('启动失败:', err.message);
    }
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    // 先把 .thumbs 建出来：前端靠它的目录索引判断「有没有缩略图/能不能写」
    mkdir(THUMB_DIR, { recursive: true }).catch(() => {});
    const home = `http://${HOST}:${PORT}/`;
    console.log('E-mote 本地服务已启动');
    console.log(`角色档案首页  ${home}`);
    console.log(`故事模式      ${home}steins_gate/story/index.html`);
    console.log(`LAB 播放页    ${home}steins_gate/stage/index.html`);
    console.log(`静态根目录  ${ROOT}`);
    console.log('Ctrl+C 停止');
    if (argv.includes('--open')) openBrowser(home);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 800); });
}
