import { resizeImage } from '@earendil-works/pi-coding-agent';
import type { ContextImage } from './pi-context.js';

// maxBytes bounds the Base64 payload, rather than the decoded file size.
export const MODEL_IMAGE_OPTIONS = { maxWidth: 1600, maxHeight: 1600, maxBytes: 512 * 1024, jpegQuality: 80 };

export async function prepareModelImage(bytes: Buffer, mimeType: string): Promise<ContextImage> {
  const prepared = await resizeImage(bytes, mimeType, MODEL_IMAGE_OPTIONS);
  if (!prepared) throw new Error('Image cannot be prepared for inline context.');
  return { type: 'image', data: prepared.data, mimeType: prepared.mimeType };
}
