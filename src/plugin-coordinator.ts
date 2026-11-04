import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeStore } from './store.js';
import type { Logger, PendingBatch } from './types.js';
import type { ManagedIdentity } from './managed-worker.js';
import { workerRequest } from './managed-worker.js';
import { directFetch } from './network.js';
import { formatCommandHelp } from './plugins/core/commands.js';
import { logEvent } from './logging.js';
import type { PluginCommand, PluginResult, PluginSync } from './plugin-contract.js';
import type { ChatAsset } from './chat-context-contract.js';
import { pluginSourceImageIds } from './plugin-images.js';

interface PluginSnapshot {
  results: PluginResult[];
  commands: PluginCommand[];
  pendingBindings?: string[];
  pendingSources?: string[];
  waitSeconds?: number;
}
interface SendResult {
  ok: boolean; messageId?: string; code?: string; deliveryStatus?: 'failed' | 'unconfirmed';
  replyTo?: string | null;
  text?: string; asset?: { id: string; type: 'video'|'image'; title?: string; status: 'ready'; role?: string };
}
export interface PluginCoordinatorOptions {
  identity: ManagedIdentity;
  store: BridgeStore;
  logger: Logger;
  notify(): void;
  request?: (path: string, body: unknown | undefined, signal: AbortSignal) => Promise<unknown>;
  send?: (result: PluginResult, signal: AbortSignal) => Promise<SendResult>;
  registerImages?: (messageId:string,pluginId:string,assetIds:string[])=>void;
}

/** Plugins publish facts; only the worker decides when a chat action or Pi write runs. */
export class PluginCoordinator {
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private closed = false;
  private draining = false;
  private readonly bindings = new Set<string>();
  private readonly acknowledgements = new Set<string>();
  private readonly outputs = new Map<string, PluginResult>();
  private readonly uncertain = new Set<string>();
  private readonly cancellations = new Map<string, 'expired' | 'conversation_changed'>();
  private pendingSources = new Set<string>();
  private commands: PluginCommand[] = [];
  private waitSeconds = 2;
  private lastConversation = '';
  private readonly abortParent: () => void;

  constructor(private readonly options: PluginCoordinatorOptions, private readonly signal: AbortSignal) {
    this.abortParent = () => this.controller.abort();
    signal.addEventListener('abort', this.abortParent, { once: true });
    if (signal.aborted) this.controller.abort();
  }
  get helpText(): string { return formatCommandHelp(this.commands); }
  get hasPending(): boolean { return !this.closed && !this.draining && this.outputs.size > 0; }
  register(messageId: string): void { if (!this.closed) this.bindings.add(messageId); }
  start(): void {
    if (this.closed || this.timer) return;
    const tick = async () => {
      this.timer = undefined;
      try { await this.synchronize(); } catch { if (!this.controller.signal.aborted) logEvent(this.options.logger, 'warn', 'plugin.sync.failed'); }
      if (!this.closed && !this.controller.signal.aborted) { this.timer = setTimeout(() => void tick(), 1000); this.timer.unref(); }
    };
    void tick();
  }
  requestDrain(): void { this.draining = true; this.outputs.clear(); }
  async close(): Promise<void> {
    this.closed = true; this.draining = true; clearTimeout(this.timer); this.controller.abort();
    this.signal.removeEventListener('abort', this.abortParent);
    try { await this.flight; } catch { /* The result stays durable at the host. */ }
  }

