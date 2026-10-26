import { randomUUID } from 'node:crypto';
import type { BotRecord, RuntimeState } from './contracts.js';
import type { DockerClient, ContainerInfo } from './docker.js';

interface Runtime { state: RuntimeState; connected: boolean; processing: boolean; drained: boolean; lastHeartbeat: number | null; error?: string }
interface LifecycleStore {
  listBots(): BotRecord[]; getBot(id: string): BotRecord | null; getRuntime(id: string): Runtime;
  setRuntime(id: string, patch: Partial<Omit<Runtime, 'error'>> & { error?: string | null }): void;
  setDesiredState(id: string, state: 'running' | 'stopped'): void;
  getSetting(key: string): string | null; setSetting(key: string, value: string): void;
}
interface Operation { id: string; kind: 'start' | 'stop' | 'restart'; phase: 'drain' | 'starting'; time: number; containerId?: string }

export class Lifecycle {
  private busy = false;
  private retryAt = new Map<string, number>();
  constructor(readonly store: LifecycleStore, readonly docker: DockerClient) {}
  operation(id: string): Operation | null {
    try {
      const op = JSON.parse(this.store.getSetting(`operation.${id}`) ?? 'null') as Operation | null;
      return op && typeof op.id === 'string' && ['start', 'stop', 'restart'].includes(op.kind) && ['drain', 'starting'].includes(op.phase) && Number.isFinite(op.time) ? op : null;
    } catch { return null; }
  }
  effectiveState(bot: BotRecord): 'running' | 'stopped' { return this.operation(bot.id)?.phase === 'drain' ? 'stopped' : bot.desiredState; }
  request(id: string, action: 'start' | 'stop' | 'restart'): void {
    const bot = this.store.getBot(id);
    if (!bot) throw new Error('实例不存在');
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('实例操作无效');
    if (action !== 'stop') {
      const collision = this.store.listBots().some(other => other.id !== id && (other.desiredState === 'running' || this.store.getRuntime(other.id).state !== 'stopped') && other.targetType === bot.targetType && other.targetId === bot.targetId && other.config.wsUrl === bot.config.wsUrl);
      if (collision) throw new Error('同一 NapCat 连接和目标已有运行实例');
    }
    this.store.setDesiredState(id, action === 'stop' ? 'stopped' : 'running');
    this.retryAt.delete(id);
    const op: Operation = { id: randomUUID(), kind: action, phase: action === 'start' ? 'starting' : 'drain', time: Date.now() };
    this.saveOperation(id, op);
    this.store.setRuntime(id, { state: action === 'start' ? 'starting' : 'stopping', drained: false, error: null });
  }
  async reconcile(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const snapshot of this.store.listBots()) {
        if ((this.retryAt.get(snapshot.id) ?? 0) > Date.now()) continue;
        try { await this.reconcileBot(snapshot.id); }
        catch {
          this.retryAt.set(snapshot.id, Date.now() + 30000);
          this.store.setRuntime(snapshot.id, { state: 'error', error: '容器操作失败，请检查 Docker 服务、镜像和数据卷' });
        }
      }
    } finally { this.busy = false; }
  }
  private async reconcileBot(id: string): Promise<void> {
    let container = await this.docker.inspect(id);
    let bot = this.store.getBot(id)!;
    let op = this.operation(id);
    let runtime = this.store.getRuntime(id);
    if (this.effectiveState(bot) === 'stopped') {
      if (container?.State.Running) {
        const heartbeatAfterRequest = runtime.lastHeartbeat !== null && (!op || runtime.lastHeartbeat > op.time);
        if (!runtime.drained || !heartbeatAfterRequest || Date.now() - runtime.lastHeartbeat! >= 15000) {
          this.store.setRuntime(id, { state: 'stopping' }); return;
        }
        await this.docker.stop(id);
        container = await this.docker.inspect(id);
        // A newer request may have arrived while Docker was stopping the old container.
        if (!this.sameOperation(id, op)) return;
      }
      if (op?.kind === 'restart' && op.phase === 'drain') {
        if (container) await this.docker.remove(id);
        if (!this.sameOperation(id, op)) return;
        container = null;
        op = { ...op, phase: 'starting', time: Date.now(), containerId: undefined };
        this.saveOperation(id, op);
      } else {
        if (this.sameOperation(id, op)) this.saveOperation(id, null);
        this.store.setRuntime(id, { state: 'stopped', connected: false, processing: false, drained: true });
        return;
      }
    }
    bot = this.store.getBot(id)!;
    if (bot.desiredState !== 'running') return;
    if (!container) {
      await this.docker.create(bot);
      if (!this.sameOperation(id, op) || this.store.getBot(id)?.desiredState !== 'running') return;
      await this.docker.start(id);
      container = await this.docker.inspect(id);
      this.started(id, op, container);
      return;
    }
    if (!container.State.Running) {
      await this.docker.start(id);
      container = await this.docker.inspect(id);
      this.started(id, op, container);
      return;
    }
    op = this.operation(id); runtime = this.store.getRuntime(id);
    if (op?.phase === 'starting' && !op.containerId) {
      this.started(id, op, container); return;
    }
    if (op?.phase === 'starting' && op.containerId === container.Id && runtime.lastHeartbeat !== null && runtime.lastHeartbeat > op.time && runtime.connected) {
      // Restart acknowledgements belong to the replacement container's start boundary.
      if (this.sameOperation(id, op)) this.saveOperation(id, null);
    }
    if (runtime.lastHeartbeat !== null && Date.now() - runtime.lastHeartbeat > 20000 && runtime.state !== 'unknown') this.store.setRuntime(id, { state: 'unknown', connected: false });
  }
  private started(id: string, op: Operation | null, container: ContainerInfo | null): void {
    if (op && this.sameOperation(id, op)) this.saveOperation(id, { ...op, phase: 'starting', time: Date.now(), containerId: container?.Id });
    this.store.setRuntime(id, { state: 'starting', connected: false, processing: false, drained: false, error: null });
  }
  private sameOperation(id: string, op: Operation | null): boolean { return this.operation(id)?.id === op?.id; }
  private saveOperation(id: string, operation: Operation | null): void { this.store.setSetting(`operation.${id}`, JSON.stringify(operation)); }
}
