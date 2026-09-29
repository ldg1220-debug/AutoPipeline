import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle, retryOn429, retryOn503 } from '../utils/rateLimiter.js';
import { extractRegion, isOverseasRegion } from './tradule_source.js';

// [역할: Image Maker] — 전체 워크플로우는 docs/AGENT_WORKFLOW.md 참고.
// 가이드 파일(prompts/image_guide.md)에 정의된 규칙을 LLM 프롬프트에 주입하고,
// 자체 검수(Gemini Vision)까지 책임지는 단일 책임 에이전트.

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 이미지 가이드 (prompts/image_guide.md) 로드 — LLM 프롬프트에 주입 ────────
let _imageGuideCache = null;
async function loadImageGuide() {
  if (_imageGuideCache !== null) return _imageGuideCache;
  try {
    _imageGuideCache = await fs.readFile(
      path.resolve(__dirname, '../../prompts/image_guide.md'),
      'utf-8'
    );
  } catch {
    _imageGuideCache = '';
  }
  return _imageGuideCache;
}

// 카테고리별 Pexels 검색 쿼리 (블로그 가로형 이미지용)
// travel은 지역마다 완전히 다른 장소이므로 고정 문자열이 아니라
// buildTravelPexelsQuery()가 trip_data.region 기반으로 매번 만든다 (아래 참고).
const PEXELS_QUERY = {
  finance:       'money finance investment korean',
  economy:       'economy business news chart graph',
  realestate:    'real estate apartment building korea',
  health:        'health wellness lifestyle fitness',
  entertainment: 'entertainment media korean drama',
  social:        'society people community korea',
};

// 트레쥴 지역 트리(DOMESTIC_REGIONS/OVERSEAS_REGIONS)의 한글 지역명 → Pexels 영문 검색어.
// 이 맵이 없던 시기엔 travel 카테고리가 PEXELS_QUERY에 항목이 없어 `${keyword} korea`로
// 폴백했는데, 해외 지역(예: "발리")에도 "korea"가 그대로 붙어 완전히 무관한 한국 사진이
// 나오는 버그가 있었다(실측: 발리 글에 한국 번화가 사진).
const REGION_EN_NAMES = {
  // 국내
  '경주': 'Gyeongju', '강릉': 'Gangneung', '서울': 'Seoul', '부산': 'Busan',
  '제주': 'Jeju', '전주': 'Jeonju', '여수': 'Yeosu', '통영': 'Tongyeong',
  '속초': 'Sokcho', '춘천': 'Chuncheon', '양양': 'Yangyang', '대구': 'Daegu',
  '인천': 'Incheon', '수원': 'Suwon', '군산': 'Gunsan', '목포': 'Mokpo',
  '거제': 'Geoje', '남해': 'Namhae', '담양': 'Damyang',
  // 해외 — OVERSEAS_REGIONS(tradule_source.js)와 동기화.
  '후쿠오카': 'Fukuoka', '오사카': 'Osaka', '도쿄': 'Tokyo', '삿포로': 'Sapporo',
  '나고야': 'Nagoya', '오키나와': 'Okinawa', '방콕': 'Bangkok', '다낭': 'Da Nang',
  '나트랑': 'Nha Trang', '치앙마이': 'Chiang Mai', '타이베이': 'Taipei', '상하이': 'Shanghai',
  // 2026-09-28(작업지시서 "세부 초안 2차 대조" §5): "세부"가 이 맵에 없어
  // buildTravelPexelsQuery()가 지역 없는 일반 쿼리로 폴백했고, Pexels가 그 쿼리를
  // 튀르키예 카파도키아·스위스 알프스 사진에 매칭해 세부 글에 넣는 사고가 났다.
  '세부': 'Cebu', '코타키나발루': 'Kota Kinabalu', '우붓': 'Ubud', '발리': 'Bali',
  '시드니': 'Sydney',
};

// REGION_EN_NAMES 해외 지역의 국가명(영문) — Pexels 검색어에 국가명을 넣어야
// "지역명만으로는 다른 나라 사진과 헷갈릴 수 있는" 지역(세부↔필리핀 등)에서도
// 정확한 사진을 찾는다. 매핑 없는 지역은 지역 영문명만 사용.
const REGION_COUNTRY = {
  '세부': 'Philippines', '코타키나발루': 'Malaysia', '우붓': 'Indonesia', '발리': 'Indonesia',
  '시드니': 'Australia', '방콕': 'Thailand', '치앙마이': 'Thailand', '다낭': 'Vietnam',
  '나트랑': 'Vietnam', '타이베이': 'Taiwan', '상하이': 'China',
  '후쿠오카': 'Japan', '오사카': 'Japan', '도쿄': 'Japan', '삿포로': 'Japan',
  '나고야': 'Japan', '오키나와': 'Japan',
};

