/**
 * Grok API 연결 진단 스크립트
 * 실행: node scripts/test-grok-api.js
 */
import 'dotenv/config';
import axios from 'axios';

const apiKey = process.env.GROK_API_KEY;
if (!apiKey) { console.error('❌ GROK_API_KEY가 .env에 없습니다'); process.exit(1); }

console.log(`🔑 API 키 확인: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);

// 1. 사용 가능한 모델 목록 확인
console.log('\n📋 사용 가능한 모델 조회 중...');
try {
  const res = await axios.get('https://api.x.ai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 10000,
  });
  const imageModels = res.data.data?.filter(m => m.id.includes('image') || m.id.includes('vision')) ?? [];
  const allIds = res.data.data?.map(m => m.id) ?? [];
  console.log('전체 모델:', allIds.join(', '));
  console.log('이미지 관련:', imageModels.map(m => m.id).join(', ') || '(없음)');
} catch (err) {
  console.error('모델 조회 실패:', err.response?.status, JSON.stringify(err.response?.data ?? err.message));
}

// 2. 이미지 생성 테스트
console.log('\n🎨 이미지 생성 테스트 (grok-2-image-1212)...');
try {
  const res = await axios.post(
    'https://api.x.ai/v1/images/generations',
    { model: 'grok-2-image-1212', prompt: 'a simple red circle on white background', n: 1 },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  console.log('✅ 이미지 생성 성공!', JSON.stringify(res.data).slice(0, 200));
} catch (err) {
  console.error('❌ 이미지 생성 실패:', err.response?.status, JSON.stringify(err.response?.data ?? err.message));
}
