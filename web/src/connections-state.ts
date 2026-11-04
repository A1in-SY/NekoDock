import type { PublicBot, PublicNapcatConnection } from "../../src/console/contracts";

export type ConnectionView = PublicNapcatConnection & {
  connected?: boolean;
  online?: boolean;
  error?: string;
  transportConnections?: number;
};

export interface ConnectionDraft {
  name: string;
  wsUrl: string;
  reconnectSeconds: number;
  actionTimeout: number;
  enabled: boolean;
  mediaBaseUrl?: string;
  token?: string | null;
}

export function connectionPayload(draft: ConnectionDraft, revision?: number) {
  const wsUrl = draft.wsUrl.trim();
  let url: URL;
  try { url = new URL(wsUrl); }
  catch { throw new Error("请填写有效的 WebSocket 地址"); }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("连接地址须使用 ws:// 或 wss://，凭据请填写在 Token 中");
  if (!draft.name.trim()) throw new Error("请填写连接名称");
  if (!Number.isFinite(draft.reconnectSeconds) || draft.reconnectSeconds < 1)
    throw new Error("重连间隔至少为 1 秒");
  if (!Number.isFinite(draft.actionTimeout) || draft.actionTimeout < 1)
    throw new Error("发送确认超时至少为 1 秒");
  let mediaBaseUrl = draft.mediaBaseUrl?.trim();
  if (mediaBaseUrl) {
    let media: URL;
    try { media = new URL(mediaBaseUrl); } catch { throw new Error("请填写有效的媒体回源地址"); }
    if (!["http:", "https:"].includes(media.protocol) || media.username || media.password || media.search || media.hash || media.pathname !== '/')
      throw new Error("媒体回源地址须使用 http:// 或 https://，且不能包含凭据、路径或查询参数");
    mediaBaseUrl = media.toString().replace(/\/$/, "");
  }
  return {
    name: draft.name.trim(), wsUrl,
    reconnectSeconds: draft.reconnectSeconds,
    actionTimeout: draft.actionTimeout, enabled: draft.enabled,
    ...(mediaBaseUrl === undefined ? {} : { mediaBaseUrl }),
    ...(draft.token === null ? { token: null } : draft.token ? { token: draft.token } : {}),
    ...(revision === undefined ? {} : { expectedRevision: revision }),
  };
}

export function affectedBots(connection: Pick<PublicNapcatConnection, "botIds">, bots: PublicBot[]) {
  const ids = new Set(connection.botIds);
  return bots.filter((bot) => ids.has(bot.id));
}

export function connectionLabel(connection: ConnectionView) {
  if (!connection.enabled) return "已停用";
  if (!connection.connected) return connection.connected === undefined ? "等待状态" : "未连接";
  return connection.online ? "QQ 在线" : "QQ 未在线";
}

export function botConnectionStates(bot: Pick<PublicBot, "connected"> & {
  transportConnected?: boolean; upstreamConnected?: boolean; qqOnline?: boolean;
}) {
  return {
    transport: bot.transportConnected ?? bot.connected,
    upstream: bot.upstreamConnected ?? bot.connected,
    online: bot.qqOnline ?? bot.connected,
    connected: bot.connected,
  };
}

export function canSwitchConnection(bot: Pick<PublicBot, "state" | "desiredState" | "processing">) {
  return bot.state === "stopped" && bot.desiredState === "stopped" && !bot.processing;
}

export function canSelectConnection(
  bot: Pick<PublicBot, "connectionId" | "state" | "desiredState" | "processing">,
  candidate: PublicNapcatConnection,
  connections: PublicNapcatConnection[],
) {
  if (candidate.id === bot.connectionId) return true;
  const current = connections.find(connection => connection.id === bot.connectionId);
  return canSwitchConnection(bot) && candidate.enabled && Boolean(current?.accountId) &&
    Boolean(candidate.accountId) && current?.accountId === candidate.accountId;
}

/** Shared NapCat settings are submitted through the connection resource only. */
export function instanceSettings(config: object) {
  const result: Record<string, unknown> = { ...config };
  for (const key of ["wsUrl", "napcatToken", "reconnectSeconds", "actionTimeout"])
    delete result[key];
  return result;
}
