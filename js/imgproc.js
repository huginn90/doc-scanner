// 이미지 처리: 문서 감지, 원근 보정, 스캔 필터
const IP = (() => {
  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function ctx2d(c) {
    return c.getContext('2d', { willReadFrequently: true });
  }

  // iOS Safari는 캔버스 메모리 한도가 있으므로 다 쓴 캔버스는 크기를 0으로 만들어 해제
  function release(c) {
    if (c) { c.width = 0; c.height = 0; }
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ---------------------------------------------------------------- 기본 연산

  // 분리형 박스 블러 (running sum), in-place
  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h);
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        const add = Math.min(w - 1, x + r + 1), sub = Math.max(0, x - r);
        acc += src[row + add] - src[row + sub];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        src[y * w + x] = acc / win;
        const add = Math.min(h - 1, y + r + 1), sub = Math.max(0, y - r);
        acc += tmp[add * w + x] - tmp[sub * w + x];
      }
    }
    return src;
  }

  function otsu(values) {
    const hist = new Float64Array(256);
    for (let i = 0; i < values.length; i++) hist[Math.min(255, Math.max(0, values[i] | 0))]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // 정사각 구조요소 min/max 필터 (분리형), mask: Uint8Array 0/1
  function morph(mask, w, h, r, isMax) {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    const pick = isMax ? 1 : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 1 - pick;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
          if (mask[y * w + k] === pick) { v = pick; break; }
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 1 - pick;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
          if (tmp[k * w + x] === pick) { v = pick; break; }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // 가장 큰 연결 영역: 행별 좌/우 끝점과 (구멍을 메운) 면적 반환
  function largestComponent(mask, w, h) {
    const labels = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let bestLabel = 0, bestArea = 0, label = 0;
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || labels[s]) continue;
      label++;
      let sp = 0, area = 0;
      stack[sp++] = s;
      labels[s] = label;
      while (sp) {
        const p = stack[--sp];
        area++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = label; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = label; stack[sp++] = p + w; }
      }
      if (area > bestArea) { bestArea = area; bestLabel = label; }
    }
    if (!bestLabel) return null;
    const points = [];
    let spanArea = 0;
    for (let y = 0; y < h; y++) {
      let minX = -1, maxX = -1;
      for (let x = 0; x < w; x++) {
        if (labels[y * w + x] === bestLabel) {
          if (minX < 0) minX = x;
          maxX = x;
        }
      }
      if (minX >= 0) {
        points.push({ x: minX, y }, { x: maxX + 1, y }, { x: minX, y: y + 1 }, { x: maxX + 1, y: y + 1 });
        spanArea += maxX - minX + 1;
      }
    }
    return { points, area: spanArea };
  }

  function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [], upper = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
      upper.push(q);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  const triArea = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;

  function polyArea(q) {
    let s = 0;
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }

  // 볼록 다각형에 내접하는 최대 면적 사각형 (대각선 i-k 고정 후 양쪽 최원점)
  function maxAreaQuad(hull) {
    const n = hull.length;
    if (n < 4) return null;
    let best = 0, quad = null;
    for (let i = 0; i < n; i++) {
      for (let k = i + 2; k < n; k++) {
        if (i === 0 && k === n - 1) continue;
        let a1 = 0, j1 = -1;
        for (let j = i + 1; j < k; j++) {
          const a = triArea(hull[i], hull[j], hull[k]);
          if (a > a1) { a1 = a; j1 = j; }
        }
        let a2 = 0, j2 = -1;
        for (let j = k + 1; j < n + i; j++) {
          const jj = j % n;
          const a = triArea(hull[i], hull[jj], hull[k]);
          if (a > a2) { a2 = a; j2 = jj; }
        }
        if (j1 >= 0 && j2 >= 0 && a1 + a2 > best) {
          best = a1 + a2;
          quad = [hull[i], hull[j1], hull[k], hull[j2]];
        }
      }
    }
    return quad;
  }

  // 좌상→우상→우하→좌하 순서로 정렬
  function orderQuad(q) {
    let pts = q.map(p => ({ x: p.x, y: p.y }));
    if (polyArea(pts) < 0) pts.reverse();
    let start = 0;
    for (let i = 1; i < 4; i++) {
      if (pts[i].x + pts[i].y < pts[start].x + pts[start].y) start = i;
    }
    return pts.slice(start).concat(pts.slice(0, start));
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cr) < 1e-9) return false;
      const s = Math.sign(cr);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  function defaultQuad(w, h, inset = 0.08) {
    const dx = w * inset, dy = h * inset;
    return [
      { x: dx, y: dy }, { x: w - dx, y: dy },
      { x: w - dx, y: h - dy }, { x: dx, y: h - dy },
    ];
  }

  // ---------------------------------------------------------------- 문서 감지

  function detect(src) {
    const W0 = src.width, H0 = src.height;
    const scale = Math.min(1, 480 / Math.max(W0, H0));
    const w = Math.max(8, Math.round(W0 * scale)), h = Math.max(8, Math.round(H0 * scale));
    const c = canvas(w, h);
    const cx = ctx2d(c);
    cx.drawImage(src, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;
    release(c);

    const n = w * h;
    const lum = new Float32Array(n), minc = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = d[j], g = d[j + 1], b = d[j + 2];
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      minc[i] = Math.min(r, g, b); // 밝고 채도 낮은 = 종이다움
    }
    boxBlur(lum, w, h, 2);
    boxBlur(minc, w, h, 2);

    let best = null;
    for (const feat of [lum, minc]) {
      const t = otsu(feat);
      for (const invert of [false, true]) {
        let mask = new Uint8Array(n);
        for (let i = 0; i < n; i++) mask[i] = (feat[i] > t) !== invert ? 1 : 0;
        // 열림 연산: 문서와 배경 사이의 가는 연결을 끊음
        mask = morph(morph(mask, w, h, 2, false), w, h, 2, true);
        const comp = largestComponent(mask, w, h);
        if (!comp || comp.area < n * 0.08) continue;
        const hull = convexHull(comp.points);
        const quad = maxAreaQuad(hull);
        if (!quad) continue;
        const qa = Math.abs(polyArea(quad));
        const frac = qa / n;
        const fill = Math.min(1, comp.area / qa);
        const hullFill = comp.area / Math.abs(polyArea(hull));
        let score = frac * Math.pow(fill, 4) * Math.pow(hullFill, 2);
        if (frac > 0.93) score *= 0.15; // 사진 전체 = 배경일 가능성
        if (invert) score *= 0.8;
        if (!best || score > best.score) best = { score, quad };
      }
    }

    if (!best || best.score < 0.05) return { quad: defaultQuad(W0, H0), found: false };
    const q = orderQuad(best.quad.map(p => ({
      x: Math.min(W0, Math.max(0, p.x / scale)),
      y: Math.min(H0, Math.max(0, p.y / scale)),
    })));
    if (!isConvex(q)) return { quad: defaultQuad(W0, H0), found: false };
    return { quad: q, found: true };
  }

  // ---------------------------------------------------------------- 원근 보정

  // src 4점 -> dst 4점 호모그래피 (h33 = 1)
  function homography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], X = dst[i].x, Y = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
    }
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      [A[col], A[piv]] = [A[piv], A[col]];
      const div = A[col][col];
      if (Math.abs(div) < 1e-12) throw new Error('singular');
      for (let k = col; k < 9; k++) A[col][k] /= div;
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = A[r][col];
        if (!f) continue;
        for (let k = col; k < 9; k++) A[r][k] -= f * A[col][k];
      }
    }
    return A.map(row => row[8]).concat(1);
  }

  function warp(src, quad, outW, outH) {
    const [tl, tr, br, bl] = quad;
    const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
    const bx = Math.max(0, Math.floor(Math.min(...xs)) - 2);
    const by = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const bx2 = Math.min(src.width, Math.ceil(Math.max(...xs)) + 2);
    const by2 = Math.min(src.height, Math.ceil(Math.max(...ys)) + 2);
    const bw = Math.max(2, bx2 - bx), bh = Math.max(2, by2 - by);

    // 원본이 출력보다 훨씬 크면 브라우저 고품질 축소를 먼저 적용 (계단 현상 방지)
    const sideW = Math.max(dist(tl, tr), dist(bl, br));
    const sideH = Math.max(dist(tl, bl), dist(tr, br));
    const s = Math.min(1, 1.3 * Math.max(outW / sideW, outH / sideH));
    const cw = Math.max(2, Math.round(bw * s)), ch = Math.max(2, Math.round(bh * s));
    const tmp = canvas(cw, ch);
    const tctx = ctx2d(tmp);
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(src, bx, by, bw, bh, 0, 0, cw, ch);
    const sd = tctx.getImageData(0, 0, cw, ch).data;
    release(tmp);

    const sx = cw / bw, sy = ch / bh;
    const q = quad.map(p => ({ x: (p.x - bx) * sx, y: (p.y - by) * sy }));
    const H = homography(
      [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }], q);

    const out = canvas(outW, outH);
    const octx = ctx2d(out);
    const img = octx.createImageData(outW, outH);
    const od = img.data;
    const maxX = cw - 1.001, maxY = ch - 1.001, stride = cw * 4;
    let o = 0;
    for (let v = 0; v < outH; v++) {
      const V = v + 0.5;
      for (let u = 0; u < outW; u++, o += 4) {
        const U = u + 0.5;
        const den = H[6] * U + H[7] * V + 1;
        let x = (H[0] * U + H[1] * V + H[2]) / den - 0.5;
        let y = (H[3] * U + H[4] * V + H[5]) / den - 0.5;
        x = x < 0 ? 0 : x > maxX ? maxX : x;
        y = y < 0 ? 0 : y > maxY ? maxY : y;
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const i00 = y0 * stride + x0 * 4, i10 = i00 + 4, i01 = i00 + stride, i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
          const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
          od[o + c] = top + (bot - top) * fy;
        }
        od[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  // ---------------------------------------------------------------- 스캔 필터

  // 종이 배경(조명/그림자) 추정: 블록 최대값 → 팽창 → 블러 → 저해상도 격자
  function backgroundGrid(d, w, h, channels) {
    const block = Math.max(4, Math.round(Math.max(w, h) / 100));
    const gw = Math.ceil(w / block), gh = Math.ceil(h / block);
    const grids = channels.map(() => new Float32Array(gw * gh));
    for (let y = 0; y < h; y++) {
      const gy = ((y / block) | 0) * gw;
      for (let x = 0; x < w; x++) {
        const gi = gy + ((x / block) | 0), j = (y * w + x) * 4;
        for (let c = 0; c < channels.length; c++) {
          const v = channels[c](d, j);
          if (v > grids[c][gi]) grids[c][gi] = v;
        }
      }
    }
    for (let c = 0; c < grids.length; c++) {
      let g = grids[c];
      // 3x3 팽창: 굵은 글자/선도 배경으로 오인하지 않도록
      const dil = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          let m = 0;
          for (let yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++)
            for (let xx = Math.max(0, x - 1); xx <= Math.min(gw - 1, x + 1); xx++)
              if (g[yy * gw + xx] > m) m = g[yy * gw + xx];
          dil[y * gw + x] = m;
        }
      }
      g = dil;
      // 사진 등 넓은 어두운 영역이 하얗게 날아가지 않도록 하한 설정
      const sorted = Float32Array.from(g).sort();
      const paper = sorted[Math.floor(sorted.length * 0.9)] || 255;
      const floor = Math.max(1, paper * 0.55);
      for (let i = 0; i < g.length; i++) if (g[i] < floor) g[i] = floor;
      boxBlur(g, gw, gh, 2);
      boxBlur(g, gw, gh, 2);
      grids[c] = g;
    }
    return { grids, block, gw, gh };
  }

  function makeLut(fn) {
    // 인덱스 = (값/배경) * 1024, 1.25배까지
    const lut = new Uint8ClampedArray(1281);
    for (let k = 0; k <= 1280; k++) lut[k] = Math.round(255 * fn(k / 1024));
    return lut;
  }

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const stretch = (lo, hi, gamma) => v => Math.pow(clamp01((v - lo) / (hi - lo)), gamma);
  const smoothstep = (a, b) => v => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

  const LUTS = {
    enhance: () => makeLut(stretch(0.1, 0.9, 1.15)),
    gray: () => makeLut(stretch(0.12, 0.88, 1.3)),
    bw: () => makeLut(smoothstep(0.62, 0.78)),
  };

  const lumOf = (d, j) => 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];

  function applyFilter(c, mode) {
    if (!mode || mode === 'original') return c;
    const w = c.width, h = c.height;
    const cx = ctx2d(c);
    const img = cx.getImageData(0, 0, w, h);
    const d = img.data;
    const perChannel = mode === 'enhance';
    const channels = perChannel
      ? [(d, j) => d[j], (d, j) => d[j + 1], (d, j) => d[j + 2]]
      : [lumOf];
    const { grids, block, gw, gh } = backgroundGrid(d, w, h, channels);
    const lut = LUTS[mode]();

    // 격자 → 픽셀 이중선형 보간용 좌표 미리 계산
    const x0s = new Int32Array(w), x1s = new Int32Array(w), fxs = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const g = Math.min(gw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      x0s[x] = g | 0; x1s[x] = Math.min(gw - 1, x0s[x] + 1); fxs[x] = g - x0s[x];
    }
    for (let y = 0; y < h; y++) {
      const g = Math.min(gh - 1, Math.max(0, (y + 0.5) / block - 0.5));
      const y0 = (g | 0) * gw, y1 = Math.min(gh - 1, (g | 0) + 1) * gw, fy = g - (g | 0);
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4, a = x0s[x], b = x1s[x], fx = fxs[x];
        if (perChannel) {
          for (let ch = 0; ch < 3; ch++) {
            const G = grids[ch];
            const top = G[y0 + a] + (G[y0 + b] - G[y0 + a]) * fx;
            const bot = G[y1 + a] + (G[y1 + b] - G[y1 + a]) * fx;
            const bg = top + (bot - top) * fy;
            d[j + ch] = lut[Math.min(1280, (d[j + ch] * 1024 / bg) | 0)];
          }
        } else {
          const G = grids[0];
          const top = G[y0 + a] + (G[y0 + b] - G[y0 + a]) * fx;
          const bot = G[y1 + a] + (G[y1 + b] - G[y1 + a]) * fx;
          const bg = top + (bot - top) * fy;
          const v = lut[Math.min(1280, (lumOf(d, j) * 1024 / bg) | 0)];
          d[j] = d[j + 1] = d[j + 2] = v;
        }
      }
    }
    cx.putImageData(img, 0, 0);
    return c;
  }

  function rotate(c, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return c;
    const swap = deg === 90 || deg === 270;
    const out = canvas(swap ? c.height : c.width, swap ? c.width : c.height);
    const cx = out.getContext('2d');
    cx.translate(out.width / 2, out.height / 2);
    cx.rotate(deg * Math.PI / 180);
    cx.drawImage(c, -c.width / 2, -c.height / 2);
    release(c);
    return out;
  }

  // ---------------------------------------------------------------- 출력 크기

  const A4_MM = { short: 210, long: 297 };
  const A4_PT = { short: 595.28, long: 841.89 };

  function outputSize(quad, paper, dpi) {
    const [tl, tr, br, bl] = quad;
    const wEst = (dist(tl, tr) + dist(bl, br)) / 2;
    const hEst = (dist(tl, bl) + dist(tr, br)) / 2;
    const longPx = Math.round(A4_MM.long / 25.4 * dpi);
    const shortPx = Math.round(A4_MM.short / 25.4 * dpi);
    const land = wEst > hEst;
    if (paper === 'a4') return land ? { w: longPx, h: shortPx } : { w: shortPx, h: longPx };
    const r = wEst / hEst;
    return land ? { w: longPx, h: Math.round(longPx / r) } : { w: Math.round(longPx * r), h: longPx };
  }

  // PDF 페이지 크기(pt): A4는 정확히 A4, 원본 비율은 긴 변을 A4 긴 변에 맞춤
  function pageSizePt(w, h, paper) {
    const land = w > h;
    if (paper === 'a4') return land ? [A4_PT.long, A4_PT.short] : [A4_PT.short, A4_PT.long];
    return land ? [A4_PT.long, A4_PT.long * h / w] : [A4_PT.long * w / h, A4_PT.long];
  }

  function render(src, quad, { paper, filter, rot }, dpi) {
    const { w, h } = outputSize(quad, paper, dpi);
    let c = warp(src, quad, w, h);
    applyFilter(c, filter);
    return rotate(c, rot);
  }

  return {
    canvas, release, detect, defaultQuad, isConvex, orderQuad,
    warp, applyFilter, rotate, render, outputSize, pageSizePt,
  };
})();
