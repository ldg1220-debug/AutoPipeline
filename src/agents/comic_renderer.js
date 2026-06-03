/**
 * Marvel 코믹스 스타일 쇼핑 영상 렌더러
 *
 * 구조:
 *   Panel 1 (Problem)  — 문제 상황, OH NO!
 *   Panel 2 (Hero)     — 제품 등장, BOOM!
 *   Panel 3 (Solution) — 해결 완료, PERFECT!
 *
 * 이미지: Grok Aurora → gpt-image-1 폴백
 * TTS  : ClovaVoice → ElevenLabs → OpenAI 폴백
 * 영상 : ffmpeg (3 패널 concat + 오디오)
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const require        = createRequire(import.meta.url);
const sharp          = require('sharp');
const execFileAsync  = promisify(execFile);
const { default: ffmpegPath } = await import('ffmpeg-static');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const W = 1080, H = 1920;
const FONT = "'Malgun Gothic',AppleGothic,'Nanum Gothic',sans-serif";

// 매읽남 캐릭터 에셋 경로 (한 번 생성 후 재사용)
const CHARACTER_ASSET = path.resolve(__dirname, '../../src/assets/maeilnamja_comic.png');

// AI 이미지 프롬프트에 삽입할 매읽남 캐릭터 묘사 (영문)
const MAEILNAMJA_COMIC_BASE =
  'chibi kawaii anime-style white Persian cat professor character, ' +
  'bright white fluffy fur, large round expressive eyes, round cute face, ' +
  'wearing beige/tan blazer with dark navy necktie. ' +
  'Marvel comic book style: bold thick black outlines, ben-day dots halftone, vivid pop art colors.';

// ── SVG helpers ─────────────────────────────────────────────────────────────

const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrapKorean(text, maxLen = 18) {
  const chars = [...(text ?? '')];
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    cur += ch;
    if ([...cur].length >= maxLen) { lines.push(cur); cur = ''; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

/** Ben-Day 점묘 오버레이 */
function benDaySvg(w, h, opacity = 0.07) {
  const spacing = 16, r = 4;
  const dots = [];
  for (let y = 0; y <= h; y += spacing)
    for (let x = 0; x <= w; x += spacing)
      dots.push(`<circle cx="${x}" cy="${y}" r="${r}"/>`);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <g fill="black" opacity="${opacity}">${dots.join('')}</g>
    </svg>`
  );
}

/** 방사형 스피드 라인 (히어로 패널) */
function speedLinesSvg(cx, cy, count = 52) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r1 = 210, r2 = Math.hypot(W, H) * 0.75;
    lines.push(
      `<line x1="${(cx + Math.cos(a) * r1).toFixed(1)}" y1="${(cy + Math.sin(a) * r1).toFixed(1)}"
             x2="${(cx + Math.cos(a) * r2).toFixed(1)}" y2="${(cy + Math.sin(a) * r2).toFixed(1)}"
             stroke="#FFD700" stroke-width="3.5" opacity="0.50"/>`
    );
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${lines.join('')}</svg>`
  );
}

