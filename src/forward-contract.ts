/** Forwarded speech stays inside its real outer message; paths are never QQ IDs. */
export interface ForwardContent {
  type: 'forward';
  path: string;
  status: 'pending' | 'ready' | 'partial' | 'failed';
  nodes: ForwardNode[];
  error?: string;
}

export interface ForwardNode {
  path: string;
  senderId?: string;
  senderName?: string;
  time?: number;
  segments: ForwardSegment[];
}

export type ForwardSegment =
  | { type: 'text'; text: string }
  | { type: 'image'; assetId: string; sourceKey?: string; error?: string }
  | { type: 'media'; kind: string; name?: string; text?: string }
  | ForwardContent;

export interface ForwardSnapshot {
  messageId: string;
  revision: number;
  contents: ForwardContent[];
  /** The ingress resolver's total deadline, in Unix milliseconds. */
  deadline: number;
}

export const FORWARD_LIMITS = { depth: 8, nodes: 200, bytes: 128 * 1024, timeoutMs: 15_000, concurrency: 2 } as const;

export function isForwardSnapshot(value: unknown): value is ForwardSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.messageId !== 'string' || !v.messageId || v.messageId.length > 200
    || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1
    || typeof v.deadline !== 'number' || !Number.isFinite(v.deadline) || !Array.isArray(v.contents)
    || Buffer.byteLength(JSON.stringify(v.contents)) > FORWARD_LIMITS.bytes) return false;
  let count = 0;
  const forward = (item: unknown, depth: number): boolean => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || depth > FORWARD_LIMITS.depth) return false;
    const x = item as Record<string, unknown>;
    if (x.type !== 'forward' || typeof x.path !== 'string' || x.path.length > 500
      || !['pending', 'ready', 'partial', 'failed'].includes(String(x.status)) || !Array.isArray(x.nodes)
      || x.error !== undefined && typeof x.error !== 'string') return false;
    return x.nodes.every(node => {
      if (!node || typeof node !== 'object' || Array.isArray(node) || ++count > FORWARD_LIMITS.nodes) return false;
      const n = node as Record<string, unknown>;
      if (typeof n.path !== 'string' || n.path.length > 500 || !Array.isArray(n.segments)
        || n.senderId !== undefined && typeof n.senderId !== 'string'
        || n.senderName !== undefined && typeof n.senderName !== 'string'
        || n.time !== undefined && (typeof n.time !== 'number' || !Number.isFinite(n.time))) return false;
      return n.segments.every(segment => {
        if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false;
        const s = segment as Record<string, unknown>;
        return s.type === 'forward' ? forward(s, depth + 1)
          : s.type === 'text' ? typeof s.text === 'string'
            : s.type === 'image' ? typeof s.assetId === 'string' && (s.sourceKey === undefined || typeof s.sourceKey === 'string') && (s.error === undefined || typeof s.error === 'string')
              : s.type === 'media' && typeof s.kind === 'string' && (s.name === undefined || typeof s.name === 'string') && (s.text === undefined || typeof s.text === 'string');
      });
    });
  };
  return v.contents.every(item => forward(item, 1));
}
