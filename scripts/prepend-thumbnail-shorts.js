/**
 * Shorts 영상 앞에 썸네일 이미지를 1초 인트로로 붙인다.
 * YouTube Shorts는 API로 썸네일 설정이 안 되므로,
 * 영상 첫 프레임으로 썸네일을 넣어 Studio에서 커버 프레임 선택 가능하게 한다.
 *
 * 사용법:
 *   node scripts/prepend-thumbnail-shorts.js <입력영상> <썸네일jpg> <출력영상>
 *
 * 예시:
 *   node scripts/prepend-thumbnail-shorts.js output/media/강남_부동산_shorts.mp4 output/media/강남_부동산_thumb_shorts.jpg output/media/강남_부동산_shorts_new.mp4
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { default as ffmpegStatic } from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';

const [,, inputVideo, thumbPath, outputVideo] = process.argv;

if (!inputVideo || !thumbPath || !outputVideo) {
  console.error('사용법: node scripts/prepend-thumbnail-shorts.js <입력영상> <썸네일jpg> <출력영상>');
  process.exit(1);
}

const absInput  = path.resolve(process.cwd(), inputVideo);
const absThumb  = path.resolve(process.cwd(), thumbPath);
const absOutput = path.resolve(process.cwd(), outputVideo);
const tmpClip   = path.join(os.tmpdir(), `thumb_intro_${Date.now()}.mp4`);
const tmpMerged = path.join(os.tmpdir(), `merged_${Date.now()}.mp4`);

try {
  console.log('1/3 썸네일 1초 클립 생성 중...');
  await execFileAsync(ffmpegPath, [
    '-loop', '1', '-i', absThumb,
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '1',
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
    '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-r', '30',
    '-preset', 'fast', '-shortest', '-y', tmpClip,
  ]);

  console.log('2/3 영상 합치는 중...');
  await execFileAsync(ffmpegPath, [
    '-i', tmpClip,
    '-i', absInput,
    '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-y', tmpMerged,
  ]);

  await fs.unlink(tmpClip);

  console.log('3/3 출력 저장 중...');
  await fs.rename(tmpMerged, absOutput);

  console.log(`\n✅ 완료: ${absOutput}`);
  console.log(`   이제 YouTube Studio 앱에서 영상 수정 → 커버 선택 → 첫 번째 프레임(썸네일) 선택`);

} catch (err) {
  console.error(`❌ 실패: ${err.message}`);
  for (const tmp of [tmpClip, tmpMerged]) {
    await fs.unlink(tmp).catch(() => {});
  }
  process.exit(1);
}
