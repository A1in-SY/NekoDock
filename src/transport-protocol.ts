import type { MessageSegment, OutgoingDeliveryMetadata } from './types.js';
import { INCOMING_IMAGE_MAX_COUNT } from './incoming-image-contract.js';
import { FORWARD_LIMITS } from './forward-contract.js';

/** The same event bound applies before persistence and after SSE framing. */
export const NAPCAT_EVENT_MAX_BYTES = 16 * 1024 * 1024;
export const NAPCAT_SSE_MAX_BYTES = NAPCAT_EVENT_MAX_BYTES + FORWARD_LIMITS.bytes + INCOMING_IMAGE_MAX_COUNT * 1024 + 2048;
export const NAPCAT_MEDIA_MAX_BYTES = 16 * 1024 * 1024;

export type NapcatOutgoingMessage =
  | { kind: 'text'; text: string; replyTo?: string }
  | { kind: 'image'; file: string }
  | { kind: 'video'; file: string }
  | { kind: 'voice'; file: string }
  | { kind: 'message'; segments: MessageSegment[]; replyTo?:string };

/** A delivery ID identifies one attempt permanently, including an unknown outcome. */
export type NapcatSendRequest = NapcatOutgoingMessage & { deliveryId: string; deadline: number; metadata?:OutgoingDeliveryMetadata };
export type NapcatSendResult = { ok: true; messageId?: string }
  | { ok: false; code: string; deliveryStatus: 'failed' | 'unconfirmed' };
export interface NapcatInboundDelivery { seq: number; event: unknown }
export interface NapcatChannelStatus { connected: boolean; online: boolean; paused?: boolean }

export function isNapcatSendResult(value: unknown): value is NapcatSendResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.ok === true ? (result.messageId === undefined || typeof result.messageId === 'string')
    : result.ok === false && typeof result.code === 'string'
      && (result.deliveryStatus === 'failed' || result.deliveryStatus === 'unconfirmed');
}
