import { logEvent } from './logging.js';
import type { SpeechProvider } from './tts.js';
import type { Logger, MessageSegment, MessageSender, OutgoingDeliveryMetadata, OutputMessage, ReplyPart, SegmentMessage } from './types.js';

export function splitReply(text: string, maxChars: number): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('无效的回复分段长度');
  const chars = Array.from(text);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars) parts.push(chars.slice(i, i + maxChars).join(''));
  return parts;
}

export function splitMessage(segments: MessageSegment[], maxChars: number): SegmentMessage[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('无效的回复分段长度');
  const parts: SegmentMessage[] = [];
  let current: MessageSegment[] = [];
  let pendingMentions: MessageSegment[] = [];
  let charsInCurrent = 0;
  for (const segment of segments) {
    if (segment.type === 'at') {
      pendingMentions.push({ ...segment });
      continue;
    }
    const chars = Array.from(segment.text);
    for (let offset = 0; offset < chars.length;) {
      if (charsInCurrent === maxChars) {
        parts.push({ type: 'message', segments: current });
        current = [];
        charsInCurrent = 0;
      }
      current.push(...pendingMentions);
      pendingMentions = [];
      const count = Math.min(maxChars - charsInCurrent, chars.length - offset);
      current.push({ type: 'text', text: chars.slice(offset, offset + count).join('') });
      charsInCurrent += count;
      offset += count;
    }
  }
  current.push(...pendingMentions);
  if (current.length > 0) parts.push({ type: 'message', segments: current });
  return parts;
}

export interface ReplyDeliveryOptions {
  replyMaxChars:number; speech?:SpeechProvider|null; voiceReplyEnabled?:boolean; voiceReplyProbability?:number;
  sender:MessageSender; logger:Logger; random?:()=>number; ttsMaxChars?:number;
}
export function prepareReplyParts(messages:OutputMessage[],options:ReplyDeliveryOptions,throughSeq:number, messageIndices?:number[]):ReplyPart[] {
    const { replyMaxChars, speech, voiceReplyEnabled, sender, logger } = options;
    const probability = options.voiceReplyProbability ?? 0.2;
    const replies: ReplyPart[] = [];
    for (const [messageIndex, message] of messages.entries()) {
      const start=replies.length;
      try {
      if (message.type === 'image') {
        replies.push({ type: 'image', file: message.path });
        continue;
      }
      const text = message.type === 'text' ? message.text
        : message.segments.filter(segment => segment.type === 'text').map(segment => segment.text).join('');
      const useVoice = !message.replyTo && voiceReplyEnabled && speech && sender.sendVoice && text.trim().length > 0 && probability > 0
        && (probability === 1 || (options.random ?? Math.random)() < probability);
      if (!useVoice) {
        if (message.type === 'text') replies.push(...splitReply(message.text, replyMaxChars));
        else replies.push(...splitMessage(message.segments, replyMaxChars));
        continue;
      }
      const parts = splitReply(text, Math.min(replyMaxChars, options.ttsMaxChars ?? 300));
      if (message.type === 'message') {
        const mentions = message.segments.filter(segment => segment.type === 'at').map(segment => ({ ...segment }));
        if (mentions.length > 0) replies.push({ type: 'message', segments: mentions });
      }
      for (const text of parts) replies.push(text.trim() ? { type: 'voice', text } : text);
      logEvent(logger, 'info', 'processor.voice.selected', {
        through_seq: throughSeq, message_index: messageIndex, text_chars: Array.from(text).length, part_count: parts.length,
      });
      } finally {for(let i=start;i<replies.length;i++)messageIndices?.push(messageIndex);}
    }
    return replies;
}

export async function transmitReply(part:ReplyPart,sender:MessageSender,signal:AbortSignal,replyTo?:string,metadata?:OutgoingDeliveryMetadata) {
  if(typeof part==='string')return sender.sendText(part,signal,replyTo,metadata);
  if(part.type==='message')return sender.sendMessage(part.segments,signal,replyTo,metadata);
  if(part.type==='voice') {
    if(!sender.sendVoice||!part.file)throw new Error('Prepared voice sender unavailable');
    return sender.sendVoice(part.file,signal,metadata);
  }
  return sender.sendImage(part.file,signal,metadata);
}
