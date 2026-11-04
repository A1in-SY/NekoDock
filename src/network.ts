import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { Agent, Dispatcher, ProxyAgent, Request as UndiciRequest, fetch as undiciFetch } from 'undici';
import { fingerprint, logEvent } from './logging.js';
import type { Logger } from './types.js';

export interface NetworkProxyConfig {
  enabled: boolean;
  url: string;
  username?: string;
  password?: string;
  noProxy: string;
  forTools: boolean;
}

export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,host.docker.internal';

export function defaultNetworkProxy(): NetworkProxyConfig {
  return { enabled: false, url: '', noProxy: DEFAULT_NO_PROXY, forTools: true };
}

export class NetworkError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'NetworkError'; }
}

interface BypassEntry { host: string; port?: number; all?: boolean }

function configError(): never { throw new NetworkError('NETWORK_PROXY_CONFIG_ERROR'); }

function normalizeHost(value: string): string {
  const host = value.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (isIP(host) === 6) return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  if (isIP(host)) return host;
  if (/[\\/:@?#%*\[\]]/u.test(host)) configError();
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length > 253 || !ascii.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u.test(label))) configError();
  return ascii;
}

function parseBypassEntry(value: string): BypassEntry {
  if (value === '*') return { host: '*', all: true };
  let host = value;
  let port: number | undefined;
  if (value.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/u.exec(value);
    if (!match || isIP(match[1]!) !== 6) configError();
    host = match[1]!;
    if (match[2]) port = Number(match[2]);
  } else if (!isIP(value)) {
    const match = /^(.*):(\d+)$/u.exec(value);
    if (match) { host = match[1]!; port = Number(match[2]); }
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) configError();
  if (host.startsWith('*.')) host = host.slice(2);
  else if (host.startsWith('.')) host = host.slice(1);
  return { host: normalizeHost(host), ...(port === undefined ? {} : { port }) };
}

function bypassEntries(value: string): BypassEntry[] {
  if (typeof value !== 'string' || value.length > 16_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) configError();
  const tokens = value.trim().split(/[,\s]+/u).filter(Boolean);
  if (tokens.length > 256) configError();
  return tokens.map(parseBypassEntry);
}

function credential(value: unknown, username: boolean): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/u.test(value) || (username && value.includes(':'))) configError();
  return value;
}

/** Validate without echoing endpoints or credentials in configuration errors. */
export function normalizeNetworkProxy(input: Partial<NetworkProxyConfig> = {}): NetworkProxyConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) configError();
  const result = { ...defaultNetworkProxy(), ...input };
  if (typeof result.enabled !== 'boolean' || typeof result.forTools !== 'boolean' || typeof result.url !== 'string') configError();
  const raw = result.url.trim();
  if (raw.length > 4096 || /[\x00-\x1f\x7f\\@]/u.test(raw)) configError();
  if (raw) {
    if (!/^https?:\/\//iu.test(raw)) configError();
    let parsed: URL;
    try { parsed = new URL(raw); } catch { configError(); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
      || parsed.pathname !== '/' || raw.includes('?') || raw.includes('#')) configError();
    result.url = parsed.origin;
  } else {
    if (result.enabled) configError();
    result.url = '';
  }
  result.username = credential(result.username, true);
  result.password = credential(result.password, false);
  if (result.password !== undefined && result.username === undefined) configError();
  if (result.username === undefined) delete result.username;
  if (result.password === undefined) delete result.password;
  result.noProxy = [...new Set(bypassEntries(result.noProxy).map(entry => entry.all ? '*' :
    `${isIP(entry.host) === 6 && entry.port ? `[${entry.host}]` : entry.host}${entry.port ? `:${entry.port}` : ''}`))].join(',');
  return result;
}

export function loadNetworkProxyConfig(env: NodeJS.ProcessEnv): NetworkProxyConfig {
  const boolean = (key: string, fallback: boolean): boolean => {
    const input = env[key]?.trim();
    if (input === undefined) return fallback;
    if (input !== 'true' && input !== 'false') configError();
    return input === 'true';
  };
  return normalizeNetworkProxy({ enabled: boolean('NETWORK_PROXY_ENABLED', false), url: env.NETWORK_PROXY_URL ?? '',
    username: env.NETWORK_PROXY_USERNAME, password: env.NETWORK_PROXY_PASSWORD,
    noProxy: env.NETWORK_PROXY_NO_PROXY ?? DEFAULT_NO_PROXY, forTools: boolean('NETWORK_PROXY_FOR_TOOLS', true) });
}

export type NetworkRoute = { mode: 'direct' | 'proxy'; reason: 'disabled' | 'bypass' | 'configured' };

export function routeNetworkUrl(input: NetworkProxyConfig, url: string | URL): NetworkRoute {
  const config = normalizeNetworkProxy(input);
  return routeFor(config, bypassEntries(config.noProxy), url);
}

