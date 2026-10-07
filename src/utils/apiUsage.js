// API 호출 사용량 기록(D-127) — 모델별 호출 수·토큰·이미지 수를 세어 실행 끝에 요약하고 output/api_usage/에 누적한다.
// axios 전역 인터셉터라 각 에이전트 코드를 건드리지 않는다(axios.post를 쓰는 OpenAI·Gemini 호출이 대상).
// 금액은 계산하지 않는다(모델별 단가가 바뀌므로) — 토큰·횟수를 단가표와 곱해 쓰세요.
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stats = new Map();   // key "provider:model" → { calls, in, out }
let installed = false;

function add(key, inTok = 0, outTok = 0, calls = 1) {
  const s = stats.get(key) ?? { calls: 0, in: 0, out: 0 };
  s.calls += calls; s.in += inTok; s.out += outTok;
  stats.set(key, s);
}

export function installApiUsageTracking(label = 'run') {
  if (installed) return;
  installed = true;
  axios.interceptors.response.use((res) => {
    try {
      const url = String(res.config?.url ?? '');
      const d = res.data;
      if (url.includes('api.openai.com/v1/chat/completions')) {
        add(`openai:${d?.model ?? 'chat'}`, d?.usage?.prompt_tokens ?? 0, d?.usage?.completion_tokens ?? 0);
      } else if (url.includes('api.openai.com/v1/images')) {
        const body = typeof res.config?.data === 'string' ? JSON.parse(res.config.data) : {};
        add(`openai-image:${body.model ?? 'image'}`, 0, 0, Array.isArray(d?.data) ? d.data.length : 1);
      } else if (url.includes('api.openai.com/v1/embeddings')) {
        add(`openai-embed:${d?.model ?? 'embedding'}`, d?.usage?.prompt_tokens ?? 0, 0);
      } else if (url.includes('generativelanguage.googleapis.com')) {
        const model = url.match(/models\/([^:/?]+)/)?.[1] ?? 'gemini';
        add(`gemini:${model}`, d?.usageMetadata?.promptTokenCount ?? 0, d?.usageMetadata?.candidatesTokenCount ?? 0);
      }
    } catch { /* 집계 실패는 무시 */ }
    return res;
  });

  process.on('exit', () => {
    if (stats.size === 0) return;
    const rows = [...stats.entries()].sort((a, b) => b[1].calls - a[1].calls);
    console.log(`\n[api-usage] ${label} — 호출 요약`);
    for (const [k, s] of rows) console.log(`  ${k.padEnd(34)} ${String(s.calls).padStart(3)}회  입력 ${s.in.toLocaleString()} · 출력 ${s.out.toLocaleString()} 토큰`);
    try {
      const dir = path.resolve(__dirname, '../../output/api_usage');
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const file = path.join(dir, `usage_${day}.jsonl`);
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), label, usage: Object.fromEntries(rows) }) + '\n');
    } catch { /* 기록 실패는 무시 */ }
  });
}
