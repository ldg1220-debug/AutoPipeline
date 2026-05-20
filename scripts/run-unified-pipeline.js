/**
 * 콘텐츠 삼각형 파이프라인 1회 즉시 실행 스크립트
 * npm run unified        — 실제 실행
 * npm run unified:dry    — DRY_RUN (발행 없이 테스트)
 */
import { runUnifiedPipeline } from '../src/app.js';

try {
  await runUnifiedPipeline();
  process.exit(0);
} catch (err) {
  console.error('[unified] Fatal error:', err.message);
  process.exit(1);
}
