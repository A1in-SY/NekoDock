# 开发与调试

使用方式和容器部署见 [README](../README.md)。受管实例的模型、人格、消息策略及服务凭据由控制台数据库管理，再通过受管配置协议下发给 Worker；不需要为实例维护环境文件、独立 Compose 或人格文件。

本文的 Worker 参数表用于理解配置适配、编写测试和排查问题，不是另一套部署步骤。默认值和校验规则分别以 `src/config.ts`、`src/console/settings.ts`、`src/web-search.ts`、`src/tts.ts` 为准。

## 记忆与聊天压缩

`MemoryStore` 与聊天档案使用同一个实例 SQLite，通过入站与 ACK 出站触发器原子追加增量来源。首次启用以当时入库高水位为学习起点；回填使用独立时间范围，不改变正常增量进度。每日和成功压缩触发按幂等键合并，每次作业范围冻结，分批验证来源与版本，发布记忆和推进游标使用同一个短事务。超长来源通过持久化偏移分块处理，取消与重启不跳过尚未整理的尾部。

`MemoryCoordinator` 独立于 `Processor` 与普通 `Scheduler`。不要把它加入 `scheduledBusy`、主会话 `processing` 或发送排空判断。模型在单独 Pi 子进程、临时会话和专用英文系统提示下运行，仅提供历史读取、记忆查询和变更暂存工具；候选在成功结束后由父进程校验提交。关闭实例取消后台请求并保留可恢复进度，不等待后台模型自然完成。

模型侧 `MemoryProposal.sources` 只接受 `{sourceSeq, quote}`；`MemoryStore.validateProposals` 在当前批次内解析来源，返回内部的 `MemoryChange.sources`，不自动猜测或兼容模型拼出的 ID。校验复用真实变更规则，在内部 SAVEPOINT 中试运行后始终回滚，失败返回安全错误码及 `changeIndex/sourceIndex/sourceSeq`。修正提交替换整个暂存批次，最多三次；连续验证失败后停止，不再从头重复相同批次。最终 `publish` 再做版本和来源检查。

记忆运行通过专用的 `finishTurn` 包装器在已验证暂存的工具结果完成后正常结束，不追加一次收尾生成；外部取消和模型错误仍保持失败。失败作业的异步 `retry` 管理命令仅重新排队原作业，保留处理位置、长消息偏移、时间范围、已发布记忆和正常学习游标。

Console 只保存加密展示投影及持久化管理命令，通过 `/internal/workers/:id/memory` 与 Worker 同步；写操作收到 Worker 确认前保持待处理。记忆工具、可见思考、失败和用量属于独立作业事件，不进入主聊天投影；页面通过实例变更 SSE 刷新。大数据集的展示快照会标记截断，底层原文与记忆不因展示限制删除。

主会话的自动召回通过请求级 `context` hook 临时加入当前输入，不写回 Pi JSONL。服务商用量已包含召回，不能再次相加。可选 embedding 使用实例代理，浮点向量持久化于 SQLite，分页计算相似度并让出事件循环；服务不可用时保留关键词检索，不增加常驻向量服务或本地模型。

`session_before_compact` 返回自定义聊天 checkpoint，复用 SDK 的 preparation、切点、分轮信息和持久化。不要仅追加 `customInstructions`，它仍会保留 SDK 固定工作摘要模板。扩展抛错可能被 SDK 捕获后回退默认生成，因此摘要失败必须在扩展内部记录失败并取消，禁止隐式回退、恢复重试和重复发送。摘要成功后仅投递异步记忆作业，不等待长期记忆整理。

修改这些协议后至少运行 `memory-*`、`console-memory`、`pi-runner`、`proxy-agent`、`commands-e2e` 测试，再执行完整测试和前端构建。容器测试必须使用模拟模型、模拟 NapCat 和隔离数据，不能用真实聊天验证整理或发送行为。

## 安装与验证

### 聊天资料与 Pi 提交

`chat_messages` 是实例内的版本化聊天投影，原始 NapCat 事件继续保存在原归档。`chat_context_batches` 保存待提供批次和提交 hash，`chat_context_versions` 保存每个 Pi 会话已提交的消息版本与条目。普通回复保存真实 QQ ID 与工具调用／拆分片段关系，不把正文再次灌入模型。

