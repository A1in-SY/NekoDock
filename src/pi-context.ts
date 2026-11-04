import { createHash } from 'node:crypto';
import { closeSync, createReadStream, fsyncSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import {createInterface} from 'node:readline';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ChatContextMessage, ContextCommit, ContextSubmission, ContextVersion } from './chat-context-contract.js';
import type {AgentMessage} from '@earendil-works/pi-agent-core';

export interface ContextImage { type: 'image'; data: string; mimeType: string }
export interface PiContextStart {
  submission: ContextSubmission;
  /** Immutable bytes prepared by the Worker before this round starts. */
  imageData: Record<string, ContextImage>;
}

interface ContextMarker {
  batchId: string;
  conversationId: string;
  versions: ContextVersion[];
  entries: Array<ContextVersion & { entryId: string }>;
}
type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const key = (message: ContextVersion) => `${message.chatMessageId}:${message.revision}`;

export function contextMessage(message: ChatContextMessage, historical = false): Json {
  return {
    chatMessageId: message.chatMessageId, revision: message.revision,
    messageId: message.messageId, senderId: message.senderId, senderName: message.senderName,
    time: message.time, text: message.text, replyTo: message.replyTo,
    role: message.role, origin: message.origin,
    ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
    ...(message.assets?.length ? { assets: message.assets, images: message.assets.filter(asset => asset.type === 'image'&&asset.modelInput!==false).map(asset => ({
      attachmentId: asset.id, status: asset.status ?? 'ready', ...(asset.path ? { path: asset.path } : {}), ...(asset.error ? { error: asset.error } : {}),
      ...(asset.origin==='plugin'?{origin:asset.origin,pluginId:asset.pluginId,assetId:asset.pluginAssetId}:{}),
    })) } : {}),
    ...(message.contents?.length ? { contents: message.contents } : {}),
    ...(message.sourceMessageId ? { sourceMessageId: message.sourceMessageId } : {}),
    ...(message.pluginId ? { pluginId: message.pluginId } : {}),
    ...(historical ? { historical: true } : {}),
  };
}

function paths(message: Json): string[] {
  const assets = Array.isArray(message.assets) ? message.assets : [];
  const images = Array.isArray(message.images) ? message.images : [];
  const found = [...assets.filter(item => object(item)?.type === 'image'&&object(item)?.modelInput!==false), ...images]
    .map(object).filter((item): item is Json => !!item)
    .filter(item => item.status === undefined || item.status === 'ready')
    .map(item => item.path).filter((path): path is string => typeof path === 'string');
  return [...new Set(found)];
}

function textInput(content: unknown): { envelope: Json; textIndex: number; blocks: Json[] } | null {
  if (!Array.isArray(content)) return null;
  for (const [textIndex, part] of content.entries()) {
    const block = object(part);
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const envelope = object(parseEnvelope(block.text));
      if (envelope && Array.isArray(envelope.messages)) return { envelope, textIndex, blocks: content as Json[] };
    } catch { /* Other user text remains untouched. */ }
  }
  return null;
}

function parseEnvelope(text: string): unknown {
  try { return JSON.parse(text); } catch { /* Pi may append a notice when rejecting an inline image. */ }
  const start = text.search(/\S/u);
  if (start < 0 || text[start] !== '{') return null;
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (--depth === 0) return JSON.parse(text.slice(start,index+1));
    }
  }
  return null;
}

/** Delivery metadata remains durable but has no semantic role in provider requests. */
export function modelContextMessages(messages: AgentMessage[]): AgentMessage[] {
  let result = messages;
  messages.forEach((message,index) => {
    if (message.role !== 'user') return;
    const input = textInput(message.content);
    if (!input || !validMarker(input.envelope.contextBatch)) return;
    const {contextBatch:_internal,...body} = input.envelope;
    const original = String(input.blocks[input.textIndex]!.text);
    const encoded = JSON.stringify(input.envelope);
    const suffix = original.startsWith(encoded) ? original.slice(encoded.length) : '';
    const content = [...input.blocks]; content[input.textIndex] = {...content[input.textIndex],text:JSON.stringify(body)+suffix};
    if (result === messages) result = [...messages];
    result[index] = {...message,content:content as never};
  });
  return result;
}