/** 별꽃 모양 (사운드 이펙트 배경) */
function starburstPath(cx, cy, r1, r2, pts) {
  const p = [];
  for (let i = 0; i < pts * 2; i++) {
    const a = (i * Math.PI) / pts - Math.PI / 2;
    const r = i % 2 === 0 ? r2 : r1;
    p.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return p.join(' ');
}

// ── SVG 고양이 캐릭터 ─────────────────────────────────────────────────────────
/**
 * 치비 고양이 교수 캐릭터를 SVG 엘리먼트로 그린다.
 * PNG 오버레이 없이 코드로 직접 드로잉 → 패널에 네이티브 통합.
 *
 * @param {'worried'|'hero'|'happy'} pose
 * @param {number} cx   캐릭터 수평 중심 (px)
 * @param {number} cy   캐릭터 바닥 기준 Y (px)
 * @param {number} h    전체 캐릭터 높이 (px)
 */
function catCharacterSvg(pose, cx, cy, h) {
  const sw   = Math.max(3, h * 0.030);  // 선 굵기 (코믹 스타일)
  const fur  = '#F4F2EE';               // 흰 털
  const pink = '#FFAAAA';               // 귀 속 / 코 / 볼 핑크
  const suit = '#C8A84B';               // 베이지 블레이저
  const tie  = '#1C2A78';               // 감청 넥타이
  const dark = '#111111';               // 아웃라인

  // ── 비율 ──
  const legH   = h * 0.14;
  const bodyH  = h * 0.33;
  const bodyW  = h * 0.44;
  const headR  = h * 0.28;

  const bodyTop = cy - legH - bodyH;
  const headCy  = bodyTop - headR * 0.62;  // 머리 중심

  // ── 귀 ──
  const earBW  = headR * 0.38;
  const earPk  = headR * 0.50;
  const earLX  = cx - headR * 0.50;
  const earRX  = cx + headR * 0.50;
  const earBY  = headCy - headR * 0.58;
  const earTY  = earBY - earPk;

  // ── 눈 ──
  const eLX = cx - headR * 0.36;
  const eRX = cx + headR * 0.36;
  const eY  = headCy - headR * 0.06;
  const eW  = headR * 0.195;
  const eH  = headR * 0.245;
  const bY  = eY - eH * 1.25;   // 눈썹 Y
  const bL  = eW * 1.6;          // 눈썹 길이

  // ── 포즈별 요소 ──
  let eyesEl = '', browsEl = '', mouthEl = '', armsEl = '';

  if (pose === 'worried') {
    // 눈: 크게 뜸 + 하이라이트
    eyesEl = `
      <ellipse cx="${eLX}" cy="${eY}" rx="${eW*1.2}" ry="${eH*1.25}" fill="${dark}"/>
      <ellipse cx="${eRX}" cy="${eY}" rx="${eW*1.2}" ry="${eH*1.25}" fill="${dark}"/>
      <circle  cx="${eLX-eW*.28}" cy="${eY-eH*.3}" r="${eW*.38}" fill="white"/>
      <circle  cx="${eRX-eW*.28}" cy="${eY-eH*.3}" r="${eW*.38}" fill="white"/>`;
    // 눈썹: 가운데 위로 올라감 (걱정 표정)
    browsEl = `
      <path d="M${eLX-bL/2} ${bY+bL*.22} Q${eLX} ${bY-bL*.18} ${eLX+bL/2} ${bY}"
            fill="none" stroke="${dark}" stroke-width="${sw*1.3}" stroke-linecap="round"/>
      <path d="M${eRX-bL/2} ${bY} Q${eRX} ${bY-bL*.18} ${eRX+bL/2} ${bY+bL*.22}"
            fill="none" stroke="${dark}" stroke-width="${sw*1.3}" stroke-linecap="round"/>`;
    // 입: 약간 벌린 역호
    mouthEl = `
      <path d="M${cx-headR*.20} ${headCy+headR*.42} Q${cx} ${headCy+headR*.58} ${cx+headR*.20} ${headCy+headR*.42}"
            fill="none" stroke="${dark}" stroke-width="${sw}" stroke-linecap="round"/>`;
    // 팔: 양팔 번쩍 (OH NO! 포즈)
    armsEl = `
      <line x1="${cx-bodyW*.47}" y1="${bodyTop+bodyH*.28}"
            x2="${cx-bodyW*.80}" y2="${bodyTop-bodyH*.12}"
            stroke="${suit}" stroke-width="${sw*3.8}" stroke-linecap="round"/>
      <circle cx="${cx-bodyW*.80}" cy="${bodyTop-bodyH*.12}" r="${h*.047}"
              fill="${fur}" stroke="${dark}" stroke-width="${sw}"/>
      <line x1="${cx+bodyW*.47}" y1="${bodyTop+bodyH*.28}"
            x2="${cx+bodyW*.80}" y2="${bodyTop-bodyH*.12}"
            stroke="${suit}" stroke-width="${sw*3.8}" stroke-linecap="round"/>
      <circle cx="${cx+bodyW*.80}" cy="${bodyTop-bodyH*.12}" r="${h*.047}"
              fill="${fur}" stroke="${dark}" stroke-width="${sw}"/>`;

  } else if (pose === 'hero') {
    // 눈: 반짝이 눈
    eyesEl = `
      <ellipse cx="${eLX}" cy="${eY}" rx="${eW*1.1}" ry="${eH*1.15}" fill="${dark}"/>
      <ellipse cx="${eRX}" cy="${eY}" rx="${eW*1.1}" ry="${eH*1.15}" fill="${dark}"/>
      <circle  cx="${eLX-eW*.26}" cy="${eY-eH*.28}" r="${eW*.34}" fill="white"/>
      <circle  cx="${eRX-eW*.26}" cy="${eY-eH*.28}" r="${eW*.34}" fill="white"/>
      <circle  cx="${eLX+eW*.18}" cy="${eY+eH*.12}" r="${eW*.18}" fill="white"/>
      <circle  cx="${eRX+eW*.18}" cy="${eY+eH*.12}" r="${eW*.18}" fill="white"/>`;
    // 눈썹: 자신감 (살짝 치켜올림)
    browsEl = `
      <path d="M${eLX-bL/2} ${bY+bL*.05} Q${eLX} ${bY-bL*.28} ${eLX+bL/2} ${bY+bL*.05}"
            fill="none" stroke="${dark}" stroke-width="${sw*1.4}" stroke-linecap="round"/>
      <path d="M${eRX-bL/2} ${bY+bL*.05} Q${eRX} ${bY-bL*.28} ${eRX+bL/2} ${bY+bL*.05}"
            fill="none" stroke="${dark}" stroke-width="${sw*1.4}" stroke-linecap="round"/>`;
    // 입: 크게 웃음 + 이빨
    mouthEl = `
      <path d="M${cx-headR*.30} ${headCy+headR*.36} Q${cx} ${headCy+headR*.64} ${cx+headR*.30} ${headCy+headR*.36}"
            fill="#BB3333" stroke="${dark}" stroke-width="${sw*.9}"/>
      <rect  x="${cx-headR*.24}" y="${headCy+headR*.36}" width="${headR*.48}" height="${headR*.15}" fill="white"/>`;
    // 오른팔 주먹 들어올림, 왼팔 앞으로
    armsEl = `
      <line x1="${cx+bodyW*.46}" y1="${bodyTop+bodyH*.26}"
            x2="${cx+bodyW*.82}" y2="${bodyTop-bodyH*.32}"
            stroke="${suit}" stroke-width="${sw*3.8}" stroke-linecap="round"/>
      <rect  x="${cx+bodyW*.76}" y="${bodyTop-bodyH*.46}" width="${h*.12}" height="${h*.105}"
             rx="${h*.026}" fill="${fur}" stroke="${dark}" stroke-width="${sw}"/>
      <line x1="${cx-bodyW*.46}" y1="${bodyTop+bodyH*.26}"
            x2="${cx-bodyW*.86}" y2="${bodyTop+bodyH*.42}"
            stroke="${suit}" stroke-width="${sw*3.8}" stroke-linecap="round"/>
      <circle cx="${cx-bodyW*.86}" cy="${bodyTop+bodyH*.42}" r="${h*.047}"
              fill="${fur}" stroke="${dark}" stroke-width="${sw}"/>`;

  } else { // happy
    // 눈: 초승달 (^_^)
    eyesEl = `
      <path d="M${eLX-eW} ${eY} Q${eLX} ${eY-eH*1.45} ${eLX+eW} ${eY}"
            fill="${dark}"/>
      <path d="M${eRX-eW} ${eY} Q${eRX} ${eY-eH*1.45} ${eRX+eW} ${eY}"
            fill="${dark}"/>`;
    browsEl = `
      <path d="M${eLX-bL/2} ${bY+bL*.08} Q${eLX} ${bY-bL*.22} ${eLX+bL/2} ${bY+bL*.08}"
            fill="none" stroke="${dark}" stroke-width="${sw*1.4}" stroke-linecap="round"/>
      <path d="M${eRX-bL/2} ${bY+bL*.08} Q${eRX} ${bY-bL*.22} ${eRX+bL/2} ${bY+bL*.08}"
            fill="none" stroke="${dark}" stroke-width="${sw*1.4}" stroke-linecap="round"/>`;
    mouthEl = `
      <path d="M${cx-headR*.32} ${headCy+headR*.36} Q${cx} ${headCy+headR*.66} ${cx+headR*.32} ${headCy+headR*.36}"
            fill="#BB3333" stroke="${dark}" stroke-width="${sw*.9}"/>
      <rect  x="${cx-headR*.26}" y="${headCy+headR*.36}" width="${headR*.52}" height="${headR*.15}" fill="white"/>`;
    // 오른팔 엄지 척, 왼팔은 자연스럽게
    armsEl = `
      <line x1="${cx+bodyW*.46}" y1="${bodyTop+bodyH*.26}"
            x2="${cx+bodyW*.86}" y2="${bodyTop+bodyH*.06}"
            stroke="${suit}" stroke-width="${sw*3.8}" stroke-linecap="round"/>
      <rect  x="${cx+bodyW*.83}" y="${bodyTop+bodyH*.03}" width="${h*.105}" height="${h*.09}"
             rx="${h*.022}" fill="${fur}" stroke="${dark}" stroke-width="${sw}"/>
      <rect  x="${cx+bodyW*.83}" y="${bodyTop-bodyH*.07}" width="${h*.068}" height="${h*.11}"
             rx="${h*.022}" fill="${fur}" stroke="${dark}" stroke-width="${sw}"/>
      <line x1="${cx-bodyW*.46}" y1="${bodyTop+bodyH*.26}"
            x2="${cx-bodyW*.62}" y2="${bodyTop+bodyH*.62}"
            stroke="${suit}" stroke-width="${sw*3.8}" stroke-linecap="round"/>
      <circle cx="${cx-bodyW*.62}" cy="${bodyTop+bodyH*.62}" r="${h*.047}"
              fill="${fur}" stroke="${dark}" stroke-width="${sw}"/>`;
  }

  // ── 공통: 다리, 꼬리, 몸통, 머리 ──
  return `
    ${armsEl}
    <path d="M${cx+bodyW*.47} ${bodyTop+bodyH*.62} Q${cx+bodyW*.88} ${bodyTop+bodyH*.28} ${cx+bodyW*.72} ${bodyTop-bodyH*.08}"
          fill="none" stroke="${fur}" stroke-width="${sw*4.5}" stroke-linecap="round"/>
    <rect x="${cx-bodyW/2}" y="${bodyTop}" width="${bodyW}" height="${bodyH}"
          rx="${h*.036}" fill="${suit}" stroke="${dark}" stroke-width="${sw*1.9}"/>
    <path d="M${cx-bodyW*.50} ${bodyTop} L${cx-bodyW*.13} ${bodyTop} L${cx} ${bodyTop+bodyH*.19} L${cx+bodyW*.13} ${bodyTop} L${cx+bodyW*.50} ${bodyTop}"
          fill="none" stroke="${dark}" stroke-width="${sw*.9}"/>
    <polygon points="${cx},${bodyTop+bodyH*.04} ${cx-bodyW*.085},${bodyTop+bodyH*.13} ${cx},${bodyTop+bodyH*.52} ${cx+bodyW*.085},${bodyTop+bodyH*.13}"
             fill="${tie}" stroke="${dark}" stroke-width="${sw*.85}"/>
    <rect x="${cx-bodyW*.28}" y="${bodyTop+bodyH*.90}" width="${bodyW*.24}" height="${legH*.92}"
          rx="${h*.022}" fill="${suit}" stroke="${dark}" stroke-width="${sw}"/>
    <rect x="${cx+bodyW*.04}" y="${bodyTop+bodyH*.90}" width="${bodyW*.24}" height="${legH*.92}"
          rx="${h*.022}" fill="${suit}" stroke="${dark}" stroke-width="${sw}"/>
    <ellipse cx="${cx-bodyW*.16}" cy="${cy}" rx="${h*.072}" ry="${h*.040}" fill="${fur}" stroke="${dark}" stroke-width="${sw}"/>
    <ellipse cx="${cx+bodyW*.16}" cy="${cy}" rx="${h*.072}" ry="${h*.040}" fill="${fur}" stroke="${dark}" stroke-width="${sw}"/>
    <circle cx="${cx}" cy="${headCy}" r="${headR}" fill="${fur}" stroke="${dark}" stroke-width="${sw*1.9}"/>
    <polygon points="${earLX-earBW},${earBY} ${earLX+earBW},${earBY} ${earLX},${earTY}"
             fill="${fur}" stroke="${dark}" stroke-width="${sw*1.9}"/>
    <polygon points="${earLX-earBW*.52},${earBY-headR*.04} ${earLX+earBW*.52},${earBY-headR*.04} ${earLX},${earTY+earPk*.28}"
             fill="${pink}"/>
    <polygon points="${earRX-earBW},${earBY} ${earRX+earBW},${earBY} ${earRX},${earTY}"
             fill="${fur}" stroke="${dark}" stroke-width="${sw*1.9}"/>
    <polygon points="${earRX-earBW*.52},${earBY-headR*.04} ${earRX+earBW*.52},${earBY-headR*.04} ${earRX},${earTY+earPk*.28}"
             fill="${pink}"/>
    <ellipse cx="${cx-headR*.56}" cy="${headCy+headR*.26}" rx="${headR*.22}" ry="${headR*.14}" fill="${pink}" opacity="0.55"/>
    <ellipse cx="${cx+headR*.56}" cy="${headCy+headR*.26}" rx="${headR*.22}" ry="${headR*.14}" fill="${pink}" opacity="0.55"/>
    ${browsEl}
    ${eyesEl}
    <polygon points="${cx-headR*.075},${headCy+headR*.26} ${cx+headR*.075},${headCy+headR*.26} ${cx},${headCy+headR*.36}"
             fill="${pink}" stroke="${dark}" stroke-width="${sw*.65}"/>
    <line x1="${cx-headR*.12}" y1="${headCy+headR*.31}" x2="${cx-headR*.74}" y2="${headCy+headR*.23}" stroke="${dark}" stroke-width="${sw*.7}" opacity="0.65"/>
    <line x1="${cx-headR*.12}" y1="${headCy+headR*.34}" x2="${cx-headR*.74}" y2="${headCy+headR*.34}" stroke="${dark}" stroke-width="${sw*.7}" opacity="0.65"/>
    <line x1="${cx-headR*.12}" y1="${headCy+headR*.37}" x2="${cx-headR*.74}" y2="${headCy+headR*.45}" stroke="${dark}" stroke-width="${sw*.7}" opacity="0.65"/>
    <line x1="${cx+headR*.12}" y1="${headCy+headR*.31}" x2="${cx+headR*.74}" y2="${headCy+headR*.23}" stroke="${dark}" stroke-width="${sw*.7}" opacity="0.65"/>
    <line x1="${cx+headR*.12}" y1="${headCy+headR*.34}" x2="${cx+headR*.74}" y2="${headCy+headR*.34}" stroke="${dark}" stroke-width="${sw*.7}" opacity="0.65"/>
    <line x1="${cx+headR*.12}" y1="${headCy+headR*.37}" x2="${cx+headR*.74}" y2="${headCy+headR*.45}" stroke="${dark}" stroke-width="${sw*.7}" opacity="0.65"/>
    ${mouthEl}`;
}

/**
 * 패널 크기에 맞게 고양이 캐릭터를 SVG 버퍼로 반환.
 * Sharp composite에 직접 사용 가능.
 */
function buildCatCharacterLayer(panelType, panelW, panelH) {
  const configs = {
    problem:  { pose: 'worried',    cx: panelW * 0.71, cy: panelH * 0.88, h: panelH * 0.43 },
    hero:     { pose: 'hero',       cx: panelW * 0.50, cy: panelH * 0.84, h: panelH * 0.72 },
    solution: { pose: 'happy',      cx: panelW * 0.30, cy: panelH * 0.85, h: panelH * 0.56 },
  };
  const { pose, cx, cy, h } = configs[panelType] ?? configs.hero;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${panelW}" height="${panelH}">
      ${catCharacterSvg(pose, cx, cy, h)}
    </svg>`,
  );
}

/** 사운드 이펙트 SVG (POW! / BOOM! / PERFECT!) */
function soundFxSvg(cfg) {
  const { text, textColor, bgColor, cx, cy, size, angle } = cfg;
  const burst = starburstPath(cx, cy, size * 0.82, size * 1.48, 14);
  const sw    = Math.max(6, Math.round(size * 0.11));
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <g transform="rotate(${angle}, ${cx}, ${cy})">
        <polygon points="${burst}" fill="${bgColor}" stroke="black" stroke-width="7"/>
        <text x="${cx}" y="${cy + size * 0.36}"
          font-family="Impact,'Arial Black',sans-serif"
          font-size="${size}" font-weight="900"
          fill="${textColor}" stroke="black" stroke-width="${sw}"
          text-anchor="middle" paint-order="stroke">${esc(text)}</text>
      </g>
    </svg>`
  );
}

