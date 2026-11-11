import type { SegmentMessage } from './types.js';

export function isSegmentMessage(value: unknown): value is SegmentMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (Object.keys(message).some(key=>!['type','segments','replyTo'].includes(key)) || message.type !== 'message'
    || message.replyTo!==undefined&&(typeof message.replyTo!=='string'||!message.replyTo||message.replyTo.length>200||message.replyTo.trim()!==message.replyTo)
    || !Array.isArray(message.segments) || message.segments.length === 0) return false;
  return message.segments.every((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const segment = value as Record<string, unknown>;
    if (Object.keys(segment).length !== 2) return false;
    return segment.type === 'text' ? typeof segment.text === 'string' && segment.text.length > 0
      : segment.type === 'at' && typeof segment.userId === 'string' && /^[1-9]\d*$/.test(segment.userId);
  });
}
