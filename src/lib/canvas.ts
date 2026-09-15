// 캔버스 입출력 (OffscreenCanvas 우선 — 워커에서도 동작)
import type { RGBA } from './imgproc';

export type Surface = HTMLCanvasElement | OffscreenCanvas;
export type Drawable = CanvasImageSource & { width: number; height: number };
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createSurface(w: number, h: number): Surface {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(W, H);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}

export function ctx2d(s: Surface): Ctx {
  const c = (s as OffscreenCanvas).getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('2D 컨텍스트를 만들 수 없습니다');
  return c;
}

/** iOS Safari는 캔버스 메모리 한도가 있어 다 쓴 캔버스는 크기를 0으로 해제 */
export function release(s?: Surface | null) {
  if (s) { s.width = 0; s.height = 0; }
}

/** 원본의 (sx,sy,sw,sh) 영역을 dw×dh로 고품질 축소해 RGBA로 */
export function readRGBA(src: Drawable, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): RGBA {
  const s = createSurface(dw, dh);
  const cx = ctx2d(s);
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, sx, sy, sw, sh, 0, 0, s.width, s.height);
  const { data, width, height } = cx.getImageData(0, 0, s.width, s.height);
  release(s);
  return { data, width, height };
}

export function toSurface(img: RGBA): Surface {
  const s = createSurface(img.width, img.height);
  const data = img.data as Uint8ClampedArray<ArrayBuffer>;
  ctx2d(s).putImageData(new ImageData(data, img.width, img.height), 0, 0);
  return s;
}

/** 90도 단위 회전. 입력 캔버스는 해제됨 */
export function rotate(s: Surface, deg: number): Surface {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return s;
  const swap = deg === 90 || deg === 270;
  const out = createSurface(swap ? s.height : s.width, swap ? s.width : s.height);
  const cx = ctx2d(out);
  cx.translate(out.width / 2, out.height / 2);
  cx.rotate(deg * Math.PI / 180);
  cx.drawImage(s, -s.width / 2, -s.height / 2);
  release(s);
  return out;
}

export function scaled(src: Drawable, maxSide: number): Surface {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const out = createSurface(src.width * s, src.height * s);
  const cx = ctx2d(out);
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

export function encodeJpeg(s: Surface, quality: number): Promise<Blob> {
  if ('convertToBlob' in s) return s.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) =>
    s.toBlob(b => (b ? resolve(b) : reject(new Error('JPEG 변환 실패'))), 'image/jpeg', quality));
}

/** JPEG 헤더에서 크기와 EXIF 방향만 읽음 (전체 디코딩 없이) */
export function jpegInfo(bytes: DataView): { w: number; h: number; orientation: number } | null {
  if (bytes.byteLength < 4 || bytes.getUint16(0) !== 0xffd8) return null;
  let off = 2, orientation = 1;
  while (off + 9 <= bytes.byteLength) {
    const marker = bytes.getUint16(off);
    if ((marker & 0xff00) !== 0xff00) return null;
    const len = bytes.getUint16(off + 2);
    if (marker === 0xffe1 && bytes.getUint32(off + 4) === 0x45786966) {
      orientation = exifOrientation(bytes, off + 10) ?? orientation;
    }
    // SOF0~SOF15 (DHT·JPG·DAC 제외)에 높이·너비가 있음
    if (marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc) {
      return { h: bytes.getUint16(off + 5), w: bytes.getUint16(off + 7), orientation };
    }
    off += 2 + len;
  }
  return null;
}

function exifOrientation(v: DataView, tiff: number): number | null {
  if (tiff + 8 > v.byteLength) return null;
  const le = v.getUint16(tiff) === 0x4949;
  const ifd = tiff + v.getUint32(tiff + 4, le);
  if (ifd + 2 > v.byteLength) return null;
  const count = v.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > v.byteLength) return null;
    if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
  }
  return null;
}

/**
 * 기기 메모리에 맞춘 원본 최대 변 길이. 저사양 폰에서 큰 사진을 열 때 탭이 죽는 것을 막음
 * (200dpi A4 출력은 긴 변 2339px)
 */
export const MAX_SOURCE_SIDE = (() => {
  const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  return gb <= 2 ? 2200 : gb <= 4 ? 2600 : 3200;
})();

/**
 * EXIF 회전을 반영해 디코딩하고, 메모리 보호를 위해 긴 변을 maxSide로 제한.
 * JPEG는 디코딩 단계에서 바로 줄여 받음 — 5천만 화소 사진도 원본 크기로 메모리에 올리지 않음.
 * (Chrome은 EXIF 회전 후 크기를 조정하므로 표시 기준 크기를 넘김)
 */
export async function decodeImage(blob: Blob, maxSide = MAX_SOURCE_SIDE): Promise<Surface> {
  try {
    let opts: ImageBitmapOptions = { imageOrientation: 'from-image' };
    const info = jpegInfo(new DataView(await blob.slice(0, 512 * 1024).arrayBuffer()));
    if (info) {
      const [dw, dh] = info.orientation >= 5 ? [info.h, info.w] : [info.w, info.h];
      const s = Math.min(1, maxSide / Math.max(dw, dh));
      if (s < 1) {
        opts = { ...opts, resizeWidth: Math.round(dw * s), resizeHeight: Math.round(dh * s), resizeQuality: 'high' };
      }
    }
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob, opts);
    } catch {
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); // 크기 옵션 미지원 브라우저
    }
    const out = scaled(bmp, maxSide);
    bmp.close();
    return out;
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return scaled(img, maxSide);
    } catch {
      throw new Error('이미지를 열 수 없습니다');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