/** 하단 캡션 바 */
function captionBarSvg(text) {
  const lines   = wrapKorean(text, 18);
  const fontSize = 50, lineH = 66, padV = 24;
  const barH    = lines.length * lineH + padV * 2;
  const textEls = lines.map((line, i) =>
    `<text x="${W / 2}" y="${padV + (i + 0.83) * lineH}"
      font-family="${FONT}" font-size="${fontSize}" font-weight="bold"
      fill="white" stroke="black" stroke-width="5" paint-order="stroke"
      text-anchor="middle">${esc(line)}</text>`
  ).join('');
  return {
    barH,
    barY: H - barH,
    svg: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${barH}">
        <rect width="${W}" height="${barH}" fill="black" opacity="0.78"/>
        ${textEls}
      </svg>`
    ),
  };
}

/** 굵은 패널 테두리 */
function borderSvg(bw = 16) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect x="${bw / 2}" y="${bw / 2}" width="${W - bw}" height="${H - bw}"
        fill="none" stroke="black" stroke-width="${bw}"/>
    </svg>`
  );
}

// ── 패널 전용 SVG 배경 생성 ──────────────────────────────────────────────────
// 외부 이미지 API 없이 코믹북 스타일 배경을 순수 SVG로 생성

/** Panel 1: 빨간 사선 해칭 배경 (위기/문제) */
function problemBgSvg(w, h) {
  const stripes = [];
  for (let i = -h; i < w + h; i += 36)
    stripes.push(
      `<line x1="${i}" y1="0" x2="${i + h}" y2="${h}" stroke="#000" stroke-width="12" opacity="0.20"/>`,
    );
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs>
        <radialGradient id="rg" cx="40%" cy="65%" r="70%">
          <stop offset="0%"   stop-color="#8B0000" stop-opacity="0.70"/>
          <stop offset="100%" stop-color="#CC1111" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="#CC1111"/>
      <rect width="${w}" height="${h}" fill="url(#rg)"/>
      <g>${stripes.join('')}</g>
    </svg>`,
  );
}

/** Panel 2: 검정 바탕 + 황금 방사선 (영웅 등장) */
function heroBgSvg(w, h) {
  const cx = w * 0.5, cy = h * 0.40;
  const lines = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const r1 = 160, r2 = Math.hypot(w, h) * 0.92;
    const thick = i % 5 === 0 ? 7 : i % 2 === 0 ? 3.5 : 1.8;
    const op    = i % 5 === 0 ? 0.95 : i % 2 === 0 ? 0.65 : 0.40;
    lines.push(
      `<line x1="${(cx + Math.cos(a) * r1).toFixed(1)}" y1="${(cy + Math.sin(a) * r1).toFixed(1)}"
             x2="${(cx + Math.cos(a) * r2).toFixed(1)}" y2="${(cy + Math.sin(a) * r2).toFixed(1)}"
             stroke="#FFD700" stroke-width="${thick}" opacity="${op}"/>`,
    );
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs>
        <radialGradient id="hg" cx="50%" cy="40%" r="55%">
          <stop offset="0%"   stop-color="#FFE040" stop-opacity="0.50"/>
          <stop offset="60%"  stop-color="#FF7700" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#09071A" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="#09071A"/>
      <rect width="${w}" height="${h}" fill="url(#hg)"/>
      <g>${lines.join('')}</g>
    </svg>`,
  );
}

