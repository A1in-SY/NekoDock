import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ConsoleAuth } from './auth.js';
import type { ConsoleDatabase } from './database.js';

/** Durable event replay, followed by push notifications for this instance only. */
export class ConversationStreams {
  private readonly clients = new Set<{ botId: string; token: unknown; flush(): void; stop(): void }>();
  constructor(private readonly db: ConsoleDatabase, private readonly auth: ConsoleAuth, private readonly heartbeatMs = 15_000) {}

  open(req: FastifyRequest, reply: FastifyReply, botId: string, after: number): void {
    reply.hijack(); const response = reply.raw; const token = req.cookies.console_session;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    let cursor = after; let stopped = false; let scheduled: NodeJS.Immediate | undefined; let blocked = false;
    const stop = () => {
      if (stopped) return; stopped = true; clearInterval(heartbeat); if (scheduled) clearImmediate(scheduled);
      this.clients.delete(client); response.removeListener('drain', drained); if (!response.destroyed) response.end();
    };
    const flush = () => {
      if (stopped || blocked) return;
      if (!this.auth.valid(token)) { stop(); return; }
      if (response.destroyed || response.writableLength > 512 * 1024) { response.destroy(); stop(); return; }
      try {
        const update = this.db.getConversationUpdate(botId, cursor);
        if (update.cursor === cursor && !update.reset) return;
        const chunk = `id: ${update.cursor}\nevent: conversation\ndata: ${JSON.stringify(update)}\n\n`;
        blocked = !response.write(chunk); cursor = update.cursor;
        // Bound each turn of the event loop and wait for drain on slow clients.
        // Reconnection resumes from the last event ID actually received.
        if (!blocked && this.db.getConversationCursor(botId) > cursor) schedule();
      } catch { stop(); }
    };
    const schedule = () => {
      if (!stopped && !scheduled) scheduled = setImmediate(() => { scheduled = undefined; flush(); });
    };
    const drained = () => { blocked = false; schedule(); };
    const client = { botId, token, flush: schedule, stop };
    const heartbeat = setInterval(() => {
      if (!this.auth.valid(token)) { stop(); return; }
      if (response.destroyed || response.writableLength > 512 * 1024) { response.destroy(); stop(); return; }
      if (!blocked) blocked = !response.write(': heartbeat\n\n');
    }, this.heartbeatMs); heartbeat.unref();
    this.clients.add(client); response.once('close', stop); response.on('drain', drained);
    // Register before replay so uploads cannot fall between catch-up and live push.
    response.write(': connected\n\n'); schedule();
  }
  notify(botId: string): void { for (const client of this.clients) if (client.botId === botId) client.flush(); }
  closeSession(token: unknown): void { for (const client of this.clients) if (client.token === token) client.stop(); }
  close(): void { for (const client of this.clients) client.stop(); }
}
