import assert from 'node:assert/strict';
import {crc32,deflateSync} from 'node:zlib';
import {resizeImage} from '@earendil-works/pi-coding-agent';

let largeImage:Buffer|undefined;

/** Deterministic RGB noise exercises both dimension and encoded-size limits. */
export function largeModelImage():Buffer {
  if(largeImage)return largeImage;
  const width=1920,height=1080,stride=width*3+1;
  const pixels=Buffer.alloc(stride*height);let seed=123456789;
  for(let y=0;y<height;y++)for(let x=1;x<stride;x++) {
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
    pixels[y*stride+x]=seed&255;
  }
  const chunk=(type:string,data:Buffer)=>{
    const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
    length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
    return Buffer.concat([length,name,data,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  largeImage=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  return largeImage;
}

/** Inspect actual provider-wire bytes, including the SDK's second normalization. */
export async function assertModelImage(dataURL:string):Promise<void> {
  const match=/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(dataURL);
  assert.ok(match,'The provider must receive a supported inline image.');
  assert.ok(Buffer.byteLength(match[2]!)<512*1024,'Model image Base64 must stay below 512 KiB.');
  const decoded=await resizeImage(Buffer.from(match[2]!,'base64'),match[1]!,{maxWidth:1600,maxHeight:1600,maxBytes:512*1024,jpegQuality:80});
  assert.ok(decoded,'The actual provider image must decode successfully.');
  assert.ok(decoded.width<=1600&&decoded.height<=1600);
  assert.equal(decoded.wasResized,false,'The provider image must already satisfy the limits before this assertion inspects it.');
  assert.equal(decoded.data,match[2],'Inspection must leave the provider image bytes unchanged.');
}
