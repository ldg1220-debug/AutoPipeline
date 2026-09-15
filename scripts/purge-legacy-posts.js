#!/usr/bin/env node
/**
 * purge-legacy-posts.js — 여행 채널 전환 이전(경제·부동산·뷰티 등) 발행 글을 정리한다.
 *
 * ⚠️ 삭제는 되돌릴 수 없다. 안전장치를 절대 빼지 말 것 (작업지시서 2026-09-14 §4).
 *
 * 배경:
 *   Search Console 실측(2026-09-14) — maeilg.com 색인 미생성 216개 > 색인 생성 170개,
 *   3개월 누적 클릭 14회. 여행 채널로 전환한 지 오래인데 옛 경제 글 194편이 여전히
 *   도메인 평가(색인 품질)를 갉아먹고 있어, 새로 쓰는 여행 글도 그 평가를 같이 받는다.
 *   경제 채널로 돌아갈 계획이 없고 보존 가치가 없다고 판단해 삭제를 권장받음.
 *
 * 대상 판별:
 *   blog_posts.keyword_id → keywords.category로 조인. keyword_id가 없거나(옛 발행분이라
 *   FK가 비어있는 경우) 조인 실패 시, keyword_miner.classifyCategory()로 키워드 텍스트
 *   기반 재분류해 폴백한다(둘 다 없으면 판단 불가로 목록에서 제외 — 삭제 여부를 추측하지
 *   않음). category !== 'travel'이면 삭제 후보.
 *
 * 사용법:
 *   node scripts/purge-legacy-posts.js --dry                  # 기본값. 목록만 출력, 삭제 없음
 *   node scripts/purge-legacy-posts.js --dry --limit 20
 *   node scripts/purge-legacy-posts.js --apply --post 89      # 특정 글 1건만 실제 삭제
 *   node scripts/purge-legacy-posts.js --apply --limit 5      # 소량 먼저 (권장)
 *   node scripts/purge-legacy-posts.js --apply                # 전체
 *
 * --apply 없이는 절대 삭제되지 않는다. --dry 목록을 사람이 직접 확인하기 전에는
 * --apply를 실행하지 말 것.
 *
 * 재개 가능: output/backup/purge-legacy/done.json에 처리 완료한 postId를 누적,
 * 재실행 시 이미 처리한 글은 건너뛴다. 삭제 전 원본 HTML을 같은 디렉터리에 백업한다.
 *
 * 주의(미검증): 삭제 플로우(§ deletePost)는 strip-coupang-links.js처럼 실제 DOM 덤프로
 * 검증되지 않았다 — Tistory 관리자 페이지 구조가 바뀌었거나 추정 셀렉터가 안 맞으면
 * "삭제 확인 안 됨"으로 표시되고 done.json에도 기록하지 않는다(다음 실행에서 재시도).
 * --apply --post <id> 로 반드시 1건 먼저 돌려 실제로 지워졌는지 눈으로 확인할 것.
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { createTistoryContext, isLoggedIn } from '../src/utils/playwright_session.js';
import { classifyCategory } from '../src/agents/keyword_miner.js';
import db from '../src/db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args      = process.argv.slice(2);
const isApply   = args.includes('--apply');
const isDry     = !isApply; // --apply가 없으면 무조건 dry-run
const limitArg  = args.indexOf('--limit');
const limit     = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : Infinity;
const postArg   = args.indexOf('--post');
const onlyPostId = postArg !== -1 ? args[postArg + 1] : null;
const isHeaded  = args.includes('--headed');

const BACKUP_DIR = path.resolve(__dirname, '../output/backup/purge-legacy');
const DONE_PATH  = path.join(BACKUP_DIR, 'done.json');
const REQUEST_DELAY_MS = 1000;
const KEEP_CATEGORY = 'travel'; // 이 카테고리는 대상에서 제외

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launchBrowser(headless = true) {
  const channels = ['msedge', 'chrome'];
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless, channel });
    } catch { /* 다음 채널 시도 */ }
  }
  return chromium.launch({ headless });
}