/** Panel 3: 초록 배경 + 별 스파클 (해결/성공) */
function solutionBgSvg(w, h) {
  const positions = [
    [0.12,0.10],[0.80,0.07],[0.52,0.17],[0.22,0.52],[0.68,0.44],
    [0.08,0.76],[0.86,0.68],[0.42,0.80],[0.64,0.92],[0.28,0.32],
    [0.92,0.28],[0.50,0.48],[0.06,0.43],[0.76,0.83],[0.38,0.13],
    [0.90,0.55],[0.18,0.88],[0.60,0.60],[0.32,0.70],[0.75,0.22],
  ];
  const sparkles = positions.map(([rx, ry], idx) => {
    const x  = rx * w, y = ry * h;
    const s  = 12 + (idx % 5) * 6;
    const op = (0.35 + (idx % 4) * 0.15).toFixed(2);
    return `<polygon points="${starburstPath(x, y, s * 0.38, s, 4)}"
      fill="white" opacity="${op}" transform="rotate(45,${x},${y})"/>`;
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs>
        <radialGradient id="sg" cx="50%" cy="38%" r="62%">
          <stop offset="0%"   stop-color="#50FF99" stop-opacity="0.60"/>
          <stop offset="100%" stop-color="#009940" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="#00A843"/>
      <rect width="${w}" height="${h}" fill="url(#sg)"/>
      <g>${sparkles.join('')}</g>
    </svg>`,
  );
}

const PANEL_BG_FN = { problem: problemBgSvg, hero: heroBgSvg, solution: solutionBgSvg };

// ── 패널 설정 ────────────────────────────────────────────────────────────────

const PANEL_CFG = {
  problem: {
    sfxText: 'OH NO!',   sfxTextColor: 'white',  sfxBgColor: '#DD0000',
    sfxCx: W * 0.74, sfxCy: H * 0.14, sfxSize: 112, sfxAngle: -10,
    speedLines: false,
  },
  hero: {
    sfxText: 'BOOM!',    sfxTextColor: 'black',  sfxBgColor: '#FFD700',
    sfxCx: W * 0.76, sfxCy: H * 0.12, sfxSize: 134, sfxAngle: 9,
    speedLines: true,
  },
  solution: {
    sfxText: 'PERFECT!', sfxTextColor: 'white',  sfxBgColor: '#00AA44',
    sfxCx: W * 0.71, sfxCy: H * 0.13, sfxSize: 100, sfxAngle: -7,
    speedLines: false,
  },
};

// ── 이미지 로더 ───────────────────────────────────────────────────────────────

async function loadImageBuf(src) {
  if (!src) return null;
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const res = await axios.get(src, { responseType: 'arraybuffer', timeout: 30000 });
    return Buffer.from(res.data);
  }
  return fs.readFile(src);
}

// ── Grok Aurora 이미지 생성 ──────────────────────────────────────────────────

const PANEL_PEXELS_QUERY = {
  problem:  (kw) => `${kw} problem struggle discomfort`,
  hero:     (kw) => `${kw} product solution cool`,
  solution: (kw) => `happy satisfied person outdoor summer`,
};

/**
 * AI 이미지 생성 (마블 코믹 스타일 장면)
 * Gemini Flash → Grok Aurora → DALL-E 3 순으로 시도
 * @returns {{ path: string, isAI: boolean } | null}
 */
async function generateComicImage(prompt, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const geminiKey = config.gemini?.apiKey ?? process.env.GEMINI_API_KEY;

  // 1순위: Gemini Flash 네이티브 이미지 생성 (responseModalities: IMAGE)
  // 동일 API 키로 텍스트 모델처럼 호출 — 별도 과금 없이 Imagen보다 접근 쉬움
  if (geminiKey) {
    const flashModels = [
      'gemini-2.5-flash-image',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-image-preview',
    ];
    for (const model of flashModels) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            contents: [{ parts: [{ text: prompt.slice(0, 4000) }] }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 120000 },
        );
        const parts = res.data.candidates?.[0]?.content?.parts ?? [];
        const img   = parts.find((p) => p.inlineData?.data);
        if (img?.inlineData?.data) {
          await fs.writeFile(outputPath, Buffer.from(img.inlineData.data, 'base64'));
          logger.info(`[comic] Gemini Flash (${model}) 이미지 생성 성공`);
          return { path: outputPath, isAI: true };
        }
      } catch (e) {
        const status = e.response?.status ?? 'ERR';
        const msg    = e.response?.data?.error?.message ?? e.message;
        logger.warn(`[comic] Gemini Flash (${model}) 실패 (${status}): ${msg}`);
        if (status !== 404 && status !== 400) break;
      }
    }
  }

  // 2순위: Grok Aurora (여러 모델명 시도)
  const grokKey = config.grok?.apiKey;
  if (grokKey) {
    for (const model of ['grok-2-image-1212', 'aurora', 'grok-2-aurora', 'grok-2-image']) {
      try {
        const res = await axios.post(
          'https://api.x.ai/v1/images/generations',
          { model, prompt, n: 1 },
          { headers: { Authorization: `Bearer ${grokKey}`, 'Content-Type': 'application/json' }, timeout: 120000 },
        );
        const item = res.data.data?.[0];
        if (!item) continue;
        if (item.b64_json) {
          await fs.writeFile(outputPath, Buffer.from(item.b64_json, 'base64'));
          logger.info(`[comic] Grok (${model}) 이미지 생성 성공`);
          return { path: outputPath, isAI: true };
        }
        if (item.url) {
          const img = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000 });
          await fs.writeFile(outputPath, Buffer.from(img.data));
          logger.info(`[comic] Grok (${model}) 이미지 생성 성공 (URL)`);
          return { path: outputPath, isAI: true };
        }
      } catch (e) {
        const status = e.response?.status ?? 'ERR';
        const detail = e.response?.data?.error?.message ?? e.response?.data?.message ?? e.message;
        logger.warn(`[comic] Grok (${model}) 실패 (${status}): ${detail}`);
        if (status !== 404 && status !== 422) break;
      }
    }
  }

  // 3순위: DALL-E 3
  if (config.openai?.apiKey) {
    try {
      const res = await axios.post(
        'https://api.openai.com/v1/images/generations',
        { model: 'dall-e-3', prompt: prompt.slice(0, 4000), n: 1, size: '1024x1792', quality: 'standard' },
        { headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 120000 },
      );
      const item = res.data.data?.[0];
      if (item?.b64_json) {
        await fs.writeFile(outputPath, Buffer.from(item.b64_json, 'base64'));
        logger.info('[comic] DALL-E 3 이미지 생성 성공');
        return { path: outputPath, isAI: true };
      }
      if (item?.url) {
        const img = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000 });
        await fs.writeFile(outputPath, Buffer.from(img.data));
        logger.info('[comic] DALL-E 3 이미지 생성 성공 (URL)');
        return { path: outputPath, isAI: true };
      }
    } catch (e) {
      logger.warn(`[comic] DALL-E 3 실패: ${e.response?.data?.error?.message ?? e.message}`);
    }
  }

  // 4순위: Gemini Imagen (유료 플랜 필요)
  if (geminiKey) {
    for (const model of ['imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001', 'imagen-3.0-generate-002']) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${geminiKey}`,
          { instances: [{ prompt: prompt.slice(0, 4000) }], parameters: { sampleCount: 1, aspectRatio: '9:16' } },
          { headers: { 'Content-Type': 'application/json' }, timeout: 120000 },
        );
        const b64 = res.data.predictions?.[0]?.bytesBase64Encoded;
        if (b64) {
          await fs.writeFile(outputPath, Buffer.from(b64, 'base64'));
          logger.info(`[comic] Gemini Imagen (${model}) 이미지 생성 성공`);
          return { path: outputPath, isAI: true };
        }
      } catch (e) {
        logger.warn(`[comic] Gemini Imagen (${model}) 실패: ${e.response?.data?.error?.message ?? e.message}`);
      }
    }
  }

  return null; // 모든 AI 실패 → SVG 폴백
}

