export const MAX_VOICE_BYTES = 16 * 1024 * 1024;

/** Check the first MPEG audio frame, skipping an optional ID3v2 tag. */
export function isMp3(data: Uint8Array): boolean {
  let offset = 0;
  if (data.length >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    if (data.length < 10 || data[3]! < 2 || data[3]! > 4
      || [data[6], data[7], data[8], data[9]].some(byte => byte! > 0x7f)) return false;
    const tagSize = (data[6]! << 21) | (data[7]! << 14) | (data[8]! << 7) | data[9]!;
    offset = 10 + tagSize + ((data[3] === 4 && (data[5]! & 0x10)) ? 10 : 0);
  }
  if (data.length < offset + 5) return false;
  const second = data[offset + 1]!;
  const third = data[offset + 2]!;
  return data[offset] === 0xff && (second & 0xe0) === 0xe0
    && ((second >> 3) & 3) !== 1 && ((second >> 1) & 3) === 1
    && (third >> 4) > 0 && (third >> 4) < 15 && ((third >> 2) & 3) !== 3;
}

/** Audio is transferred across hosts as a bounded, canonical Base64 snapshot. */
export function isMp3Snapshot(file: unknown): file is string {
  if (typeof file !== 'string' || !file.startsWith('base64://')) return false;
  const encoded = file.slice(9);
  if (!encoded || encoded.length > 4 * Math.ceil(MAX_VOICE_BYTES / 3)
    || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
  const data = Buffer.from(encoded, 'base64');
  return data.length <= MAX_VOICE_BYTES && data.toString('base64') === encoded && isMp3(data);
}
