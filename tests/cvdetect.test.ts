import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectByEdges, edgeSupport } from '../src/lib/cvdetect';
import { orderQuad } from '../src/lib/geometry';
import { detectByRegion } from '../src/lib/imgproc';
import type { CV } from '../src/lib/opencv';
import { cornerError, rect, synthHeldBook, synthPhoto } from './synth';

let cv: CV;
beforeAll(async () => {
  // 패키지가 Promise를 export해서 Vitest의 ESM 로더로는 불러올 수 없음 → CommonJS require 사용
  const mod = createRequire(import.meta.url)('@techstark/opencv-js');
  const ready = mod instanceof Promise ? await mod : mod;
  if (!ready.Mat) await new Promise<void>(resolve => { ready.onRuntimeInitialized = () => resolve(); });
  cv = ready;
}, 60000);

describe('edgeSupport', () => {
  const w = 100, h = 100;
  const edges = new Uint8Array(w * h);
  const box = rect(20, 20, 80, 80);
  for (let i = 20; i <= 80; i++) {
    edges[20 * w + i] = edges[80 * w + i] = edges[i * w + 20] = edges[i * w + 80] = 1;
  }

  it('경계와 겹치는 사각형은 1에 가깝다', () => {
    expect(edgeSupport(edges, w, h, box)).toBeGreaterThan(0.95);
  });

  it('한 변이 허공에 뜨면 점수가 크게 떨어진다', () => {
    expect(edgeSupport(edges, w, h, rect(20, 20, 95, 80))).toBeLessThan(0.5);
  });
});

describe('detectByEdges', () => {
  it('어두운 책상 위 문서', () => {
    const { img, corners } = synthPhoto();
    const det = detectByEdges(cv, img);
    expect(det).not.toBeNull();
    expect(cornerError(orderQuad(det!.quad), corners)).toBeLessThan(6);
  });

  it('피부가 맞닿은 손에 든 책 (영역 기반이 실패하는 경우)', () => {
    const { img, corners } = synthHeldBook();
    const region = detectByRegion(img);
    const regionErr = region ? cornerError(orderQuad(region.quad), corners) : Infinity;
    const det = detectByEdges(cv, img, region ? [region.quad] : []);
    expect(det).not.toBeNull();
    const err = cornerError(orderQuad(det!.quad), corners);
    expect(err).toBeLessThan(8);
    expect(err).toBeLessThan(regionErr);
  });
});
