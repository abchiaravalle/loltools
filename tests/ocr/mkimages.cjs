// Makes the OCR test images with ImageMagick. Each image has a known text so the
// test can measure how much of it the page reads back correctly.
// Usage: node tests/ocr/mkimages.cjs [outDir]   (default: _work/ocr/img)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SUP = '/System/Library/Fonts/Supplemental/';
const FONTS = {
  sans: SUP + 'Arial.ttf',
  serif: SUP + 'Georgia.ttf',
  mono: SUP + 'Courier New.ttf',
  monoBold: SUP + 'Courier New Bold.ttf',
};

const TEXTS = {
  clean: 'The quick brown fox jumps over the lazy dog near the river bank. Please send the signed form back by Friday, March 14, so we can finish the order. Call 555-0142 if you have any questions about invoice 7781.',
  photo: 'Dear tenant, the water will be shut off on Tuesday from 9 AM to 1 PM while we replace the main valve. Please fill a few bottles the night before. We are sorry for the trouble and thank you for your patience.',
  receipt: [
    'CORNER MARKET',
    '123 MAIN ST, SPRINGFIELD',
    '',
    'COFFEE BEANS 12OZ     11.99',
    'WHOLE MILK 1GAL        4.29',
    'BANANAS 2.1LB          1.34',
    'SOURDOUGH LOAF         6.50',
    'EGGS LARGE DOZEN       3.79',
    '',
    'SUBTOTAL              27.91',
    'TAX 7%                 1.95',
    'TOTAL                 29.86',
    '',
    'VISA ENDING 4417',
    'THANK YOU, COME AGAIN',
  ].join('\n'),
  dark: 'Dark mode screenshots work too. White text on a dark background gets flipped before reading.',
  spanish: 'El niño comió una manzana en el jardín. Mañana vamos a la playa con nuestros amigos después de la reunión.',
  blurry: 'Meeting moved to room 4B at noon. Bring the budget sheets and the signed contract copies for review.',
};

function magick(args) { execFileSync('magick', args, { stdio: ['ignore', 'ignore', 'pipe'] }); }

function make(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const P = (n) => path.join(outDir, n);
  // Fixed seed so the noise (and so the expected OCR result) is the same every run.
  const seed = ['-seed', '4242'];

  // 1. Clean screenshot: sans, 22px, dark grey on white, like a chat or web page.
  magick(['-background', 'white', '-fill', '#222222', '-font', FONTS.sans, '-pointsize', '22', '-density', '72',
    '-size', '1000x', `caption:${TEXTS.clean}`, '-bordercolor', 'white', '-border', '40x32', P('clean.png')]);

  // 2. "Photo of a document": serif on off-white paper, rotated 2.5 degrees,
  //    uneven lighting, sensor noise, a little blur, saved as a JPEG.
  magick([...seed, '-background', '#f3efe4', '-fill', '#1d1d1d', '-font', FONTS.serif, '-pointsize', '30', '-density', '72',
    '-size', '1300x', `caption:${TEXTS.photo}`, '-bordercolor', '#f3efe4', '-border', '70x60',
    '-background', '#8a8578', '-rotate', '2.5',
    '(', '+clone', '-sparse-color', 'Barycentric', '0,0 #ffffff %w,%h #b8b8b8', ')', '-compose', 'Multiply', '-composite',
    '-attenuate', '0.5', '+noise', 'Gaussian', '-blur', '0x0.7', '-quality', '72', P('photo.jpg')]);

  // 3. Receipt: small monospace text (14px), narrow, thermal-paper grey.
  magick([...seed, '-background', '#fbfbf8', '-fill', '#303030', '-font', FONTS.mono, '-pointsize', '14', '-density', '72',
    `label:${TEXTS.receipt}`, '-bordercolor', '#fbfbf8', '-border', '24x20',
    '-attenuate', '0.25', '+noise', 'Gaussian', P('receipt.png')]);

  // 4. Dark-mode screenshot (white on near-black), WebP.
  magick(['-background', '#15181e', '-fill', '#e8e8e8', '-font', FONTS.sans, '-pointsize', '22', '-density', '72',
    '-size', '900x', `caption:${TEXTS.dark}`, '-bordercolor', '#15181e', '-border', '36x28', '-quality', '90', P('dark.webp')]);

  // 5. Spanish text with accents, for the language picker.
  magick(['-background', 'white', '-fill', '#111111', '-font', FONTS.sans, '-pointsize', '24', '-density', '72',
    '-size', '1000x', `caption:${TEXTS.spanish}`, '-bordercolor', 'white', '-border', '40x30', P('spanish.png')]);

  // 6. A bad photo: small grey text, blurred, noisy, low-quality JPEG. The
  //    engine should report low confidence and the page should warn about it.
  magick([...seed, '-background', '#d8d4cc', '-fill', '#555555', '-font', FONTS.serif, '-pointsize', '12', '-density', '72',
    '-size', '360x', `caption:${TEXTS.blurry}`, '-bordercolor', '#d8d4cc', '-border', '20',
    '-blur', '0x1.0', '-attenuate', '0.5', '+noise', 'Gaussian', '-quality', '40', P('blurry.jpg')]);

  // Not an image: a small PDF-looking file and a text file.
  fs.writeFileSync(P('notes.txt'), 'this is not an image\n');
  fs.writeFileSync(P('fake.pdf'), '%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
  // Looks like a PNG by name but the bytes are junk.
  fs.writeFileSync(P('broken.png'), Buffer.from('89504e470d0a1a0a0000000d49484452deadbeef', 'hex'));
  return { dir: outDir, texts: TEXTS };
}

module.exports = { make, TEXTS };
if (require.main === module) {
  const out = make(path.resolve(process.argv[2] || path.join(__dirname, '../../_work/ocr/img')));
  console.log('wrote images to', out.dir);
}