/**
 * travel 카테고리 전용 Pexels 쿼리 생성. trip_data.region(또는 키워드에서 추출한 지역명)이
 * REGION_EN_NAMES에 있으면 그 지역 영문명(+국가명)으로 쿼리를 만든다. 없으면(지역 매칭
 * 실패 키워드 — 예: "신혼 여행지 추천"처럼 특정 지역이 없는 리스티클, 또는 아직
 * REGION_EN_NAMES에 등록되지 않은 신규 해외 지역) null을 반환한다 — 지역 없는 일반
 * 쿼리로 폴백하면 엉뚱한 나라 사진이 나올 수 있으므로(2026-09-28 작업지시서 §5 실측:
 * "세부" 글에 튀르키예·스위스 사진), 지역을 특정할 수 없으면 사진을 아예 건너뛴다.
 */
function buildTravelPexelsQuery(content) {
  const region = content?.trip_data?.region ?? extractRegion(content?.keyword ?? '');
  const en = region ? REGION_EN_NAMES[region] : null;
  if (!en) return null;
  const overseas = isOverseasRegion(region);
  const country = REGION_COUNTRY[region];
  if (overseas && country) return `${en} ${country} travel landmarks`;
  return `${en} travel landmarks${overseas ? '' : ' korea'}`;
}

// 2026-09-28(작업지시서 §5③): Pexels 결과의 alt 설명/URL slug에 지역명 또는
// 국가명이 전혀 없으면 그 사진은 버린다 — 검색어가 맞아도 결과가 엉뚱할 수 있다.
// 지역 자체 도시명 외에, 실제 course-brief에 같이 등장하는 하위 지명(같은
// 지역 안의 동네/섬)도 "이 지역 사진"으로 인정한다. 예: 세부 코스에
// "막탄"(Mactan)이 포함되므로 Mactan 사진도 세부 지역 사진으로 본다.
const REGION_CITY_ALIASES = {
  '세부': ['Mactan'],
};

// 2026-09-28(작업지시서 "세부 초안 3차" §7): "Philippines"(국가명)만 있어도
// 통과시켰더니, 마닐라 사진(alt에 "Philippines"가 섞여 있지만 도시는 마닐라)이
// "세부" 섹션에 그대로 들어갔다(실측: historic-building-in-manila...). 도시
// 단위 지역은 국가명만으로는 부족하고 그 지역의 도시명이 있어야 통과시킨다 —
// 다른 도시명(Manila·Boracay 등)이 있으면 국가명이 같이 있어도 탈락.
function photoMatchesRegion(photo, region) {
  if (!region) return true;
  const en = REGION_EN_NAMES[region];
  if (!en) return true;
  const haystack = `${photo.alt ?? ''} ${photo.url ?? ''}`.toLowerCase();
  const norm = (t) => t.toLowerCase();
  const includesTerm = (t) => haystack.includes(norm(t)) || haystack.includes(norm(t).replace(/\s+/g, '-'));

  const ownCityTerms = [en, ...(REGION_CITY_ALIASES[region] ?? [])];
  if (ownCityTerms.some(includesTerm)) return true;

  const otherCityTerms = Object.entries(REGION_EN_NAMES)
    .filter(([r]) => r !== region)
    .map(([, name]) => name);
  if (otherCityTerms.some(includesTerm)) return false;

  // 자기 지역 도시명도, 다른 지역 도시명도 없으면(국가명만 있거나 아무 지명도
  // 없으면) 도시를 특정할 수 없으므로 탈락시킨다(도시 단위 지역 기준).
  return false;
}

// ── 전역 Pexels ID 추적 (포스트 간 이미지 중복 방지) ─────────────────────────
const GLOBAL_USED_IDS_PATH = path.resolve(__dirname, '../../output/blog/pexels_used_ids.json');

async function loadGlobalUsedIds() {
  try {
    const data = await fs.readFile(GLOBAL_USED_IDS_PATH, 'utf-8');
    const arr = JSON.parse(data);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function saveGlobalUsedIds(ids) {
  try {
    await fs.mkdir(path.dirname(GLOBAL_USED_IDS_PATH), { recursive: true });
    // 최근 500개만 유지 (파일 비대화 방지)
    const arr = [...ids].slice(-500);
    await fs.writeFile(GLOBAL_USED_IDS_PATH, JSON.stringify(arr));
  } catch (err) {
    logger.warn(`[blog_asset_builder] Failed to save global used IDs: ${err.message}`);
  }
}

// DALL-E 3 썸네일 프롬프트 — 블로그 대표 이미지 스타일
function buildThumbnailPrompt(content) {
  const base = content.image_prompt || `${content.keyword} concept`;
  const categoryStyle = {
    economy:       'dark blue gradient background, financial charts, bar graphs, upward arrows',
    finance:       'dark navy background, gold coins, stock market charts, clean minimal',
    realestate:    'aerial city view, apartment buildings, korea cityscape, modern architecture',
    health:        'clean white background, green accents, wellness lifestyle, fresh minimalist',
    entertainment: 'vibrant colorful background, media entertainment, dynamic composition',
    social:        'warm tones, people silhouettes, community, social connection',
    travel:        'vivid travel photography style, scenic destination, warm natural light, wanderlust mood',
  }[content.category] ?? 'clean gradient background, modern flat design';

  return (
    `Eye-catching blog thumbnail image. Topic: "${content.keyword}". ` +
    `Style: ${categoryStyle}. ${base}. ` +
    `16:9 aspect ratio, professional editorial look, visually striking. ` +
    `No text, no letters, no words in the image.`
  );
}

// ── 이미지 다운로드 유틸 ────────────────────────────────────────────────────
async function downloadImage(url, destPath) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, Buffer.from(res.data));
  return destPath;
}

