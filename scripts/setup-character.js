/**
 * 매읽남 캐릭터 에셋 설정 스크립트
 *
 * 사용법:
 *   node scripts/setup-character.js                  → 기존 pipeline 출력에서 자동 탐색
 *   node scripts/setup-character.js <이미지경로>      → 직접 이미지 파일 지정
 *
 * 결과: src/assets/maeilnamja_comic.png 저장
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sharp   = require('sharp');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ASSET_PATH  = path.resolve(__dirname, '../src/assets/maeilnamja_comic.png');
const OUTPUT_ROOT = path.resolve(__dirname, '../output');

// 기존 pipeline 출력에서 매읽남 이미지 후보 탐색
async function findExistingCharacter() {
  const candidates = [];
  try {
    const entries = await fs.readdir(OUTPUT_ROOT, { recursive: true });
    for (const entry of entries) {
      const f = typeof entry === 'string' ? entry : entry.name;
      if (
        (f.endsWith('.jpg') || f.endsWith('.png')) &&
        (f.includes('character') || f.includes('maeilnamja') || f.includes('매읽남') || f.includes('shorts_thumb'))
      ) {
        const full = path.join(OUTPUT_ROOT, f);
        try {
          const stat = await fs.stat(full);
          candidates.push({ path: full, size: stat.size, mtime: stat.mtimeMs });
        } catch {}
      }
    }
  } catch {}
  // 최신 순 정렬 후 가장 큰 파일 선택 (썸네일보다 원본이 더 큼)
  return candidates.sort((a, b) => b.mtime - a.mtime || b.size - a.size)[0]?.path ?? null;
}

async function main() {
  await fs.mkdir(path.dirname(ASSET_PATH), { recursive: true });

  const provided = process.argv[2];

  if (provided) {
    const src = path.resolve(process.cwd(), provided);
    await sharp(src).png().toFile(ASSET_PATH);
    console.log(`✅ 캐릭터 에셋 저장: ${ASSET_PATH}`);
    console.log(`   원본: ${src}`);
    return;
  }

  // 자동 탐색
  const found = await findExistingCharacter();
  if (found) {
    await sharp(found).png().toFile(ASSET_PATH);
    console.log(`✅ 캐릭터 에셋 저장: ${ASSET_PATH}`);
    console.log(`   원본: ${found}`);
  } else {
    console.log('⚠️  기존 매읽남 이미지를 찾지 못했습니다.');
    console.log('');
    console.log('다음 중 하나를 실행하세요:');
    console.log('  node scripts/setup-character.js "C:\\path\\to\\maeilnamja.jpg"');
    console.log('');
    console.log('또는 직접 파일을 복사하세요:');
    console.log(`  cp <매읽남이미지.png> ${ASSET_PATH}`);
  }
}

main().catch(console.error);
