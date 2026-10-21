/*
  colorpicker.lol palette worker. Finds the main colors in an image off the
  main thread so the page stays responsive. It gets raw pixel bytes from the
  page and posts back a short list of colors. No network access.
*/
importScripts('/colormath.js');

self.onmessage = (e) => {
  const { id, buffer, k } = e.data;
  try {
    const colors = self.colormath.palette(new Uint8ClampedArray(buffer), k);
    self.postMessage({ id, colors });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
