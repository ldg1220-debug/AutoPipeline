/**
 * 프로젝트 전체 검수 즉시 실행 스크립트
 * npm run project:review
 */
import { runProjectManagerReview } from '../src/agents/project_manager.js';
import logger from '../src/utils/logger.js';

runProjectManagerReview().catch((err) => {
  logger.error('[project:review] 치명적 오류', { message: err.message });
  process.exit(1);
});
