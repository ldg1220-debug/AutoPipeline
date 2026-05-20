import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import db from '../db/db.js';
import { generateYouTubeDescription, generateYouTubeTags, generateYouTubeTitle } from '../utils/youtubeSEO.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * refresh_token으로 YouTube access_token을 갱신한다.
 * google-auth-library 없이 axios 직접 호출 방식을 사용한다.
 * 토큰 값은 로그에 절대 출력하지 않는다.
 */
async function refreshYouTubeAccessToken() {
  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      refresh_token: config.youtube.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  return response.data.access_token;
}

/**
 * YouTube에 숏폼 영상을 예약 업로드한다.
 * YouTube Data API는 실제 영상 바이너리가 없으면 업로드 자체가 불가능하다.
 * 영상 파일 경로를 받아 multipart 업로드하며, 파일이 없으면 스킵한다.
 * publishAt은 현재 시각 + 2시간으로 설정한다.
 */
async function publishToYouTube(content, accessToken) {
  // 영상 파일 경로 규칙: output/media/<keyword>.mp4
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const videoPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    `../../output/media/${safeKeyword}.mp4`
  );

  try {
    await fs.access(videoPath);
  } catch {
    // 영상 파일이 없으면 이 단계에서는 스킵 (영상 생성은 별도 Phase에서 추가)
    logger.warn(`[auto_publisher] Video file not found, skipping YouTube upload: ${videoPath}`);
    return { platform: 'youtube', status: 'skipped_no_video_file' };
  }

  const publishAt  = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const seriesName = content.series_name ?? '매일읽어주는남자';

  // 블로그 포스트 URL (발행 결과가 있으면 설명란에 삽입)
  const blogPostUrl = content.blog_publish?.url ?? content.blog_post_url ?? null;

  // SEO 최적화: 설명·태그·제목 (GPT-4o-mini, 실패 시 폴백)
  const [description, tags, optimizedTitle] = await Promise.all([
    generateYouTubeDescription(content, blogPostUrl),
    generateYouTubeTags(
      content.keyword,
      content.category,
      content.blog_draft?.seo_keywords ?? []
    ),
    generateYouTubeTitle(
      content.keyword,
      content.shortform_script?.hook,
      content.youtube_title
    ),
  ]);

  logger.info(`[auto_publisher] SEO — title: "${optimizedTitle}" | tags: ${tags.length}개 | desc: ${description.length}자`);

  const metadata = JSON.stringify({
    snippet: {
      title: optimizedTitle,
      description,
      tags,
      categoryId: '22',
      defaultLanguage: 'ko',
    },
    status: {
      privacyStatus: 'private',
      publishAt,
      selfDeclaredMadeForKids: false,
    },
  });

  const videoBuffer = await fs.readFile(videoPath);
  const boundary = 'frontier_boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
    ),
    videoBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const response = await axios.post(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 120000,
    }
  );

  const videoId = response.data.id;

  // 썸네일 A 업로드 (Variant A = 초기 버전)
  const mediaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output/media');
  const thumbPathA = path.resolve(mediaDir, `${safeKeyword}_thumb_a.jpg`);
  const thumbPathB = path.resolve(mediaDir, `${safeKeyword}_thumb_b.jpg`);

  let thumbnailUploaded = false;
  try {
    thumbnailUploaded = await uploadYouTubeThumbnail(videoId, thumbPathA, accessToken);
  } catch (err) {
    logger.warn(`[auto_publisher] Thumbnail upload failed: ${err.message}`);
  }

  // A/B 테스트 레코드 저장 (Variant B가 있을 때만)
  if (thumbnailUploaded) {
    try {
      const bExists = await fs.access(thumbPathB).then(() => true).catch(() => false);
      db.prepare(`
        INSERT INTO thumbnail_ab_tests (keyword, video_id, thumb_a_path, thumb_b_path)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_id) DO NOTHING
      `).run(content.keyword, videoId, thumbPathA, bExists ? thumbPathB : null);
      logger.info(`[auto_publisher] A/B test registered: ${videoId} (B variant: ${bExists ? 'ready' : 'not generated'})`);
    } catch (err) {
      logger.warn(`[auto_publisher] A/B test record failed: ${err.message}`);
    }
  }

  return {
    platform: 'youtube',
    video_id: videoId,
    publish_at: publishAt,
    url: `https://youtu.be/${videoId}`,
    thumbnail_uploaded: thumbnailUploaded,
  };
}

/**
 * 업로드된 YouTube 영상에 썸네일을 설정한다.
 * thumbnails.set API는 multipart/form-data로 이미지를 전송한다.
 * swap-thumbnails.js 스크립트에서도 재사용하기 위해 export.
 */
