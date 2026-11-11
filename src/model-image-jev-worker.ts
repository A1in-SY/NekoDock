import { parentPort } from 'node:worker_threads';
import * as photon from '@silvia-odwyer/photon-node';

const MAX_PIXELS = 40_000_000;

/** Check header dimensions before the decoder can allocate the full pixel buffer. */
function checkDimensions(bytes: Buffer): void {
  let width = 0, height = 0;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (kind === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
      const size = bytes.readUInt16BE(offset + 2), end = offset + 2 + size;
      if (size < 2 || end > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) { height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break; }
      offset = end;
    }
  }
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('IMAGE_PREPARATION_FAILED');
}

function tiffOrientation(bytes: Buffer, offset: number, end: number): number {
  if (offset < 0 || offset + 8 > end) return 1;
  const order = bytes.toString('ascii', offset, offset + 2), little = order === 'II';
  if (!little && order !== 'MM') return 1;
  const u16 = (at: number) => little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
  const u32 = (at: number) => little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  if (u16(offset + 2) !== 42) return 1;
  const directory = offset + u32(offset + 4);
  if (directory < offset + 8 || directory + 2 > end) return 1;
  const count = u16(directory);
  for (let index = 0; index < count; index++) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > end) break;
    if (u16(entry) !== 0x0112 || u16(entry + 2) !== 3 || u32(entry + 4) !== 1) continue;
    const value = u16(entry + 8); return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

function orientation(bytes: Buffer): number {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
      const size = bytes.readUInt16BE(offset + 2), end = offset + 2 + size;
      if (size < 2 || end > bytes.length) break;
      if (marker === 0xe1 && bytes.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') return tiffOrientation(bytes, offset + 10, end);
      offset = end;
    }
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4), start = offset + 8, end = start + size;
      if (end > bytes.length) break;
      if (bytes.toString('ascii', offset, offset + 4) === 'EXIF') return tiffOrientation(bytes, bytes.toString('ascii', start, start + 6) === 'Exif\0\0' ? start + 6 : start, end);
      offset = end + size % 2;
    }
  } else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset), start = offset + 8, end = start + size;
      if (end + 4 > bytes.length) break;
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'eXIf') return tiffOrientation(bytes, start, end);
      offset = end + 4;
    }
  }
  return 1;
}

function orient(image: photon.PhotonImage, value: number): photon.PhotonImage {
  if (value <= 4) {
    if (value === 2 || value === 3) photon.fliph(image);
    if (value === 3 || value === 4) photon.flipv(image);
    return image;
  }
  const width = image.get_width(), height = image.get_height(), source = image.get_raw_pixels(), target = new Uint8Array(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = value === 5 || value === 8 ? y : height - 1 - y;
    const dy = value === 5 || value === 6 ? x : width - 1 - x;
    const at = (dy * height + dx) * 4, from = (y * width + x) * 4;
    target.set(source.subarray(from, from + 4), at);
  }
  return new photon.PhotonImage(target, height, width);
}

/** Decode once, export a still image, and preserve content without stretching small images. */
function normalize(bytes: Buffer): Uint8Array {
  let image: photon.PhotonImage | undefined;
  try {
    checkDimensions(bytes);
    image = photon.PhotonImage.new_from_byteslice(bytes);
    if (!image.get_width() || !image.get_height() || image.get_width() * image.get_height() > MAX_PIXELS) throw new Error('IMAGE_PREPARATION_FAILED');
    const corrected = orient(image, orientation(bytes));
    if (corrected !== image) { image.free(); image = corrected; }
    const scale = Math.min(1, 1568 / Math.max(image.get_width(), image.get_height()));
    if (scale < 1) {
      const resized = photon.resize(image, Math.max(1, Math.round(image.get_width() * scale)), Math.max(1, Math.round(image.get_height() * scale)), photon.SamplingFilter.Lanczos3);
      image.free(); image = resized;
    }
    const width = image.get_width(), height = image.get_height(), canvasWidth = Math.max(280, width), canvasHeight = Math.max(280, height);
    const source = image.get_raw_pixels(), pixels = new Uint8Array(canvasWidth * canvasHeight * 4).fill(255);
    const left = Math.floor((canvasWidth - width) / 2), top = Math.floor((canvasHeight - height) / 2);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = ((y + top) * canvasWidth + x + left) * 4, from = (y * width + x) * 4, alpha = source[from + 3]! / 255;
      for (let channel = 0; channel < 3; channel++) pixels[at + channel] = Math.round(source[from + channel]! * alpha + 255 * (1 - alpha));
    }
    const canvas = new photon.PhotonImage(pixels, canvasWidth, canvasHeight);
    try { return canvas.get_bytes(); } finally { canvas.free(); }
  } finally { image?.free(); }
}

parentPort!.once('message', (message: {bytes: Uint8Array}) => {
  try { const bytes = normalize(Buffer.from(message.bytes)); parentPort!.postMessage({bytes}, [bytes.buffer as ArrayBuffer]); }
  catch { parentPort!.postMessage({error: 'IMAGE_PREPARATION_FAILED'}); }
});