Pi 子进程在会话文件持久化后发出 `context.committed`；进程异常时，父进程核对稳定批次 ID，恢复资料提交状态，不重跑旧生成。晚到增强在下一轮边界通过 `appendContextEdit` 更新有效历史条目；已压缩来源通过真实引用或历史读取补充。`contextBatch` 仅用于持久恢复，模型请求和压缩输入会剔除它。自动记忆召回继续只修改请求副本。

引用回复在每条逻辑输出保存可选的真实 QQ `replyTo`，与逻辑消息、物理分段的映射一起持久化。仅首段携带引用；带引用的文字不随机转语音。Worker 在整次入队前校验所有引用，引用业务错误通过工具结果返回，不终止整轮。Console 在取得发送队列资格后再次校验，晚到撤回只阻止相关待发内容，不自动降级或补发。

Console 的消息索引独立于投递队列保留连接、账号、实例、聊天目标、真实平台 ID 和撤回状态。模型回复的 `messageRef` 在发送确认时绑定实际分段；撤回接口按已登记的自身模型回复解析，不能指定任意 QQ 消息。缺少可信账号归属的旧历史不会自动迁移为可引用消息。

`message.recalled` 是真实状态事件；原内容与内容 revision 不变，当前消息另存 `recalled` 状态。Pi 将撤回追加为专用 `custom_message`，不启动新轮、回写旧输入或冒用聊天参与者。状态提交使用独立事件 ID 去重；原消息尚未提交时仍同时提供原消息和后续撤回事实。历史查询、记忆来源和压缩保留这种先后关系，撤回不自动清除记忆。

记忆抽取来源保持不可变：首次聊天资料与后续增强版本分别写入 `memory_ingest`，版本证据 ID 不得对应另一份重构文本。图片本身仍由主模型按能力读取，记忆整理器读取文本及明确取得的分享资料，不推测图片或视频内容。

### 插件作业与媒体

每个插件位于 `src/plugins/<插件 ID>/`，以 `nekodock.plugin.json` 声明身份、版本、插件 API 版本、运行入口、能力、指令和配置表单。`core/` 提供内置指令，`bilibili/`、`heybox/` 和 `douyin/` 各自包含平台配置、识别、资料转换与执行逻辑；公共协议与注册逻辑位于 `src/plugin-system/`。`core` 的必装、不可关闭约束由宿主保证，插件不能自行声明为系统必装插件。

`npm run generate:plugins` 只发现 `src/plugins/` 的直接子目录。没有声明文件的目录被忽略；声明存在时必须是有效 JSON，插件 ID 必须与目录一致，API 版本受支持，指令不能重名，入口必须存在且不能越出插件目录。源码声明中的 `.js` 入口对应同路径 `.ts` 源码，构建后运行编译出的 JavaScript。无效声明或缺少 `core` 会使构建失败。发现阶段不导入或执行插件代码。

构建脚本生成 `src/plugin-system/generated/` 中的目录、Console 和 Runner 静态注册表。生成文件由 Git 忽略，`build`、`check`、`build:web` 和 `test:web` 自动重新生成；新增插件通过重新构建镜像发布，无需手工修改宿主注册数组。Console 和 Runner 分别装配各自的入口。

配置声明可用 `group` 将字段分组；字符串字段可声明非空、无重复的 `enum`，用等长的 `enumLabels` 提供显示名称。枚举默认值必须是可选项，枚举不能用作密钥字段；生成器将其转换为带 `options` 的 `select` 字段，Web 使用相同选项校验提交值。资源类型支持 `video`、`article`、`post`、`live` 和 `game`。

字段可用 `parent` 引用同组的根字段，声明一层表单归属；父字段必须为非敏感的布尔或枚举控制项。只有实际从属选项才声明父项，独立能力保持同级。该元数据只影响展示层级，不隐藏或清空配置、不改变业务启用条件；配置提交仍使用原字段键和值。

插件 API 1 支持控制、命令、内容与观察插件。`core` 控制插件使用 `commands` 能力及 Worker/control 指令路由；普通命令插件使用 Console/chat 路由；内容插件声明 `content-enrichment` 或 `video-download` 并提供 Runner 入口。观察插件独立声明 `forward-inspection`，只提供 Console 入口，不混合平台资源或命令能力。API 1 的内容插件声明示例如下：

