import { createHash, randomBytes } from 'node:crypto';

// Compatibility with the public Heybox Web client's request-signing algorithm:
// https://www.xiaoheihe.cn/app/ (game API path -> epoch seconds + 1 -> nonce).
// MD5 here is an upstream protocol requirement, never a local security primitive.
const alphabet = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';
const map = (value: string, chars: string) => [...value].map(char => chars[char.charCodeAt(0) % chars.length]!).join('');
const twice = (value: number) => value & 128 ? 255 & ((value << 1) ^ 27) : value << 1;
const three = (value: number) => twice(value) ^ value;
const four = (value: number) => three(twice(value));
const eight = (value: number) => four(three(twice(value)));
const fourteen = (value: number) => eight(value) ^ four(value) ^ three(value);
export function heyboxHkey(path: string, timestamp: number, nonce: string): string {
  const normalized = '/' + path.split('/').filter(Boolean).join('/') + '/';
  const parts = [map(String(timestamp + 1), alphabet.slice(0, -2)), map(normalized, alphabet), map(nonce, alphabet)];
  let interleaved = '';
  for (let index = 0; index < Math.max(...parts.map(part => part.length)); index++) for (const part of parts) if (index < part.length) interleaved += part[index];
  const digest = createHash('md5').update(interleaved.slice(0, 20)).digest('hex'), tail = [...digest.slice(-6)].map(char => char.charCodeAt(0));
  const [a, b, c, d] = tail as [number, number, number, number, number, number];
  const mixed = [fourteen(a) ^ eight(b) ^ four(c) ^ three(d), three(a) ^ fourteen(b) ^ eight(c) ^ four(d),
    four(a) ^ three(b) ^ fourteen(c) ^ eight(d), eight(a) ^ four(b) ^ three(c) ^ fourteen(d), ...tail.slice(4)];
  return map(digest.slice(0, 5), alphabet.slice(0, -4)) + String(mixed.reduce((sum, value) => sum + value, 0) % 100).padStart(2, '0');
}
export function heyboxSignedUrl(path: string, params: Record<string, string>, now = Date.now(), nonce = randomBytes(16).toString('hex').toUpperCase()): URL {
  const timestamp = Math.floor(now / 1000), url = new URL(path, 'https://api.xiaoheihe.cn');
  for (const [key, value] of Object.entries({ ...params, version: '999.0.4', _time: String(timestamp), nonce, hkey: heyboxHkey(path, timestamp, nonce) })) url.searchParams.set(key, value);
  return url;
}
