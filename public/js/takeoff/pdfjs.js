// pdf.js, loaded from the CDN the first time a drawing is opened (the rest of the app never needs it).
// The version is pinned: reader.js reads pdf.js 4.x operator lists.
export const PDFJS_VERSION = '4.10.38';
const BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

let lib = null;

export async function pdfjs() {
  if (!lib) {
    lib = await import(`${BASE}/build/pdf.min.mjs`);
    lib.GlobalWorkerOptions.workerSrc = `${BASE}/build/pdf.worker.min.mjs`;
  }
  return lib;
}

export async function openPdf(data) {
  const p = await pdfjs();
  return p.getDocument({
    data,
    cMapUrl: `${BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}/standard_fonts/`,
    isEvalSupported: false,
  }).promise;
}
