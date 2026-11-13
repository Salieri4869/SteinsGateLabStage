/* STEINS;GATE E-mote —— 本地服务（零依赖，Node 18+）

   用法：
     node main.mjs                     # 默认 127.0.0.1:8899
     node main.mjs --port 8000
     node main.mjs --port 8000 --open  # 起完自动开浏览器（run.bat 走的就是这条）
     node main.mjs --root .            # 换静态根目录，默认本文件所在目录

   在静态托管之外多三个接口，响应头都带 X-Emote-Server: node，
   前端据此判断有没有写盘能力：
     GET  /api/order              读 actions-config/order.json
     PUT  /api/order              写回角色顺序 {"roles": [...]}
     GET  /api/thumbs             background/.thumbs/ 里已有的缩略图
     PUT  /api/thumb?name=原图名  收 1280×720 JPEG，落成 .thumbs/<原名>.jpg
   探测不到（python / file:// / 别人的机器）时前端只改内存、只读已有缩略图，
   提示会直说没连上服务，不假装保存成功。

   写盘边界：
     · 只写 order.json 与 .thumbs/<原名>.jpg 两类路径，全部重新拼，不接受目录成分；
     · order.json 只收 {"roles": [...]} 并逐项校验；缩略图只收 JPEG（FFD8FF）且原图必须存在；
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
const ORDER_FILE = join(ROOT, 'actions-config', 'order.json');
const ORDER_REL = 'actions-config/order.json';
const MAX_BODY = 256 * 1024;         // 200 个角色名远用不到这么多，超了按异常请求处理

/* 背景缩略图落盘目录：background/.thumbs/<原名去扩展名>.jpg（1280×720）
   页面用 canvas 生成一次，之后所有预览都读这张小图，不再反复解码 3072×1728 原图。 */
const BG_DIR = join(ROOT, 'steins_gate', 'background');
const THUMB_DIR = join(BG_DIR, '.thumbs');
const THUMB_REL = 'steins_gate/background/.thumbs';
const THUMB_MAX = 2 * 1024 * 1024;   // 实测 720p JPEG 约 120~220KB，2MB 兜底
const IMG_EXT = /\.(jpe?g|png|webp|bmp|gif|avif)$/i;

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

/* 把 URL 路径映射到磁盘路径；任何越界一律 403，不做「尽力而为」 */
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

/* ---------- 背景缩略图（background/.thumbs） ---------- */
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

/* 只接受「background/ 里真实存在的那张原图」的 720p JPEG，写到 .thumbs/<原名去扩展名>.jpg。
   路径全部重新拼，不接受任何目录成分；先写 .tmp 再 rename，不会留半张图。 */
async function writeThumb(name, buf) {
    const base = String(name || '');
    if (!base || base.length > 200) throw new Error('缺少 name');
    if (base !== base.replace(/^.*[\\/]/, '') || base.startsWith('.')) throw new Error('name 只能是文件名');
    if (BAD_CHARS.test(base)) throw new Error('name 含非法字符');
    if (!IMG_EXT.test(base)) throw new Error('name 必须带图片扩展名');

    let info;
    try { info = await stat(join(BG_DIR, base)); }
    catch (_) { throw new Error('background/ 里没有这个文件：' + base); }
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
        /* 目录里有 index.html 就当首页（项目根 = 角色档案主页，steins_gate/ = 场景页）；
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
/* --open：起完自动用默认浏览器打开首页（run.bat 走这条，双击就能用） */
function openBrowser(url) {
    try {
        if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
        } else if (process.platform === 'darwin') {
            spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
        } else {
            spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
        }
    } catch (_) { /* 开不了就算了，地址已经打印出来了 */ }
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
    console.log(`场景页        ${home}steins_gate/index.html`);
    console.log(`静态根目录  ${ROOT}`);
    console.log('Ctrl+C 停止');
    if (argv.includes('--open')) openBrowser(home);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 800); });
}
