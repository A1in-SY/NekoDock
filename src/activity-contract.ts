export const ACTIVITY_NAMES = {
  reply: '聊天回复', agent: '模型执行', model_request: '模型接口请求', model_stream: '接收模型响应',
  run: '聊天模型', append: '更新上下文', compact: '上下文压缩', scheduled: '定时任务', memory: '记忆整理',
  prepare: '准备上下文与图片', plugin_resolve: '解析分享内容', plugin_prepare: '准备分享图片', plugin_download: '下载媒体', plugin_queue:'等待插件执行',
  image_download: '下载图片', image_inspect: '检查图片', render_wait: '等待渲染名额', image_render: '生成图片',
  media_process: '处理媒体', asset_upload: '上传媒体', send: '发送并等待确认', voice: '生成语音',
  bash: '执行命令', read: '读取文件', write: '写入文件', edit: '编辑文件', web_search: '搜索网页', web_fetch: '读取网页',
  send_message: '提交聊天回复', recall_message: '撤回消息', other_tool: '调用工具', inspect: '检查转发图片',
} as const;
export type ActivityName = keyof typeof ACTIVITY_NAMES;
export type ActivityKind = 'run' | 'model' | 'tool' | 'command' | 'plugin' | 'download' | 'render_wait' | 'render' | 'upload' | 'send' | 'compact' | 'memory' | 'schedule' | 'prepare';
export type ActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface ActivityEvent {
  id: string; traceId: string; parentId?: string; kind: ActivityKind; name: ActivityName;
  time: number; startedAt: number; status: ActivityStatus; durationMs?: number;
  /** Fixed metadata only; never command lines, URLs, prompts or tool results. */
  requestIndex?: number; firstEventMs?: number; count?: number; errorCode?: string;
}
export interface ActivitySpan extends ActivityEvent {
  botId: string | null; resourceId: string; endedAt: number | null; conversationId?: string;
  runId?: string; jobId?: string; pluginId?: string; sourceMessageId?: string;
}
export interface ProcessPoint {
  pid: number; startTime: string; program: 'bash' | 'browser' | 'python' | 'ffmpeg' | 'node' | 'downloader' | 'other';
  cpu: number;
}
export interface ProcessSample {
  id: string; spanId: string; time: number; intervalMs: number; cpu: number | null;
  scope?: 'self' | 'tree';
  coverage: 'sampled' | 'partial' | 'unavailable'; processes: ProcessPoint[];
}
export interface ObservedProcessSample extends ProcessSample { botId: string | null; resourceId: string; }
export interface MonitorResource { id: string; name: string; kind: 'worker' | 'console' | 'plugin-runner'; botId?: string; }
export interface ActivityTimeline {
  spans: ActivitySpan[]; processes: ObservedProcessSample[]; truncated: boolean; processTruncated: boolean;
  droppedProcessSamples: number;
}
export function activityName(name: string): ActivityName { return Object.hasOwn(ACTIVITY_NAMES, name) ? name as ActivityName : 'other_tool'; }
