// Kontrol Merkezi · one file of the hall's pack, fetched and inflated off the main thread (salon.js, "loading").
// Inflating the pack's 680 MB of deflate into 1.85 GB is ~3.2 s of one core (zlib, measured 11-17); on the page's
// thread it held the loading screen and everything else. Each big file gets its own worker, so they inflate side by
// side on separate cores. Messages in: { url, kmv1 }. Out: { got, size } now and then (bytes off the wire so far, for
// the loading screen), then { buf, laidOut } (transferred) or { error }.
// kmv1: a light volume (KMV1: header, then per group M and F grids of RGBA half floats) is returned in its texture's
// layout instead (the same header, then per group and slice and row M's row and F's row side by side), when its
// header is sound; salon.js checks it and uploads it as it is.
'use strict';
self.onmessage = async e => {
  const { url, kmv1 } = e.data;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) { self.postMessage({ error: 'HTTP ' + r.status, status: r.status }); return; }
    self.postMessage({ got: 0, size: +(r.headers.get('Content-Length') || 0) });
    let got = 0, told = 0;
    const count = new TransformStream({
      transform(chunk, c) {
        got += chunk.byteLength;
        if (got - told >= 4 << 20) { told = got; self.postMessage({ got }); }
        c.enqueue(chunk);
      },
    });
    let body = r.body.pipeThrough(count);
    if (/\.gz$/.test(url)) body = body.pipeThrough(new DecompressionStream('gzip'));
    else if (/\.z$/.test(url)) body = body.pipeThrough(new DecompressionStream('deflate'));
    let buf = await new Response(body).arrayBuffer(), laidOut = false;
    if (kmv1) { const o = layOut(buf); if (o) { buf = o; laidOut = true; } }
    self.postMessage({ got, buf, laidOut }, [buf]);
  } catch (err) {
    self.postMessage({ error: err && err.message || String(err) });
  }
};

function layOut(buf) {
  if (buf.byteLength < 20) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x31564d4b || dv.getUint32(16, true) !== 3) return null;
  const nx = dv.getUint32(4, true), ny = dv.getUint32(8, true), nz = dv.getUint32(12, true);
  const grid = nx * ny * nz * 4, row = nx * 4;
  if (buf.byteLength !== 20 + grid * 2 * 2 * 3) return null;
  const res = new ArrayBuffer(buf.byteLength);
  new Uint8Array(res, 0, 20).set(new Uint8Array(buf, 0, 20));
  const out = new Uint16Array(res, 20, grid * 2 * 3);
  for (let g = 0; g < 3; g++) {
    const M = new Uint16Array(buf, 20 + (g * 2) * grid * 2, grid), F = new Uint16Array(buf, 20 + (g * 2 + 1) * grid * 2, grid);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      const s = (z * ny + y) * row, d = ((g * nz + z) * ny + y) * row * 2;
      out.set(M.subarray(s, s + row), d);
      out.set(F.subarray(s, s + row), d + row);
    }
  }
  return res;
}
