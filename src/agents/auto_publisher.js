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
 * 카테고리에 맞는 YouTube 채널 설정을 반환한다.
 * 카테고리별 전용 채널 credentials가 설정된 경우 그것을, 없으면 기본 채널을 사용한다.
 */
function getYouTubeChannelConfig(category) {
  const channelOverride = config.youtubeChannels?.[category];
  if (channelOverride?.refreshToken) return channelOverride;
  return config.youtube;
}

/**
 * refresh_token으로 YouTube access_token을 갱신한다.
 * google-auth-library 없이 axios 직접 호출 방식을 사용한다.
 * 토큰 값은 로그에 절대 출력하지 않는다.
 */
async function refreshYouTubeAccessToken(channelConfig = config.youtube) {
  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id:     channelConfig.clientId,
      client_secret: channelConfig.clientSecret,
      refresh_token: channelConfig.refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  return response.data.access_token;
}

/**
 * 공개 시간 계산 — 다음 날 7:15 AM KST (업로드 후 최소 12시간 후 보장)
 * KST = UTC+9 → 7:15 KST = 22:15 UTC (전날)
 */
function getOptimalPublishTime() {
  const KST_TARGET_HOUR = 7;
  const KST_TARGET_MIN  = 15;
  const UTC_HOUR = ((KST_TARGET_HOUR - 9) + 24) % 24; // 22

  const now    = new Date();
  const target = new Date(now);
  target.setUTCHours(UTC_HOUR, KST_TARGET_MIN, 0, 0);

  // 12시간 이상 남지 않았으면 하루 추가 (항상 "다음 날 7:15" 보장)
  while (target.getTime() - now.getTime() < 12 * 60 * 60 * 1000) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString();
}

/**
 * 단일 mp4 파일을 YouTube에 multipart 업로드하는 내부 헬퍼.
 * @param {string} videoPath  업로드할 mp4 파일 경로
 * @param {object} metadata   JSON.stringify 전 snippet+status 객체
 * @param {string} accessToken
 * @returns {string} videoId
 */
async function uploadVideoFile(videoPath, metadata, accessToken) {
  const videoBuffer = await fs.readFile(videoPath);
  const boundary    = 'frontier_boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
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
  return response.data.id;
}

/**
 * YouTube에 쇼츠(숏폼) 영상을 업로드한다.
 * 파일 규칙: output/media/<keyword>.mp4 (9:16 세로 포맷, ≤60초)
 * #Shorts 해시태그를 제목·설명에 추가해 YouTube가 쇼츠로 인식하도록 한다.
 * 쇼츠는 예약 발행 대신 즉시 공개 처리한다.
 */