export async function uploadYouTubeThumbnail(videoId, thumbnailPath, accessToken) {
  let imageData;
  try {
    imageData = await fs.readFile(thumbnailPath);
  } catch {
    logger.warn(`[auto_publisher] Thumbnail file not found, skipping: ${thumbnailPath}`);
    return false;
  }

  await axios.post(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
    imageData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'image/jpeg',
        'Content-Length': imageData.length,
      },
      timeout: 60000,
    }
  );
  logger.info(`[auto_publisher] Thumbnail uploaded for video: ${videoId}`);
  return true;
}

/**
 * APPROVED 콘텐츠를 YouTube에 발행한다.
 * DRY_RUN=true이면 실제 업로드 없이 로그만 출력한다.
 */
export async function publishContents(qaData, contentData) {
  const approvedReports = (qaData?.reports ?? []).filter(
    (r) => r.final_decision === 'APPROVED'
  );

  if (approvedReports.length === 0) {
    logger.warn('[auto_publisher] No APPROVED items to publish.');
    return { published_at: new Date().toISOString(), results: [] };
  }

  // keyword 기준으로 콘텐츠 빠른 조회
  const contentMap = Object.fromEntries(
    (contentData?.contents ?? []).map((c) => [c.keyword, c])
  );

  const results = [];

  for (const report of approvedReports) {
    const content = contentMap[report.keyword];
    if (!content) {
      logger.warn(`[auto_publisher] Content not found for approved keyword: ${report.keyword}`);
      continue;
    }

    logger.info(`[auto_publisher] Publishing: ${content.keyword}`);

    if (config.runtime.dryRun) {
      logger.info(`[auto_publisher] DRY RUN — skipping actual upload for: ${content.keyword}`);
      results.push({
        keyword: content.keyword,
        dry_run: true,
        youtube: { platform: 'youtube', status: 'dry_run' },
      });
      continue;
    }

    const result = { keyword: content.keyword, dry_run: false };

    // YouTube 발행
    try {
      if (!config.youtube.clientId || !config.youtube.refreshToken) {
        throw new Error('YouTube credentials not configured');
      }
      const accessToken = await refreshYouTubeAccessToken();
      result.youtube = await publishToYouTube(content, accessToken);
      logger.info(`[auto_publisher] YouTube upload success: ${result.youtube.url}`);
    } catch (err) {
      logger.error(`[auto_publisher] YouTube upload failed: ${content.keyword}`, {
        message: err.message,
      });
      result.youtube = { platform: 'youtube', status: 'failed', error: err.message };
    }

    results.push(result);
  }

  return {
    published_at: new Date().toISOString(),
    results,
  };
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

      let qaData, contentData;

      try {
        qaData = await readJSON(
          path.resolve(__dirname, `../../output/qa_reports/qa_${date}.json`)
        );
      } catch {
        logger.warn('[auto_publisher] No QA report found. Using mock APPROVED data.');
        const mockTrend = await readJSON(
          path.resolve(__dirname, '../../mock/mock_trend.json')
        );
        qaData = {
          evaluated_at: new Date().toISOString(),
          reports: mockTrend.selected_items.map((item, i) => ({
            content_id: `${item.keyword}_${i}`,
            keyword: item.keyword,
            category: item.category,
            fact_check_score: 85,
            grammar_check: 'PASS',
            banned_words_detected: false,
            video_layout_check: 'PASS',
            audio_sync_check: 'PASS',
            final_decision: 'APPROVED',
            revision_reason: '',
          })),
        };
      }

      try {
        contentData = await readJSON(
          path.resolve(__dirname, `../../output/scripts/content_${date}.json`)
        );
      } catch {
        logger.warn('[auto_publisher] No content file found. Using mock content data.');
        const mockTrend = await readJSON(
          path.resolve(__dirname, '../../mock/mock_trend.json')
        );
        contentData = {
          generated_at: new Date().toISOString(),
          contents: mockTrend.selected_items.map((item) => ({
            keyword: item.keyword,
            category: item.category,
            series_name: item.series ?? '오늘의 이슈',
            shortform_script: {
              hook: `${item.keyword}?`,
              context: `${item.keyword} 관련 현황과 나에게 미치는 영향`,
              insight: `${item.keyword} 핵심 인사이트. 배경-현황-행동 순서로 설명.`,
              summary: `한 줄 정리: ${item.keyword} 핵심 포인트`,
              cta: '매일읽어주는남자 구독하면 매일 아침 이런 소식 먼저 받아봐요',
            },
            youtube_title: `${item.keyword} 지금 어떻게 해야 하나?`,
            youtube_description: `${item.keyword}에 대해 알아봅니다. #매일읽어주는남자 #재테크 #${item.keyword.replace(/\s/g, '')}`,
            image_prompt: 'placeholder',
            blog_draft: { title: `${item.keyword} 정리`, sections: [], affiliate_hooks: [] },
          })),
        };
      }

      const result = await publishContents(qaData, contentData);

      const outPath = path.resolve(__dirname, `../../output/qa_reports/publish_${date}.json`);
      await writeJSON(outPath, result);

      logger.info(`[auto_publisher] Saved to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error('[auto_publisher] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
