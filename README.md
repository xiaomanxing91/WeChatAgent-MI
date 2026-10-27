# WeChatAgent MI version

> 源码归档仓库（GitHub-ready）。本目录包含 WeChatAgent MI 桌面端助手的**全部可编辑源码**，
> 含原生文字 / 表情包 / **图片** / **原生语音发送** 等全部当前功能。

WeChatAgent MI（M：Modeification修改，I：Integration整合）是基于sourcepro5的WeChatAgent项目进行修改的版本，修改的原版本为0.3.7.（原项目地址：https://github.com/sourcepro5/WeChatAgent/）
WeChatAgent MI 是一个 Windows 桌面 AI 助手：通过注入式原生 Hook（`version.dll`）桥接微信桌面端
（`Weixin.exe`，已验收版本 `4.1.10.27`），由 Electron 主进程托管控制台与桥接服务，并把社交对话
交给外部 DSH 智能体（DeepSeek Harness）驱动。用户消息经 OneBot 反向桥接进入社交引擎，模型通过
工具（含本次新增的原生语音发送工具）产出回复与富媒体，最终由原生 Hook 落地到微信。
**注意**这里的微信版本锁死 4.1.10.27 ！

---

## 目录结构

```
WeChatAgent MI version/
├── README.md                 # 本文档
├── .gitignore
└── resources/
    ├── app/                  # Electron 主进程源码（deployment / 控制台服务 / 启动壳）
    │   ├── main.cjs
    │   ├── deployment.cjs    # 启动时将 resources/project 落地到运行工作区
    │   ├── console-server.mjs # 控制台 HTTP 服务（端口随机，记录于 state/desktop/runtime.json）
    │   └── ...
    └── project/              # 全部可编辑源码（deployment.json 管理的文件集合）
        ├── components/
        │   ├── WeChat-Hook/           # 上游 Hook 源码（aixed/WeChat-Hook，已审计 commit）
        │   ├── qq-bridge/             # OneBot 桥接 / 社交引擎 / 各适配器
        │   └── weflow-cli/            # 工作流 CLI（源码；二进制密钥资源不入库）
        ├── packages/
        │   └── dsh-social-bridge-plugin/  # DSH 社交插件：工具定义、策略、对话上下文
        ├── scripts/
        │   ├── native-hook/           # 自定义原生 C++：voice_sender / sticker_sender / wechatagent_hook ...
        │   ├── build-hook.ps1         # 编译 version.dll（整合上游 + 自定义源码）
        │   ├── wechat_voice.py        # TTS → SILK_V3 语音合成
        │   ├── hook-onebot.mjs        # 桥接路由：SendTextMsg / SendImgMsg / SendVoiceMsg ...
        │   └── ...
        ├── public/console/            # 桌面控制台前端
        ├── roles/  docs/  extensions/ config/  # 人格预设 / 文档 / 扩展 / 示例配置
        ├── deployment.json            # 清单：1361 个可编辑源文件 + node_modules 引用
        ├── package.json  README.md  LICENSE  LICENSES.md  RELEASE_NOTES.md
```

---

## 功能特性

- 好友 / 群聊白名单、人格预设（傲娇助手、德克萨斯、洛奇希等）、独立 DSH 会话。
- 联网搜索（修改了使用bing引擎进行搜索）、网页正文阅读、图片理解（修改了或者说修复了ai阅读原图，目前仅测试了deepseekfash可用，其他模型需自行测试）、表情包管理（本地 50 张池）。
- 原生文字、图片、表情包发送（经微信原生通道，非文件转发）。
- **原生语音发送（MI 版本新增）**：模型可调用 `wechat_voice_send` 工具，把文字合成为微信原生
  语音条并发送；送达后即回复文字之后自动落地，群聊与个人均可用。
- 主动接续回合（轮流互动中自发推进）、上下文压缩、逐聊天开关。
- 新增本地生图功能，可接入comfyui等本地生图，目前仅测试了comfyui可用。模型可调用 `wechat_image_resend` 工具进行本地生图并发送到微信。

---

## 构建与依赖

详细构建可访问原项目
### 1. Node 依赖
DSH 社交插件依赖需本地安装（本仓库不提交 `node_modules`，由 `deployment.json` 引用）：

```powershell
cd resources/project/packages/dsh-social-bridge-plugin
npm install
```

### 2. 原生 Hook（`version.dll`）
由 `scripts/build-hook.ps1` 把上游 `components/WeChat-Hook`（已审计 commit `e905d07…`）与
`scripts/native-hook/*` 自定义 C++ 整合编译为 `version.dll`，注入微信进程，监听
`127.0.0.1:30001` 提供原生发送 / 查询接口。

```powershell
# 需安装 Visual Studio C++ 生成工具（v143），或在参数中指定 -MsBuild
pwsh resources/project/scripts/build-hook.ps1
```

自定义源文件：`deferred_init.*`（延迟初始化）、`http_server.*`（HTTP 服务）、
`wechatagent_hook.*`（路由：`/SendTextMsg` `/SendImgMsg` `/SendVoiceMsg` …）、
`sticker_sender.*`、`sticker_trace.*`、`voice_sender.*`（**含 `0x02` 前缀修复**，保证手机端可播放）。

### 3. 语音合成依赖（Python）
`scripts/wechat_voice.py` 链路：`edge-tts` 文本转语音 → `miniaudio` 解码为 24kHz 单声道 SIGNED16
WAV → `pilk` 编码为 SILK_V3，落盘 `state/generated-voices/<sha256>.silk`。

```powershell
pip install edge-tts miniaudio pilk
```

### 4. Reader 依赖（Python，消息读取）
```powershell
pip install -r resources/project/scripts/reader-requirements.txt
# sqlcipher3==0.6.2 cryptography==50.0.2 zstandard==0.25.0 pycryptodome==3.23.0 Pillow==12.3.0 imageio-ffmpeg==0.6.0
```

---

## 部署模型（铁律）

`resources/project/deployment.json` 是**清单**：列出全部可编辑源文件及其 SHA-256（`sourceHashes`）。
每次应用启动，`resources/app/deployment.cjs` 读取该清单，逐项把模板写入运行工作区
（`%AppData%/WeChatAgentMI/workspace`），哈希不同即覆盖。

**因此修改既有功能必须“两边同时改”**，否则重启即被覆盖：

1. 先在运行工作区改并测试；
2. 同步改 `resources/project/` 下同名源文件；
3. 若新增文件，追加到 `deployment.json` 的 `files`（并刷新对应 `sourceHashes`）；
4. 复核：模板与工作区哈希全等（注意 `cordis.patch.yml` 由 `project-config.mjs` 每次启动重写，除外）。

**跳过覆盖项**（用户态，重启保留）：`state/**`、`roles/**`、`config/wechatagent.json`。
注意 `deployment.json` **不能带 BOM**（`deployment.cjs:11` 直接 `JSON.parse`，带 BOM 会导致启动失败）。

---

## 许可

见 `resources/project/LICENSE` 与 `resources/project/LICENSES.md`（第三方组件许可汇总）。
