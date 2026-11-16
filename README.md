# SteinsGateLabStage

在浏览器中运行《STEINS;GATE》角色的 E-mote 动态立绘，支持手臂姿势切换、触摸反应、语音与口型同步。

> **本项目为非官方、非商业的二次创作，与 MAGES. / Nitroplus / M2 Co., Ltd. 均无关联。**
> 仓库**不包含**任何游戏原始素材（模型、立绘、背景、语音），也**不包含** E-mote 运行时（专有 SDK）。

[English](README.en.md)

---

## 内容

首页 `index.html` 顶部有三个标签：「作品 / 角色 / 技术」是页内锚点，「故事模式 / LAB」通向两个独立页面：

| 入口 | 说明 |
|---|---|
| `index.html` | 角色档案页（世界观介绍 + Labmem 名鉴），纯静态 |
| `story/index.html` | **故事模式**：可视化编辑台词并播放，打字机 + 点击/自动推进 |
| `steins_gate/index.html` | **LAB 播放页**：互动立绘（触摸反应、手臂姿势、口型同步），两个页面都需要下方「快速开始」中的文件才能启动 |

## 功能

- **模型直读**：直接解析 `.pure.psb`（PSB v4）二进制，无需反编译、无需预生成配置、无需构建步骤。模型放进 `character/data/<角色>/` 后自动出现在角色 tab；触摸反应按[动作配置指南](docs/动作配置指南.md)逐模型配置。
- **手臂姿势切换**：针对 PSB 4.0 的互斥追加部件（`insert` / `delete`），在 GPU 纹理上传阶段打补丁，擦除未选中的那套手臂。适用于只支持到 3.9.8 的 SDK 运行时。
- **触摸反应**：按 `charaProfile` 部位（eye / mouth / bust / top …）划分命中区，命中后从动作池随机抽一条执行，可携带语音与变量插值。
- **口型同步**：WebAudio 离线分析音频包络后按 rAF 查表驱动 `face_talk`；音频不可用时明确告警并跳过语音与口型，不提供第二条播放路径。
- **场景 UI**：角色 tab 与造型面板、背景预览面板、tab 顺序调整；顺序写回 `character/actions_config/order.json`，背景与卡片统一读 `static/background/.thumbs/` 的 720p 缩略图。
- **故事模式**：`/story` 单页双模式，可视化编辑场景（行拖拽 / ▲▼ / 增删）与打字机播放器（点击 / 自动推进 / 语音 / 动作宏）；角色绑定写在 `story/cast.json`，场景存 `story/scenes/*.json`。剧情页的「即时台词」浮层可脱离剧本，直接输入文字 + 选择音频（本地文件或 `character/sounds/` 音频列表）或文字合成，让当前立绘开口说话。
- **开发者面板**：内置选择器 / 姿势 / 变量调试入口（`installDevPanel`）。

## 快速开始

**克隆本仓库后无法直接运行**，需要自备两类文件（均已被 `.gitignore` 排除）：

