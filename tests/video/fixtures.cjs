// Makes the test videos for tests/video/test.cjs with the local ffmpeg CLI.
// Usage: node tests/video/fixtures.cjs <outDir>   (skips files that already exist)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = function makeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ff = (name, args) => {
    const out = path.join(dir, name);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
    execSync(`ffmpeg -v error -y ${args} "${out}"`, { stdio: 'inherit' });
    return out;
  };
  const tone = (sec, rate = 48000) => `-f lavfi -i "sine=frequency=1000:sample_rate=${rate}:duration=${sec}"`;
  const pattern = (size, sec, rate = 30) => `-f lavfi -i "testsrc2=size=${size}:rate=${rate}:duration=${sec}"`;
  // Tag the picture as BT.709 like phones and cameras do. Untagged HD video is
  // ambiguous: ffmpeg assumes BT.601, Chrome assumes BT.709, and the colors differ.
  const c709 = '-vf "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p" -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv';
  const x264 = `${c709} -c:v libx264 -preset veryfast`;
  const F = {};
  // 6 s 1280x720 30 fps H.264 + 1 kHz AAC (mono, 48 kHz)
  F.sine = ff('sine.mp4', `${pattern('1280x720', 6)} ${tone(6)} ${x264} -c:a aac -b:a 128k -shortest -movflags +faststart`);
  // Same picture, no sound at all
  F.noaudio = ff('noaudio.mp4', `${pattern('1280x720', 6)} ${x264}`);
  // WebM VP9 + Opus
  F.webm = ff('clip.webm', `${pattern('640x360', 4)} ${tone(4)} ${c709} -c:v libvpx-vp9 -b:v 1M -deadline realtime -cpu-used 8 -c:a libopus -b:a 96k -shortest`);
  // WebM with no sound
  F.webmSilent = ff('silent.webm', `${pattern('640x360', 3)} ${c709} -c:v libvpx-vp9 -b:v 1M -deadline realtime -cpu-used 8`);
  // iPhone-style portrait: HEVC (hvc1) in a QuickTime MOV, stored landscape with a 90 degree rotation flag,
  // stereo AAC at 44.1 kHz with the moov box at the end like the iPhone writes it.
  const hevcTmp = ff('_hevc_tmp.mov', `${pattern('1280x720', 5)} ${tone(5, 44100)} ${c709} -c:v libx265 -tag:v hvc1 -preset fast -x265-params log-level=error -c:a aac -ac 2 -shortest -f mov`);
  F.iphone = ff('iphone-portrait.mov', `-display_rotation 90 -i "${hevcTmp}" -c copy -f mov`);
  // Same idea with H.264 (plays everywhere)
  F.portrait = ff('portrait.mov', `-display_rotation 90 -i "${F.sine}" -c copy -f mov`);
  // 70 s small stereo video for the length warnings, the cap, Stop, and a longer MP3
  F.long = ff('long.mp4', `${pattern('320x180', 70)} -f lavfi -i "sine=frequency=1000:sample_rate=44100:duration=70" -ac 2 ${x264} -c:a aac -b:a 128k -shortest`);
  // Not videos
  F.png = path.join(dir, 'picture.png');
  if (!fs.existsSync(F.png)) execSync(`ffmpeg -v error -y -f lavfi -i "testsrc2=size=64x64" -frames:v 1 "${F.png}"`);
  F.txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(F.txt, 'this is not a video\n');
  F.empty = path.join(dir, 'empty.mp4');
  fs.writeFileSync(F.empty, '');
  F.fakeMp4 = path.join(dir, 'broken.mp4');
  fs.writeFileSync(F.fakeMp4, Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(4000, 7)]));
  return F;
};

if (require.main === module) console.log(module.exports(process.argv[2] || path.join(__dirname, '../../_work/video/fixtures')));
