/**
 * 특정 영상에 썸네일을 수동으로 올린다.
 *
 * 사용법:
 *   node scripts/set-thumbnail.js <videoId> <썸네일파일경로>
 *
 * 예시:
 *   node scripts/set-thumbnail.js abc123XYZ output/media/금리인하_thumb_a.jpg
 *   node scripts/set-thumbnail.js abc123XYZ output/media/금리인하_thumb_shorts.jpg
 *
 * 건강 채널 영상은 --health 플래그 추가:
 *   node scripts/set-thumbnail.js abc123XYZ output/media/혈당관리_thumb_a.jpg --health
 */
import 'dotenv/config';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [,, videoId, thumbPath, flag] = process.argv;
const isHealth = flag === '--health';

if (!videoId || !thumbPath) {
  console.error('사용법: node scripts/set-thumbnail.js <videoId> <썸네일경로> [--health]');
  process.exit(1);
}

const channelCfg = isHealth ? config.youtubeChannels?.health : config.youtube;

if (!channelCfg?.clientId || !channelCfg?.refreshToken) {
  console.error(`[set-thumbnail] ${isHealth ? '건강' : '경제'} 채널 OAuth 설정이 없습니다.`);
  process.exit(1);
}

const absThumbPath = path.resolve(process.cwd(), thumbPath);

try {
  // 액세스 토큰 발급
  const tokenRes = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id:     channelCfg.clientId,
      client_secret: channelCfg.clientSecret,
      refresh_token: channelCfg.refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  const accessToken = tokenRes.data.access_token;

  // 썸네일 파일 읽기
  const imageData = await fs.readFile(absThumbPath);
  const ext = path.extname(absThumbPath).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

  // 업로드
  await axios.post(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
    imageData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': contentType,
        'Content-Length': imageData.length,
      },
      timeout: 60000,
    }
  );

  console.log(`✅ 썸네일 업로드 완료`);
  console.log(`   영상: https://youtu.be/${videoId}`);
  console.log(`   파일: ${absThumbPath}`);
  console.log(`   채널: ${isHealth ? '건강채널' : '경제채널'}`);

} catch (err) {
  const msg = err.response?.data?.error?.message ?? err.message;
  console.error(`❌ 실패: ${msg}`);
  process.exit(1);
}
