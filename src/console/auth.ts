import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
interface SettingsStore { getSetting(key: string): string | null; setSetting(key: string, value: string): void }

export class ConsoleAuth {
  private setupBusy = false;
  private attempts = new Map<string, { since: number; count: number }>();
  constructor(private readonly store: SettingsStore) {}
  needsSetup(): boolean { return !this.store.getSetting('admin.password'); }
  private rate(ip: string): void {
    const now = Date.now();
    for (const [key, row] of this.attempts) if (now - row.since >= 60000) this.attempts.delete(key);
    let row = this.attempts.get(ip);
    if (!row) {
      if (this.attempts.size >= 1000) throw new Error('请求过于频繁，请一分钟后重试');
      row = { since: now, count: 0 }; this.attempts.set(ip, row);
    }
    if (++row.count > 10) throw new Error('请求过于频繁，请一分钟后重试');
  }
  async setup(password: unknown, ip: string): Promise<string> {
    this.rate(ip);
    if (!this.needsSetup() || this.setupBusy) throw new Error('管理员已经设置');
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('密码须为 12–256 个字符');
    this.setupBusy = true;
    try {
      const salt = randomBytes(16).toString('hex');
      const key = await scrypt(password, salt, 32) as Buffer;
      this.store.setSetting('admin.password', `${salt}:${key.toString('hex')}`);
      return this.createSession();
    } finally { this.setupBusy = false; }
  }
  async login(password: unknown, ip: string): Promise<string> {
    this.rate(ip);
    if (typeof password !== 'string' || password.length > 256) throw new Error('密码不正确');
    const value = this.store.getSetting('admin.password');
    if (!value) throw new Error('请先设置管理员密码');
    if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/u.test(value)) throw new Error('管理员凭据格式无效，请恢复有效备份');
    const [salt, hash] = value.split(':');
    const key = await scrypt(password, salt!, 32) as Buffer;
    const expected = Buffer.from(hash!, 'hex');
    if (!timingSafeEqual(key, expected)) throw new Error('密码不正确');
    return this.createSession();
  }
  private createSession(): string {
    const token = randomBytes(32).toString('hex');
    this.store.setSetting(this.sessionKey(token), String(Date.now() + 12 * 3600000));
    return token;
  }
  private sessionKey(token: string): string { return 'session.' + createHash('sha256').update(token).digest('hex'); }
  valid(token: unknown): boolean {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) return false;
    const expires = Number(this.store.getSetting(this.sessionKey(token)));
    return Number.isSafeInteger(expires) && expires > Date.now();
  }
  logout(token: unknown): void {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/u.test(token)) this.store.setSetting(this.sessionKey(token), '0');
  }
}
