/**
 * theme_styler.js — 카테고리·시즌별 블로그 테마 CSS 생성
 *
 * 사용법: monetizer.js에서 getThemeStyles(category) 호출 →
 *         반환된 CSS를 <style> 태그에 주입하면 BLOG_STYLES와 합산 적용됨.
 *
 * 구현 방식: regex HTML 조작 대신 CSS 변수 오버라이드 방식 사용.
 *   - monetizer.js가 렌더링하는 .tldr-box / .section-hdr / .faq-wrap /
 *     .callout / .cta-box 등의 클래스를 카테고리 색상으로 덮어씀.
 */

// ── 카테고리별 테마 ───────────────────────────────────────────────────────────
const THEMES = {
  economy: {
    primary:   '#2563eb',   // 블루 (기존 CATEGORY_COLOR 통일)
    light:     '#eff6ff',
    border:    '#bfdbfe',
    accent:    '#1d4ed8',
    icon:      '📊',
    label:     '경제',
  },
  finance: {
    primary:   '#d97706',
    light:     '#fffbeb',
    border:    '#fde68a',
    accent:    '#b45309',
    icon:      '💰',
    label:     '재테크',
  },
  realestate: {
    primary:   '#16a34a',
    light:     '#f0fdf4',
    border:    '#bbf7d0',
    accent:    '#15803d',
    icon:      '🏠',
    label:     '부동산',
  },
  health: {
    primary:   '#0891b2',
    light:     '#f0f9ff',
    border:    '#bae6fd',
    accent:    '#0e7490',
    icon:      '💊',
    label:     '건강',
  },
  entertainment: {
    primary:   '#9333ea',
    light:     '#faf5ff',
    border:    '#e9d5ff',
    accent:    '#7e22ce',
    icon:      '🎬',
    label:     '엔터',
  },
  social: {
    primary:   '#dc2626',
    light:     '#fef2f2',
    border:    '#fecaca',
    accent:    '#b91c1c',
    icon:      '👥',
    label:     '사회',
  },
};

const DEFAULT_THEME = {
  primary: '#475569',
  light:   '#f8fafc',
  border:  '#e2e8f0',
  accent:  '#334155',
  icon:    '📌',
  label:   '일반',
};

// ── 시즌별 배경 효과 ─────────────────────────────────────────────────────────
function getSeasonalCSS() {
  const month = new Date().getMonth() + 1;

  // 겨울 (12, 1): TL;DR 박스에 미세한 도트 패턴
  if (month === 12 || month === 1) {
    return `.tldr-box {
      background-image: radial-gradient(rgba(255,255,255,.15) 1px, transparent 1px) !important;
      background-size: 14px 14px !important;
    }`;
  }
  // 봄 (3, 4, 5): 연한 그린 gradient
  if (month >= 3 && month <= 5) {
    return `.tldr-box {
      background: linear-gradient(135deg, #14532d 0%, #16a34a 100%) !important;
    }`;
  }
  // 여름 (6, 7, 8): 오션 블루
  if (month >= 6 && month <= 8) {
    return `.tldr-box {
      background: linear-gradient(135deg, #0c4a6e 0%, #0891b2 100%) !important;
    }`;
  }
  // 가을 (9, 10, 11): 웜 오렌지
  if (month >= 9 && month <= 11) {
    return `.tldr-box {
      background: linear-gradient(135deg, #7c2d12 0%, #ea580c 100%) !important;
    }`;
  }
  return '';
}

// ── 메인: 카테고리 테마 CSS 반환 ─────────────────────────────────────────────
export function getThemeStyles(category) {
  const t = THEMES[category] ?? DEFAULT_THEME;
  const seasonal = getSeasonalCSS();

  return `
/* ── 카테고리 테마: ${t.label} (${t.primary}) ── */
:root { --cat-color: ${t.primary}; }

/* TL;DR 박스 — 카테고리 primary 색 적용 */
.tldr-box {
  background: linear-gradient(135deg, ${t.accent} 0%, ${t.primary} 100%) !important;
}

/* callout 박스 — 카테고리 라이트 색상 */
.callout {
  background: ${t.light} !important;
  border-left-color: ${t.primary} !important;
  color: ${t.accent} !important;
}

/* FAQ 섹션 배경 */
.faq-wrap {
  border-top: 3px solid ${t.primary};
  padding-top: 12px;
}
.faq-q { color: ${t.accent} !important; }

/* 키워드 태그 */
.keyword-tag {
  background: ${t.light} !important;
  color: ${t.accent} !important;
}

/* 제휴 블록 강조 */
.affiliate-block {
  border-color: ${t.border} !important;
  background: ${t.light} !important;
}

/* 시즌 효과 */
${seasonal}
`.trim();
}

// ── 카테고리 아이콘 반환 (포스트 헤더용) ─────────────────────────────────────
export function getCategoryIcon(category) {
  return (THEMES[category] ?? DEFAULT_THEME).icon;
}
