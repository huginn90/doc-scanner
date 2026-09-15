// 실사진 테스트 도우미 (test-photos/ 는 git에 올리지 않음 — 없으면 테스트 건너뜀)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { type RGBA, createRGBA } from '../src/lib/imgproc';

export const PHOTO_DIR = join(__dirname, '..', 'test-photos');

export const photoFiles = () =>
  existsSync(PHOTO_DIR) ? readdirSync(PHOTO_DIR).filter(f => /\.jpe?g$/i.test(f)).sort() : [];

export function loadJpeg(file: string): RGBA {
  const { data, width, height } = jpeg.decode(readFileSync(join(PHOTO_DIR, file)), { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height };
}

/** 앱과 같은 크기(긴 변 maxSide)로 면적 평균 축소 */
export function downscale(img: RGBA, maxSide: number): RGBA {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (s === 1) return img;
  const W = Math.round(img.width * s), H = Math.round(img.height * s);
  const out = createRGBA(W, H);
  const fx = img.width / W, fy = img.height / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      const acc = [0, 0, 0];
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const j = (yy * img.width + xx) * 4;
          acc[0] += img.data[j]; acc[1] += img.data[j + 1]; acc[2] += img.data[j + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0), o = (y * W + x) * 4;
      out.data[o] = acc[0] / n; out.data[o + 1] = acc[1] / n; out.data[o + 2] = acc[2] / n; out.data[o + 3] = 255;
    }
  }
  return out;
}