function inputImages(messages: Json[], imageData: Record<string, ContextImage>, old?: ReturnType<typeof textInput>): ContextImage[] {
  const fallback = new Map<string, ContextImage>();
  if (old) {
    const oldPaths = [...new Set((old.envelope.messages as unknown[]).flatMap(value => object(value) ? paths(value as Json) : []))];
    const blocks = old.blocks.filter(block => block.type === 'image') as unknown as ContextImage[];
    oldPaths.forEach((path, index) => { if (blocks[index]) fallback.set(path, blocks[index]!); });
  }
  return [...new Set(messages.flatMap(paths))].flatMap(path => {
    const image = imageData[path] ?? fallback.get(path);
    return image ? [image] : [];
  });
}

/** Apply only revisions whose original entry still contributes to the active context. */
export function prepareContextInput(manager: SessionManager, plan: PiContextStart, replyTargets: string[]): {
  prompt: string; images: ContextImage[]; marker: ContextMarker;
} {
  const submission = plan.submission;
  const active = new Map(manager.buildSessionProjection().entries.map(entry => [entry.sourceEntry.id, entry]));
  const revised = new Map<string, ContextVersion & { entryId: string }>();
  const unresolved: ChatContextMessage[] = [];
  const groups = new Map<string, typeof submission.revisions>();
  const revisions = [...submission.revisions];
  const locate = (message: ChatContextMessage) => {
    const exact: Array<{entryId:string;previous:Json}> = [];
    const legacy: Array<{entryId:string;previous:Json}> = [];
    for (const entry of active.values()) {
      const projected = entry.messages.find(item => item.role === 'user');
      const old = projected ? textInput(projected.content) : null;
      for (const value of old?.envelope.messages as unknown[] | undefined ?? []) {
        const previous = object(value); if (!previous) continue;
        if (previous.chatMessageId === message.chatMessageId) exact.push({entryId:entry.sourceEntry.id,previous});
        else if (!previous.chatMessageId && message.origin === 'human' && message.messageId !== null
          && previous.messageId === message.messageId && previous.senderId === message.senderId
          && (previous.role === undefined || previous.role === 'user')) legacy.push({entryId:entry.sourceEntry.id,previous});
      }
    }
    const found = exact.length ? exact : legacy;
    return found.length === 1 ? found[0] : undefined;
  };
  const newMessages: ChatContextMessage[] = [];
  for (const message of submission.messages) {
    const found = locate(message);
    if (!found) { newMessages.push(message); continue; }
    revised.set(key(message),{chatMessageId:message.chatMessageId,revision:message.revision,entryId:found.entryId});
    if (Number(found.previous.revision ?? 0) <= message.revision
      && !revisions.some(item => item.message.chatMessageId === message.chatMessageId)) revisions.push({message,entryId:found.entryId});
  }
  for (const message of submission.references) {
    if (revisions.some(item => item.message.chatMessageId === message.chatMessageId)) continue;
    const found = locate(message);
    if (found && Number(found.previous.revision ?? 0) < message.revision) revisions.push({message,entryId:found.entryId});
  }
  for (const revision of revisions) {
    const group = groups.get(revision.entryId) ?? []; group.push(revision); groups.set(revision.entryId, group);
  }
  for (const [entryId, revisions] of groups) {
    const entry = active.get(entryId);
    const projected = entry?.messages.find(message => message.role === 'user');
    const old = projected ? textInput(projected.content) : null;
    if (!old) { unresolved.push(...revisions.map(item => item.message)); continue; }
    const messages = (old.envelope.messages as unknown[]).map(value => object(value) ?? {});
    let changed = false;
    for (const { message } of revisions) {
      const index = messages.findIndex(previous => previous.chatMessageId === message.chatMessageId
        || !previous.chatMessageId && message.messageId !== null && previous.messageId === message.messageId);
      if (index < 0) { unresolved.push(message); continue; }
      const replacement = contextMessage(message, messages[index]!.historical === true);
      if (JSON.stringify(messages[index]) !== JSON.stringify(replacement)) { messages[index] = replacement; changed = true; }
      revised.set(key(message), { chatMessageId: message.chatMessageId, revision: message.revision, entryId });
    }
    if (changed) {
      const envelope = { ...old.envelope, messages };
      const content = old.blocks.filter((block, index) => index !== old.textIndex && block.type !== 'image');
      content.splice(Math.min(old.textIndex, content.length), 0, { type: 'text', text: JSON.stringify(envelope) });
      content.push(...inputImages(messages, plan.imageData, old).map(image => ({...image})));
      manager.appendContextEdit(entryId, { content: content as never });
    }
  }
  const receiptGroups = new Map<string, ChatContextMessage[]>();
  for (const message of [...submission.receipts ?? [], ...submission.references.filter(message => message.origin === 'model')]) if (message.toolCallId) {
    const group = receiptGroups.get(message.toolCallId) ?? [];
    if (!group.some(item => key(item) === key(message))) group.push(message);
    receiptGroups.set(message.toolCallId, group);
  }
  for (const [toolCallId, receipts] of receiptGroups) {
    const source = [...active.values()].find(entry => entry.messages.some(message => message.role === 'toolResult' && message.toolCallId === toolCallId));
    const result = source?.messages.find(message => message.role === 'toolResult' && message.toolCallId === toolCallId);
    if (!source || !result || result.role !== 'toolResult' || !Array.isArray(result.content)) continue;
    let content = structuredClone(result.content);
    const text = content.find(part => part.type === 'text');
    if (!text || text.type !== 'text') continue;
    let body: Json | null;
    try { body = object(JSON.parse(text.text)); } catch { continue; }
    if (body?.accepted !== true) continue;
    const delivered = new Map<string, Json>((Array.isArray(body.deliveredMessages) ? body.deliveredMessages : [])
      .map(object).filter((item): item is Json => !!item && typeof item.chatMessageId === 'string')
      .map(item => [item.chatMessageId as string, item]));
    const before = [...delivered.values()];
    for (const message of receipts) {
      delivered.set(message.chatMessageId, { chatMessageId: message.chatMessageId, revision: message.revision,
        messageId: message.messageId, logicalMessageIndex: message.logicalMessageIndex, partIndex: message.partIndex,
        ...(message.assets?.length ? {assets:message.assets} : {}) });
      revised.set(key(message), {chatMessageId:message.chatMessageId,revision:message.revision,entryId:source.sourceEntry.id});
    }
    const next = JSON.stringify({...body,deliveredMessages:[...delivered.values()]});
    text.text = next;
    const imageBlocks = inputImages([...delivered.values()],plan.imageData,{envelope:{messages:before},textIndex:0,blocks:result.content as unknown as Json[]});
    content = [...content.filter(block => block.type !== 'image'),...imageBlocks];
    if (JSON.stringify(content) !== JSON.stringify(result.content)) manager.appendContextEdit(source.sourceEntry.id, {content});
  }
  const selected = new Map<string, Json>();
  for (const message of newMessages) selected.set(message.chatMessageId, contextMessage(message));
  const present = new Map<string, ContextVersion & {entryId:string}>();
  for (const entry of manager.buildSessionProjection().entries) for (const projected of entry.messages) {
    if (projected.role === 'user') {
      const envelope = textInput(projected.content)?.envelope;
      for (const value of Array.isArray(envelope?.messages) ? envelope.messages : []) {
        const message = object(value);
        if (typeof message?.chatMessageId === 'string' && Number.isSafeInteger(message.revision)) {
          present.set(message.chatMessageId, {chatMessageId:message.chatMessageId,revision:Number(message.revision),entryId:entry.sourceEntry.id});
        }
      }
    } else if (projected.role === 'toolResult') {
      for (const block of projected.content) if (block.type === 'text') {
        let body: Json | null;
        try { body = object(JSON.parse(block.text)); } catch { continue; }
        for (const value of Array.isArray(body?.deliveredMessages) ? body.deliveredMessages : []) {
          const message = object(value);
          if (typeof message?.chatMessageId === 'string' && Number.isSafeInteger(message.revision)) {
            present.set(message.chatMessageId, {chatMessageId:message.chatMessageId,revision:Number(message.revision),entryId:entry.sourceEntry.id});
          }
        }
      }
    }
  }
  for (const message of [...submission.references, ...unresolved]) if (!selected.has(message.chatMessageId)) {
    const existing = present.get(message.chatMessageId);
    if (existing && existing.revision >= message.revision) revised.set(key(message), {...existing,revision:message.revision});
    else selected.set(message.chatMessageId, contextMessage(message, true));
  }
  const messages = [...selected.values()].sort((a,b) => a.sequence !== undefined && b.sequence !== undefined
    ? Number(a.sequence)-Number(b.sequence)
    : Number(a.time)-Number(b.time));
  const marker: ContextMarker = { batchId: submission.batchId, conversationId: submission.conversationId,
    versions: submission.versions, entries: [...revised.values()] };
  // Keep reply targets last so stable chat content remains a reusable provider prefix.
  const prompt = JSON.stringify({ messages, contextBatch: marker, replyTargetMessageIds: replyTargets });
  return { prompt, images: inputImages(messages, plan.imageData), marker };
}