async function loadDone() {
  try {
    const raw = await fs.readFile(DONE_PATH, 'utf8');
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function saveDone(doneSet) {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  await fs.writeFile(DONE_PATH, JSON.stringify([...doneSet], null, 2), 'utf8');
}

/**
 * 삭제 후보 목록을 만든다. category가 판단 불가(키워드도 없고 분류도 안 됨)인 항목은
 * "삭제할지 말지 추측하지 않는다"는 원칙에 따라 후보에서 제외한다.
 */
function findLegacyCandidates() {
  const rows = db.prepare(
    `SELECT b.id, b.keyword, b.post_url, b.published_at, k.category AS kw_category
     FROM blog_posts b
     LEFT JOIN keywords k ON k.id = b.keyword_id
     WHERE b.status = 'published' AND b.post_url IS NOT NULL
     ORDER BY b.published_at ASC`
  ).all();

  const candidates = [];
  const unknown = [];
  for (const row of rows) {
    let category = row.kw_category;
    let source = 'keywords 테이블';
    if (!category) {
      category = classifyCategory(row.keyword ?? '');
      source = 'keyword 텍스트 재분류';
    }
    if (!category) {
      unknown.push(row);
      continue;
    }
    if (category !== KEEP_CATEGORY) {
      candidates.push({ ...row, category, categorySource: source });
    }
  }
  return { candidates, unknown };
}

async function deletePost(page, blogName, postId) {
  // 미검증 플로우 — Tistory 글 관리 페이지의 "관리" 드롭다운 → "삭제" 버튼을 추정 셀렉터로
  // 여러 개 시도한다. strip-coupang-links.js와 같은 관리 URL 패턴을 쓴다.
  const editUrl = `https://${blogName}.tistory.com/manage/post/${postId}/`;
  await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#post-title-inp, input[name="title"]', { timeout: 20000 });

  let menuOpened = false;
  for (const sel of ['button:has-text("관리")', '[aria-label="더보기"]', 'button:has-text("설정")']) {
    try {
      const el = await page.$(sel);
      if (!el || !(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 3000 });
      menuOpened = true;
      break;
    } catch { /* 다음 시도 */ }
  }
  if (menuOpened) await page.waitForTimeout(800);

  let clicked = false;
  for (const sel of ['button:has-text("삭제")', 'a:has-text("삭제")', '[role="menuitem"]:has-text("삭제")']) {
    try {
      const el = await page.$(sel);
      if (!el || !(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 3000 });
      clicked = true;
      break;
    } catch { /* 다음 시도 */ }
  }
  if (!clicked) return { deleted: false, reason: '삭제 버튼을 찾지 못함' };

  await page.waitForTimeout(500);
  // 확인 다이얼로그
  for (const sel of ['button:has-text("확인")', 'button:has-text("삭제")', 'button:has-text("예")']) {
    try {
      const el = await page.$(sel);
      if (!el || !(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 3000 });
      break;
    } catch { /* 다음 시도 */ }
  }
  await page.waitForTimeout(2000);

  // 실제로 지워졌는지 검증 — 같은 편집 URL이 더 이상 정상적으로 열리지 않아야 한다.
  try {
    await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const stillExists = await page.$('#post-title-inp, input[name="title"]');
    if (stillExists) return { deleted: false, reason: '삭제 후에도 편집 페이지가 여전히 열림 — 확인 필요' };
  } catch {
    // goto 자체가 실패하면(페이지 없음 등) 삭제된 것으로 간주
  }
  return { deleted: true };
}

async function main() {
  console.log(
    `\n옛 경제 글 정리 — 모드: ${isDry ? 'DRY-RUN (목록만 출력, 삭제 없음)' : '⚠️  APPLY (실제 삭제)'}` +
    `${limit !== Infinity ? ` / 최대 ${limit}건` : ''}${onlyPostId ? ` / post=${onlyPostId}` : ''}\n`
  );

  const blogName = config.tistory?.blogName;
  if (!blogName) {
    console.error('❌ TISTORY_BLOG_NAME 미설정');
    process.exit(1);
  }

  const { candidates, unknown } = findLegacyCandidates();

  console.log(`대상 후보: ${candidates.length}건 (category='${KEEP_CATEGORY}' 제외)`);
  if (unknown.length > 0) {
    console.log(`판단 불가(카테고리 확인 안 됨, 목록 제외): ${unknown.length}건`);
  }

  let targets = candidates;
  if (onlyPostId) {
    targets = targets.filter((p) => p.post_url?.match(/\/(\d+)\/?$/)?.[1] === String(onlyPostId));
    if (targets.length === 0) {
      console.error(`❌ post_url에 ID ${onlyPostId}를 가진 대상을 찾지 못함`);
      process.exit(1);
    }
  }

  const done = isDry ? new Set() : await loadDone();
  if (!isDry && done.size > 0) {
    console.log(`이전에 처리 완료한 ${done.size}건은 건너뜁니다 (done.json).\n`);
  }
  targets = targets.filter((p) => {
    const postId = p.post_url?.match(/\/(\d+)\/?$/)?.[1];
    return postId && !done.has(postId);
  }).slice(0, limit);

  if (targets.length === 0) {
    console.log('처리할 대상이 없습니다.');
    return;
  }

  console.log(`\n처리 대상 ${targets.length}건:\n`);
  for (const t of targets) {
    const postId = t.post_url.match(/\/(\d+)\/?$/)?.[1] ?? '?';
    console.log(`  [${postId}] "${t.keyword}" (category: ${t.category}, ${t.categorySource}) — ${t.post_url}`);
  }

  if (isDry) {
    console.log(`\n이것은 미리보기입니다. 실제로 삭제하려면 --apply를 붙이세요.`);
    console.log(`  node scripts/purge-legacy-posts.js --apply --post <id>   # 1건 먼저 확인 필수`);
    console.log(`\n⚠️  --apply를 실행하기 전에 위 목록을 반드시 사람이 눈으로 확인하세요.`);
    console.log(`⚠️  삭제 플로우는 실제 DOM으로 검증되지 않았습니다 — --post 단건으로 먼저 확인할 것.`);
    return;
  }

  console.log(`\n⚠️  실제 삭제를 시작합니다. 5초 후 진행... (Ctrl+C로 중단)`);
  await sleep(5000);

  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const browser = await launchBrowser(!isHeaded);
  const context = await createTistoryContext(browser);
  if (!context) {
    console.error('❌ Tistory 로그인 세션 없음 — npm run blog:login 먼저 실행하세요.');
    await browser.close();
    process.exit(1);
  }

  const page = await context.newPage();
  if (!(await isLoggedIn(page))) {
    console.error('❌ 세션 만료됨 — npm run blog:login 다시 실행하세요.');
    await browser.close();
    process.exit(1);
  }

  let deleted = 0;
  const failures = [];

  for (const target of targets) {
    const postId = target.post_url.match(/\/(\d+)\/?$/)[1];

    try {
      if (!(await isLoggedIn(page))) {
        console.error(`\n❌ 세션이 처리 도중 만료됨 (postId=${postId}에서 중단). npm run blog:login 후 재실행하세요.`);
        console.error(`   재실행하면 이미 처리된 ${deleted}건은 done.json 기록으로 건너뜁니다.`);
        break;
      }

      // 백업 먼저 — 편집 페이지 본문을 저장해둔다 (실패하면 이 글은 건너뜀)
      const editUrl = `https://${blogName}.tistory.com/manage/post/${postId}/`;
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('#post-title-inp, input[name="title"]', { timeout: 20000 });
      const original = await page.evaluate(() => {
        const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
        return ed ? ed.getContent() : document.body.innerHTML;
      }).catch(() => null);

      if (original) {
        const backupPath = path.join(BACKUP_DIR, `${postId}.html`);
        await fs.writeFile(
          backupPath,
          `<!-- keyword: ${target.keyword} / category: ${target.category} / url: ${target.post_url} -->\n${original}`,
          'utf8'
        ).catch((err) => {
          console.log(`⚠️  [${postId}] 백업 실패(계속 진행): ${err.message}`);
        });
      }

      const result = await deletePost(page, blogName, postId);
      if (!result.deleted) {
        console.log(`⚠️  [${postId}] "${target.keyword}" — 삭제 확인 안 됨: ${result.reason}`);
        failures.push({ postId, keyword: target.keyword, reason: result.reason });
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      console.log(`✅ [${postId}] "${target.keyword}" 삭제 완료 — 백업: ${path.join(BACKUP_DIR, `${postId}.html`)}`);
      deleted++;
      done.add(postId);
      await saveDone(done);
    } catch (err) {
      console.log(`❌ [${postId}] 처리 실패: ${err.message}`);
      logger.error(`[purge-legacy-posts] postId=${postId} 처리 실패`, { message: err.message });
      failures.push({ postId, keyword: target.keyword, reason: err.message });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await browser.close();

  console.log(`\n───────────────────────────────`);
  console.log(`대상 ${targets.length}건 / 삭제 완료 ${deleted}건 / 실패(확인 필요) ${failures.length}건`);
  if (failures.length > 0) {
    console.log(`\n실패 목록:`);
    for (const f of failures) console.log(`  - [${f.postId}] "${f.keyword}": ${f.reason}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