// ── TTS ───────────────────────────────────────────────────────────────────────

async function generateComicAudio(text, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const { clientId, clientSecret, speaker, speed, pitch, volume } = config.clovaVoice;
  if (clientId && clientSecret) {
    const params = new URLSearchParams({
      speaker, volume: String(volume), speed: String(speed), pitch: String(pitch),
      format: 'mp3', text: text.slice(0, 2000),
    });

    // 1순위: 네이버 developers.naver.com Clova Voice (X-Naver-Client-Id)
    try {
      const res = await axios.post(
        'https://openapi.naver.com/v1/voice/tts.bin',
        params.toString(),
        {
          headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          responseType: 'arraybuffer', timeout: 60000,
        }
      );
      if (res.data.byteLength > 500) {
        await fs.writeFile(outputPath, Buffer.from(res.data));
        logger.info('[comic] TTS: Clova Voice (naver) 성공');
        return outputPath;
      }
    } catch (e) {
      logger.warn(`[comic] ClovaVoice (naver) 실패: ${e.response?.status ?? e.message}`);
    }

    // 2순위: NCP Clova Voice Premium (X-NCP-APIGW-API-KEY-ID)
    try {
      const res = await axios.post(
        'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts',
        params.toString(),
        {
          headers: {
            'X-NCP-APIGW-API-KEY-ID': clientId, 'X-NCP-APIGW-API-KEY': clientSecret,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          responseType: 'arraybuffer', timeout: 60000,
        }
      );
      if (res.data.byteLength > 500) {
        await fs.writeFile(outputPath, Buffer.from(res.data));
        logger.info('[comic] TTS: Clova Voice (NCP) 성공');
        return outputPath;
      }
    } catch (e) {
      logger.warn(`[comic] ClovaVoice (NCP) 실패: ${e.response?.status ?? e.message}`);
    }
  }

  // 3순위: ElevenLabs
  if (config.elevenlabs?.apiKey) {
    try {
      const res = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}`,
        { text: text.slice(0, 5000), model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.32, similarity_boost: 0.80, style: 0.58, use_speaker_boost: true } },
        {
          headers: { 'xi-api-key': config.elevenlabs.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          responseType: 'arraybuffer', timeout: 60000,
        }
      );
      await fs.writeFile(outputPath, Buffer.from(res.data));
      return outputPath;
    } catch (e) {
      logger.warn(`[comic] ElevenLabs 실패: ${e.message}`);
    }
  }

  // 4순위: OpenAI TTS
  if (config.openai?.apiKey) {
    try {
      const voice = process.env.OPENAI_TTS_VOICE || 'onyx';
      const res = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        { model: 'tts-1', input: text.slice(0, 4096), voice },
        {
          headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
          responseType: 'arraybuffer', timeout: 60000,
        },
      );
      await fs.writeFile(outputPath, Buffer.from(res.data));
      logger.info('[comic] TTS: OpenAI 성공');
      return outputPath;
    } catch (e) {
      logger.warn(`[comic] OpenAI TTS 실패: ${e.response?.status ?? e.message}`);
    }
  }

  // 5순위: ffmpeg 30초 무음 (모든 TTS 실패 시 — 영상 구조 완성 목적)
  logger.warn('[comic] TTS 모든 서비스 실패 → ffmpeg 무음 오디오 생성');
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '30',
    '-c:a', 'libmp3lame', '-b:a', '128k', '-y', outputPath,
  ]);
  logger.warn('[comic] 무음 오디오 생성됨 — TTS API 키를 확인하세요');
  return outputPath;
}

// ── 오디오 길이 측정 ──────────────────────────────────────────────────────────

async function getAudioDuration(audioPath) {
  try {
    const { stderr } = await execFileAsync(ffmpegPath, ['-i', audioPath], { encoding: 'utf8' }).catch(e => ({ stderr: e.stderr ?? '' }));
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  } catch {}
  return 30;
}

// ── 매읽남 캐릭터 에셋 로드/생성 ──────────────────────────────────────────────

async function loadOrGenerateCharacter() {
  try {
    await fs.access(CHARACTER_ASSET);
    logger.info('[comic] 매읽남 캐릭터 에셋 로드 (캐시)');
    return CHARACTER_ASSET;
  } catch {}

  // 에셋 없으면 생성 시도
  await fs.mkdir(path.dirname(CHARACTER_ASSET), { recursive: true });
  logger.info('[comic] 매읽남 캐릭터 생성 중...');
  const heroPrompt =
    MAEILNAMJA_COMIC_BASE +
    ' Full body, triumphant hero pose: one fist raised high, confident big smile. ' +
    'Pure white background. Tall portrait 9:16. No text, no speech bubbles.';
  const tmpPath = CHARACTER_ASSET + '.tmp';
  const result  = await generateComicImage(heroPrompt, tmpPath, 'white cat mascot character');
  if (result) {
    try { await fs.rename(tmpPath, CHARACTER_ASSET); } catch { await fs.copyFile(tmpPath, CHARACTER_ASSET); }
    logger.info('[comic] 매읽남 캐릭터 에셋 저장 완료');
    return CHARACTER_ASSET;
  }
  return null;
}


// ── 단일 패널 렌더링 ──────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string|null}  opts.aiBgSrc         - AI 생성 배경 이미지 (있을 때만 텍스처로 사용)
 * @param {string|null}  opts.productImageSrc  - 제품 이미지 (히어로 패널용)
 * @param {string|null}  opts.characterImageSrc - 매읽남 캐릭터 PNG 경로
 * @param {'problem'|'hero'|'solution'} opts.panelType
 * @param {string}       opts.captionText      - 하단 캡션
 * @param {string}       opts.outputPath
 */
async function renderPanel({ aiBgSrc, isAI, productImageSrc, panelType, captionText, outputPath }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const cfg = PANEL_CFG[panelType] ?? PANEL_CFG.hero;
  const composites = [];
  let baseBuf;

  if (aiBgSrc && isAI) {
    // ━━ AI 성공 경로 ━━
    // AI가 마블 스타일 장면 전체를 그렸으므로 그것이 메인 비주얼.
    // SVG 효과(Ben-Day dots, SFX, 캡션, 테두리)만 얹는다.
    const raw = await loadImageBuf(aiBgSrc);
    baseBuf = await sharp(raw).resize(W, H, { fit: 'cover', position: 'centre' }).png().toBuffer();
    // AI 이미지 위에 Ben-Day dots
    composites.push({ input: benDaySvg(W, H, 0.05), top: 0, left: 0 });
  } else {
    // ━━ 폴백 경로 ━━
    // SVG 배경 + 코드로 그린 고양이 캐릭터
    const bgFn = PANEL_BG_FN[panelType] ?? heroBgSvg;
    baseBuf = await sharp(bgFn(W, H)).resize(W, H).png().toBuffer();
    composites.push({ input: benDaySvg(W, H), top: 0, left: 0 });
    if (cfg.speedLines) {
      composites.push({ input: speedLinesSvg(W * 0.5, H * 0.40), top: 0, left: 0 });
    }
    // SVG 고양이 캐릭터 (코드로 직접 드로잉)
    composites.push({ input: buildCatCharacterLayer(panelType, W, H), top: 0, left: 0 });
  }

  // ⑥ 제품 이미지 원형 배지 (히어로 패널 우측 하단)
  if (productImageSrc && panelType === 'hero') {
    try {
      const prodBuf   = await loadImageBuf(productImageSrc);
      const DIAM = 380, PROD_SZ = 320;
      const circleSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${DIAM}" height="${DIAM}">
          <circle cx="${DIAM / 2}" cy="${DIAM / 2}" r="${DIAM / 2 - 10}"
            fill="white" stroke="#FFD700" stroke-width="16"/>
        </svg>`,
      );
      const prodResized = await sharp(prodBuf)
        .resize(PROD_SZ, PROD_SZ, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .png().toBuffer();
      const badge = await sharp(circleSvg)
        .composite([{ input: prodResized, left: (DIAM - PROD_SZ) >> 1, top: (DIAM - PROD_SZ) >> 1 }])
        .png().toBuffer();
      composites.push({ input: badge, left: W - DIAM - 24, top: Math.round(H * 0.60) });
    } catch (e) {
      logger.warn(`[comic] Product badge skipped: ${e.message}`);
    }
  }

  // ⑦ 캡션 바
  const { barY, svg: captionSvg } = captionBarSvg(captionText);
  composites.push({ input: captionSvg, left: 0, top: barY });

  // ⑧ 사운드 이펙트 (OH NO! / BOOM! / PERFECT!)
  composites.push({
    input: soundFxSvg({
      text:      cfg.sfxText,
      textColor: cfg.sfxTextColor,
      bgColor:   cfg.sfxBgColor,
      cx: cfg.sfxCx, cy: cfg.sfxCy, size: cfg.sfxSize, angle: cfg.sfxAngle,
    }),
    top: 0, left: 0,
  });

  // ⑨ 테두리
  composites.push({ input: borderSvg(), top: 0, left: 0 });

  await sharp(baseBuf).composite(composites).jpeg({ quality: 92 }).toFile(outputPath);
  logger.info(`[comic] Panel "${panelType}" rendered: ${path.basename(outputPath)}`);
  return outputPath;
}

