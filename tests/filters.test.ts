import { describe, expect, it } from 'vitest';
import { grayDocument, packBits, scanDocument } from '../src/lib/filters';
import type { Gray } from '../src/lib/imgproc';
import { buildPdf, deflate } from '../src/lib/pdf';
import { rng } from './synth';

// ---------------------------------------------------------------- 합성 문서 (1채널)

const W = 827, H = 1170; // 100dpi A4

function page(paper = 235) {
  const g: Gray = { data: new Uint8ClampedArray(W * H).fill(paper), width: W, height: H };
  return g;
}

function fill(g: Gray, x0: number, y0: number, x1: number, y1: number, v: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g.data[y * W + x] = v;
}

/** 왼쪽이 어두운 그림자 + 센서 잡음 */
function photoLike(g: Gray, seed = 1) {
  const rand = rng(seed);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      g.data[i] = g.data[i] * (0.62 + 0.38 * (x / (W - 1))) + (rand() + rand() - 1) * 10;
    }
  }
  return g;
}

/** 영역 안 검정(< 128) 비율 */
function inkRatio(g: Gray, x0: number, y0: number, x1: number, y1: number) {
  let ink = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (g.data[y * g.width + x] < 128) ink++;
  return ink / ((x1 - x0) * (y1 - y0));
}

/** 진한 글씨 줄, 연한 글씨 줄(종이보다 25%만 어두움), 굵은 제목(반사 점 포함), 가는 선 */
function document() {
  const g = page();
  for (let i = 0; i < 6; i++) fill(g, 80, 200 + i * 40, 740, 206 + i * 40, 40);     // 진한 글씨
  for (let i = 0; i < 4; i++) fill(g, 80, 520 + i * 40, 740, 524 + i * 40, 176);    // 연한 글씨
  fill(g, 100, 60, 700, 150, 45);                                                  // 굵은 제목
  const rand = rng(3);
  for (let n = 0; n < 60; n++) {                                                   // 제목 속 반사
    const x = 110 + Math.floor(rand() * 570), y = 70 + Math.floor(rand() * 70);
    fill(g, x, y, x + 4, y + 3, 150);
  }
  fill(g, 80, 800, 740, 802, 150);                                                 // 가는 선 (2px)
  return photoLike(g);
}

// ---------------------------------------------------------------- 스캔

describe('스캔', () => {
  const out = scanDocument(document());

  it('결과는 흑·백 두 값뿐', () => {
    expect(out.data.every(v => v === 0 || v === 255)).toBe(true);
  });

  it('그림자진 종이는 흰색 (왼쪽 어두운 쪽 포함)', () => {
    expect(inkRatio(out, 20, 900, 400, 1150)).toBeLessThan(0.005);
    expect(inkRatio(out, 400, 900, 800, 1150)).toBeLessThan(0.005);
  });

  it('진한 글씨는 검정', () => {
    expect(inkRatio(out, 90, 201, 730, 205)).toBeGreaterThan(0.95);
  });

  it('종이보다 살짝만 어두운 연한 글씨도 남는다', () => {
    for (let i = 0; i < 4; i++) {
      expect(inkRatio(out, 90, 520 + i * 40, 730, 524 + i * 40), `연한 줄 ${i}`).toBeGreaterThan(0.8);
    }
  });

  it('가는 선이 끊기지 않는다', () => {
    expect(inkRatio(out, 90, 800, 730, 802)).toBeGreaterThan(0.9);
  });

  it('굵은 제목 속 반사 점은 채워진다', () => {
    expect(inkRatio(out, 110, 70, 690, 140)).toBeGreaterThan(0.97);
  });

  it('테두리에 붙은 검은 띠(문서 밖 책상)는 지우고, 가장자리 근처 글씨는 남긴다', () => {
    const g = document();
    fill(g, 0, 0, W, 8, 40);         // 위쪽 검은 띠 (테두리에 닿음)
    fill(g, W - 5, 0, W, H, 40);     // 오른쪽 검은 띠
    fill(g, 30, 30, 400, 34, 40);    // 테두리에서 30px 떨어진 글씨 줄 (띠 폭 안쪽이지만 테두리에 안 닿음)
    const r = scanDocument(g);
    expect(inkRatio(r, 0, 0, W, 8)).toBeLessThan(0.01);
    expect(inkRatio(r, W - 5, 200, W, H - 200)).toBeLessThan(0.01);
    expect(inkRatio(r, 40, 30, 390, 34)).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------- 흑백

describe('흑백', () => {
  const out = grayDocument(document());
  const mean = (x0: number, y0: number, x1: number, y1: number) => {
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += out.data[y * W + x];
    return s / ((x1 - x0) * (y1 - y0));
  };

  it('그림자가 사라져 종이 밝기가 고르다', () => {
    const left = mean(20, 900, 200, 1150), right = mean(620, 900, 800, 1150);
    expect(left).toBeGreaterThan(235);
    expect(Math.abs(left - right)).toBeLessThan(10);
  });

  it('글씨는 진하게, 연한 글씨도 종이와 구분된다', () => {
    expect(mean(90, 201, 730, 205)).toBeLessThan(40);
    expect(mean(90, 520, 730, 524)).toBeLessThan(mean(20, 900, 800, 1150) - 50);
  });
});

// ---------------------------------------------------------------- 1비트 저장

describe('1비트 PDF 이미지', () => {
  it('앞 비트부터 채우고 1이 흰색', () => {
    const g: Gray = { data: new Uint8ClampedArray([0, 255, 255, 0, 0, 0, 0, 0, 255, 255]), width: 10, height: 1 };
    expect([...packBits(g)]).toEqual([0b01100000, 0b11000000]);
  });

  it('deflate 압축이 원래대로 풀리고, PDF에 FlateDecode 흑백 이미지로 들어간다', async () => {
    const bits = packBits(scanDocument(document()));
    const z = await deflate(bits);
    expect(z).not.toBeNull();
    expect(z!.length).toBeLessThan(bits.length / 5);
    const back = new Uint8Array(await new Response(new Blob([z! as BlobPart]).stream()
      .pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    expect(back).toEqual(bits);

    const pdf = buildPdf([{ image: { kind: 'mono', bytes: z!, deflated: true }, w: W, h: H, pw: 595.28, ph: 841.89 }], 't');
    const text = new TextDecoder('latin1').decode(new Uint8Array(await pdf.arrayBuffer()));
    expect(text).toContain('/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode');
  });
});
