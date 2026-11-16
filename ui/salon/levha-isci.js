// Kontrol Merkezi · the hall's texts redrawn off the main thread (11-17: a redraw of the keystone display cost 20-25 ms
// of drawing and 7-22 ms of canvas upload on the main thread, once a second, and every one of them cost frames).
// The same levha.js draws here into an OffscreenCanvas (same CPU raster, same bytes); the pixels go back as a
// transferred buffer and the renderer uploads them in strips over a few frames (salon.js setLevhaBytes).
'use strict';
importScripts('levha.js');
self.onmessage = async e => {
  const { id, name, data } = e.data;
  try {
    await KM_LEVHA.ready;
    const cv = KM_LEVHA.draw(name, data);
    const img = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
    self.postMessage({ id, name, w: cv.width, h: cv.height, buf: img.data.buffer }, [img.data.buffer]);
  } catch (err) {
    self.postMessage({ id, name, error: String(err && err.message || err) });
  }
};
