# NekoDock 开发约定

## 配置与数据

受管实例的设置保存在控制台数据库；群聊／私聊类型及目标号码创建后不可更改。不要为受管实例生成独立 env、Compose 或宿主人格文件。人格由数据库配置直接传给 Pi SDK。

每个实例使用独立的数据卷、数据库、Pi 会话和工作目录。复用原卷更新实例，不要同时运行两个使用同一数据卷的 Worker。持久化标识不随展示名称改变。

## 验证

修改后运行与变更相关的测试。涉及完整行为或共享协议时运行：

```bash
npm test
npm run build:web
```

需要验证容器行为时，使用隔离的测试数据卷、模拟模型和模拟 NapCat；不要向真实 QQ 会话发送测试消息。

## 部署更新

功能、基础提示词或镜像依赖变更完成并验证后，共享 Worker 镜像只构建一次：

```bash
docker compose -f compose.console.yaml --profile build build worker-image
docker compose -f compose.console.yaml build console
docker compose -f compose.console.yaml build plugin-runner
docker compose -f compose.console.yaml up -d console plugin-runner
```

先通过控制台重启一个验证实例，确认运行正常，再逐个更新其他受管实例。等待当前轮生成与发送 ACK 完成，再由控制台重建容器。检查运行状态、NapCat 连接、Pi 会话和配置生效版本。不要强杀仍有待发记录的容器。

构建前检查可用内存、Swap 和磁盘空间。每条构建命令只指定一个服务，等待该服务构建完成后再构建下一个；不要依赖 `COMPOSE_PARALLEL_LIMIT` 限制 Buildx Bake 的并发。小内存主机应为编译进程设置内存上限，并在构建时观察内存压力与换页情况。

每次更新前记录当前镜像 ID，并为 Worker、Console 和插件运行器保留一组回滚镜像。全部实例更新并验证成功后，立即清理本项目更早且无容器引用的镜像，以及已被替换、排空并停用的旧容器；正常停止的受管实例容器继续保留。镜像只保留当前版本、所有容器仍在引用的版本和最近一组已验证的回滚版本，逐项删除，不使用强制删除。检查构建缓存占用；共享 Docker 主机仅清理能确认归属本项目的缓存。清理前后记录磁盘用量，核对容器状态；更新失败时保留回滚资源。不要使用全局 `docker system prune`、`container prune`、`image prune -a` 或卷清理，不删除数据卷、数据库、配置和备份。

纳管独立 Worker 时，先备份、停止旧实例并关闭自动重启，再导入原配置和原卷。受管期间不要再次执行旧 Compose 的启动命令。

## 公开文件

README、注释、测试及部署样板使用通用描述和合成示例。真实凭据、目标号码、人格、对话记录、数据库、日志、实际部署文件与本地运维记录留在 Git 忽略范围内。示例配置中的密钥使用空值或明确占位符。

详细部署、导入、日志和备份说明见 README。