  async beforeContext(batch: PendingBatch, signal: AbortSignal): Promise<void> {
    for (const message of batch.messages) this.register(message.messageId);
    const affected = new Set(batch.messages.flatMap(message => [message.messageId, ...(message.replyTo ? [message.replyTo] : [])]));
    const deadline = Date.now() + this.waitSeconds * 1000;
    do {
      signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) { void this.synchronize().catch(() => {}); return; }
      try {
        const completed = await Promise.race([
          this.synchronize().then(() => true),
          delay(remaining, false, { signal }),
        ]);
        if (!completed) return;
      } catch { signal.throwIfAborted(); return; }
      if (![...affected].some(id => this.pendingSources.has(id)) || Date.now() >= deadline) return;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal });
    } while (Date.now() < deadline);
  }

  synchronize(): Promise<void> {
    if (this.closed || this.controller.signal.aborted) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.sync().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private request(path: string, body?: unknown): Promise<unknown> {
    return this.options.request
      ? this.options.request(path, body, this.controller.signal)
      : workerRequest(this.options.identity, path, body, this.controller.signal);
  }
  private async sync(): Promise<void> {
    const store = this.options.store;
    for (const [id, reason] of [...this.cancellations].slice(0, 100)) {
      const response = await this.request(`plugins/${encodeURIComponent(id)}/cancel`, { reason }) as { cancelled?: boolean };
      if (response?.cancelled !== false) this.acknowledgements.add(id);
      else this.uncertain.add(id);
      this.cancellations.delete(id);
    }
    const bind = [...this.bindings].flatMap(messageId => {
      const conversationId = store.getMessageConversation(messageId);
      return conversationId ? [{ messageId, conversationId }] : [];
    }).slice(0, 200);
    const ack = [...this.acknowledgements].slice(0, 200);
    const current = store.recorder.conversationId;
    if (bind.length || ack.length || current !== this.lastConversation) {
      await this.request('plugins/sync', { bindings: bind, acknowledgements: ack, conversationId: current } satisfies PluginSync);
      for (const item of bind) this.bindings.delete(item.messageId);
      for (const id of ack) this.acknowledgements.delete(id);
      this.lastConversation = current;
    }
    const value = await this.request('plugins') as PluginSnapshot;
    if (!value || !Array.isArray(value.results) || !Array.isArray(value.commands) || value.results.length > 1000) throw new Error('Invalid plugin snapshot.');
    this.commands = value.commands.filter(command => command && typeof command.name === 'string' && typeof command.description === 'string');
    if (Number.isSafeInteger(value.waitSeconds)) this.waitSeconds = Math.max(0, Math.min(5, value.waitSeconds!));
    for (const id of value.pendingBindings ?? []) if (typeof id === 'string') this.register(id);
    this.pendingSources = new Set((value.pendingSources ?? []).filter(id => typeof id === 'string'));
    for (const result of value.results) {
      if (!result || typeof result.id !== 'string' || typeof result.sourceMessageId !== 'string' || typeof result.conversationId !== 'string') throw new Error('Invalid plugin result.');
      const source = store.chatMessageForQQ(result.sourceMessageId);
      if (!source || source.conversationId !== result.conversationId) continue;
      if (result.kind === 'enrichment') {
        if (Array.isArray(result.contents)) store.applyEnrichment(result.sourceMessageId, result.pluginId, result.contents, result.revision);
        else if (result.content) store.mergeEnrichment(result.sourceMessageId, result.pluginId, result.content, result.revision);
        this.options.registerImages?.(result.sourceMessageId,result.pluginId,pluginSourceImageIds(store.chatMessageForQQ(result.sourceMessageId)?.contents??[]));
        this.acknowledgements.add(result.id);
      } else if (result.delivery) {
        if (result.delivery.status === 'acknowledged') this.recordReply(result, { ok: true, messageId: result.delivery.messageId, text: result.text,
          ...(result.assetId ? { asset: { id: result.assetId, type: result.kind==='image'?'image':'video', status: 'ready', title: result.content?.title,role:result.assetRole } } : {}) });
        this.acknowledgements.add(result.id); this.outputs.delete(result.id); this.uncertain.delete(result.id);
      } else if (!this.draining && !this.acknowledgements.has(result.id) && !this.uncertain.has(result.id)) {
        this.outputs.set(result.id, result);
      }
    }
    const active = new Set(value.results.map(result => result.id));
    for (const id of this.outputs.keys()) if (!active.has(id)) this.outputs.delete(id);
    for (const id of this.uncertain) if (!active.has(id)) this.uncertain.delete(id);
    if (this.hasPending) this.options.notify();
  }

  async runNext(signal: AbortSignal): Promise<boolean> {
    if (!this.hasPending) return false;
    const result = this.outputs.values().next().value as PluginResult | undefined;
    if (!result) return false;
    this.outputs.delete(result.id);
    if (result.conversationId !== this.options.store.recorder.conversationId
      && this.options.store.chatMessageForQQ(result.sourceMessageId)?.conversationId === this.options.store.recorder.conversationId) {
      // The source moved after this snapshot. Wait for the host's durable migration
      // instead of cancelling a result that still belongs to the queued message.
      try { await this.synchronize(); } catch { /* A later poll refreshes ownership. */ }
      return true;
    }
    if (result.conversationId !== this.options.store.recorder.conversationId || result.expiresAt !== undefined && result.expiresAt <= Date.now()) {
      this.cancellations.set(result.id, result.conversationId !== this.options.store.recorder.conversationId ? 'conversation_changed' : 'expired');
      try { await this.synchronize(); } catch { /* Retain the cancellation until the host confirms it. */ }
      return true;
    }
    try {
      const receipt = await (this.options.send ? this.options.send(result, signal) : this.send(result, signal));
      if (receipt.ok) this.recordReply(result, receipt);
      else logEvent(this.options.logger, 'warn', 'plugin.reply.failed', { plugin_id: result.pluginId, code: receipt.code, status: receipt.deliveryStatus });
      this.acknowledgements.add(result.id);
    } catch {
      // The host retains one stable delivery intent. Poll its result, never issue a new send.
      this.uncertain.add(result.id);
      logEvent(this.options.logger, 'warn', 'plugin.reply.unconfirmed', { plugin_id: result.pluginId });
    }
    return true;
  }
  private recordReply(result: PluginResult, receipt: SendResult): void {
    const assets: ChatAsset[] = receipt.asset ? [{ ...receipt.asset,...(receipt.asset.type==='image'?{modelInput:false}:{}) }] : [];
    const replyTo=receipt.replyTo!==undefined?receipt.replyTo:result.replyTo===undefined?result.kind==='video'||result.kind==='image'?null:result.sourceMessageId:result.replyTo;
    this.options.store.recordPluginReply({ id: `plugin:${result.id}`, conversationId: result.conversationId, pluginId: result.pluginId,
      sourceMessageId: result.sourceMessageId, text: receipt.text ?? result.text ?? (assets.length ? result.kind==='image'?'[图片]':'[视频]' : ''),
      replyTo,
      qqMessageId: receipt.messageId, assets });
  }
  private async send(result: PluginResult, signal: AbortSignal): Promise<SendResult> {
    const identity = this.options.identity;
    const response = await directFetch(`${identity.url}/internal/workers/${encodeURIComponent(identity.botId)}/plugins/${encodeURIComponent(result.id)}/send`, {
      method: 'POST', headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(125_000)]), redirect: 'error',
    });
    if (!response.ok) throw new Error('Plugin delivery unavailable.');
    const receipt = await response.json() as SendResult;
    if (!receipt || typeof receipt.ok !== 'boolean') throw new Error('Invalid plugin delivery response.');
    return receipt;
  }
}
