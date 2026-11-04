import { NetworkError, type NetworkClient } from './network.js';

export interface NetworkProbeResult {
  ok: boolean; code: string; durationMs: number; status?: number; route?: 'direct' | 'proxy';
}
export interface NetworkProbeJob {
  id: string; status: 'pending' | 'completed' | 'failed'; revision: number; result?: NetworkProbeResult;
}
export interface NetworkProbeCommand { id: string; revision: number }

export const NETWORK_PROBE_CODES = new Set(['OK','PROXY_UNREACHABLE','PROXY_AUTH_FAILED','TARGET_CONNECT_FAILED',
  'TLS_ERROR','TIMEOUT','CANCELLED','CONFIGURATION_REQUIRED','NETWORK_ERROR','WORKER_UNAVAILABLE','REVISION_CHANGED']);
const ERROR_CODES: Record<string,string> = {
  NETWORK_PROXY_UNREACHABLE:'PROXY_UNREACHABLE', NETWORK_PROXY_AUTH_FAILED:'PROXY_AUTH_FAILED',
  NETWORK_TARGET_UNREACHABLE:'TARGET_CONNECT_FAILED', NETWORK_TLS_FAILED:'TLS_ERROR', NETWORK_TIMEOUT:'TIMEOUT',
  NETWORK_REQUEST_ABORTED:'CANCELLED', NETWORK_CLIENT_CLOSED:'REVISION_CHANGED',
};

/** Header-only connectivity probe: no model credentials, generation or chat writes. */
export async function probeNetwork(client: NetworkClient, baseUrl: string | undefined, signal: AbortSignal): Promise<NetworkProbeResult> {
  const started = Date.now();
  if (!baseUrl) return {ok:false,code:'CONFIGURATION_REQUIRED',durationMs:0};
  const target = `${baseUrl.replace(/\/+$/u,'')}/models`;
  const route = client.route(target).mode;
  const requestSignal = AbortSignal.any([signal,AbortSignal.timeout(15_000)]);
  try {
    const response = await client.fetch(target,{method:'GET',signal:requestSignal,redirect:'follow'});
    await response.body?.cancel();
    const finalRoute=client.route(response.url || target).mode;
    if(response.status===407&&finalRoute==='proxy')return {ok:false,code:'PROXY_AUTH_FAILED',route:finalRoute,durationMs:Date.now()-started};
    return {ok:true,code:'OK',status:response.status,route:finalRoute,durationMs:Date.now()-started};
  } catch(error) {
    const code = error instanceof NetworkError ? ERROR_CODES[error.code] : undefined;
    return {ok:false,code:requestSignal.aborted ? signal.aborted?'CANCELLED':'TIMEOUT' : code??'NETWORK_ERROR',
      route,durationMs:Date.now()-started};
  }
}
