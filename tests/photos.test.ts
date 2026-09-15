// 실사진 회귀 테스트 — test-photos/ 는 개인 사진이라 git에 올리지 않음. 사진이 없으면(CI 등) 건너뜀.
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectByEdges, detectRobust } from '../src/lib/cvdetect';
import { type Quad, dist, orderQuad, unrotatePoint } from '../src/lib/geometry';
import { detectByRegion, rotateRGBA } from '../src/lib/imgproc';
import type { CV } from '../src/lib/opencv';
import { downscale, loadJpeg, photoFiles } from './photos';

/**
 * 정답 모서리(원본 1058×1411 기준, 좌상·우상·우하·좌하)와 모서리별 허용 오차(px).
 * 두꺼운 책은 아래쪽 모서리가 종이 단면·그림자 때문에 애매해서 허용 오차를 크게 둠.
 */
const TRUTH: Record<string, { quad: [number, number][]; tol: number[] }> = {
  // 책상 위 정면 책: 위쪽 두 모서리는 선명(키보드 모서리와 헷갈리면 안 됨)
  'KakaoTalk_20260916_012401905_01.jpg': {
    quad: [[270, 431], [757, 423], [895, 1110], [55, 1110]],
    tol: [18, 18, 45, 45],
  },
  // 비스듬한 책: 좌하 모서리는 책등 단면 때문에 애매
  'KakaoTalk_20260916_012401905_02.jpg': {
    quad: [[92, 512], [497, 351], [1048, 720], [575, 1092]],
    tol: [18, 18, 18, 45],
  },
};

const files = photoFiles().filter(f => TRUTH[f]);
const DETECT_SIZE = 600;

let cv: CV;
beforeAll(async () => {
  if (!files.length) return;
  const mod = createRequire(import.meta.url)('@techstark/opencv-js');
  const ready = mod instanceof Promise ? await mod : mod;
  if (!ready.Mat) await new Promise<void>(resolve => { ready.onRuntimeInitialized = () => resolve(); });
  cv = ready;
}, 60000);

function check(file: string, quad: Quad, scale: number) {
  const { quad: truth, tol } = TRUTH[file];
  const q = orderQuad(quad.map(p => ({ x: p.x * scale, y: p.y * scale })));
  q.forEach((p, i) => {
    const err = dist(p, { x: truth[i][0], y: truth[i][1] });
    expect(err, `${file} 모서리 ${i}: (${Math.round(p.x)},${Math.round(p.y)}) 오차 ${err.toFixed(0)}px`).toBeLessThan(tol[i]);
  });
}

describe.skipIf(!files.length)('실사진', () => {
  for (const file of files) {
    describe(file, () => {
      const full = loadJpeg(file);
      const small = downscale(full, DETECT_SIZE);
      const scale = full.width / small.width;

      for (const k of [0, 1, 2, 3]) {
        it(`${k * 90}° 회전해도 같은 문서를 찾는다`, () => {
          const img = rotateRGBA(small, k);
          const region = detectByRegion(img);
          const d = detectByEdges(cv, img, region ? [region.quad] : []);
          expect(d, '문서를 찾지 못함').not.toBeNull();
          check(file, d!.quad.map(p => unrotatePoint(p, k, small.width, small.height)) as Quad, scale);
        });
      }

      it('4방향 투표 결과', () => {
        const d = detectRobust(cv, small);
        expect(d, '문서를 찾지 못함').not.toBeNull();
        expect(d!.votes).toBeGreaterThanOrEqual(2);
        check(file, d!.quad, scale);
      });
    });
  }
});