// ── DALL-E 3 썸네일 생성 ────────────────────────────────────────────────────
async function generateDalleThumbnail(content, destPath) {
  const res = await axios.post(
    'https://api.openai.com/v1/images/generations',
    {
      model: 'gpt-image-1',
      prompt: buildThumbnailPrompt(content),
      n: 1,
      size: '1024x1024',
      quality: 'medium',
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  const item = res.data.data[0];
  const rawPath = destPath.replace('.jpg', '_raw.png');
  if (item.b64_json) {
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.writeFile(rawPath, Buffer.from(item.b64_json, 'base64'));
  } else if (item.url) {
    await downloadImage(item.url, rawPath);
  } else {
    throw new Error('gpt-image-1: b64_json과 url 모두 없음');
  }

  // 블로그 썸네일 표준 사이즈 800×450 (16:9) 으로 리사이즈
  await sharp(rawPath)
    .resize(800, 450, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toFile(destPath);

  await fs.unlink(rawPath).catch(() => {});
  return destPath;
}

// ── Pexels 이미지 소싱 (카테고리 기반 — 폴백용) ──────────────────────────
// content를 넘기면 travel 카테고리는 buildTravelPexelsQuery()로 지역 기반 쿼리를 쓴다
// (하위 호환: content 없이 keyword/category만 넘기는 기존 호출부도 그대로 동작).
async function fetchPexelsImages(keyword, category, count, destDir, content = null) {
  const apiKey = config.pexels.apiKey;
  if (!apiKey) return [];

  const region = content?.trip_data?.region ?? (content?.keyword ? extractRegion(content.keyword) : null);
  const query = category === 'travel'
    ? buildTravelPexelsQuery(content ?? { keyword, category })
    : (PEXELS_QUERY[category] ?? `${keyword} korea`);
  // 2026-09-28(작업지시서 §5④): travel 카테고리에서 지역을 특정할 수 없으면(query===null)
  // 엉뚱한 나라 사진을 받느니 사진 없이 발행한다.
  if (query === null) return [];
  const res = await axios.get('https://api.pexels.com/v1/search', {
    params: { query, per_page: count + 5, orientation: 'landscape', page: Math.floor(Math.random() * 4) + 1 },
    headers: { Authorization: apiKey },
    timeout: 10000,
  });

  const allPhotos = res.data.photos ?? [];
  const photos = category === 'travel' ? allPhotos.filter((p) => photoMatchesRegion(p, region)) : allPhotos;
  const paths = [];
  for (let i = 0; i < Math.min(photos.length, count); i++) {
    const photo = photos[i];
    const srcUrl = photo.src.large;
    const destPath = path.join(destDir, `body_${i + 1}.jpg`);
    try {
      await downloadImage(srcUrl, destPath);
      const resizedPath = path.join(destDir, `img_${i + 1}.jpg`);
      await sharp(destPath).resize(730, 490, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(resizedPath);
      await fs.unlink(destPath).catch(() => {});
      paths.push({ path: resizedPath, image_url: srcUrl, pexels_id: photo.id, photographer: photo.photographer, pexels_url: photo.url });
    } catch (err) {
      logger.warn(`[blog_asset_builder] Image download failed: ${srcUrl}`, { message: err.message });
    }
  }
  return paths;
}

// ── ② 섹션별 맞춤 이미지 ──────────────────────────────────────────────────

// 섹션 헤딩 키워드 → Pexels 영어 검색어 매핑 (규칙 기반, API 비용 없음)
const HEADING_EN_MAP = {
  '배경': 'history background context',
  '원인': 'cause factors analysis',
  '영향': 'impact effect change result',
  '전망': 'forecast future outlook trend',
  '대응': 'solution strategy response action',
  '현황': 'current situation status',
  '금리': 'interest rate central bank',
  '부동산': 'real estate property apartment',
  '주식': 'stock market trading chart',
  '물가': 'price inflation goods',
  '고용': 'employment job work office',
  '성장': 'growth development progress',
  '위기': 'crisis risk danger warning',
  '정책': 'policy government regulation',
  '투자': 'investment portfolio finance',
};

function buildSectionQuery(keyword, sectionHeading, category, content = null) {
  // travel은 HEADING_EN_MAP이 전부 경제 채널 시절 헤딩(금리/부동산/주식 등)이라
  // 여행 섹션 헤딩과는 매치되지 않고 늘 아래 폴백으로 빠짐 — 지역 기반 쿼리를 바로 쓴다.
  if (category === 'travel') return buildTravelPexelsQuery(content ?? { keyword, category });
  for (const [kr, en] of Object.entries(HEADING_EN_MAP)) {
    if ((sectionHeading ?? '').includes(kr)) return `${en} korea business`;
  }
  return PEXELS_QUERY[category] ?? `${keyword} korea`;
}

/**
 * 섹션 헤딩 기반으로 각 섹션에 맞는 이미지를 검색한다.
 * 섹션마다 다른 쿼리를 사용해 내용과 관련된 이미지를 가져온다.
 * 같은 포스트 내에서 동일한 Pexels 사진이 재사용되지 않도록 ID를 추적한다.
 * content를 넘기면 travel 카테고리는 trip_data.region 기반 쿼리를 쓴다.
 */
async function fetchSectionImages(sections, keyword, category, destDir, sharedGlobalIds = null, content = null) {
  const apiKey = config.pexels.apiKey;
  if (!sections?.length) return [];

  const paths = [];
  const count = Math.min(sections.length, 3);
  // sharedGlobalIds가 있으면 포스트 간 공유 Set 사용 (없으면 로컬 Set)
  const usedIds = sharedGlobalIds ?? new Set();
  const region = content?.trip_data?.region ?? (keyword ? extractRegion(keyword) : null);

  // 2026-09-28(작업지시서 §5①): travel 글은 트레쥴 코스 지도(course-brief의 imageUrl)를
  // 1순위로 — Pexels 검색 없이도 실제 그 코스의 진짜 사진이다.
  let startIndex = 0;
  if (category === 'travel' && content?.trip_data?.imageUrl) {
    try {
      const mapDestPath = path.join(destDir, 'section_map_raw.jpg');
      const mapResizedPath = path.join(destDir, 'img_1.jpg');
      await downloadImage(content.trip_data.imageUrl, mapDestPath);
      await sharp(mapDestPath).resize(730, 490, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(mapResizedPath);
      await fs.unlink(mapDestPath).catch(() => {});
      paths.push({
        path:            mapResizedPath,
        image_url:       content.trip_data.imageUrl,
        section_heading: sections[0]?.heading,
        section_index:   0,
        source:          'tradule_map',
      });
      startIndex = 1;
      logger.info(`[blog_asset_builder] Section img [0] ← 트레쥴 코스 지도`);
    } catch (err) {
      logger.warn(`[blog_asset_builder] 트레쥴 코스 지도 다운로드 실패: ${err.message}`);
    }
  }

  if (!apiKey) return paths;

  // 2026-09-29(작업지시서 "사실은 맞췄습니다. 이제 읽히는 글로" §3): 스톡 사진은 도입부
  // 1장만 — 일자("N일차") 섹션에는 넣지 않는다(실측: 같은 세부 야경 사진이 일자 섹션마다
  // 5번 반복). 일자별 지도는 트레쥴 배포 후 연결한다.
  const stockTarget = sections.findIndex((sec, idx) => idx >= Math.max(startIndex, 1) && !/\d+\s*일차/.test(sec.heading ?? ''));
  for (let i = startIndex; i < count; i++) {
    if (category === 'travel' && i !== stockTarget) continue;
    const section = sections[i];
    const query = buildSectionQuery(keyword, section.heading ?? '', category, content);
    // 2026-09-28(작업지시서 §5④): 지역을 특정할 수 없으면 이 섹션은 사진 없이 둔다.
    if (query === null) continue;
    try {
      await throttle(300);
      // per_page를 10으로 늘려서 중복 회피 여지 확보
      const res = await axios.get('https://api.pexels.com/v1/search', {
        params: { query, per_page: 10, orientation: 'landscape', page: Math.floor(Math.random() * 5) + 1 },
        headers: { Authorization: apiKey },
        timeout: 10000,
      });

      const allPhotos = res.data.photos ?? [];
      const regionFiltered = category === 'travel' ? allPhotos.filter((p) => photoMatchesRegion(p, region)) : allPhotos;
      // 이미 사용된 ID는 건너뜀
      const photo = regionFiltered.find((p) => !usedIds.has(p.id) && (p.photographer ?? '').trim());
      if (!photo) continue;
      usedIds.add(photo.id);

      const srcUrl = photo.src.large;
      const destPath = path.join(destDir, `section_${i + 1}_raw.jpg`);
      const resizedPath = path.join(destDir, `img_${i + 1}.jpg`);

      await downloadImage(srcUrl, destPath);
      await sharp(destPath).resize(730, 490, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(resizedPath);
      await fs.unlink(destPath).catch(() => {});

      paths.push({
        path:            resizedPath,
        image_url:       srcUrl,
        section_heading: section.heading,
        section_index:   i,
        pexels_id:       photo.id,
        photographer:    photo.photographer,
        pexels_url:      photo.url,
      });
      logger.info(`[blog_asset_builder] Section img [${section.heading}] ← "${query}" (id:${photo.id})`);
    } catch (err) {
      logger.warn(`[blog_asset_builder] Section img failed [${section.heading}]: ${err.message}`);
    }
  }
  return paths;
}

// ── ③ 인포그래픽 카드 (Playwright 스크린샷) ──────────────────────────────

/**
 * 2026-09-28(작업지시서 "세부 초안 2차 대조" §4): extractKeyStats()가 LLM
 * 생성 본문 텍스트에서 "인상적인 수치"를 다시 추출하다 보니, 본문에 남아있던
 * "약 6시간" 같은 부정확한 서술을 그대로 정보카드에 박아 넣었다(실제 구간
 * 합계는 3.2시간). trip_data가 있으면 LLM을 거치지 않고 코드로 직접 계산한다
 * — 재추출 자체가 필요 없어지므로 이런 왜곡이 구조적으로 생길 수 없다.
 */
function truncateAtWordBoundary(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  // 단어 경계에서 자른 뒤 끝에 남은 관사·전치사("House of"의 of)는 떼어낸다.
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim().replace(/\s+(of|the|and|&|in)$/i, '').trim();
}

function buildStatsFromTripData(tripData) {
  if (!tripData?.spots?.length) return null;
  const totalMinutes = tripData.spots.reduce(
    (sum, s) => sum + (typeof s.toNextMinutes === 'number' ? s.toNextMinutes : 0), 0
  );
  const hours = totalMinutes / 60;
  const timeLabel = totalMinutes === 0 ? null : (hours < 1 ? `${totalMinutes}분` : `${hours.toFixed(1)}시간`);
  const ratedSpots = tripData.spots.filter((s) => typeof s.rating === 'number');
  const topSpot = ratedSpots.length ? ratedSpots.reduce((a, b) => (b.rating > a.rating ? b : a)) : null;

  const stats = [];
  if (typeof tripData.totalDistanceKm === 'number') {
    stats.push({ value: `${tripData.totalDistanceKm}km`, label: '총 이동 거리' });
  }
  if (timeLabel) stats.push({ value: timeLabel, label: '이동 시간' });
  stats.push({ value: `${tripData.spots.length}곳`, label: '방문 장소' });
  // 2026-09-28(작업지시서 "세부 초안 3차" §9): slice(0,10)이 단어 중간을
  // 잘라 "Sage Healt"처럼 잘린 라벨이 나왔다 — 단어 경계에서 자른다.
  if (topSpot) stats.push({ value: `★${topSpot.rating}`, label: truncateAtWordBoundary(topSpot.name, 10) });
  return stats.slice(0, 4);
}

/**
 * GPT-4o-mini로 블로그 본문에서 핵심 수치·팩트 3~4개를 추출한다.
 */
async function extractKeyStats(content) {
  if (!config.openai.apiKey) return [];
  const sections = content.blog_draft?.sections ?? [];
  if (!sections.length) return [];

  const bodyText = sections
    .slice(0, 4)
    .map((s) => `${s.heading}: ${(s.body ?? '').slice(0, 300)}`)
    .join('\n');

  const guideText = await loadImageGuide();
  const prompt =
    `다음 블로그 본문에서 독자에게 가장 인상적인 핵심 수치나 팩트를 3~4개 추출해줘.\n` +
    `키워드: ${content.keyword}\n\n${bodyText.slice(0, 1200)}\n\n` +
    `${guideText.slice(0, 800)}\n\n` +
    `조건 (반드시 따를 것): 숫자·퍼센트가 있으면 우선 선택. 없으면 핵심 팩트 한 줄.\n` +
    `value는 반드시 8자 이내, label은 반드시 10자 이내로 압축할 것.\n` +
    `JSON만 반환: {"stats":[{"value":"3.5%","label":"기준금리"},{"value":"7%","label":"전세가 하락"},...]}`;

  try {
    await throttle(1000);
    const res = await retryOn429(() =>
      axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.3,
        },
        {
          headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      )
    );
    return JSON.parse(res.data.choices[0].message.content).stats ?? [];
  } catch (err) {
    logger.warn(`[blog_asset_builder] Stat extraction failed: ${err.message}`);
    return [];
  }
}

const CARD_COLORS = {
  economy:       '#2563eb',
  finance:       '#d97706',
  realestate:    '#16a34a',
  health:        '#0891b2',
  entertainment: '#9333ea',
  social:        '#dc2626',
};

/**
 * Playwright로 핵심 수치 카드 HTML을 렌더링해 730×200 JPG로 저장한다.
 * 추가 npm 패키지 없이 이미 설치된 playwright를 활용.
 */
async function generateInfoCard(stats, keyword, category, outputPath) {
  if (!stats?.length) return null;

  const catColor = CARD_COLORS[category] ?? '#2563eb';
  const cards = stats.slice(0, 4).map((s) =>
    `<div class="card">
      <div class="val">${s.value}</div>
      <div class="lbl">${s.label}</div>
    </div>`
  ).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:730px;height:200px;background:linear-gradient(135deg,#0f172a,#1e293b);
  display:flex;align-items:center;padding:20px 24px;gap:14px;
  font-family:'Malgun Gothic','맑은 고딕','AppleGothic',sans-serif}
.title{color:#64748b;font-size:12px;writing-mode:vertical-rl;
  letter-spacing:3px;flex-shrink:0;white-space:nowrap}
.cards{display:flex;gap:12px;flex:1}
.card{flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);
  border-radius:12px;padding:18px 10px;text-align:center;border-top:3px solid ${catColor}}
.val{font-size:26px;font-weight:700;color:#f1f5f9;line-height:1.1;margin-bottom:7px}
.lbl{font-size:11px;color:#94a3b8;line-height:1.4}
</style></head><body>
<div class="title">${keyword.slice(0, 8)}</div>
<div class="cards">${cards}</div>
</body></html>`;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 730, height: 200 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const rawPath = outputPath.replace('.jpg', '_raw.png');
    await page.screenshot({ path: rawPath });
    await page.close();

    await sharp(rawPath).jpeg({ quality: 92 }).toFile(outputPath);
    await fs.unlink(rawPath).catch(() => {});
    logger.info(`[blog_asset_builder] Info card saved: ${outputPath}`);
    return outputPath;
  } finally {
    await browser.close();
  }
}

// ── ④ Gemini Vision 자가 검수 (이미지 self-review 루프) ──────────────────

/**
 * 생성된 이미지(JPG)를 Gemini Vision으로 검수한다.
 * qa_editor.js의 checkVideoWithGemini와 동일한 패턴 — 영상 대신 이미지에 적용.
 * API 키 없거나 호출 실패 시 PASS로 폴백 (자가 검수는 보강 장치이지 필수 게이트가 아님).
 */
async function reviewImageWithGemini(imagePath, guideText) {
  if (!config.gemini.apiKey) return { pass: true, reason: '' };

  try {
    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const prompt =
      `다음은 블로그용으로 HTML/CSS 렌더링한 이미지입니다. 아래 자가 검수 체크리스트를 기준으로 ` +
      `JSON으로만 응답하세요.\n\n${guideText.slice(0, 1500)}\n\n` +
      `출력: { "pass": true|false, "reason": "FAIL이면 구체적 사유, PASS면 빈 문자열" }`;

    const res = await retryOn503(() =>
      axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.gemini.apiKey}`,
        {
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: base64Image } },
            ],
          }],
          generationConfig: { response_mime_type: 'application/json' },
        },
        { timeout: 30000 }
      )
    );

    const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(raw);
    return { pass: parsed.pass !== false, reason: parsed.reason ?? '' };
  } catch (err) {
    logger.warn(`[blog_asset_builder] Vision self-review failed: ${err.message}. Defaulting to PASS.`);
    return { pass: true, reason: '' };
  }
}

