import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/autopipeline.db');
const SCHEMA_PATH = path.resolve(__dirname, './schema.sql');

// data/ 디렉토리 보장
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 최초 실행 시 스키마 적용
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// 컬럼 추가 마이그레이션 — CREATE TABLE IF NOT EXISTS는 기존 테이블 컬럼을 추가하지 않으므로
// ALTER TABLE로 누락된 컬럼을 조용히 추가한다 (이미 있으면 에러를 무시)
const migrations = [
  `ALTER TABLE keywords ADD COLUMN used_at TEXT`,
  `ALTER TABLE keywords ADD COLUMN commercial INTEGER DEFAULT 0`,
  `ALTER TABLE keywords ADD COLUMN sources TEXT DEFAULT ''`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* 이미 존재하면 무시 */ }
}

export default db;