function validMarker(value: unknown): value is ContextMarker {
  const item = object(value);
  return !!item && typeof item.batchId === 'string' && item.batchId.length <= 200
    && typeof item.conversationId === 'string' && item.conversationId.length <= 200
    && Array.isArray(item.versions) && item.versions.length <= 10_000
    && item.versions.every(value => { const version = object(value); return version && typeof version.chatMessageId === 'string'
      && version.chatMessageId.length <= 400 && Number.isSafeInteger(version.revision) && Number(version.revision) > 0; })
    && Array.isArray(item.entries) && item.entries.every(value => { const entry = object(value); return entry
      && typeof entry.chatMessageId === 'string' && Number.isSafeInteger(entry.revision) && typeof entry.entryId === 'string'; });
}

function receipt(entry: Json, session: string): ContextCommit | null {
  const message = object(entry.message);
  if (entry.type !== 'message' || message?.role !== 'user' || typeof entry.id !== 'string') return null;
  const input = textInput(message.content); const marker = input?.envelope.contextBatch;
  if (!input || !validMarker(marker)) return null;
  const text = String(input.blocks[input.textIndex]!.text);
  const entryId = entry.id;
  const revised = new Map(marker.entries.map(item => [key(item), item]));
  return { batchId: marker.batchId, conversationId: marker.conversationId, session, entryId,
    versions: marker.versions, hash: createHash('sha256').update(text).digest('hex'),
    entries: marker.versions.map(version => revised.get(key(version)) ?? { ...version, entryId }) };
}