export function proxyUrlWithCredentials(input: NetworkProxyConfig): string {
  const config = normalizeNetworkProxy(input);
  if (!config.url) return '';
  const url = new URL(config.url);
  if (config.username !== undefined) { url.username = encodeURIComponent(config.username); url.password = encodeURIComponent(config.password ?? ''); }
  return url.toString();
}

function routeFor(config: NetworkProxyConfig, entries: BypassEntry[], input: string | URL): NetworkRoute {
  if (!config.enabled) return { mode: 'direct', reason: 'disabled' };
  const url = input instanceof URL ? input : new URL(input);
  const host = normalizeHost(url.hostname);
  const port = Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80));
  const bypass = entries.some(entry => entry.all || (entry.port === undefined || entry.port === port)
    && (host === entry.host || !isIP(entry.host) && host.endsWith(`.${entry.host}`)));
  return bypass ? { mode: 'direct', reason: 'bypass' } : { mode: 'proxy', reason: 'configured' };
}

class RoutingDispatcher extends Dispatcher {
  constructor(readonly direct: Agent, readonly proxy: ProxyAgent | undefined, readonly choose: (url: string | URL) => NetworkRoute) { super(); }
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const dispatcher = this.proxy && options.origin && this.choose(options.origin).mode === 'proxy' ? this.proxy : this.direct;
    return dispatcher.dispatch(options, handler);
  }
}

/** Management traffic uses its own dispatcher even if the process has ambient proxy settings. */
const managementAgent = new Agent({ connectTimeout: 10_000 });

// Node's bundled Undici and our pinned Undici have different Request classes.
// SDKs may construct a native Request before handing it to the provided fetch.
function fetchInput(input: Parameters<typeof globalThis.fetch>[0]): Parameters<typeof undiciFetch>[0] {
  if (typeof input === 'string' || input instanceof URL || input instanceof UndiciRequest) return input;
  return new UndiciRequest(input.url, { method: input.method, headers: [...input.headers],
    body: input.body as never, signal: input.signal, redirect: input.redirect, credentials: input.credentials,
    cache: input.cache, integrity: input.integrity, keepalive: input.keepalive, mode: input.mode,
    referrer: input.referrer, referrerPolicy: input.referrerPolicy, duplex: 'half' });
}

export const directFetch: typeof globalThis.fetch = async (input, init) => await undiciFetch(fetchInput(input), {
  ...init as Parameters<typeof undiciFetch>[1], dispatcher: managementAgent,
}) as unknown as Response;

function failureCode(error: unknown, mode: NetworkRoute['mode'], signal?: AbortSignal | null): string {
  if (signal?.aborted) return signal.reason?.name === 'TimeoutError' ? 'NETWORK_TIMEOUT' : 'NETWORK_REQUEST_ABORTED';
  let cause: unknown = error;
  for (let i = 0; i < 8 && cause && typeof cause === 'object'; i++) {
    const value = cause as { code?: string; message?: string; cause?: unknown };
    const message = typeof value.message === 'string' ? value.message : '';
    const errorCode = typeof value.code === 'string' ? value.code : '';
    if (/\b407\b/u.test(message)) return 'NETWORK_PROXY_AUTH_FAILED';
    if (/Proxy response \([345]\d\d\)/u.test(message)) return 'NETWORK_TARGET_UNREACHABLE';
    if (errorCode.includes('TIMEOUT') || errorCode === 'ETIMEDOUT') return 'NETWORK_TIMEOUT';
    if (errorCode.includes('TLS') || errorCode.includes('SSL') || errorCode.includes('CERT') || errorCode === 'EPROTO' || errorCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      || errorCode === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'NETWORK_TLS_FAILED';
    cause = value.cause;
  }
  return mode === 'proxy' ? 'NETWORK_PROXY_UNREACHABLE' : 'NETWORK_TARGET_UNREACHABLE';
}

export interface NetworkClient {
  fetch: typeof globalThis.fetch;
  route(url: string | URL): NetworkRoute;
  close(): Promise<void>;
}

/** A runtime owns its connection pools. No process-global proxy state is changed. */
export function createNetworkClient(input: NetworkProxyConfig = defaultNetworkProxy(), logger?: Logger, category = 'application'): NetworkClient {
  const config = normalizeNetworkProxy(input);
  const entries = bypassEntries(config.noProxy);
  const route = (url: string | URL) => routeFor(config, entries, url);
  const direct = new Agent({ connectTimeout: 10_000 });
  const proxy = config.enabled ? new ProxyAgent({ uri: config.url, connectTimeout: 10_000,
    ...(config.username !== undefined ? { token: `Basic ${Buffer.from(`${config.username}:${config.password ?? ''}`).toString('base64')}` } : {}) }) : undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (closed) throw new NetworkError('NETWORK_CLIENT_CLOSED');
    let url: URL;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
    catch { throw new NetworkError('NETWORK_REQUEST_INVALID'); }
    let decision = route(url);
    const started = Date.now();
    const metadata = { category, mode: decision.mode, reason: decision.reason, target_ref: fingerprint(url.origin) };
    if (logger) logEvent(logger, 'info', 'network.request.started', metadata);
    const signal = init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined);
    const dispatcher = new RoutingDispatcher(direct, proxy, origin => {
      decision = route(origin);
      if (logger) logEvent(logger, 'info', 'network.route', { category, ...decision, target_ref: fingerprint(new URL(origin).origin) });
      return decision;
    });
    try {
      const response = await undiciFetch(fetchInput(input), {
        ...init as Parameters<typeof undiciFetch>[1], dispatcher,
      });
      if (logger) logEvent(logger, 'info', 'network.response.headers', { ...metadata, status: response.status, duration_ms: Date.now() - started });
      return response as unknown as Response;
    } catch (error) {
      const code = failureCode(error, decision.mode, signal);
      if (logger) logEvent(logger, 'warn', 'network.request.failed', { ...metadata, code, duration_ms: Date.now() - started });
      throw new NetworkError(code);
    }
  };
  return { fetch, route, close: () => closing ??= (async () => {
    closed = true;
    await Promise.all([direct.destroy(), proxy?.destroy()]);
  })() };
}