/**
 * GPT-4o-mini로 썸네일용 짧은 헤드라인 문구를 생성한다 (image_guide.md 규칙 강제 주입).
 * 실패 시 키워드를 그대로 사용.
 */
async function generateThumbnailHeadline(content, guideText) {
  if (!config.openai.apiKey) return content.keyword.slice(0, 14);

  const prompt =
    `블로그 썸네일에 들어갈 짧은 헤드라인 문구를 만들어줘.\n` +
    `키워드: ${content.keyword}\n` +
    `참고 맥락: ${(content.image_prompt ?? '').slice(0, 200)}\n\n` +
    `${guideText.slice(0, 800)}\n\n` +
    `JSON만 반환: {"headline":"..."}`;

  try {
    await throttle(500);
    const res = await retryOn429(() =>
      axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.6,
        },
        {
          headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      )
    );
    const headline = JSON.parse(res.data.choices[0].message.content).headline;
    return (headline || content.keyword).slice(0, 14);
  } catch (err) {
    logger.warn(`[blog_asset_builder] Headline generation failed: ${err.message}`);
    return content.keyword.slice(0, 14);
  }
}

const THUMB_GRADIENT = {
  economy:       ['#0f172a', '#1e3a8a'],
  finance:       ['#1c1917', '#92400e'],
  realestate:    ['#052e16', '#15803d'],
  health:        ['#083344', '#0891b2'],
  entertainment: ['#2e1065', '#9333ea'],
  social:        ['#450a0a', '#dc2626'],
};

