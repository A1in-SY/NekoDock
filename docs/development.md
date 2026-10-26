# 开发与调试

使用方式和容器部署见 [README](../README.md)。受管实例的模型、人格、消息策略及服务凭据由控制台数据库管理，再通过受管配置协议下发给 Worker；不需要为实例维护环境文件、独立 Compose 或人格文件。

本文的 Worker 参数表用于理解配置适配、编写测试和排查问题，不是另一套部署步骤。默认值和校验规则分别以 `src/config.ts`、`src/console/settings.ts`、`src/web-search.ts`、`src/tts.ts` 为准。

## 安装与验证

使用 Node.js **24.16.0 或更新的 24.x**，安装项目锁定的依赖：

```bash
npm ci
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run build:all` | 编译服务端及测试到 `dist/`，检查并构建前端到 `dist/web/` |
| `npm run check` | 仅检查服务端和测试的 TypeScript 类型 |
| `npm test` | 先编译，再运行服务端与前端测试；需要镜像的测试未配置镜像时跳过 |
| `npm run test:web` | 仅运行前端逻辑测试 |
| `npm run build:web` | 检查前端类型并构建静态文件 |

涉及共享协议或完整行为的变更，运行 `npm test` 和 `npm run build:web`。仅修改某一模块时，可先使用下一节的定向测试定位问题。

## 使用模拟服务调试

`test/fixtures/pi-e2e.ts` 在临时目录中创建数据，并启动模拟模型 HTTP/SSE 服务与模拟 NapCat WebSocket 服务。测试使用合成目标和凭据，不需要真实 QQ、模型 API Key 或云端服务。

先编译测试：

```bash
npm run build
```

选择相关测试运行：

```bash
node --test dist/test/config.test.js dist/test/web-search.test.js dist/test/tts.test.js
node --test dist/test/pi-runner.test.js dist/test/pi-thinking.test.js
node --test dist/test/e2e.test.js dist/test/reply-tool-e2e.test.js
node --test dist/test/managed-worker.test.js dist/test/conversation-stream.test.js
```

按测试名称缩小范围：

```bash
node --test --test-name-pattern 'provider-visible thinking' dist/test/pi-runner.test.js
```

需要断点时，直接启动带模拟模型的测试文件，在调试器中继续执行：

```bash
node --inspect-brk --enable-source-maps dist/test/pi-runner.test.js
```

Pi 在独立 Node 子进程中执行；上面的调试器首先连接测试及父进程。需要调试子进程时，在 IDE 中启用 Node 子进程自动附加。不要把模型、NapCat 或控制台管理凭据写入调试配置。

容器行为也沿用这些 fixture。`BRIDGE_E2E_IMAGE` 指定已经构建的测试 Worker 镜像后，fixture 会创建临时 Worker，并在结束时清理。以下命令只用于验收，不构成独立 Worker 部署流程：

```bash
BRIDGE_E2E_IMAGE=nekodock-worker:latest node --test dist/test/e2e.test.js dist/test/console-managed-e2e.test.js
```

Docker 测试需要可访问的 Docker Engine；`DOCKER_SOCKET` 可覆盖默认 `/var/run/docker.sock`。fixture 通过 `host.docker.internal` 访问宿主机的模拟服务。受管验收创建独立网络和数据卷，不复用已有实例的数据卷。不要向真实 QQ 会话发送测试消息。

## 本地控制台与前端

已执行 `npm run build:all` 后，可以启动本地控制台，用于界面和 API 调试：

```bash
CONSOLE_HOST=127.0.0.1 CONSOLE_DATA_DIR=./data/console-dev npm run start:console
```

访问 `http://127.0.0.1:4180/`，首次使用时设置管理员密码。确保此端口空闲；开发数据目录应与实际控制台数据分开。控制台仍会使用 Docker 管理实例，完整容器行为优先通过隔离的受管验收测试验证。

修改 React 页面时，可在第二个终端运行 Vite：

```bash
npx vite web
```

访问 `http://127.0.0.1:4178/`；默认将 `/api` 代理到 `http://127.0.0.1:4180`。如修改后端端口，需同时调整 `web/vite.config.ts` 的开发代理地址。Vite 不替代控制台后端。