async function publishShortsToYouTube(content, accessToken, longFormUrl = null) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const mediaDir    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output/media');

  // 롱폼에서 추출된 숏폼 우선 사용, 없으면 별도 생성된 숏폼 사용
  const extractedPath = path.resolve(mediaDir, `${safeKeyword}_shorts.mp4`);
  const standalonePath = path.resolve(mediaDir, `${safeKeyword}.mp4`);
  const hasExtracted = await fs.access(extractedPath).then(() => true).catch(() => false);
  const videoPath = hasExtracted ? extractedPath : standalonePath;

  try { await fs.access(videoPath); } catch {
    logger.warn(`[auto_publisher] Shorts file not found, skipping: ${videoPath}`);
    return { platform: 'youtube_shorts', status: 'skipped_no_video_file' };
  }
  logger.info(`[auto_publisher] Shorts source: ${hasExtracted ? '롱폼 추출' : '단독 생성'} → ${videoPath}`);

  const blogPostUrl = content.blog_publish?.url ?? content.blog_post_url ?? null;

  const [description, tags, baseTitle] = await Promise.all([
    generateYouTubeDescription(content, blogPostUrl),
    generateYouTubeTags(content.keyword, content.category, content.blog_draft?.seo_keywords ?? []),
    generateYouTubeTitle(content.keyword, content.shortform_script?.hook, content.youtube_title),
  ]);

  // #Shorts 태그 필수 — 없으면 YouTube가 Shorts 피드에 노출하지 않음
  const shortsTitle = baseTitle.includes('#Shorts') ? baseTitle : `${baseTitle} #Shorts`;
  // 롱폼 URL이 있으면 설명에 추가
  const longFormLine = longFormUrl ? `\n\n▶ 풀버전 영상: ${longFormUrl}` : '';
  const shortsDesc  = description.includes('#Shorts')
    ? `${description}${longFormLine}`
    : `${description}${longFormLine}\n\n#Shorts`;
  const shortsTags  = tags.includes('Shorts') ? tags : [...tags, 'Shorts', '쇼츠'];

  logger.info(`[auto_publisher] Shorts SEO — title: "${shortsTitle}" | tags: ${shortsTags.length}개`);

  const shortsPublishAt = getOptimalPublishTime(); // 다음 날 7:23 AM KST
  const metadata = {
    snippet: {
      title: shortsTitle,
      description: shortsDesc,
      tags: shortsTags,
      categoryId: '22',
      defaultLanguage: 'ko',
    },
    status: {
      privacyStatus: 'private',
      publishAt: shortsPublishAt,
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true, // AI 생성 콘텐츠 정직 표기
    },
  };

  const videoId = await uploadVideoFile(videoPath, metadata, accessToken);
  logger.info(`[auto_publisher] Shorts uploaded: https://youtube.com/shorts/${videoId}`);

  // 쇼츠 썸네일: 세로(9:16) 우선, 없으면 가로 폴백 — 5초 대기 후 최대 3회 재시도
  const thumbShortsPath = path.resolve(mediaDir, `${safeKeyword}_thumb_shorts.jpg`);
  const thumbFallback   = path.resolve(mediaDir, `${safeKeyword}_thumb.jpg`);
  const shortsThumbExists = await fs.access(thumbShortsPath).then(() => true).catch(() => false);
  const thumbPath = shortsThumbExists ? thumbShortsPath : thumbFallback;
  const thumbPathExists   = await fs.access(thumbPath).then(() => true).catch(() => false);

  let thumbnailUploaded = false;
  if (!thumbPathExists) {
    logger.warn(`[auto_publisher] 쇼츠 썸네일 파일 없음: ${thumbPath}`);
  } else {
    await new Promise((r) => setTimeout(r, 5000));
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        thumbnailUploaded = await uploadYouTubeThumbnail(videoId, thumbPath, accessToken);
        if (thumbnailUploaded) {
          logger.info(`[auto_publisher] 쇼츠 썸네일 업로드 성공 (시도 ${attempt}): ${thumbPath}`);
          break;
        }
      } catch (err) {
        logger.warn(`[auto_publisher] 쇼츠 썸네일 실패 (시도 ${attempt}/3): ${err.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 4000));
      }
    }
    if (!thumbnailUploaded) logger.error(`[auto_publisher] 쇼츠 썸네일 3회 모두 실패: ${videoId}`);
  }

  return {
    platform:           'youtube_shorts',
    video_id:           videoId,
    url:                `https://youtube.com/shorts/${videoId}`,
    thumbnail_uploaded: thumbnailUploaded,
  };
}

/**
 * YouTube에 롱폼 영상을 예약 업로드한다.
 * 파일 규칙: output/media/<keyword>_long.mp4
 * publishAt은 현재 시각 + 2시간으로 설정한다.
 */
async function publishToYouTube(content, accessToken) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const mediaDir    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output/media');
  // long-form 파일 우선, 없으면 기존 <keyword>.mp4 (하위 호환)
  const longPath    = path.resolve(mediaDir, `${safeKeyword}_long.mp4`);
  const legacyPath  = path.resolve(mediaDir, `${safeKeyword}.mp4`);

  const longExists   = await fs.access(longPath).then(() => true).catch(() => false);
  const legacyExists = await fs.access(legacyPath).then(() => true).catch(() => false);
  if (!longExists && !legacyExists) {
    logger.warn(`[auto_publisher] Long-form video not found, skipping: ${longPath}`);
    return { platform: 'youtube', status: 'skipped_no_video_file' };
  }
  const videoPath = longExists ? longPath : legacyPath;

  const publishAt    = getOptimalPublishTime(); // 다음 날 7:15 AM KST
  const channelCfg   = getYouTubeChannelConfig(content.category);
  const seriesName   = content.series_name ?? channelCfg.seriesName ?? '매일읽어주는남자';

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

  const metadata = {
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
      containsSyntheticMedia: true, // AI 생성 콘텐츠 정직 표기 (페널티 없음)
    },
  };

  logger.info(`[auto_publisher] Scheduled publish at: ${publishAt} (KST 7:15 AM)`);
  const videoId = await uploadVideoFile(videoPath, metadata, accessToken);
  logger.info(`[auto_publisher] Long-form uploaded: https://youtu.be/${videoId}`);

  // 카테고리 재생목록에 영상 추가
  try {
    await addVideoToPlaylist(videoId, content.category, accessToken);
  } catch (err) {
    logger.warn(`[auto_publisher] Playlist insert failed: ${err.message}`);
  }

  // 자막(SRT) 업로드
  const srtPath  = path.resolve(mediaDir, `${safeKeyword}_long.srt`);
  let captionsUploaded = false;
  try {
    captionsUploaded = await uploadYouTubeCaptions(videoId, srtPath, accessToken);
  } catch (err) {
    logger.warn(`[auto_publisher] Captions upload failed: ${err.message}`);
  }

  // 썸네일 A 업로드 — 5초 대기 후 최대 3회 재시도 (YouTube 처리 시간 확보)
  const thumbPath = path.resolve(mediaDir, `${safeKeyword}_thumb.jpg`);

  let thumbnailUploaded = false;
  const thumbExists = await fs.access(thumbPath).then(() => true).catch(() => false);
  if (!thumbExists) {
    logger.warn(`[auto_publisher] 썸네일 파일 없음: ${thumbPath}`);
  } else {
    await new Promise((r) => setTimeout(r, 5000)); // YouTube 업로드 처리 대기
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        thumbnailUploaded = await uploadYouTubeThumbnail(videoId, thumbPath, accessToken);
        if (thumbnailUploaded) {
          logger.info(`[auto_publisher] 썸네일 업로드 성공 (시도 ${attempt}): ${thumbPath}`);
          break;
        }
      } catch (err) {
        logger.warn(`[auto_publisher] 썸네일 업로드 실패 (시도 ${attempt}/3): ${err.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 4000));
      }
    }
    if (!thumbnailUploaded) logger.error(`[auto_publisher] 썸네일 3회 모두 실패: ${videoId}`);
  }

  return {
    platform: 'youtube',
    video_id: videoId,
    publish_at: publishAt,
    url: `https://youtu.be/${videoId}`,
    thumbnail_uploaded: thumbnailUploaded,
    captions_uploaded:  captionsUploaded,
  };
}

