# SteinsGateLabStage

在浏览器中运行《STEINS;GATE》角色的 E-mote 动态立绘，支持手臂姿势切换、触摸反应、语音与口型同步。

> **本项目为非官方、非商业的二次创作，与 MAGES. / Nitroplus / M2 Co., Ltd. 均无关联。**
> 仓库**不包含**任何游戏原始素材（模型、立绘、背景、语音），也**不包含** E-mote 运行时（专有 SDK）。

[English](README.en.md)

---

## 内容

仓库包含两个页面：

| 入口 | 说明 |
|---|---|
| `index.html` | 角色档案页（世界观介绍 + Labmem 名鉴），纯静态 |
| `steins_gate/index.html` | E-mote 播放页（**主功能**），需要下方"运行前提"中的文件才能启动 |

## 功能

- **模型直读**：直接解析 `.pure.psb`（PSB v4）二进制，无需反编译、无需预生成配置、无需构建步骤。模型放进 `data/<角色>/` 后自动出现在角色 tab；触摸反应按[动作配置指南](docs/动作配置指南.md)逐模型配置。
- **手臂姿势切换**：针对 PSB 4.0 的互斥追加部件（`insert` / `delete`），在 GPU 纹理上传阶段打补丁，擦除未选中的那套手臂。适用于只支持到 3.9.8 的 SDK 运行时。
- **触摸反应**：按 `charaProfile` 部位（eye / mouth / bust / top …）划分命中区，命中后从动作池随机抽一条执行，可携带语音与变量插值。
- **口型同步**：WebAudio 离线分析音频包络后按 rAF 查表驱动 `face_talk`；音频不可用时明确告警并跳过语音与口型，不提供第二条播放路径。
- **开发者面板**：内置选择器 / 姿势 / 变量调试入口（`installDevPanel`）。

## 运行前提

**克隆本仓库后无法直接运行**，需要自备两类文件（均已被 `.gitignore` 排除）：

1. **E-mote 运行时**，放到 `driver/`
   - 必需：`emotedriver.js`、`emotedriver.wasm`（本项目验证于 `driver_wasm_modularize` 构建）、`emoteplayer.js`
   - 获取方式：向 [M2 Co., Ltd.](https://emote.mtwo.co.jp/) 申请 E-mote SDK
   - ⚠️ 该 SDK 为专有软件，其条款禁止再分发。**请勿将 `driver/` 提交到任何公开仓库**，本项目亦不会提供。

2. **模型与素材**，放到 `data/` 与 `steins_gate/background/`
   - `data/<角色>/<名称>.pure.psb.zip` — 每个 zip 内含一个 `pure.psb`
   - `steins_gate/background/` — 背景图，`thumbs/` 下为缩略图
   - 需从你合法持有的游戏副本中提取，本项目不提供任何素材。

准备好后，用任意静态服务器启动（`fetch` 加载要求 HTTP，不能直接开 `file://`）：

```bash
python -m http.server 8000
# 访问 http://localhost:8000/steins_gate/
```

## 目录结构

```
index.html                  角色档案页
actions-config/             动作配置（镜像 data/ 的目录结构）
  common.json                公共 base，无专属配置时兜底
  <角色>/<模型>.json         专属演出，文件名与模型去掉打包后缀后同名，可缺省
steins_gate/
  index.html                播放页入口
  main.js                   启动流程、画布布局、手臂切换、开发面板
  model-loader.js           PSB v4 解析 + 互斥部件配置 + 模型加载（单文件）
  gl-arm-pose.js            纹理层手臂擦除（拦截 texImage2D / texSubImage2D）
  lipsync.js                口型同步（WebAudio 离线分析 + rAF 查表）
  scene-ui.js               场景 UI、背景与交互
  actions-config-loader.js  按模型名读取配置、稀疏继承、库存对齐
  emote-config.js           模型与动作基础配置
  config-validator.js       配置 shape 校验（含 CLI 自测）
driver/                     E-mote 运行时（不入库）
libs/fflate.js              zip 解压（第三方）
data/                       模型（不入库）
sounds/                     语音（不入库）
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
