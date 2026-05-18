import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';

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
  const fs = await import('fs/promises');

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

  const publishAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const description = [
    content.shortform_script?.hook ?? '',
    '',
    content.shortform_script?.body ?? '',
    '',
    content.shortform_script?.cta ?? '',
  ].join('\n');

  const metadata = JSON.stringify({
    snippet: {
      title: content.blog_draft?.title ?? content.keyword,
      description,
      tags: [content.keyword, content.category, '숏폼', '트렌드'],
      categoryId: '22',
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

  return {
    platform: 'youtube',
    video_id: response.data.id,
    publish_at: publishAt,
    url: `https://youtu.be/${response.data.id}`,
  };
}

/**
 * WordPress REST API로 블로그 초안을 draft 상태로 업로드한다.
 * - SEO 메타(Yoast 호환): meta_description, seo_keywords를 커스텀 필드로 삽입
 * - 제휴 훅: section 말미에 [AFFILIATE_LINK: {product_category}] 플레이스홀더 삽입
 *   → 발행 전 실제 링크로 교체 필요 (또는 자동화 가능)
 * App Password 방식의 Basic Auth를 사용한다.
 */
async function publishToWordPress(content) {
  const token = Buffer.from(
    `${config.wordpress.user}:${config.wordpress.appPassword}`
  ).toString('base64');

  const blog = content.blog_draft ?? {};
  const sections = blog.sections ?? [];
  const affiliateHooks = blog.affiliate_hooks ?? [];

  // 제휴 훅을 position 기준으로 매핑
  const affiliateByPosition = Object.fromEntries(
    affiliateHooks.map((h) => [h.position, h])
  );

  // HTML 콘텐츠 조립 (섹션 말미에 제휴 플레이스홀더 삽입)
  const sectionHtml = sections
    .map((s, i) => {
      const hookKey = `section${i + 1}_end`;
      const hook = affiliateByPosition[hookKey];
      const affiliateHtml = hook
        ? `\n<p>👉 <strong>[AFFILIATE_LINK: ${hook.product_category} | 앵커: ${hook.anchor_text}]</strong></p>`
        : '';
      return `<h2>${s.heading}</h2>\n<p>${s.body}</p>${affiliateHtml}`;
    })
    .join('\n\n');

  // SEO 키워드를 태그로 변환 (WordPress 태그 API 미사용, excerpt에 포함)
  const seoKeywords = blog.seo_keywords ?? [];
  const metaDesc = blog.meta_description ?? '';
  const excerptHtml = metaDesc
    ? `${metaDesc}\n\n관련 키워드: ${seoKeywords.join(', ')}`
    : '';

  const response = await axios.post(
    `${config.wordpress.url}/wp-json/wp/v2/posts`,
    {
      title: blog.title ?? content.keyword,
      content: sectionHtml,
      excerpt: excerptHtml,
      status: 'draft',
      // Yoast SEO REST API 필드 (Yoast 플러그인 설치 시 자동 적용)
      meta: {
        _yoast_wpseo_metadesc: metaDesc,
        _yoast_wpseo_focuskw: seoKeywords[0] ?? content.keyword,
      },
    },
    {
      headers: {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return {
    platform: 'wordpress',
    post_id: response.data.id,
    url: response.data.link,
    status: response.data.status,
  };
}

/**
 * TikTok Content Posting API v2로 숏폼 영상을 발행한다.
 * 영상 파일이 없으면 스킵한다.
 *
 * TikTok API 주의사항:
 *   - 2023년 이후 Content Posting API는 TikTok Developer 심사 필요
 *   - access_token은 OAuth 2.0 흐름으로 발급받은 단기 토큰을 사용
 *   - 영상은 PULL_FROM_URL 또는 FILE_UPLOAD 방식 모두 지원
 *     현재 구현은 로컬 파일 → FILE_UPLOAD 방식
 */
async function publishToTikTok(content) {
  const accessToken = config.tiktok.accessToken;
  if (!accessToken) {
    throw new Error('TIKTOK_ACCESS_TOKEN is not configured');
  }

  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const videoPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp4`);

  try {
    await import('fs/promises').then((fs) => fs.access(videoPath));
  } catch {
    logger.warn(`[auto_publisher] TikTok: video file not found, skipping: ${videoPath}`);
    return { platform: 'tiktok', status: 'skipped_no_video_file' };
  }

  // Step 1: 업로드 세션 초기화
  const initRes = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/video/init/',
    {
      post_info: {
        title: content.blog_draft?.title ?? content.keyword,
        privacy_level: 'SELF_ONLY', // 검토 후 PUBLIC_TO_EVERYONE 으로 변경
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: { source: 'FILE_UPLOAD' },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      timeout: 15000,
    }
  );

  const { publish_id, upload_url } = initRes.data.data;

  // Step 2: 영상 파일 업로드
  const { readFile, stat } = await import('fs/promises');
  const videoBuffer = await readFile(videoPath);
  const videoSize = (await stat(videoPath)).size;

  await axios.put(upload_url, videoBuffer, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
      'Content-Length': videoSize,
    },
    timeout: 120000,
  });

  return {
    platform: 'tiktok',
    publish_id,
    status: 'uploaded',
    privacy: 'SELF_ONLY',
  };
}

/**
 * APPROVED 콘텐츠를 YouTube·WordPress·TikTok에 발행한다.
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
        wordpress: { platform: 'wordpress', status: 'dry_run' },
        tiktok: { platform: 'tiktok', status: 'dry_run' },
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

    // WordPress 발행
    try {
      if (!config.wordpress.url || !config.wordpress.user) {
        throw new Error('WordPress credentials not configured');
      }
      result.wordpress = await publishToWordPress(content);
      logger.info(`[auto_publisher] WordPress upload success: ${result.wordpress.url}`);
    } catch (err) {
      logger.error(`[auto_publisher] WordPress upload failed: ${content.keyword}`, {
        message: err.message,
      });
      result.wordpress = { platform: 'wordpress', status: 'failed', error: err.message };
    }

    // TikTok 발행 (영상 파일 존재 시에만)
    try {
      result.tiktok = await publishToTikTok(content);
      if (result.tiktok.status === 'uploaded') {
        logger.info(`[auto_publisher] TikTok upload success: ${content.keyword}`);
      }
    } catch (err) {
      logger.error(`[auto_publisher] TikTok upload failed: ${content.keyword}`, {
        message: err.message,
      });
      result.tiktok = { platform: 'tiktok', status: 'failed', error: err.message };
    }

    results.push(result);
  }

  return {
    published_at: new Date().toISOString(),
    results,
  };
}

// 단독 실행
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
            shortform_script: { hook: '훅', body: '본문', cta: 'CTA' },
            image_prompt: 'placeholder',
            blog_draft: {
              title: `${item.keyword} 정리`,
              sections: [{ heading: '배경', body: '내용' }],
            },
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
