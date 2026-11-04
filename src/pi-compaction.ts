import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { contentText, normalizeContext, type Api, type Model } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { convertToLlm, serializeConversation, type CompactionResult, type SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import type { PiConfig } from './pi-protocol.js';
import {modelContextMessages} from './pi-context.js';

export const CHECKPOINT_HEADINGS = ['Recent relevant topics', 'People and references', 'Current facts and corrections', 'Explicitly unfinished work', 'Useful results and artifacts'];
export function validateChatCheckpoint(text: string, maxTokens: number): string {
  const value = text.trim();
  if (!value || Buffer.byteLength(value) > Math.max(1024, maxTokens * 12)
    || !CHECKPOINT_HEADINGS.every(heading => value.includes(`## ${heading}\n`))) {
    throw new Error('Chat checkpoint was empty, incomplete, or invalid.');
  }
  return value;
}

export async function createChatCheckpoint(event: SessionBeforeCompactEvent, config: PiConfig, model: Model<Api>): Promise<CompactionResult> {
  const p = event.preparation;
  const system = await readFile(new URL('../../prompts/compaction.md', import.meta.url), 'utf8');
  const maxTokens = Math.min(config.maxOutputTokens, config.summaryMaxTokens ?? 4000);
  const input = JSON.stringify({
    previousCheckpoint: p.previousSummary ?? null,
    historicalConversation: serializeConversation(convertToLlm(modelContextMessages(p.messagesToSummarize))),
    splitTurnPrefix: p.isSplitTurn ? serializeConversation(convertToLlm(modelContextMessages(p.turnPrefixMessages))) : null,
    instructions: 'Summarize only this material; the retained suffix is stored separately. Do not duplicate it. Use the five required headings.',
    maxOutputTokens: maxTokens,
  });
  const response = await completeSimple(model, normalizeContext({ systemPrompt: system, messages: [
    { role: 'user', content: [{ type: 'text', text: input }], timestamp: Date.now() },
  ] }), { apiKey: config.apiKey || 'not-required', signal: event.signal, maxTokens,
    transport: 'sse', maxRetries: 0, maxRetryDelayMs: 0,
    cacheRetention: 'none', sessionId: randomUUID() }).catch(error => {
      if (event.signal.aborted) throw error;
      throw Object.assign(error instanceof Error ? error : new Error('Chat checkpoint model request failed.'), {modelFailure:true});
    });
  if (response.stopReason !== 'stop' || response.content.some(part => part.type === 'toolCall')) {
    throw Object.assign(new Error(response.stopReason === 'error' && response.errorMessage
      ? response.errorMessage : 'Chat checkpoint generation did not complete successfully.'),
      response.stopReason === 'error' && !event.signal.aborted ? {modelFailure:true} : {});
  }
  const summary = validateChatCheckpoint(contentText(response.content), maxTokens);
  const read = new Set(p.fileOps.read);
  const modified = new Set([...p.fileOps.written, ...p.fileOps.edited]);
  // Pi intentionally does not inherit extension details, so carry our own file references.
  const previous = event.branchEntries.findLast(entry => entry.type === 'compaction');
  if (previous?.type === 'compaction' && previous.details && typeof previous.details === 'object') {
    const details = previous.details as Record<string, unknown>;
    for (const file of Array.isArray(details.readFiles) ? details.readFiles : []) if (typeof file === 'string') read.add(file);
    for (const file of Array.isArray(details.modifiedFiles) ? details.modifiedFiles : []) if (typeof file === 'string') modified.add(file);
  }
  return { summary, firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore,
    usage: response.usage, details: { kind: 'chat_checkpoint', version: 1,
      readFiles: [...read].filter(path => !modified.has(path)).sort(), modifiedFiles: [...modified].sort() } };
}
