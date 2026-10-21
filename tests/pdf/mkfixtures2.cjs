// Fixtures for the new pdf.lol tools: a 6-page numbered PDF, a rotated-page PDF,
// a cropbox-offset PDF, and test images.
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb, degrees } = require('/tmp/loltest/node_modules/pdf-lib');
const F = process.argv[2] || '/tmp/loltest/fixtures/';
(async () => {
  // six.pdf: 6 pages, each with a big page number and a colored band
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.HelveticaBold);
  const colors = [[0.9, 0.2, 0.2], [0.2, 0.7, 0.3], [0.2, 0.4, 0.9], [0.9, 0.7, 0.1], [0.6, 0.2, 0.8], [0.1, 0.7, 0.8]];
  for (let i = 1; i <= 6; i++) {
    const p = d.addPage([612, 792]);
    p.drawRectangle({ x: 0, y: 692, width: 612, height: 100, color: rgb(...colors[i - 1]) });
    p.drawText(`PAGE ${i}`, { x: 200, y: 380, size: 64, font, color: rgb(0, 0, 0) });
  }
  fs.writeFileSync(F + 'six.pdf', await d.save());

  // rot.pdf: page 1 normal, page 2 rotated 90, page 3 rotated 270, page 4 cropbox offset
  const r = await PDFDocument.create();
  const f2 = await r.embedFont(StandardFonts.Helvetica);
  const p1 = r.addPage([612, 792]); p1.drawText('normal page', { x: 72, y: 700, size: 24, font: f2 });
  const p2 = r.addPage([612, 792]); p2.setRotation(degrees(90)); p2.drawText('rotated 90', { x: 72, y: 700, size: 24, font: f2 });
  const p3 = r.addPage([612, 792]); p3.setRotation(degrees(270)); p3.drawText('rotated 270', { x: 72, y: 700, size: 24, font: f2 });
  const p4 = r.addPage([800, 1000]); p4.setCropBox(100, 100, 612, 792); p4.drawText('cropbox offset', { x: 172, y: 800, size: 24, font: f2 });
  fs.writeFileSync(F + 'rot.pdf', await r.save());
  console.log('ok');
})();
