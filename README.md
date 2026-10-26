# NekoDock · 猫坞

自托管的多实例 AI 聊天机器人控制台。

通过 Web 控制台管理多个 QQ Bot。每个实例绑定一个群聊或私聊，使用独立 Worker 容器、SQLite 数据库、Pi 会话和工作目录。NapCat 负责 QQ 登录与收发，桥接层负责调度和发送，Pi SDK 负责模型调用与工具执行。

## 部署控制台

需要 Docker Engine 和 Docker Compose。首次部署：

```bash
cp compose.console.yaml.example compose.console.yaml
docker compose -f compose.console.yaml --profile build build worker-image
docker compose -f compose.console.yaml up -d --build console
```

打开 [http://127.0.0.1:4180/](http://127.0.0.1:4180/)，设置管理员密码，创建实例，填写 NapCat、模型和人格配置，再启动。控制台端口默认只绑定宿主机回环地址；远程访问可使用 SSH 转发。

`compose.console.yaml.example` 是部署样板，实际 `compose.console.yaml` 不纳入版本管理。共享 Worker 镜像为 `nekodock-worker:latest`，控制台镜像为 `nekodock-console:latest`；`worker-image` 仅用于构建，实际 Bot 容器由控制台创建。每个实例的数据卷独立，只有控制台挂载 Docker Socket，Worker 不挂载。

受管实例的设置统一保存在控制台数据库。无需为每个 Bot 创建 env、Compose 或人格文件。群聊／私聊类型及目标号码创建后不可修改，更换绑定时创建新实例。复制实例只复制配置，新实例从空会话开始。

### NapCat 连接

在 NapCat 中启用**正向 WebSocket 服务端**，设置监听端口与访问 Token。Worker 是主动连接它的客户端；不要将它配置为等待反向 WebSocket 连接。

| 部署位置 | Worker 中填写的示例地址 |
| --- | --- |
| NapCat 与 Worker 同一 Docker 网络 | `ws://napcat:3002` |
| NapCat 或转发端口在 Docker 宿主机 | `ws://host.docker.internal:3002` |
| NapCat 在其他可达服务器 | `wss://napcat.example.com` 或对应 `ws://` 地址 |

`127.0.0.1` 在容器内指向容器自己。访问宿主机服务应使用 `host.docker.internal`；样板和动态 Worker 配置包含 `host-gateway` 映射，无需切换为 host 网络。宿主机端口还需满足 Docker 到该监听地址的可达性。地址使用根路径，Token 单独填写，不放进 URL。

同一个 NapCat 可同时连接多个 Worker。每个 Worker 先按目标类型、群号或 QQ 号筛选，再保存和处理；机器人自己的消息被过滤。控制台拒绝同一 NapCat 地址、同一目标同时运行多个实例。不同实例对 QQ 用户显示为 NapCat 登录的同一账号。

## 实例配置

配置按版本保存，界面分别显示已保存和已生效的版本。运行中的配置修改等待当前轮生成与已受理发送结束后应用。供应商密钥加密保存，读取配置时只返回是否已设置，不回传密钥正文。

### 模型服务

每个实例显式配置 Base URL、模型 ID、API Key 和 API 协议。没有隐式的默认账号或供应商；支持不需要密钥的本地服务。

| 配置 | 说明 |
| --- | --- |
| API 协议 | `Responses` 或 `Chat Completions`，对应 `openai-responses` / `openai-completions` |
| Base URL | HTTP(S) 基础地址，通常包含 `/v1`，不包含 `/responses` 或 `/chat/completions` |
| 模型 ID | 按供应商要求填写完整名称；样板中的 `your-model-id` 需替换为实际模型 ID |
| 思考等级 | 英文 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；必须符合模型及协议实际支持 |
| 最大输出 Token | 默认 `8192`，与 QQ 文本分段上限分开 |

图片输入、思考参数分别通过模型能力开关声明。关闭思考参数后保留界面中的等级选择，但不发送该参数。配置不能赋予上游模型原本不支持的能力；错误请求不会自动切换协议或重新执行整批消息。

### 人格与基础指令

人格直接在 Web 的“人格设定”中编辑，作为本实例的身份、性格、称呼和语言风格。Worker 直接把人格传给 Pi SDK，不生成或挂载 `AGENTS.md`，也不读取 Pi 的用户配置、扩展和工作目录人格文件。

[prompts/base-instructions.md](prompts/base-instructions.md) 提供英文基础指令，包含日常聊天、消息身份与引用、任务执行、工具使用和容器环境说明。每轮以当前基础指令和该实例人格构成有效 system prompt；用户输入只提交按接收顺序排列的新增消息，不重复发送桥接规则介绍。

日常交流优先回应眼前的话题，按时间、话题连续性和明确引用使用历史，不强行关联旧闲聊。长任务只在实质结果、重要阻碍、需要对方决定或完成时发送中途回复。面对同一阻碍，最多进行三次有依据的尝试，随后如实说明问题和未完成部分。

### 文件与终端权限

| 开关 | 实际权限 |
| --- | --- |
| 允许写入文件 | 注册 `edit` / `write` 工具；文件工具限制在当前工作目录内，检查路径与符号链接 |
| 允许终端命令 | 注册 `bash` 工具；以容器内 `node` 用户权限运行命令 |

读取工具 `read` 始终可用，也能读取支持格式的本地图片。终端命令的工作目录不是沙箱，启用后可访问 `node` 用户有权访问的容器文件。文件写入开关限制文件工具，不会限制已授权 Bash 命令的写入能力。每个实例继续通过独立非 root 容器和独立数据卷隔离。

管理凭据和供应商密钥不会传入 Bash 环境。Pi 配置由 Worker 显式装配，不要求维护 `models.json`、`settings.json` 或 MCP 服务配置。

## 消息与回复

每个实例只有一个串行执行循环，WebSocket 接收不被模型执行阻塞：

```text
QQ 消息落库 → 决定批次和是否允许回复 → Agent 执行
                                ↓
             send_message 受理 → 持久化 → 按序发送到 NapCat
                                ↓
             Agent 结束 + 发送收尾 → 推进处理位置 → 下一批
```

群聊中，被 @ 时回复；其他非表情包消息按配置概率触发。私聊正常回复。普通未触发消息作为背景保存，随下一次触发提交；积压超过批次上限时，可以先追加背景上下文，不调用模型生成。

处理期间收到的普通群消息只保存，不抽样、不提示，即使回复概率为 100% 也相同。此时被 @ 会立即回复“我正在想上面的消息怎么回，你等会哦”，问题排入后续批次；等待提示不进模型上下文，也不转成语音。

### `send_message`

所有 QQ 回复通过 Pi 自定义工具 `send_message` 发送，参数是有序的 `messages` 数组：

```json
{
  "messages": [
    {"type": "text", "text": "这是生成的图片。"},
    {"type": "image", "path": "/data/workspace/output/chart.png"}
  ]
}
```

一次调用可发送多条消息，一轮也可在重要节点多次调用。目标群或私聊由实例固定，工具不能指定其他接收对象。工具先保存请求和分段，再返回 `{"accepted":true}`，父 Worker 随后异步发送；`accepted` 表示已受理，不代表已经送达或已读。

Pi 的最终 assistant 文本只用于结束执行，不自动发送到 QQ，也没有固定的 JSON 收尾协议。执行完成由 SDK 生命周期判断，再由父 Worker 完成已接受消息的发送收尾。发送工具不可用或结果中断时，不要求模型查询状态或补发。

群聊支持在同一条消息中混合艾特和文字：

```json
{
  "messages": [
    {"type": "message", "segments": [
      {"type": "at", "userId": "2001"},
      {"type": "text", "text": " 这是问题一的回答。"}
    ]},
    {"type": "message", "segments": [
      {"type": "at", "userId": "2002"},
      {"type": "text", "text": " 这是问题二的回答。"}
    ]}
  ]
}
```

`at.userId` 来自消息的 `senderId` 或对话中明确给出的 QQ 号，转换为 OneBot 原生 `at` 段。纯文本 `@昵称` 不产生艾特。多个用户的问题可在同一轮分别回复；私聊不提供群聊艾特类型。长文字按 Unicode 码点拆分，艾特保持完整和相对顺序。

### 指令

目标群或私聊支持以下独立文本指令，可附带引用或 @ 本机器人。群内无需 @，任意成员均可使用；带额外参数、其他人的 @ 或图片附件时按普通消息处理。

| 指令 | 功能 |
| --- | --- |
| `/help` | 列出指令；不调用模型，不改变会话或普通消息队列 |
| `/new` | 重置当前会话，下条普通消息新建空会话；跳过指令到达前未处理的消息，保留之后的新消息和工作目录 |
| `/compact` | 使用 Pi 压缩当前会话，保持会话关联；没有会话时直接提示 |

指令在当前轮生成和发送结束后优先执行，处理完成后直接回复确认。指令、原始事件和确认回复不进入模型上下文；控制队列只保存去重和执行状态元数据。确认发送失败时重试确认，已持久化的重置或压缩操作不会再次执行。压缩失败后可以再次发送 `/compact`。

### 失败与中断

1. 模型调用前持久化“已开始”标记，每批最多执行一次。失败或超时后记录终态、推进处理位置，不自动重跑同一批。
2. 每个普通发送分段在准备或发送前记录尝试标记。收到匹配 `echo` 的 `status=ok`、`retcode=0` 才确认成功；准备失败、明确拒绝或结果未确认都结束该项，继续后续项，不补发。
3. Agent 后续失败不撤销已经受理或发送的回复。重启后，已开始批次记为中断，剩余普通回复不续发；未开始的新消息继续处理。
4. 自动模型重试关闭，上下文溢出后的自动重跑被阻止。正常达到阈值的预先压缩和手动压缩保留；控制指令确认使用独立重试队列。
5. Web 安全重启等待当前轮自然结束。Agent 子进程超时或被取消时可单独终止，父 Worker 继续做发送和存储收尾。

QQ 发送与 SQLite 不能原子提交。发送成功但回执丢失、记录尝试后进程退出，都可能导致未确认或丢失的消息；本项目接受这种结果，不自动补发。这个策略不保证送达，其他工具也不具备恰好一次执行保证。NapCat 断线期间未收到的事件不由本地恢复。

## 会话与上下文

每轮启动一个运行 Pi SDK 的 Agent 子进程，通过 Node IPC 调用父 Worker 的回复队列。子进程结束后退出，下一轮打开同一个 Pi 会话；会话文件保存在实例数据卷的 `/data/pi/sessions/`。

用户输入是新增消息 JSON 数组，包含 `messageId`、`senderId`、`senderName`、`time`、`text`、`replyTo`，有图时附加图片及本地路径。触发概率、忙碌判断等调度信息留在桥接层。一次输入可以包含多个人、多个话题，模型按身份与引用关系理解。

| 上下文参数 | 默认值 |
| --- | ---: |
| 窗口 | 200,000 Token |
| 自动压缩阈值 | 160,000 Token |
| 预留空间 | 40,000 Token |
| 最大输出 | 8,192 Token |
| 压缩保留的近期内容 | 约 20,000 Token，受阈值约束 |

窗口减去阈值对应 Pi 的 `reserveTokens`，且必须不小于最大输出预算。达到阈值时整理较早历史，保留近期内容；原始 QQ 记录独立保存在 SQLite。窗口配置不会提高供应商的实际容量，`BATCH_SIZE` 也不代表上下文长度。

Web 会话页展示 QQ 来信、已受理回复、工具调用和图片／语音附件，生成与压缩时显示实际执行状态，失败可查看原因。服务商返回的可见思考内容按轮次合并、默认折叠；生成时持续更新，结束或失败后保留。未返回可见思考内容的请求不生成思考记录，签名与加密字段不进入展示数据。

会话事件先在 Worker 本地持久化，通常合并 100 ms 后独立上传；5 秒心跳只同步运行状态。页面首次获取快照后，通过当前实例的 SSE 接收事件和 Token／上下文增量，不因心跳或其他实例变化重新拉取会话。断线后按 `Last-Event-ID` 从已提交游标补发，重复事件去重；新会话、消息迁移或无效游标使用最新快照恢复。上传失败保留本地记录并退避重试，日志只记录传输元数据。

累计 Token 包含每次请求的输入与输出，缓存读取包含在输入内，缓存命中率为缓存读取 / 输入；未知字段显示 `—`。当前上下文占用与累计用量分开，以 Pi 当前上下文统计为准，估算值明确标记。

## 搜索、图片与语音

### 网络搜索

同时只启用一个搜索供应商，目前为 `none` 或 `tavily`。选择 Tavily 后向 Pi 注册 `web_search`、`web_fetch`，直接调用现有 Provider，不启动搜索 MCP 子进程。

配置 API Key、HTTP(S) 基础地址、`basic` / `advanced` 深度、默认结果数和超时。程序在基础地址后追加 `/search` 或 `/extract`；代理服务在宿主机时，将地址中的主机部分填写为 `host.docker.internal`，端口和路径按代理服务的实际配置填写。工具失败返回可诊断错误，不自动重试；调用额度按供应商规则计算。

### 图片

入站普通图片从 NapCat 的 HTTP(S) 地址或 Base64 读取并保存到工作目录 `.qq-images/`，支持图片输入的模型通过 Pi 图片内容接收。模型声明不支持图片时不附加图像输入；不可用的图片保留可读元数据，不根据文件名猜测内容。

出站图片使用工作目录内的真实文件路径或 HTTP(S) URL。桥接层读取后保存 Base64 快照，通过 OneBot `image` 段发送，NapCat 无需与 Worker 共享文件系统。默认单图上限 10 MiB、下载超时 15 秒，支持 PNG、JPEG、GIF、WebP 格式检查。

入站语音、视频、表情包和文件暂只保留元数据；出站视频、表情包及文件列为 TODO。普通图片不等同于专门的表情包能力。图片缓存和任务产物目前不自动清理。

### 原生语音回复

同时只启用一个 TTS 供应商：`none`、`edge-tts` 或 `mimo`。语音回复另有总开关和独立概率；关闭时保留供应商配置，开启时必须选择有效供应商。概率按每条逻辑文字回复抽样，与群聊是否参与回复的概率分开。

| 供应商 | 配置与行为 |
| --- | --- |
| Edge TTS | 无需 API Key；选择音色 ID，可调整语速、音量、音调 |
| 小米 MiMo | 单独的 API Key、服务地址、`mimo-v2.5-tts` 模型、预置音色及可选朗读风格 |

MiMo 预置音色：`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`。额外朗读风格最多 4000 个 Unicode 码点，只影响语音合成，不进入聊天上下文。例如：

```text
以自然、清晰的普通话朗读，语速适中，句间适当停顿。
```

语音通过 OneBot `record` 段发送，在 QQ 中可直接播放。选中的逻辑文字按 `min(REPLY_MAX_CHARS, TTS_MAX_CHARS)` 分段，音频快照持久化后发送；NapCat 端需要具备 MP3 解码与 QQ 语音转换能力。群聊中的原生艾特保留，不朗读 QQ 号。图片、指令确认和忙碌等待提示不转语音。

合成超时、无效音频或超过大小限制时回退到原文字。普通语音或回退文字的发送仍只尝试一次，失败或回执丢失不补发。选中的云端 TTS 服务会收到待朗读文字，MiMo 还收到朗读风格。

## 镜像工具

Worker 使用 Node.js 24、TypeScript 编译产物和锁定版本的 Pi SDK，不安装额外 Agent CLI。镜像以非 root 的 `node` 用户运行，包含：

| 类别 | 工具 |
| --- | --- |
| 脚本 | Node.js / npm / npx，Python 3 / venv / pip，uv / uvx |
| HTTP、文件与 JSON | curl、jq、git、ripgrep、file、tar、gzip、zip、unzip、xz、zstd |
| 图像与字体 | Pillow、Noto CJK 中文字体、fontconfig |
| 数据与诊断 | sqlite3、ps / top / pgrep、ip / ss、dig、nc |
| 浏览器与语音 | Playwright 1.64.1、配套 Chromium、Edge TTS 7.3.1 |

Bash 权限开启后，Agent 可以执行这些命令。Python 新依赖安装在工作目录虚拟环境，例如 `python -m venv --system-site-packages .venv`；`--system-site-packages` 允许复用 Pillow。Playwright 从 `/data/workspace` 及子目录支持普通 ESM 与 CommonJS 导入，浏览器目录为 `/opt/playwright-browsers`。

## 日志、监控与统计

Web 左侧“后端日志”与“实例总览”“监控”同级，查看 Console 服务；每个实例的“日志”页只查看该 Worker。日志页面每 2 秒读取 Docker 日志，通过 SSE 更新，支持筛选、搜索、跟随、断线重连。最多显示当前容器最近 500 行，不在数据库中另行归档。

宿主机也可查看：

```bash
docker compose -f compose.console.yaml logs --tail=100 -f console
docker logs --tail=100 -f napcat-managed-INSTANCE_ID
```

`INSTANCE_ID` 为控制台的实例 ID。日志时间固定使用东八区，格式为 `2026-01-01T12:00:00.123+08:00 INFO event field=value`。

| 环节 | 诊断字段 |
| --- | --- |
| 批次与发送 | `through_seq`、`run_ref`、`request_ref`、`delivery_id`、尝试和终态 |
| Pi 执行 | `agent.run.*`、`operation`、`api`、`run_id`、`accepted_requests`、耗时、退出和错误码 |
| 工具与压缩 | 工具开始／结束、`item_ref`、状态、耗时和压缩阶段 |
| NapCat | 建连、断开、重连、`echo`、ACK、retcode 与超时 |
| 搜索与 TTS | 供应商、选中路由、来源数、HTTP 状态、字节数和回退 |

`failed` 表示准备失败或明确拒绝；`unconfirmed` 表示可能已经发出但没有成功回执，两者均不补发。`message_ref`、`sender_ref`、`session_ref` 等为短指纹。日志只保留选定元数据，不展示模型原始错误正文、聊天内容、工具参数和结果、完整 URL、文件内容或凭据；会话页按鉴权展示脱敏后的聊天与工具记录。Agent 原始 stderr 不直接转发。

监控独立展示所有实例的 CPU、内存工作集、网络速率和批次端到端耗时。每 15 秒采样，原始数据保留 7 天，之后按 1 分钟聚合并保留 30 天；缺失数据不补成零。时间控件支持快捷范围、绝对时间、缩放和刷新间隔。

今日统计按东八区自然日；入站按真实消息 ID 去重，回复按成功 NapCat ACK 的普通出站条数统计，排除指令确认和忙碌提示。`/new` 不清零历史统计。

## 数据、备份和更新

控制台目录：

```text
console-data/
  console.sqlite3  # 配置版本、实例、账号、事件和统计
  metrics.sqlite3  # 独立指标库
  master.key       # 配置加密主密钥，必须和配置数据库一起备份
```

每个实例的独立数据卷：

```text
/data/
  bridge.sqlite3      # 目标、消息、处理位置、控制队列、发送尝试和会话事件
  pi/sessions/        # Pi 持久会话
  workspace/          # 脚本、下载、图片缓存和生成产物
  console-media/      # 供鉴权会话页面读取的媒体快照
  managed-config.enc  # 控制台不可用时使用的加密配置缓存
```

SQLite 使用 WAL 和 FULL 同步。在线备份使用 SQLite Backup API；或安全停止对应服务后备份完整目录。不要在 WAL 活跃时只复制单个 `.sqlite3` 文件，也不要只备份数据库却遗漏 `master.key`。单个目标的数据卷只运行一个 Worker。

功能、提示词或镜像依赖更新并验证后，公共镜像只构建一次：

```bash
docker compose -f compose.console.yaml --profile build build worker-image
docker compose -f compose.console.yaml up -d --build console
```

在 Web 先对一个验证实例执行“重启”，确认运行正常后，再逐个重启其他受管实例。控制台等待当前轮生成和发送收尾后重建容器，复用原卷；检查运行状态、NapCat 连接、配置版本及 Pi 会话。不要强杀仍在处理或有待发记录的容器，不要启动复用同一卷的第二个 Worker。

控制台不可用时，Worker 可从加密缓存读取上次配置并继续处理；会话事件先在本地持久化，控制台恢复后按序同步。接管已有实例后，不要启动任何复用原数据卷的旧容器。

## 本地开发

需要 Node.js 24.16.0 或更高的 24.x 版本。安装与验证：

```bash
npm ci
npm test
npm run build:web
```

本地控制台开发、Worker 配置参数、断点调试和隔离 Docker 验收见 [开发文档](docs/development.md)。测试使用模拟模型和 NapCat，运行参数由测试夹具直接注入。部署统一使用上文的控制台 Compose 样板，在 Web 中管理各实例。

### 代码入口

| 文件 | 责任 |
| --- | --- |
| `src/main.ts`、`src/managed-worker.ts` | Worker 生命周期、受管配置、事件同步和安全排空 |
| `src/pi.ts`、`src/pi-child.ts`、`src/pi-tools.ts` | Agent 子进程、Pi SDK、会话、压缩和工具适配 |
| `src/processor.ts`、`src/store.ts` | 串行批次、控制指令、持久化与一次发送尝试 |
| `src/napcat.ts`、`src/incoming.ts` | OneBot WebSocket、消息过滤、忙碌策略和原生消息发送 |
| `src/console/`、`web/src/` | 配置、鉴权、会话、日志、容器管理与 Web 页面 |

## TODO

- 专门的表情包与文件发送能力。
- 入站语音、视频及文件内容解析。
- 长期记忆与历史检索，任务产物清理策略。

## 参考

- [Pi SDK](https://pi.dev/docs/latest/sdk)：会话、工具、执行事件和嵌入式运行。
- [Pi 模型配置](https://pi.dev/docs/latest/models-configuration)：API 与模型能力。
- [Pi 压缩](https://pi.dev/docs/latest/compaction)：上下文预算和历史压缩。
- [NapCat](https://napneko.github.io/)：部署、网络服务与 QQ 消息能力。
- [OneBot 11](https://github.com/botuniverse/onebot-11)：消息段与 API 协议。