```json
{
  "kind": "nekodock-plugin",
  "id": "example",
  "name": "示例插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "entries": { "console": "./index.js", "runner": "./runner.js" },
  "capabilities": ["commands", "content-enrichment"],
  "commands": [
    {
      "name": "/example",
      "description": "执行示例功能。",
      "contextPolicy": "chat",
      "executor": "console"
    }
  ]
}
```

Console 入口默认导出接收公开 manifest 的插件工厂；内容插件通过 `entries.runner` 声明后台执行入口，由该入口具名导出 `runnerDefinition`。配置校验、资源识别、资源摘要及平台错误转换由插件实现；宿主负责配置存储、作业调度、会话绑定、媒体资产和实际发送。内容命令记录聊天并交由插件处理，不再次触发主模型。Console 收到消息的事务只登记作业，不执行网络请求。来源会话由 Worker 保存消息后确认，不能使用心跳中的当前会话猜测。

共享 `plugin-runner` 以独立凭据领取作业，执行固定版本下载器；只有实例代理和该插件所需凭据进入作业，运行器不挂 Docker Socket、主密钥或 Worker 卷。解析结果先持久化，再由 Worker 幂等接收；实际回复经 Worker 空闲执行器申请网关发送，保存确认后作为统一机器人聊天记录。

转发观察任务使用 `inspect` 作业：解析时通过同步 observer 统计有效节点和维护蓄水池样本；在最终转发快照提交的同一事务内持久化统计与固定样本。普通缓存数量不足与转发结构不完整分开处理。仅最终选中的额外图片进入消费者专用缓存，不出现在 Worker 附件列表；持久租约保留 Worker ACK 后仍需检查的内容，完成、取消或过期后释放。独立 Console 队列不使用主会话 busy 状态，主会话 `/new` 不取消检查。通知投递带稳定 deliveryId，实际发送前再次检查配置版本、实例、绑定、登录账号及撤回状态。真实 ACK 与已发送插件回复的发布在同一事务内保存；Worker 只同步这条已发送的聊天事实，不重复发送或唤醒主模型。模型输入不包含转发作者、聊天历史、源图片鉴权地址或主会话人格。

Jev 图片判定按图拆成独立请求，所有观察任务共享最多两个 HTTP 并发槽；单张超时从取得槽并实际请求时计时，整个作业另有截止时间。每张图片独立解析和记录错误，部分失败不丢弃其他图片的有效分值；全失败保留未知结果，部分未命中带覆盖不足说明。内置标准同时覆盖明确色情与明显性暗示，普通肖像、非性化泳装和非色情艺术不因性别、体型或露肤单独触发。

图片缓存按实例隔离，原图和派生图片以内容及转换版本复用；成功分值的缓存身份还包含服务端点、模型、凭据指纹、内置判断版本和补充说明，阈值变化只重新比较分值。失败不缓存。相同内容的新 QQ 消息保留各自附件、聊天与检查记录，读取已校验的相同哈希文件时复用已有内容，不重复写盘。记录分别展示 HTTP 请求次数、成功分值复用、压缩图片复用及逐图失败；等待远端图片就绪不计作内容下载开始。

`plugin_jobs`、`plugin_results`、媒体资产和投递状态各自持久化。结果未知的发送保持未知；过期／会话切换必须由宿主记录终态后再确认结果，不能只在 Worker 本地丢弃。停止和禁用取消未开始作业，发送中的投递等待 ACK 或超时收尾。媒体回源通过短期签名 URL 获取，并用模拟 NapCat 验证跨容器 HEAD／Range。

动态／直播采用 `resolve → prepare` 两阶段：先提交结构化资料，再准备原图、表情和展示产物。`prepare` 可以只为上下文取得图片，也可以按实例配置准备原始图文或排版图片。Runner 的多文件结果按稳定资产键上传，Console 验证资产属于该作业和实例后持久化有序产物；每项有独立投递 ID，前项确认后才能发送下一项。失败或未知结果阻止后续产物，不重发已经确认的部分。旧视频下载仍使用原有路径。