控制台进程参数由 `src/console/main.ts` 读取：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `CONSOLE_HOST` | `0.0.0.0` | 后端监听地址；仅在本机调试时可显式设为 `127.0.0.1` |
| `CONSOLE_PORT` | `4180` | HTTP 端口，整数 `1..65535` |
| `CONSOLE_DATA_DIR` | `data/console` | 控制台数据库、加密主密钥等的持久化目录；相对路径按当前工作目录解析 |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker Engine Unix Socket 路径 |
| `WORKER_IMAGE` | `nekodock-worker:latest` | 控制台创建 Worker 时使用的镜像名；镜像须已存在于该 Engine |
| `WORKER_NETWORK` | `nekodock` | 受管 Worker 所在的 Docker 网络名 |
| `WORKER_CONSOLE_URL` | `http://console:4180` | Worker 访问控制台的内部地址，必须从 Worker 容器可达；本地运行后端时不能直接假设 Compose 服务名 `console` 可解析 |

监听地址与 `WORKER_CONSOLE_URL` 是两个方向的配置。上面的回环地址启动示例适合本地界面调试；让真实容器访问宿主机上的开发后端时，需要另外选择容器可达的地址及监听方式，不要修改已有部署来验证。

## Worker 配置适配参考

Worker 的入口 `dist/src/main.js` 同时保留受管协议和直接读取进程环境的能力。后者供测试 fixture 和定向开发使用；实际实例统一由控制台创建和配置。

受管 Worker 的 `CONSOLE_URL`、`BOT_INSTANCE_ID`、`WORKER_TOKEN` 由控制台注入，三者必须同时存在；实例设置来自控制台快照，而不是每实例环境文件。控制台 API 使用**百分比、秒和 MiB**，`settingsToEnv()` 转换为下表的 **`0..1` 概率、毫秒和字节**。布尔值使用小写 `true` / `false`；未注明上限的正整数仍需是 JavaScript 安全整数。

### 连接、绑定与数据

| 参数 | 默认值 / 范围 | 含义 |
| --- | --- | --- |
| `NAPCAT_WS_URL` | 必填，`ws://` / `wss://` | NapCat 正向 WebSocket 服务端地址，不能在 URL 中嵌入用户名或密码；令牌单独传递 |
| `NAPCAT_TOKEN` | 空字符串 | NapCat WebSocket 的认证令牌；仅服务端关闭认证时留空 |
| `TARGET_TYPE` | 必填，`group` / `private` | 绑定群聊或私聊；受管实例创建后不可更改 |
| `TARGET_ID` | 必填，正整数形式的字符串 | 群号或对方 QQ 号；不同目标使用独立数据目录和数据卷 |
| `DATA_DIR` | 直接运行时 `./data`；受管容器 `/data` | SQLite 消息、游标、发送记录和受管配置缓存目录 |
| `AGENT_HOME` | `DATA_DIR/pi` | Pi 会话状态目录，不需要登录配置或人格文件 |
| `AGENT_WORKSPACE` | `DATA_DIR/workspace` | 脚本、下载和生成文件的持久工作目录；文件工具及本地待发送图片须位于其中 |
| `RANDOM_REPLY_PROBABILITY` | `0.05`，`0..1` | 普通非表情包群消息的回复概率；明确艾特触发回复，私聊正常回复。忙碌时普通群消息不触发，即使概率为 `1` |

所有目录参数都解析为绝对路径。容器内的 `127.0.0.1` 指容器自身；访问 Docker 宿主机服务时使用该环境支持的宿主机地址，例如 `host.docker.internal`。

### 模型与上下文

