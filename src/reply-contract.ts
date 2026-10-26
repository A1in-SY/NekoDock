import { isSegmentMessage } from './messages.js';
import type { OutputMessage, ReplyToolRequest, TargetType } from './types.js';

export const REPLY_MAX_MESSAGES = 10;
export const REPLY_MAX_BODY_BYTES = 256 * 1024;

export function replyMessagesSchema(targetType?: TargetType) {
  return {
    type: 'array' as const, minItems: 1, maxItems: REPLY_MAX_MESSAGES,
    items: { anyOf: [
      { type: 'object', properties: { type: { type: 'string', enum: ['text'] }, text: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['type', 'text'], additionalProperties: false },
      { type: 'object', properties: { type: { type: 'string', enum: ['image'] }, path: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['type', 'path'], additionalProperties: false },
      ...(targetType === 'group' ? [{ type: 'object', properties: {
        type: { type: 'string', enum: ['message'] }, segments: { type: 'array', minItems: 1, maxItems: 100, items: { anyOf: [
          { type: 'object', properties: { type: { type: 'string', enum: ['text'] }, text: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['type', 'text'], additionalProperties: false },
          { type: 'object', properties: { type: { type: 'string', enum: ['at'] }, userId: { type: 'string', pattern: '^[1-9]\\d*$' } }, required: ['type', 'userId'], additionalProperties: false },
        ] } },
      }, required: ['type', 'segments'], additionalProperties: false }] : []),
    ] },
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class ReplyToolError extends Error {
  constructor(readonly code: 'REPLY_INVALID_REQUEST' | 'REPLY_UNAVAILABLE', message: string) { super(message); }
}

export function validateReplyRequest(value: unknown, targetType?: TargetType): ReplyToolRequest {
  const input = object(value);
  const invalid = () => new ReplyToolError('REPLY_INVALID_REQUEST', 'Invalid reply tool arguments.');
  if (!input || Object.keys(input).some(key => key !== 'messages')
    || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > REPLY_MAX_MESSAGES) throw invalid();
  const messages: OutputMessage[] = input.messages.map(value => {
    if (targetType === 'group' && isSegmentMessage(value) && value.segments.length <= 100
      && value.segments.every(segment => segment.type !== 'text' || segment.text.length <= 20000)) {
      return { type: 'message', segments: value.segments.map(segment => segment.type === 'text'
        ? { type: 'text', text: segment.text } : { type: 'at', userId: segment.userId }) };
    }
    const message = object(value);
    if (!message || Object.keys(message).length !== 2) throw invalid();
    if (message.type === 'text' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 20000) return { type: 'text', text: message.text };
    if (message.type === 'image' && typeof message.path === 'string' && message.path.trim() && message.path.length <= 4096
      && (!/^[a-z][a-z\d+.-]*:/i.test(message.path) || /^https?:\/\//i.test(message.path))) return { type: 'image', path: message.path };
    throw invalid();
  });
  return { messages };
}