小黑盒游戏沿用 `resolve → prepare`：详情按 `pc`、`console`、`mobile` 分发至对应接口，保留原分享 ID 与解析后的游戏身份。PC 接口的 `steam_appid` 参数名不代表资源必定来自 Steam，具体平台以返回的 `platf` 和平台映射为准。`PluginContent.type='game'` 携带独立 `game` 结构，评分保留来源和量表，平台商店价格、商城价格、地区、币种和优惠条件分别保存。Pillow 游戏模板位于 `src/plugins/heybox/render/`；生成卡片属于展示产物，保持 `presentation` 用途，不代替结构化游戏资料。

抖音采用 `resolve → download`：先建立匿名访客身份，再以移动端分享页取得 `_ROUTER_DATA`。必须校验 `videoInfoRes.item_list` 中的实际作品 ID；空壳页面、图集和直播不能被当成已解析的视频。访客会话按实例及代理配置隔离，过期身份只作一次受控刷新；解析和媒体下载共享总超时及重试预算。临时播放地址保留在运行器内部，模型内容中只保存规范作品链接与确实取得的资料；字幕缺失不触发隐式 ASR。下载完成后由 ffprobe 核验实际媒体，不根据请求的画质参数声称实际清晰度。

平台及 CDN 请求逐跳校验已知域名，并限制响应字节、文件大小、像素及执行时间。Web 来源链接按平台白名单展示，图片和视频只经实例鉴权资产接口读取，不将源站地址或访客 Cookie 暴露给浏览器或模型。跨平台解析失败不得污染同批其他插件资料；增强和自动投递各自受所属插件配置控制。

`PluginContent` 中的原图使用 `assetId` 引用 Console 图片资产。Worker 经实例鉴权接口复制到持久媒体目录后，才作为可用图片提供给 Pi；原入站图片和插件图片按来源合并。展示图片的附件保留用途信息，默认不重复进入视觉上下文。Web 通过实例鉴权资产接口加载媒体，不直接请求内容中的外部图片 URL。所有来源时间使用 Unix 秒；界面转换为 UTC+08:00，直播图片的 HTTP `Last-Modified` 只标为文件更新时间。

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

实例网络策略在 `src/network.ts`：每个运行时持有独立的 Undici 连接池，父 Worker 显式注入图片及 TTS 请求；Pi 子进程替换自身 fetch，覆盖模型生成、压缩和搜索。管理请求使用独立直连 dispatcher。配置变更排空后销毁旧客户端，代理失败不回退直连。代理认证及其 URL 编码／Basic 表达纳入会话和日志脱敏。

`NETWORK_PROXY_ENABLED`、`NETWORK_PROXY_URL`、`NETWORK_PROXY_USERNAME`、`NETWORK_PROXY_PASSWORD`、`NETWORK_PROXY_NO_PROXY`、`NETWORK_PROXY_FOR_TOOLS` 是数据库到 Worker 的内部适配参数；受管实例通过 Web 配置，不需要维护这些环境文件。工具环境经白名单生成，并提供 `NEKODOCK_PLAYWRIGHT_PROXY` JSON 辅助参数。代理检测由鉴权 Console API 排入短期内存队列，Worker 独立控制通道领取、执行并回报，标明实际配置版本，不写聊天记录。

网络定向验证：`node --test dist/test/network.test.js dist/test/network-probe.test.js dist/test/proxy-settings.test.js dist/test/proxy-media.test.js dist/test/proxy-agent.test.js`。使用合成代理、模型和 NapCat，不能向真实会话发送测试消息。

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

## 定时任务开发

任务定义由 Console 的 `ScheduledTasks` 仓库管理，保存在 `console.sqlite3`；定义及历史版本使用与实例配置相同的主密钥加密。Worker 的 `ScheduledStore` 使用独立的 `schedules.sqlite3` 保存快照、调度点、业务检查点、控制票据、运行、发送尝试和事件发件箱。两个数据库职责不同，备份实例时必须包含整个数据卷，备份控制台时保留匹配的主密钥。