const CATEGORY_ICON = {
  economy: '📊', finance: '💰', realestate: '🏢',
  health: '🌿', entertainment: '🎬', social: '🏛️',
};

/**
 * HTML/CSS를 Playwright로 렌더링해 블로그 썸네일을 만든다.
 * DALL-E(유료, 빌링 한도 이슈 빈발)의 무료 대체/보강 경로.
 * fontScale을 줄여 재시도하면 자가 검수 FAIL(텍스트 잘림) 시 회복할 수 있다.
 */
async function renderHtmlThumbnail(headline, category, outputPath, fontScale = 1) {
  const [c1, c2] = THUMB_GRADIENT[category] ?? ['#0f172a', '#1e293b'];
  const icon = CATEGORY_ICON[category] ?? '📰';
  const fontSize = Math.round(56 * fontScale);

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:800px;height:450px;background:linear-gradient(135deg,${c1},${c2});
  display:flex;flex-direction:column;align-items:flex-start;justify-content:center;
  padding:0 64px;font-family:'Malgun Gothic','맑은 고딕','AppleGothic',sans-serif;position:relative;overflow:hidden}
.icon{font-size:64px;margin-bottom:18px}
.headline{font-size:${fontSize}px;font-weight:800;color:#f8fafc;line-height:1.3;
  max-width:90%;word-break:keep-all;text-shadow:0 2px 12px rgba(0,0,0,.3)}
