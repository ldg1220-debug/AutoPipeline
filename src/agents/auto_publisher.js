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
 * YouTube에 숏폼 대본을 description으로 삽입해 예약 업로드 메타데이터를 생성한다.
 * 실제 영상 파일 없이 메타데이터만 등록하는 방식 (영상 파일 생성은 별도 에이전트 담당).
 * publishAt은 현재 시각 + 2시간으로 설정한다.
 */
async function publishToYouTube(content, accessToken) {
  const publishAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const description = [
    content.shortform_script?.hook ?? '',
    '',
    content.shortform_script?.body ?? '',
    '',
    content.shortform_script?.cta ?? '',
  ].join('\n');

  const metadata = {
    snippet: {
      title: content.blog_draft?.title ?? content.keyword,
      description,
      tags: [content.keyword, content.category, '숏폼', '트렌드'],
      categoryId: '22', // People & Blogs
    },
    status: {
      privacyStatus: 'private',
      publishAt,
      selfDeclaredMadeForKids: false,
    },
  };

  const response = await axios.post(
    'https://www.googleapis.com/youtube/v3/videos?part=snippet,status',
    metadata,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
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
 * App Password 방식의 Basic Auth를 사용한다.
 */
async function publishToWordPress(content) {
  const token = Buffer.from(
    `${config.wordpress.user}:${config.wordpress.appPassword}`
  ).toString('base64');

  const sections = content.blog_draft?.sections ?? [];
  const postContent = sections
    .map((s) => `<h2>${s.heading}</h2>\n<p>${s.body}</p>`)
    .join('\n\n');

  const response = await axios.post(
    `${config.wordpress.url}/wp-json/wp/v2/posts`,
    {
      title: content.blog_draft?.title ?? content.keyword,
      content: postContent,
      status: 'draft',
      tags: [],
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
 * APPROVED 콘텐츠를 YouTube와 WordPress에 발행한다.
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
