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

export default db;