.bar{position:absolute;left:64px;bottom:48px;width:64px;height:6px;background:#f8fafc;border-radius:3px}
</style></head><body>
<div class="icon">${icon}</div>
<div class="headline">${headline}</div>
<div class="bar"></div>
</body></html>`;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 800, height: 450 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const rawPath = outputPath.replace('.jpg', '_raw.png');
    await page.screenshot({ path: rawPath });
    await page.close();

    await sharp(rawPath).jpeg({ quality: 92 }).toFile(outputPath);
    await fs.unlink(rawPath).catch(() => {});
    return outputPath;
  } finally {
    await browser.close();
  }
}

/**
 * HTML/CSS 썸네일 생성 + Gemini Vision 자가 검수 루프.
 * FAIL 시 폰트를 줄여 최대 2회까지 재생성, 그래도 실패하면 마지막 결과를 그대로 채택
 * (최종 폴백은 buildAssets의 Pexels 단계가 담당).
 */
async function generateHtmlThumbnailWithReview(content, destPath) {
  const guideText = await loadImageGuide();
  const headline = await generateThumbnailHeadline(content, guideText);

  let fontScale = 1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await renderHtmlThumbnail(headline, content.category, destPath, fontScale);
    const review = await reviewImageWithGemini(destPath, guideText);
    if (review.pass) {
      logger.info(`[blog_asset_builder] HTML thumbnail self-review PASS (attempt ${attempt}): ${content.keyword}`);
      return destPath;
    }
    logger.warn(`[blog_asset_builder] HTML thumbnail self-review FAIL (attempt ${attempt}): ${review.reason}`);
    fontScale -= 0.15; // 텍스트 잘림 대응 — 폰트 축소 후 재시도
  }
  return destPath; // 3회 시도 후에도 보유 — Pexels 폴백 여부는 호출부에서 판단
}

// ── 단일 콘텐츠 자산 빌드 ─────────────────────────────────────────────────
async function buildAssets(content, sharedGlobalIds = null) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const assetDir = path.resolve(__dirname, `../../output/blog/assets/${safeKeyword}`);
  await fs.mkdir(assetDir, { recursive: true });

  const result = {
    keyword:     content.keyword,
    asset_dir:   assetDir,
    thumbnail:   null,
    body_images: [],
    info_card:   null,
    info_stats:  [],
  };

  // 1. 썸네일 — DALL-E 3 우선, 실패 시 Pexels 폴백
  if (config.openai.apiKey) {
    try {
      await throttle(1000);
      const thumbPath = path.join(assetDir, 'thumbnail.jpg');
      result.thumbnail = await generateDalleThumbnail(content, thumbPath);
      logger.info(`[blog_asset_builder] Thumbnail (DALL-E 3): ${content.keyword}`);
    } catch (err) {
      const detail = err.response?.data?.error?.message ?? err.message;
      logger.warn(`[blog_asset_builder] DALL-E 3 failed (${err.response?.status ?? 'no-resp'}): ${detail}`);
    }
  }

  // 2. ② 섹션별 맞춤 이미지 — 섹션 헤딩 기반 Pexels 검색
  if (config.pexels.apiKey) {
    try {
      await throttle(500);
      const sections = content.blog_draft?.sections ?? [];
      if (sections.length > 0) {
        result.body_images = await fetchSectionImages(sections, content.keyword, content.category, assetDir, sharedGlobalIds, content);
        logger.info(`[blog_asset_builder] Section images ×${result.body_images.length}: ${content.keyword}`);
      } else {
        // 섹션 없으면 카테고리 기반 폴백
        result.body_images = await fetchPexelsImages(content.keyword, content.category, 3, assetDir, content);
        logger.info(`[blog_asset_builder] Category images ×${result.body_images.length}: ${content.keyword}`);
      }
    } catch (err) {
      logger.warn(`[blog_asset_builder] Section images failed: ${err.message}`);
    }
  }

  // 2.5. 썸네일 폴백 1단계 — DALL-E 실패 시 HTML/CSS+Playwright로 무료 렌더링 (자가 검수 포함)
  if (!result.thumbnail) {
    try {
      const htmlThumbPath = path.join(assetDir, 'thumbnail.jpg');
      result.thumbnail = await generateHtmlThumbnailWithReview(content, htmlThumbPath);
      logger.info(`[blog_asset_builder] Thumbnail (HTML/CSS render): ${content.keyword}`);
    } catch (err) {
      logger.warn(`[blog_asset_builder] HTML thumbnail failed: ${err.message}`);
      result.thumbnail = null;
    }
  }

  // 3. 썸네일 폴백 2단계 — HTML 렌더링도 실패 시 Pexels 사진으로 대체
  if (!result.thumbnail && config.pexels.apiKey) {
    try {
      // 전역 Set(포스트 간 중복 방지) + 현재 포스트 body_images ID 합산
      const excludedIds = sharedGlobalIds ?? new Set();
      for (const b of result.body_images) { if (b.pexels_id) excludedIds.add(b.pexels_id); }
      const thumbQuery = content.category === 'travel'
        ? buildTravelPexelsQuery(content)
        : (PEXELS_QUERY[content.category] ?? `${content.keyword} korea`);
      await throttle(300);
      const thumbRes = await axios.get('https://api.pexels.com/v1/search', {
        params: { query: thumbQuery, per_page: 15, orientation: 'landscape', page: 1 },
        headers: { Authorization: config.pexels.apiKey },
        timeout: 10000,
      });
      const thumbPhoto = (thumbRes.data.photos ?? []).find((p) => !excludedIds.has(p.id));
      if (thumbPhoto) {
        const rawPath = path.join(assetDir, 'thumbnail_raw.jpg');
        const thumbPath = path.join(assetDir, 'thumbnail.jpg');
        await downloadImage(thumbPhoto.src.large, rawPath);
        await sharp(rawPath).resize(800, 450, { fit: 'cover' }).jpeg({ quality: 90 }).toFile(thumbPath);
        await fs.unlink(rawPath).catch(() => {});
        sharedGlobalIds?.add(thumbPhoto.id);
        result.thumbnail = thumbPath;
        logger.info(`[blog_asset_builder] Thumbnail (Pexels fallback, id:${thumbPhoto.id}): ${content.keyword}`);
      }
    } catch (err) {
      logger.warn(`[blog_asset_builder] Thumbnail fallback failed: ${err.message}`);
    }
  }

  // 4. ③ 인포그래픽 카드 — 핵심 수치 추출 → Playwright 스크린샷
  if (config.openai.apiKey) {
    try {
      await throttle(500);
      const stats = buildStatsFromTripData(content.trip_data) ?? await extractKeyStats(content);
      if (stats.length > 0) {
        const cardPath = path.join(assetDir, 'info_card.jpg');
        result.info_card  = await generateInfoCard(stats, content.keyword, content.category, cardPath);
        result.info_stats = stats;

        const guideText = await loadImageGuide();
        const review = await reviewImageWithGemini(cardPath, guideText);
        if (!review.pass) {
          logger.warn(`[blog_asset_builder] Info card self-review FAIL: ${review.reason} (${content.keyword})`);
        }
        logger.info(`[blog_asset_builder] Info card (${stats.length} stats): ${content.keyword}`);
      }
    } catch (err) {
      logger.warn(`[blog_asset_builder] Info card failed: ${err.message}`);
    }
  }

  return result;
}

export async function buildAllAssets(contentData) {
  const contents = contentData?.contents ?? [];

  if (contents.length === 0) {
    logger.warn('[blog_asset_builder] No contents to process.');
    return { ...contentData, contents: [] };
  }

  if (!config.openai.apiKey && !config.pexels.apiKey) {
    logger.warn('[blog_asset_builder] No API keys (OpenAI/Pexels). Skipping asset build.');
    return contentData;
  }

  // 이전 실행에서 사용된 Pexels ID 로드 — 포스트 간 이미지 중복 방지
  const sharedGlobalIds = await loadGlobalUsedIds();
  logger.info(`[blog_asset_builder] Loaded ${sharedGlobalIds.size} previously-used Pexels IDs`);

  const updated = [];
  for (const content of contents) {
    logger.info(`[blog_asset_builder] Building assets: ${content.keyword}`);
    try {
      const assets = await buildAssets(content, sharedGlobalIds);
      updated.push({ ...content, blog_assets: assets });
    } catch (err) {
      logger.error(`[blog_asset_builder] Failed: ${content.keyword}`, { message: err.message });
      updated.push({ ...content, blog_assets: null });
    }
  }

  // 사용된 ID 저장 — 다음 실행에서도 중복 방지
  await saveGlobalUsedIds(sharedGlobalIds);

  return { ...contentData, assets_built_at: new Date().toISOString(), contents: updated };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let contentData;

      try {
        contentData = await readJSON(
          path.resolve(__dirname, `../../output/blog/draft_${date}.json`)
        );
      } catch {
        // blog draft 없으면 content 파일에서 읽기
        try {
          contentData = await readJSON(
            path.resolve(__dirname, `../../output/scripts/content_${date}.json`)
          );
        } catch {
          logger.warn('[blog_asset_builder] No input file. Using mock.');
          contentData = {
            generated_at: new Date().toISOString(),
            contents: [{
              keyword: '경기침체 공포',
              category: 'economy',
              image_prompt: 'economic crisis fear concept, graph declining',
              blog_draft: { sections: [] },
            }],
          };
        }
      }

      const result = await buildAllAssets(contentData);
      const outPath = path.resolve(__dirname, `../../output/blog/assets_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[blog_asset_builder] Saved to ${outPath}`);
    } catch (err) {
      logger.error('[blog_asset_builder] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