| 参数 | 默认值 / 范围 | 含义 |
| --- | --- | --- |
| `AGENT_BASE_URL` | 空；生成和压缩前必须显式提供 | HTTP(S) API 基础地址，保留服务端要求的 `/v1` 等路径，不附加 `/responses` 或 `/chat/completions`；不得包含凭据、查询参数或片段 |
| `AGENT_API_KEY` | 空 | 模型服务凭据；只有服务允许匿名调用时可留空。通过 SDK 传递，不放入 Bash 环境或命令行参数 |
| `AGENT_MODEL` | 空；生成和压缩前必须显式提供 | 服务端接受的确切模型 ID，最多 `1024` 字符，不含控制字符；设置基础地址时也必须设置模型 |
| `AGENT_API` | `openai-responses` | `openai-responses` 或 `openai-completions`（Chat Completions）；失败后不自动切换协议或重试 |
| `AGENT_REASONING` | 空 | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`；只使用供应商与模型实际支持的等级，空值交由 SDK 默认行为处理 |
| `AGENT_SUPPORTS_IMAGES` | `true` | 是否向模型传入收到的图片；关闭后不传附件 |
| `AGENT_SUPPORTS_REASONING` | `true` | 是否声明模型支持推理参数；关闭后不发送推理等级 |
| `AGENT_CONTEXT_WINDOW` | `200000` Token，正整数 | 模型真实上下文容量声明，不能扩大供应商的实际限制 |
| `AGENT_AUTO_COMPACT_TOKEN_LIMIT` | `160000` Token，正整数 | 自动压缩历史的阈值，必须小于上下文窗口 |
| `AGENT_MAX_OUTPUT_TOKENS` | `8192` Token，正整数 | 每次模型响应的输出预算，不能大于“上下文窗口减去压缩阈值”的预留量；与 QQ 文本分段长度独立 |
| `AGENT_TIMEOUT_MS` | `600000` 毫秒，正整数 | 整个 Agent 子进程轮次的超时，默认 `10` 分钟；不包括之前的图片下载和之后的 QQ 发送，超时不重放批次 |

### 人格与工具

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `AGENT_PERSONA` | 空字符串 | 传给 Pi SDK 的人格正文；受管实例在控制台编辑，不挂载 `AGENTS.md` |
| `AGENT_ALLOW_FILE_WRITES` | `true` | 是否注册工作目录内的 `write` / `edit` 工具；`read` 始终可用 |
| `AGENT_ALLOW_COMMANDS` | `false` | 是否注册 Bash；以实际进程用户的系统权限执行，不限制在工作目录。仅为可信实例开启 |

直接运行时的 Bash 权限取决于宿主机用户；镜像中则为 `node` 用户。关闭文件写工具不能限制已开启的 Bash。

### 网络搜索

一次只启用一个供应商。选择 `none` 时不注册搜索工具，不校验或调用其他供应商配置；选择 Tavily 时，该服务会收到搜索或提取请求。

| 参数 | 默认值 / 范围 | 含义 |
| --- | --- | --- |
| `WEB_SEARCH_PROVIDER` | `none` | `none` 或 `tavily` |
| `TAVILY_API_KEY` | 空；启用 Tavily 时必填 | 搜索服务凭据，受供应商配额约束 |
| `TAVILY_SEARCH_BASE_URL` | `https://api.tavily.com` | HTTP(S) 基础地址，适配器追加 `/search` 或 `/extract`；不得包含凭据、查询参数或片段 |
| `TAVILY_SEARCH_DEPTH` | `basic` | `basic` 或 `advanced`；实际配额与计费由供应商决定 |
| `TAVILY_MAX_RESULTS` | `8`，整数 `1..20` | 单次搜索的默认结果数量，模型可在请求中覆盖，仍受同样范围约束 |
| `WEB_SEARCH_TIMEOUT_MS` | `30000`，整数 `1..300000` 毫秒 | 搜索或提取的请求及响应体读取超时；失败返回工具错误，适配器不自动重试 |

### 语音回复

一次只启用一个 TTS 供应商。`VOICE_REPLY_ENABLED` 控制是否随机改用原生 QQ 语音；供应商选择和语音概率是不同设置。云端 TTS 会收到需要合成的文本。图片及 `/help`、`/new`、`/compact` 的确认消息保持非语音形式；合成失败回退为原始文字。