// ── 영상 렌더링 ───────────────────────────────────────────────────────────────

async function renderComicVideo({ panelPaths, audioPath, outputPath }) {
  const tmpDir = path.resolve(path.dirname(outputPath), `tmp_comic_${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const audioDur  = await getAudioDuration(audioPath);
    const perPanel  = audioDur / panelPaths.length;

    // 각 패널 → 무음 클립
    const clipPaths = [];
    for (let i = 0; i < panelPaths.length; i++) {
      const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
      await execFileAsync(ffmpegPath, [
        '-loop', '1', '-t', String(perPanel.toFixed(3)),
        '-i', panelPaths[i],
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-c:v', 'libx264', '-c:a', 'aac',
        '-pix_fmt', 'yuv420p', '-r', '24',
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-preset', 'fast', '-shortest', '-y', clipPath,
      ]);
      clipPaths.push(clipPath);
    }

    // 클립 이어 붙이기
    const concatTxt  = path.join(tmpDir, 'concat.txt');
    await fs.writeFile(concatTxt, clipPaths.map(p => `file '${p}'`).join('\n'));
    const silentPath = path.join(tmpDir, 'silent.mp4');
    await execFileAsync(ffmpegPath, [
      '-f', 'concat', '-safe', '0', '-i', concatTxt,
      '-c', 'copy', '-y', silentPath,
    ]);

    // 오디오 합성
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await execFileAsync(ffmpegPath, [
      '-i', silentPath, '-i', audioPath,
      '-c:v', 'copy', '-c:a', 'aac',
      '-shortest', '-y', outputPath,
    ]);

    logger.info(`[comic] Video rendered: ${path.basename(outputPath)} (${audioDur.toFixed(1)}s)`);
    return outputPath;

  } finally {
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── 썸네일 생성 ───────────────────────────────────────────────────────────────

async function renderComicThumbnail({ heroPanelPath, title, outputPath }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const W16 = 1280, H16 = 720, LEFT = 640, RIGHT = 640;
  const heroBuf = await sharp(await loadImageBuf(heroPanelPath))
    .resize(RIGHT, H16, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  const lines = wrapKorean(title, 10);
  const fs_ = Math.min(100, Math.floor(560 / Math.max(...lines.map(l => [...l].length), 1)));
  const lineH = Math.round(fs_ * 1.3);
  const textEls = lines.map((line, i) =>
    `<text x="36" y="${H16 / 2 - ((lines.length - 1) * lineH / 2) + i * lineH + fs_ * 0.35}"
      font-family="${FONT}" font-size="${fs_}" font-weight="bold"
      fill="white" stroke="black" stroke-width="${Math.round(fs_ * 0.12)}" paint-order="stroke"
    >${esc(line)}</text>`
  ).join('');

  const leftSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LEFT}" height="${H16}">
      <rect width="${LEFT}" height="${H16}" fill="#0a1228"/>
      <rect x="0" y="0" width="8" height="${H16}" fill="#FFD700"/>
      ${textEls}
      <text x="36" y="${H16 - 40}" font-family="${FONT}" font-size="28" fill="#FFD700"
        stroke="black" stroke-width="3" paint-order="stroke">🛒 쿠팡 최저가 링크 아래 ↓</text>
    </svg>`
  );

  await sharp({ create: { width: W16, height: H16, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } } })
    .composite([
      { input: leftSvg,  left: 0,    top: 0 },
      { input: heroBuf,  left: LEFT, top: 0 },
    ])
    .jpeg({ quality: 94 })
    .toFile(outputPath);

  logger.info(`[comic] Thumbnail saved: ${path.basename(outputPath)}`);
  return outputPath;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