实例设置 `taskCreatorOnly` 默认 `true`，旧配置读取时补齐默认值，不改变保存版本。它通过内部快照的 `TASK_CREATOR_ONLY` 传给 Worker 和 Pi 工具说明；Console 使用当前实例设置决定任务列表的可见字段及修改／删除权限。关闭后允许当前会话请求者编辑其他人及网页创建的任务，仍验证真实消息来源、任务所属实例、版本与脚本权限，且不改写创建人。控制台管理员接口不受此开关限制。

### 接口与版本

浏览器任务接口位于 `/api/bots/:id/tasks`，使用现有管理员会话和来源校验：

| 路径／操作 | 用途 |
| --- | --- |
| `GET` / `POST` | 列出／创建任务；列表包含软删除记录供历史查询 |
| `POST /preview` | 校验计划、命令权限和配置，返回 `nextRuns`；不执行任何任务 |
| `PUT` / `DELETE /:taskId` | 修改／软删除，必须传 `expectedRevision` |
| `POST /:taskId/run`、`POST /:taskId/reset-state` | 创建持久化控制票据，Worker 串行处理后确认 |
| `GET /:taskId/runs`、`GET /runs/:runId` | 最近 100 次运行／包含最近 500 条事件和状态的运行详情 |

Worker 接口位于 `/internal/workers/:id/tasks`，复用实例 Bearer Token 鉴权：`GET` 获取定义和未确认票据，`POST /manage` 处理模型任务工具，`POST /authorize` 在领取前验证版本和启用／权限／实例状态，`POST /applied` 上报应用版本、下次执行及票据确认。任务改动不提高实例配置版本，不触发 Worker 重建。控制台不可用时不领取新任务。

模型任务管理请求必须引用本轮应答目标的 `sourceMessageId`。Worker 从已持久化来信确定创建者，Console 检查 creator 归属和乐观版本；不得信任模型自行提供的 QQ 号。工具调用操作标识按实例保存结果，重复的同一操作返回已提交结果，标识被用于不同请求时报错。自然语言定时执行不注册任务增删改工具，只能在启用任务状态时保存当前任务的状态。

运行详情支持可选 `?after=WORKER_SEQ`。初次返回最近 500 条原始事件范围内的快照；增量从该游标之后按序读取，响应含 `events[].seq`、`cursor` 与 `hasMore`。同一个 `itemId` 的累计思考在每批内只保留最新版本，游标仍以实际扫描的原始批末尾为准；前端跨批替换相同思考快照并在 `hasMore` 为真时继续补拉。响应另受 512 KiB 预算约束，不能通过返回事件数量推断已读完。若请求游标大于数据库当前上界，返回较小游标，前端重新获取完整快照。

### 时间、状态和上下文

计划类型为 `once` 或五段分钟级 `cron`，使用 IANA 时区。一次性时间必须带 `Z` 或数值时区偏移；创建时必须在未来，编辑已过期任务的名称或暂停状态不要求重新安排未来时间。日历查询以 `scheduledAt` 锚定，范围为 `[from,to)`，不随排队时间滚动。`taskHistoryRange()` 处理计划执行日、前一天和滚动小时；`buildTaskHistory()` 从本地同步读取范围并以 UTF-8 字节保守控制输入预算，返回覆盖数量和截断标志。首版没有分块模型摘要，不能对截断材料宣称完整总结。

任务状态与任务定义版本独立。`save_task_state(data, expectedVersion)` 校验 JSON 对象与 16 KiB 上限，事务提交后立即返回新版本；后续 524、发送失败或模型中断均不撤销已提交的业务检查点。状态的更新时间和来源运行由 Worker 写入。发送 ACK 是另一条状态链，不能从“保存成功”推断“播报成功”。清空状态通过持久化票据执行，并推进状态版本，避免旧运行覆盖已重置数据。

普通聊天的 `messages` 和 `replyTargetMessageIds` 格式保留；任务输入使用 `kind: 'scheduled_task'`，携带保存的要求、可选 `context.taskState` / `context.chatMessages` / `context.chatCoverage` 及动态的 `invocation`。每次调用独立 Pi 会话，不回写主会话的 session ID；任务运行过程上报为 `schedule.run.event`，其 `eventType` 可以是思考、工具、用量或上下文。Console 只把这些事件加入任务详情，不将其混入主会话的 Token 用量和上下文占比。

### 执行与发送边界