| 参数 | 默认值 / 范围 | 含义 |
| --- | --- | --- |
| `TTS_PROVIDER` | `none` | `none` / `edge-tts` / `mimo` |
| `VOICE_REPLY_ENABLED` | `false` | 开启时必须选择可用的 TTS 供应商 |
| `VOICE_REPLY_PROBABILITY` | `0.2`，`0..1` | 每条逻辑文字回复的语音概率，仅开关开启时解析并生效；先抽样一次，再顺序分段，不决定是否发言 |
| `TTS_TIMEOUT_MS` | `30000`，整数 `1..300000` 毫秒 | 单次语音合成的总超时 |
| `TTS_MAX_BYTES` | `5242880`（`5 MiB`），整数 `1..16777216` 字节 | 单次合成音频上限，最大 `16 MiB` |
| `TTS_MAX_CHARS` | `300`，整数 `1..10000` Unicode 码点 | 单段朗读长度，和 `REPLY_MAX_CHARS` 共同限制分段 |

Edge TTS 参数仅在选择 `edge-tts` 时生效：

| 参数 | 默认值 / 范围 | 含义 |
| --- | --- | --- |
| `EDGE_TTS_BIN` | `edge-tts` | 可执行文件名或绝对路径；Worker 镜像已安装，本地测试用模拟程序替代 |
| `EDGE_TTS_VOICE` | `zh-CN-XiaoxiaoNeural` | 音色 ID，`1..128` 个字母、数字或连字符；`edge-tts --list-voices` 可查询，需网络 |
| `EDGE_TTS_RATE` | `+0%` | 语速偏移，带 `+` / `-` 的整数百分比 |
| `EDGE_TTS_VOLUME` | `+0%` | 音量偏移，带 `+` / `-` 的整数百分比 |
| `EDGE_TTS_PITCH` | `+0Hz` | 音高偏移，带 `+` / `-` 的整数 Hz |

三项偏移的解析器接受 `1..4` 位数字；实际服务是否接受某个值仍由 Edge 决定。

MiMo 参数仅在选择 `mimo` 时生效：

| 参数 | 默认值 / 范围 | 含义 |
| --- | --- | --- |
| `MIMO_TTS_API_KEY` | 空，启用时必填 | TTS 专用凭据，与模型 API Key 独立 |
| `MIMO_TTS_BASE_URL` | `https://api.xiaomimimo.com/v1` | HTTP(S) 基础地址，适配器追加 `/chat/completions`；保留需要的 `/v1`，不得包含凭据、查询参数或片段 |
| `MIMO_TTS_MODEL` | `mimo-v2.5-tts` | 当前仅支持此预制音色模型 |
| `MIMO_TTS_VOICE` | `mimo_default` | 支持 `mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`；默认音色可随服务部署变化，选择具体名称可固定音色 |
| `MIMO_TTS_STYLE` | 空，最多 `4000` Unicode 码点 | 额外朗读风格，只发送给 TTS，不进入 Agent 人格或对话；空值使用音色默认表现 |

### 消息处理、重连与图片

| 参数 | 默认值 / 范围 | 含义 |
| --- | --- | --- |
| `BATCH_SIZE` | `50`，整数 `1..1000` | 单次 Agent 批次最多包含多少条新 QQ 消息，**不是上下文长度**；单条触发消息即可立即处理，不等待凑满 |
| `REPLY_MAX_CHARS` | `1500`，整数 `1..10000` Unicode 码点 | 每段 QQ 文字长度，不限制整条逻辑回复或模型输出 Token 数 |
| `RETRY_MS` | `5000` 毫秒，正整数 | 指令确认重试与存储清理的退避间隔；不重试模型运行或普通回复 |
| `RECONNECT_MS` | `3000` 毫秒，正整数 | NapCat WebSocket 断线后的重连等待时间 |
| `ACTION_TIMEOUT_MS` | `15000` 毫秒，正整数 | 连接及 API ACK 超时；缺少 ACK 会触发 Socket 重连 |
| `IMAGE_MAX_BYTES` | `10485760`（`10 MiB`）字节，正整数 | 单张收发图片上限，Base64 按解码后的字节数计算 |
| `IMAGE_TIMEOUT_MS` | `15000` 毫秒，正整数 | HTTP(S) 图片请求的下载超时，包含响应体读取 |

### 受管设置的修改入口

受管配置的读取与保存应通过控制台设置类型、`validateSettings()` 和数据库接口完成，不直接编辑 SQLite 密文或受管缓存。人格正文在控制台限制为 `200000` 字符；生成凭据不会作为实例的普通环境配置展示。真实凭据、实际目标、数据库、日志和调试产物保持在 Git 忽略范围。
