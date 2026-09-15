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

/** EXIF 회전을 반영해 디코딩하고, 메모리 보호를 위해 긴 변을 maxSide로 제한 */
export async function decodeImage(blob: Blob, maxSide = 4096): Promise<Surface> {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
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
