// 최소 PDF 작성기: 페이지마다 JPEG 한 장(DCTDecode)을 페이지 전체에 배치

export interface PdfPage {
  jpeg: Uint8Array;
  /** 이미지 픽셀 크기 */
  w: number;
  h: number;
  /** 페이지 크기(pt) */
  pw: number;
  ph: number;
  /** 흑백 JPEG이면 DeviceGray */
  gray?: boolean;
}

const enc = new TextEncoder();

/** 한글 제목 등은 UTF-16BE 16진 문자열로 */
export function pdfText(str: string): string {
  let hex = 'FEFF';
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    const units = cp > 0xffff
      ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)]
      : [cp];
    for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

const num = (v: number) => (Math.round(v * 100) / 100).toString();

export function buildPdf(pages: readonly PdfPage[], title: string): Blob {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    len += bytes.length;
  };
  const obj = (id: number, ...parts: (string | Uint8Array)[]) => {
    offsets[id] = len;
    push(`${id} 0 obj\n`);
    parts.forEach(push);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageId = (i: number) => 4 + i * 3;
  const kids = pages.map((_, i) => `${pageId(i)} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  obj(3, `<< /Title ${pdfText(title)} /Producer (Doc Scanner Web) >>`);

  pages.forEach((p, i) => {
    const id = pageId(i);
    const content = `q ${num(p.pw)} 0 0 ${num(p.ph)} 0 0 cm /Im0 Do Q`;
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.pw)} ${num(p.ph)}] ` +
      `/Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    obj(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    obj(id + 2,
      `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} ` +
      `/ColorSpace /${p.gray ? 'DeviceGray' : 'DeviceRGB'} ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      p.jpeg, '\nendstream');
  });

  const count = pageId(pages.length);
  const xrefAt = len;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}
