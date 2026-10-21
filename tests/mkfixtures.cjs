// Build synthetic PDF fixtures with pdf-lib.
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const F = '/tmp/loltest/fixtures/';
(async () => {
  for (const [name, n] of [['a.pdf', 2], ['b.pdf', 3]]) {
    const d = await PDFDocument.create();
    const font = await d.embedFont(StandardFonts.HelveticaBold);
    for (let i = 1; i <= n; i++) {
      const p = d.addPage([612, 792]);
      p.drawText(`${name} page ${i}`, { x: 72, y: 700, size: 36, font, color: rgb(0.2, 0.2, 0.6) });
    }
    fs.writeFileSync(F + name, await d.save());
  }
  // A "scan-like" PDF: two huge high-quality JPEG pages + one PNG page.
  const d = await PDFDocument.create();
  for (const j of ['photo1.jpg', 'photo2.jpg']) {
    const img = await d.embedJpg(fs.readFileSync(F + j));
    const p = d.addPage([612, 792]);
    p.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  const png = await d.embedPng(fs.readFileSync(F + 'shot.png'));
  const p = d.addPage([612, 792]);
  p.drawImage(png, { x: 36, y: 200, width: 540, height: 405 });
  p.drawText('Text must survive compression', { x: 72, y: 100, size: 20 });
  fs.writeFileSync(F + 'scan.pdf', await d.save());
  console.log('fixtures ok');
})();
