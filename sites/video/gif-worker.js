/*
  vid2gif.lol GIF worker. Runs in a background thread in your browser.
  The page sends it raw frames (pixels it grabbed from the video with a
  canvas); it builds one palette for the clip and writes the GIF.
  It never touches the network.
*/
import { Histogram, buildPalette, GifBuilder } from './gifcore.js';

let hist = new Histogram();
let gif = null;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'sample') {
      hist.add(new Uint8Array(m.data));
      self.postMessage({ type: 'sampled' });
    } else if (m.type === 'start') {
      const palette = buildPalette(hist, 255);
      hist = null;
      gif = new GifBuilder(m.w, m.h, palette, { dither: m.dither });
      self.postMessage({ type: 'started', colors: palette.length });
    } else if (m.type === 'frame') {
      gif.addFrame(new Uint8Array(m.data), m.delay);
      self.postMessage({ type: 'ack', size: gif.size });
    } else if (m.type === 'finish') {
      const bytes = gif.finish();
      gif = null;
      self.postMessage({ type: 'done', bytes }, [bytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
