import type { PublicBot } from "../../src/console/contracts";

export interface NetworkProbe {
  id: string;
  status: "pending" | "completed" | "failed";
  revision: number;
  result?: { ok: boolean; code: string; durationMs: number; status?: number; route?: string };
}

export function canRunNetworkProbe(bot: Pick<PublicBot, "state" | "desiredState" | "appliedRevision">) {
  return bot.state === "running" && bot.desiredState === "running" && bot.appliedRevision >= 1;
}

const errors: Record<string, string> = {
  PROXY_UNREACHABLE: "代理无法连接",
  PROXY_AUTH_REQUIRED: "代理认证失败，请检查用户名和密码",
  PROXY_AUTH_FAILED: "代理认证失败，请检查用户名和密码",
  TARGET_CONNECT_FAILED: "目标无法连接",
  TLS_ERROR: "TLS 连接失败",
  TIMEOUT: "检测超时",
  CANCELLED: "检测已取消",
  CONFIGURATION_REQUIRED: "尚未配置模型服务地址",
  NETWORK_ERROR: "网络连接失败",
  WORKER_UNAVAILABLE: "Worker 暂时不可用",
  REVISION_CHANGED: "配置版本已经变更，请重新检测",
  NETWORK_PROXY_UNREACHABLE: "代理无法连接",
  NETWORK_PROXY_AUTH_FAILED: "代理认证失败，请检查用户名和密码",
  NETWORK_TARGET_UNREACHABLE: "目标无法连接",
  NETWORK_TLS_FAILED: "TLS 连接失败",
  NETWORK_TIMEOUT: "检测超时",
  NETWORK_REQUEST_ABORTED: "检测已取消",
  NETWORK_PROXY_CONFIG_ERROR: "网络代理配置无效",
};

export function describeNetworkProbe(probe: NetworkProbe, appliedRevision: number) {
  const version = `配置版本 ${probe.revision}`;
  const previous = appliedRevision !== probe.revision ? "（当前生效版本已变更）" : "";
  if (probe.status === "pending") return `${version}：正在检测…${previous}`;
  const result = probe.result;
  if (!result) return `${version}：检测未完成，请重新检测。${previous}`;
  const duration = Number.isFinite(result.durationMs) ? ` · ${Math.round(result.durationMs)} ms` : "";
  if (result.ok) {
    const route = result.route === "proxy" ? "经代理" : result.route === "direct" ? "直连" : "";
    return `${version}：${route}已收到目标响应${result.status ? ` · HTTP ${result.status}` : ""}${duration}${previous}`;
  }
  return `${version}：${errors[result.code] ?? "检测失败，请查看实例日志"}${duration}${previous}`;
}
