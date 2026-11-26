#!/usr/bin/env node
/**
 * audit-post.js — 발행된 글(또는 로컬 HTML)을 휴대폰 화면(390px)으로 띄워 레이아웃을 점검한다 (D-175).
 *
 * 사용: node scripts/audit-post.js https://maeilg.com/291 [--width 390]
 *       node scripts/audit-post.js output/blog/html/경주-2박3일.html
 * 결과: output/audit/{slug}_{yyyymmdd}.json + 화면 조각 PNG (1,500px 단위)
 *
 * 점검 항목: 가로 넘침 · 깨진/로드 안 된 이미지 · 애드센스 슬롯 수와 실제 높이 · H2/H3 수 · 사진 수(지도 제외) ·
 *            표 너비 초과 · 본문 글자 수 · 첫 화면(0~844px)에 본문 텍스트가 있는지 · 같은 문장 반복
 * 외부 API·LLM 비용 없음. 헤드리스 브라우저에서는 광고가 채워지지 않을 수 있다(높이 0이면 휴대폰에서 직접 확인).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const width = Number(args[args.indexOf('--width') + 1]) || 390;
if (!target) { console.error('사용: node scripts/audit-post.js <URL 또는 HTML 파일>'); process.exit(1); }

const isUrl = /^https?:\/\//.test(target);
const outDir = path.resolve(__dirname, '../output/audit');
fs.mkdirSync(outDir, { recursive: true });
const slug = (isUrl ? new URL(target).pathname : path.basename(target)).replace(/[^\w가-힣-]+/g, '_').replace(/^_+|_+$/g, '') || 'post';
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const base = path.join(outDir, `${slug}_${stamp}`);

const launchOpts = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOpts);
try {
  const page = await browser.newPage({
    viewport: { width, height: 844 }, isMobile: width < 500, deviceScaleFactor: 1,
    userAgent: width < 500 ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined,
  });
  if (isUrl) await page.goto(target, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  else {
    const html = fs.readFileSync(target, 'utf8');
    const wrapped = /<meta[^>]+viewport/i.test(html) ? html : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:0 16px">${html}`;
    await page.setContent(wrapped, { waitUntil: 'load', timeout: 90000 }).catch(() => {});
  }
  // 지연 로딩 이미지를 띄우려고 끝까지 스크롤
  for (let y = 0; y < 40000; y += 600) { await page.evaluate((v) => window.scrollTo(0, v), y); await page.waitForTimeout(120); }
  await page.waitForTimeout(2500);

  const r = await page.evaluate((vw) => {
    const root = document.querySelector('.mae-wrap') ?? document.body;
    const top = (e) => Math.round(e.getBoundingClientRect().top + window.scrollY);
    const imgs = [...root.querySelectorAll('img')].map((e) => ({ y: top(e), h: Math.round(e.getBoundingClientRect().height), ok: e.complete && e.naturalWidth > 0, map: /course-map|지도/.test(e.src + e.alt), alt: (e.alt || '').slice(0, 40) }));
    const ads = [...document.querySelectorAll('ins.adsbygoogle')].map((e) => ({ y: top(e), h: Math.round(e.getBoundingClientRect().height), inBody: root.contains(e) }));
    const text = root.innerText.replace(/\s+/g, ' ').trim();
    const sentences = text.split(/(?<=[.다요])\s+/).map((s) => s.trim()).filter((s) => s.length >= 20);
    const counts = new Map(); for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
    const firstScreen = [...root.querySelectorAll('p,li')].filter((e) => top(e) < 844 && e.innerText.trim().length > 20).length;
    return {
      pageHeight: document.body.scrollHeight, overflowX: document.documentElement.scrollWidth > vw + 2,
      h2: root.querySelectorAll('h2').length, h3: root.querySelectorAll('h3').length,
      chars: text.length, imgs, ads,
      wideTables: [...root.querySelectorAll('table')].filter((t) => t.getBoundingClientRect().width > vw).length,
      firstScreenTextBlocks: firstScreen,
      repeatedSentences: [...counts].filter(([, n]) => n > 1).map(([s, n]) => `${n}회: ${s.slice(0, 60)}`).slice(0, 10),
    };
  }, width);

  const issues = [];
  if (r.overflowX) issues.push('가로 넘침(옆으로 스크롤됨)');
  const broken = r.imgs.filter((i) => !i.ok); if (broken.length) issues.push(`로드 안 된 이미지 ${broken.length}장`);
  const photos = r.imgs.filter((i) => !i.map && i.ok).length; if (photos < 2) issues.push(`장소 사진 ${photos}장(지도 제외) — 2장 미만`);
  if (!r.ads.length) issues.push('애드센스 슬롯 없음');
  if (r.ads.length && r.ads.every((a) => a.h === 0)) issues.push('애드센스 슬롯 높이가 모두 0 — 휴대폰에서 실제 노출 확인 필요(헤드리스에서는 안 채워질 수 있음)');
  if (r.wideTables) issues.push(`화면보다 넓은 표 ${r.wideTables}개`);
  if (r.firstScreenTextBlocks === 0) issues.push('첫 화면에 본문 문장이 없음');
  if (r.repeatedSentences.length) issues.push(`반복 문장 ${r.repeatedSentences.length}개`);

  let n = 0;
  for (let y = 0; y < r.pageHeight && n < 20; y += 1500, n += 1) {
    await page.screenshot({ path: `${base}_${n}.png`, fullPage: true, clip: { x: 0, y, width, height: Math.min(1500, r.pageHeight - y) } });
  }
  const report = { target, width, checkedAt: new Date().toISOString(), issues, photos, ...r, screenshots: n };
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  console.log(`점검: ${target} (${width}px)`);
  console.log(`  높이 ${r.pageHeight}px · 글자 ${r.chars} · H2 ${r.h2} · H3 ${r.h3} · 사진 ${photos}장 · 지도 ${r.imgs.filter((i) => i.map).length}장 · 광고 ${r.ads.length}개`);
  console.log(issues.length ? `  문제 ${issues.length}개:\n   - ${issues.join('\n   - ')}` : '  문제 없음');
  console.log(`  리포트: ${base}.json · 화면 ${n}장`);
} finally {
  await browser.close();
}