export function proxySecrets(input?: NetworkProxyConfig): string[] {
  if (!input) return [];
  const secrets = [input.username, input.password].filter((value): value is string => !!value);
  for (const value of [...secrets]) secrets.push(encodeURIComponent(value));
  if (input.username) {
    const basic = Buffer.from(`${input.username}:${input.password ?? ''}`).toString('base64');
    secrets.push(basic, `Basic ${basic}`);
    if (input.url) {
      const url = new URL(input.url); url.username = encodeURIComponent(input.username); url.password = encodeURIComponent(input.password ?? '');
      secrets.push(url.toString(), url.toString().replace(/\/$/u, ''));
    }
  }
  return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}

const PROXY_ENV = new Set(['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'ws_proxy', 'wss_proxy', 'node_use_env_proxy',
  'global_agent_http_proxy', 'global_agent_https_proxy', 'global_agent_no_proxy', 'nekodock_playwright_proxy',
  'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_noproxy', 'npm_config_no_proxy']);

/** Callers provide an already restricted source when spawning untrusted tools. */
export function proxyEnvironment(input: NetworkProxyConfig = defaultNetworkProxy(), source: NodeJS.ProcessEnv = {}, forTools = false): NodeJS.ProcessEnv {
  const config = normalizeNetworkProxy(input);
  const result = Object.fromEntries(Object.entries(source).filter(([name]) => !PROXY_ENV.has(name.toLowerCase())));
  if (!config.enabled || forTools && !config.forTools) return result;
  const proxyUrl = proxyUrlWithCredentials(config);
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'ws_proxy', 'wss_proxy']) {
    result[name] = proxyUrl; result[name.toUpperCase()] = proxyUrl;
  }
  // Node http needs a dotted companion to match subdomains; curl already treats
  // bare domains as suffixes. Port-scoped bypass support still varies by tool.
  const noProxy = [...new Set(bypassEntries(config.noProxy).flatMap(entry => {
    if (entry.all) return ['*'];
    const normalized = `${isIP(entry.host) === 6 && entry.port ? `[${entry.host}]` : entry.host}${entry.port ? `:${entry.port}` : ''}`;
    return !isIP(entry.host) && !entry.port ? [normalized, `.${entry.host}`] : [normalized];
  }))].join(',');
  result.no_proxy = noProxy; result.NO_PROXY = noProxy;
  result.NODE_USE_ENV_PROXY = '1';
  if (forTools) result.NEKODOCK_PLAYWRIGHT_PROXY = JSON.stringify(playwrightProxy(config));
  return result;
}

export function playwrightProxy(input: NetworkProxyConfig): { server: string; username?: string; password?: string; bypass: string } | undefined {
  const config = normalizeNetworkProxy(input);
  if (!config.enabled || !config.forTools) return undefined;
  const bypass = bypassEntries(config.noProxy).flatMap(entry => {
    if (entry.all) return ['*'];
    const suffix = entry.port ? `:${entry.port}` : '';
    const host = isIP(entry.host) === 6 ? `[${entry.host}]` : entry.host;
    return isIP(entry.host) ? [`${host}${suffix}`] : [`${host}${suffix}`, `*.${host}${suffix}`];
  }).join(',');
  return { server: config.url, ...(config.username !== undefined ? { username: config.username } : {}),
    ...(config.password !== undefined ? { password: config.password } : {}), bypass };
}