/** The acknowledgement follows file and directory sync, independently of generation. */
export function committedContext(manager: SessionManager, batchId: string): ContextCommit | null {
  const session = manager.getSessionFile(); if (!session) return null;
  const entry = manager.getBranch().findLast(entry => {
    const value = receipt(entry as unknown as Json, session); return value?.batchId === batchId;
  });
  if (!entry) return null;
  syncSession(session);
  return receipt(entry as unknown as Json, session);
}

function syncSession(session: string): void {
  const file = openSync(session, 'r');
  try { fsyncSync(file); } finally { closeSync(file); }
  const directory = openSync(dirname(session), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Read only the current branch; never instantiate a mutable runtime or replay tools. */
export async function recoverContextReceipts(session: string): Promise<ContextCommit[]> {
  const input = createReadStream(session,{encoding:'utf8'});
  const lines = createInterface({input,crlfDelay:Infinity});
  const entries = new Map<string,{parentId:string|null;commit:ContextCommit|null}>();
  let leaf: string | null = null;let headerSeen=false;
  try {
    for await (const line of lines) {
      try {
        const entry = object(JSON.parse(line));
        if(!headerSeen) {
          if(!entry)continue;
          headerSeen=true;
          if(entry.type!=='session'||typeof entry.id!=='string'||!entry.id)return [];
        }
        if (entry && typeof entry.id === 'string') {
          entries.set(entry.id,{parentId:typeof entry.parentId === 'string'?entry.parentId:null,commit:receipt(entry,session)});
          leaf = entry.id;
        }
      } catch { /* An interrupted final append has no commit. */ }
    }
  } finally {lines.close();input.destroy();}
  const commits: ContextCommit[] = []; const seen = new Set<string>();
  while (leaf) {
    if(seen.has(leaf))return [];
    seen.add(leaf);const entry = entries.get(leaf);if(!entry)return [];
    if(entry.commit)commits.push(entry.commit);leaf=entry.parentId;
  }
  const receipts = commits.reverse();
  if (receipts.length) syncSession(session);
  return receipts;
}