/**
 * 제품 하나에 대한 코믹스 영상 전체 생성
 * @param {object} content - createShoppingComicContent()가 반환한 content 객체
 * @param {string} outputDir - 출력 디렉토리
 */
export async function generateComicMedia(content, outputDir) {
  const safe    = (content.keyword ?? 'product').replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const story   = content.panel_story;
  const script  = content.shortform_script;
  const ttsText = [script.hook, script.context, script.insight, script.summary, script.cta]
    .filter(Boolean).join(' ');

  await fs.mkdir(outputDir, { recursive: true });

  // ① TTS 오디오
  const audioPath = path.join(outputDir, `${safe}_comic_audio.mp3`);
  logger.info(`[comic] TTS 생성 중: ${content.keyword}`);
  await generateComicAudio(ttsText, audioPath);

  // ③ 3패널 — AI 이미지 생성 (마블 엔딩 크레딧 스타일)
  // 성공하면 AI 이미지가 완성된 장면 전체 / 실패하면 SVG 배경 + 코드 캐릭터
  const panelTypes = ['problem', 'hero', 'solution'];
  const aiBgResults = [];

  // 고양이 캐릭터 묘사 — 모든 패널에 일관된 캐릭터로 등장
  const CAT_DESC =
    'a chibi kawaii white cat professor character: large round expressive eyes, ' +
    'small pointed ears, extremely fluffy white fur, beige/tan blazer, dark navy necktie. ' +
    'Character drawn fully integrated into the scene in Marvel comic book style.';

  const MARVEL_STYLE =
    'Marvel Studios end-credit card illustration style. ' +
    'Professional comic book artwork by top Marvel illustrators. ' +
    'Bold thick black ink outlines, dynamic dramatic poses, ' +
    'vivid saturated colors, cinematic lighting and shadows, ' +
    'Ben-Day halftone dots texture throughout. ';

  const PANEL_PROMPTS = {
    problem: (scene) =>
      MARVEL_STYLE +
      `Panel mood: crisis, dread, discomfort. ` +
      `The white cat professor character (${CAT_DESC}) looks horrified or miserable — ` +
      `arms raised, sweat drops, distressed expression. ` +
      `Scene: ${scene}. ` +
      `Background: dramatic red and dark tones. NO text or letters anywhere.`,

    hero: (scene) =>
      MARVEL_STYLE +
      `Panel mood: triumphant hero entrance, explosive energy. ` +
      `The white cat professor character (${CAT_DESC}) bursts into frame heroically — ` +
      `fist raised high, confident fierce expression, golden speed lines radiating from behind. ` +
      `Character is the DOMINANT figure filling most of the frame. ` +
      `Scene: ${scene}. ` +
      `Background: deep black with gold/yellow radiating lines. NO text or letters anywhere.`,

    solution: (scene) =>
      MARVEL_STYLE +
      `Panel mood: victory, joy, celebration. ` +
      `The white cat professor character (${CAT_DESC}) gives a triumphant thumbs-up, ` +
      `big smile, eyes closed in happiness, confetti falling around. ` +
      `Scene: ${scene}. ` +
      `Background: bright green with sparkles. NO text or letters anywhere.`,
  };

  for (const type of panelTypes) {
    const imgPath     = path.join(outputDir, `${safe}_comic_bg_${type}.jpg`);
    const panel       = story[type];
    const comicPrompt = (PANEL_PROMPTS[type] ?? PANEL_PROMPTS.hero)(panel.scene_prompt);

    logger.info(`[comic] AI 이미지 생성 (${type}): ${content.keyword}`);
    const result = await generateComicImage(comicPrompt, imgPath);
    if (result) logger.info(`[comic] AI 이미지 성공 (${type}) — 마블 스타일 장면`);
    else         logger.warn(`[comic] AI 실패 (${type}) — SVG 캐릭터 폴백 사용`);
    aiBgResults.push(result);
  }

  // ④ 3패널 Sharp 합성
  const panelPaths = [];
  for (let i = 0; i < panelTypes.length; i++) {
    const type      = panelTypes[i];
    const panel     = story[type];
    const panelPath = path.join(outputDir, `${safe}_comic_panel_${type}.jpg`);
    const aiResult  = aiBgResults[i];

    await renderPanel({
      aiBgSrc:         aiResult?.path ?? null,
      isAI:            aiResult?.isAI ?? false,   // true면 AI 장면이 메인 비주얼
      productImageSrc: null,
      panelType:       type,
      captionText:     panel.caption,
      outputPath:      panelPath,
    });
    panelPaths.push(panelPath);
  }

  // ④ 영상 렌더링
  const videoPath = path.join(outputDir, `${safe}_comic.mp4`);
  logger.info(`[comic] 영상 렌더링 중: ${content.keyword}`);
  await renderComicVideo({ panelPaths, audioPath, outputPath: videoPath });

  // ⑤ 썸네일 (16:9)
  const thumbPath = path.join(outputDir, `${safe}_comic_thumb.jpg`);
  await renderComicThumbnail({
    heroPanelPath: panelPaths[1],
    title: content.youtube_title ?? content.keyword,
    outputPath: thumbPath,
  });

  logger.info(`[comic] ✓ 완료: ${content.keyword}`);
  return {
    keyword:     content.keyword,
    video:       videoPath,
    thumbnail:   thumbPath,
    audio:       audioPath,
    panels:      panelPaths,
  };
}
