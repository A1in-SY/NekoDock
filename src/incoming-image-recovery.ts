import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Reconstruct only explicit message-to-file links already saved in Pi user inputs. */
export async function recoverIncomingImages(session: string, signal: AbortSignal,
  adopt: (messageId: string, index: number, path: string, signal: AbortSignal) => Promise<boolean>): Promise<number> {
  const source = createReadStream(session, { encoding: 'utf8', signal });
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  let restored = 0;
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      // A message may contain base64 attachments; never copy those into the cache index.
      if (!line.includes('.qq-images') || line.length > 32 * 1024 * 1024) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== 'message' || entry.message?.role !== 'user' || !Array.isArray(entry.message.content)) continue;
      for (const block of entry.message.content) {
        if (block?.type !== 'text' || typeof block.text !== 'string') continue;
        let input: any;
        try { input = JSON.parse(block.text); } catch { continue; }
        if (!Array.isArray(input?.messages)) continue;
        for (const message of input.messages) {
          if (typeof message?.messageId !== 'string' || !Array.isArray(message.images)) continue;
          for (const [index, image] of message.images.entries()) {
            if(image?.origin==='plugin'||typeof image?.attachmentId==='string'&&image.attachmentId.startsWith('plugin:'))continue;
            if (typeof image?.path === 'string' && await adopt(message.messageId, index, image.path, signal)) restored++;
          }
        }
      }
    }
    return restored;
  } finally { lines.close(); source.destroy(); }
}