/**
 * 업로드된 영상을 카테고리 재생목록에 추가한다.
 * .env의 YOUTUBE_PLAYLIST_* 값이 없으면 건너뜀.
 */
async function addVideoToPlaylist(videoId, category, accessToken) {
  const playlistId = config.youtube?.playlists?.[category];
  if (!playlistId) {
    logger.info(`[auto_publisher] No playlist configured for category "${category}", skipping.`);
    return false;
  }

  await axios.post(
    'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet',
    {
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  logger.info(`[auto_publisher] Added video ${videoId} to playlist ${playlistId} (category: ${category})`);
  return true;
}

/**
 * YouTube 자막(SRT) 업로드.
 * captions.insert API: multipart/related (JSON snippet + SRT 텍스트)
 */
async function uploadYouTubeCaptions(videoId, srtPath, accessToken) {
  let srtContent;
  try {
    srtContent = await fs.readFile(srtPath, 'utf8');
  } catch {
    logger.warn(`[auto_publisher] SRT file not found, skipping: ${srtPath}`);
    return false;
  }
  if (!srtContent.trim()) return false;

  const snippet = JSON.stringify({
    snippet: {
      videoId,
      language: 'ko',
      name: '한국어',
      isDraft: false,
    },
  });

  const boundary = 'caption_boundary_ap';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    snippet,
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    srtContent,
    `--${boundary}--`,
  ].join('\r\n');

  await axios.post(
    `https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet`,
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      timeout: 30000,
    }
  );
  logger.info(`[auto_publisher] Captions uploaded for video: ${videoId}`);
  return true;
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

    // YouTube 채널 인증 (롱폼 + 쇼츠 공통)
    let accessToken = null;
    try {
      const channelCfg = getYouTubeChannelConfig(content.category);
      if (!channelCfg.clientId || !channelCfg.refreshToken) {
        throw new Error('YouTube credentials not configured');
      }
      accessToken = await refreshYouTubeAccessToken(channelCfg);
      logger.info(`[auto_publisher] Using ${content.category === 'health' && config.youtubeChannels?.health?.refreshToken ? 'health' : 'default'} channel for: ${content.keyword}`);
    } catch (err) {
      logger.error(`[auto_publisher] YouTube auth failed: ${content.keyword}`, { message: err.message });
      result.youtube       = { platform: 'youtube',        status: 'failed', error: err.message };
      result.youtube_shorts = { platform: 'youtube_shorts', status: 'failed', error: err.message };
      results.push(result);
      continue;
    }

    // 롱폼 업로드
    try {
      result.youtube = await publishToYouTube(content, accessToken);
      logger.info(`[auto_publisher] Long-form upload: ${result.youtube.url ?? result.youtube.status}`);
    } catch (err) {
      logger.error(`[auto_publisher] Long-form upload failed: ${content.keyword}`, { message: err.message });
      result.youtube = { platform: 'youtube', status: 'failed', error: err.message };
    }

    // 쇼츠 업로드 — 롱폼 URL을 설명에 포함
    try {
      const longFormUrl = result.youtube?.url ?? null;
      result.youtube_shorts = await publishShortsToYouTube(content, accessToken, longFormUrl);
      logger.info(`[auto_publisher] Shorts upload: ${result.youtube_shorts.url ?? result.youtube_shorts.status}`);
    } catch (err) {
      logger.error(`[auto_publisher] Shorts upload failed: ${content.keyword}`, { message: err.message });
      result.youtube_shorts = { platform: 'youtube_shorts', status: 'failed', error: err.message };
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