1. **E-mote 运行时**，放到 `driver/`
   - 必需：`emotedriver.js`、`emotedriver.wasm`（本项目验证于 `driver_wasm_modularize` 构建）、`emoteplayer.js`
   - 获取方式：向 [M2 Co., Ltd.](https://emote.mtwo.co.jp/) 申请 E-mote SDK
   - ⚠️ 该 SDK 为专有软件，其条款禁止再分发。**请勿将 `driver/` 提交到任何公开仓库**，本项目亦不会提供。

2. **模型与素材**，放到 `character/data/` 与 `static/background/`
   - `character/data/<角色>/<名称>.pure.psb.zip` — 每个 zip 内含一个 `pure.psb`
   - `static/background/` — 背景图，直接丢图片即可；`static/background/.thumbs/` 由页面自动生成，不用手放
   - 需从你合法持有的游戏副本中提取，本项目不提供任何素材。

准备好后启动本地服务（`fetch` 加载要求 HTTP，不能直接开 `file://`）：

```bash
node main.mjs --port 8000     # 或 ./run.sh 8000（macOS / Linux / Git Bash）
                              # Windows 也可直接双击 run.bat
# 访问 http://127.0.0.1:8000/
```

启动后首页有三个页内锚点（作品 / 角色 / 技术）和两个模式入口：LAB 互动立绘、故事模式。故事模式需要语音时可把音频放到 `character/sounds/`（缺文件会静默跳过）。

`main.mjs` 是零依赖静态服务（Node 18+，默认端口 8899；`run.bat` / `run.sh` 默认 8000，服务只监听 127.0.0.1）。相比 `python -m http.server` 多了这些写盘接口：

| 接口 | 作用 |
|---|---|
| `GET/PUT /api/order` | 读写角色顺序 `character/actions_config/order.json` |
| `GET /api/thumbs`、`PUT /api/thumb` | 背景缩略图落到 `static/background/.thumbs/` |
| `GET/PUT /api/story` | 读写 `story/cast.json` 与 `story/scenes/*.json` |
| `GET /api/voice` | 列出即时台词音频（`story/voices/`） |
| `GET /api/voice?name=…` | 流式播放音频，支持 Range（可拖动进度） |
| `POST /api/voice`（octet-stream） | 外部导入音频落盘，上限 12MB（页面「选择音频」「音频列表」都不走这里，不写盘） |
| `POST /api/voice`（json） | 文字 → 语音合成（TTS 预留，`{"text":"…"}`） |

**即时台词的语音来源**：三个 tab。「选择音频」——在面板里选本地音频，浏览器内用临时 blob URL 直接播放，不上传、不写盘；「音频列表」——列出 `character/sounds/` 下的文件夹与音频文件，选一个走静态路径直接播放，同样不写盘；「文字合成」是 TTS 预留接口：设置环境变量 `EMOTE_TTS_BIN`（如 `edge-tts`）和可选的 `EMOTE_TTS_VOICE`（默认 `zh-CN-XiaoxiaoNeural`）后启用，未配置时接口返回 501、前端提示改用「选择音频」；只有合成的音频会落盘到 `story/voices/`。外部命令需支持 `--voice <名> --text <文字> --write-media <文件>` 参数。

换成其他静态服务器也能跑，只是写盘能力退化为只读——排序只在本次会话有效，缩略图只用已有文件，剧本无法保存，文字合成（TTS）不可用；「选择音频」「音频列表」不依赖服务端写盘，照常可用。

## 目录结构

```
index.html                  角色档案页
main.mjs                    本地服务：静态托管 + order / 缩略图 / 剧本写盘（零依赖）
run.bat                     Windows 启动脚本（node main.mjs --port 8000 --open）
run.sh                      macOS / Linux 启动脚本（./run.sh [port]，默认 8000）
character/                  角色资源
  data/                      模型（不入库），<角色>/<模型> 两级结构
  sounds/                    语音素材（不入库）
  actions_config/            动作配置（镜像 data/ 的目录结构）
    common.json              公共 base，无专属配置时兜底
    <角色>/<模型>.json       专属演出，文件名与模型去掉打包后缀后同名，可缺省
    order.json               角色 tab 顺序，调序后自动写回
common/                     播放页与剧情页共用的运行时
  emote_core.js             内核：SDK 启动、动画循环、响应式布局（createLayout）
  action_config.js          按模型名读取配置、稀疏继承、库存对齐
  model_loader.js           PSB v4 解析 + 互斥部件配置 + 模型加载（单文件）
  gl_arm_pose.js            纹理层手臂擦除（拦截 texImage2D / texSubImage2D）
  lipsync.js                口型同步（WebAudio 离线分析 + rAF 查表）
  emote_config.js           模型与动作基础配置
  config_validator.js       配置 shape 校验（含 CLI 自测）
steins_gate/
  index.html                播放页入口
  main.js                   启动流程、交互、手臂切换、开发面板
  scene_ui.js               控制条、造型 / 排序 / 背景面板
static/                     静态资源
  css/  js/                 样式与脚本
  background/               背景图（不入库）
    .thumbs/                720p 缩略图，页面自动生成
story/                      剧情模式：可视化编辑 + 播放
  index.html                剧情页入口（单页双模式）
  story.js                  场景读写、打字机播放器、行编辑器
  cast.json                 角色 → 模型 / 语音目录 / 动作宏
  scenes/                   场景 JSON
  voices/                   TTS 合成的音频（「选择音频」「音频列表」不落盘，只有文字合成才写这里）
driver/                     E-mote 运行时（不入库）
libs/fflate.js              zip 解压（第三方）
docs/                       技术文档
```

## 技术要点

### 为什么自己解析 PSB

wasm 导出了 83 个 `EmotePlayer_*` / `EmoteDevice_*`，其中 `emoteplayer.js` 实际调用的 69 个只提供 `charaProfile` 标签与 `charaBounds`，**不暴露图集矩形、`source` 表与 `customSelectorList`**。互斥手臂在 SDK 层无法枚举，只能在字节层面读出来——这是 `PsbReader` 存在的唯一理由。

解析器只读结构区（约 1 MB），跳过其后约 200 MB 的贴图数据，浏览器内耗时约 10 ms。

### 为什么在纹理层打补丁

运行时的 wasm 为 3.9.8，不理解 PSB 4.0 的 `insert` / `delete` 语义，会把 A / C 两套手臂全部绘制。改为在 `texImage2D` 上传 atlas 时，把未选中那套手臂的矩形擦成透明，SDK 侧无需任何修改。

### 延伸阅读

| 文档 | 面向 | 内容 |
|---|---|---|
| [动作配置指南](docs/动作配置指南.md) | 要定制角色演出的人 | 配置目录镜像命名、字段速查、稀疏继承、库存对齐、CLI 校验、排错表 |
| [手臂姿势修复技术路线](docs/手臂姿势修复技术路线.md) | 想复用这套方法的人 | 根因、四条归组判据、PSB v4 解码规则、GPU 补丁要点、验证方法、演进史 |
| [手臂姿势切换实现说明](docs/手臂姿势切换实现说明.md) | 要改这份代码的人 | 选择器 API、兼容层与时间线桥、开发者面板、换模型流程、注意事项 |

## 已知限制

- 仅支持未加密、未压缩的 PSB v4 `pure.psb`。遇到 MDF / PSZ 加密壳、PSB v3 或其他平台导出，需要扩展头部与壳处理。
- 依赖 3.9.8 运行时；未来 SDK 版本行为变化可能影响纹理补丁的假设。
- 触摸命中区依赖模型自身的 `charaProfile`，缺失时降级为无反应。
- 缩略图按原图文件名存放（`static/background/.thumbs/<原名>.jpg`），用同名新图替换原图后旧缩略图不会自动失效，删掉对应文件即可重新生成。

## 参考与致谢

- **[NekoWebShow](https://github.com/Chocola-X/NekoWebShow)**（AGPL-3.0）—— 本项目的创作起点。服装名称译名对照表与 WebAudio 播放骨架参考了上游的设计思路；模型加载、PSB 解析、手臂补丁、场景 UI、动作配置与口型同步等主体实现为另行编写。
- **[FreeMote](https://github.com/UlyssesWu/FreeMote)**（**CC BY-NC-SA 4.0**）—— PSB 格式理解参考其 `PsbHeader.cs` / `Psb.cs` / `PsbValues.cs` 的格式说明；模型的打包与校验使用其命令行工具 FreeMoteToolkit v4.9.0（`PsBuild.exe` / `PsbDecompile.exe`）。本项目**不包含** FreeMote 的任何代码或二进制。
- **[fflate](https://github.com/101arrowz/fflate)**（MIT）—— `libs/fflate.js`。
- **E-mote SDK** —— © M2 Co., Ltd.，专有软件，不在本仓库分发。

## 许可

**代码**：[AGPL-3.0](LICENSE)。本项目以 [NekoWebShow](https://github.com/Chocola-X/NekoWebShow)（同为 AGPL-3.0）为创作起点，故整体沿用 AGPL-3.0 授权。

> AGPL 第 13 条：若你将本项目的修改版部署为可公开访问的网络服务，需向使用者提供对应源码。

**素材与 E-mote 运行时**：不在本仓库内，也不在本项目的授权范围内。模型 / 立绘 / 语音的版权属 MAGES. / Nitroplus，E-mote SDK 属 M2 Co., Ltd. 且其条款禁止再分发与商用。任何实际运行都需你自行合法取得这些文件并遵守其条款。

因此本项目无法商用、也不提供在线演示 —— 原因是**没有可分发的素材与运行时**，而非对上述 AGPL 代码附加了限制。

## 免责声明

- 本项目仅用于技术研究与学习，不提供、不分发任何游戏原始资源。
- 运行所需的模型、背景、语音均需使用者自备，版权归原权利人所有。
- "STEINS;GATE"、"命运石之门"及相关角色为 MAGES. / Nitroplus 的商标或注册商标。
- 若权利人认为本项目不妥，请通过 Issue 联系，将立即处理。