Scheduler 的时钟回调只同步任务、产生待执行记录并唤醒 Processor，实际用户代码由同一个串行执行循环领取，不能在定时器里与主聊天并发操作 Pi 会话或发送队列。`(taskId, scheduledAt)` 去重周期调度点，手动执行使用独立票据标识。开始前提交 `running`，恢复时把未结束的已开始执行终结为 `interrupted`，不重放。未开始的调度点根据允许延迟处理，旧周期只保留最新一次。

脚本在 `workspace/scheduled-runs/RUN_ID/` 中取得固定版本的源码、`task_context.json` 及 Python／Node SDK。SDK 通过专用进程管道提交受限操作，不读取 NapCat 或管理令牌；stdout/stderr 只作为执行日志。进程受任务超时、输出量、请求量和单次执行消息数限制，结束时终止进程组。`previewTaskScript()` 可供隔离测试收集拟发送消息，拒绝状态写入；它不是浏览器“检查计划时间”接口，也不保证脚本其他操作没有副作用。

脚本和模型共用持久化发送入口。`accepted` 表示已保存请求，ACK、失败与未确认分别记录；已受理发送独立于之后的模型结果收尾。测试应覆盖“消息已确认、后续模型失败”同时保留两种结果。安全排空必须同时考虑聊天执行、定时执行和已受理发送；禁止仅检查旧的 `pending_batch` 就销毁 Worker。

定向验证：

```bash
npm run build
node --test dist/test/console-scheduled-tasks.test.js dist/test/scheduled-store.test.js
node --test dist/test/scheduler.test.js dist/test/task-script.test.js
node --test dist/test/scheduled-managed-e2e.test.js
```

使用合成目标、模拟时间、模拟模型和模拟 NapCat 验证权限、计划边界、忙碌排队、版本更新、重启中断和发送 ACK。不要调用真实群聊接口进行“立即运行”验收。

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

受管快照包含 `transport: 'console'` 与 `connectionId`，实际 NapCat 连接由 Console 维护，快照不传递真实 NapCat 地址或 Token。下表的直接连接参数只用于独立测试入口和旧配置导入。内部收消息使用实时 SSE，落库后通过独立 HTTP 确认；心跳仅报告运行状态与配置版本。

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
| `IMAGE_CACHE_DAYS` | `30` 天，正整数 | Worker 入站图片缓存保留期；不随上下文压缩或 `/new` 立即删除 |
| `IMAGE_CACHE_MAX_BYTES` | `2147483648`（`2048 MiB`）字节，正整数 | 当前 Worker 入站图片缓存总容量；保护未消费和正在使用的附件 |

受管实例在控制台「高级设置」填写 `imageCacheDays`、`imageCacheMaxMiB`、`imageTransitHours` 和 `imageTransitMaxMiB`，保存在 Console 数据库。Worker 的两项缓存设置按天和字节投影到上述内部环境快照；中转保留期（默认 24 小时）和容量（默认 1024 MiB）仅由 Console 使用，不属于独立 Worker 配置。

Console 入站队列同时登记持久图片预取任务，在有限并发下异步下载普通图片，使用所属实例的代理、单图大小和超时限制。入站消息 ACK 只确认消息已持久化，不能删除未转移的图片任务；Worker 验证内容哈希并原子落盘后，另行确认图片转移。Console 和 Worker 重启均从持久记录恢复，媒体接口按 Worker 身份限制实例边界。

会话展示和模型输入使用稳定附件引用，原始鉴权 URL 留在私有原始事件中。`message.images.updated` 事件通过现有会话 SSE 更新对应来信附件，不新增聊天消息或触发模型。当前批次只在统一时间预算内等待图片，下载失败不使整轮失败；历史中已过期且未保存的原图不能恢复。仅处理当前支持的普通图片，不扩展表情包、语音、视频和文件能力。

### 受管设置的修改入口

受管配置的读取与保存应通过控制台设置类型、`validateSettings()` 和数据库接口完成，不直接编辑 SQLite 密文或受管缓存。人格正文在控制台限制为 `200000` 字符；生成凭据不会作为实例的普通环境配置展示。真实凭据、实际目标、数据库、日志和调试产物保持在 Git 忽略范围。
