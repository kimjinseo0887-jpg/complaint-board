const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

const dbPath = path.join(__dirname, 'complaints.db');
const db = new DatabaseSync(dbPath);

// 기본 테이블 생성
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_secret INTEGER DEFAULT 0,
    status TEXT DEFAULT 'NORMAL',
    admin_reply TEXT DEFAULT '',
    admin_replied_at TEXT DEFAULT NULL,
    likes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
`);

// 신규 컬럼 안전하게 추가 (마이그레이션)
function addColumnIfNotExists(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    // 이미 존재하는 컬럼 무시
  }
}

addColumnIfNotExists('posts', 'author_name TEXT DEFAULT \'사용자\'');
addColumnIfNotExists('posts', 'is_admin INTEGER DEFAULT 0');
addColumnIfNotExists('posts', 'is_notice INTEGER DEFAULT 0');
addColumnIfNotExists('comments', 'author_name TEXT DEFAULT \'사용자\'');

// 인덱스 생성
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_posts_is_notice ON posts(is_notice);
  CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);
  CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
`);

// 비밀번호 단방향 해싱 유틸 (SHA-256)
function hashPassword(password) {
  if (!password) return '';
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

// 기존 데이터 중 author_name이 비어있는 경우 '사용자'로 정규화
db.exec(`
  UPDATE posts SET author_name = '사용자' WHERE author_name IS NULL OR author_name = '';
  UPDATE comments SET author_name = '사용자' WHERE author_name IS NULL OR author_name = '';
`);

// 공지사항 샘플이 없는 경우 공지사항 1개 추가
const noticeCheck = db.prepare('SELECT COUNT(*) as count FROM posts WHERE is_notice = 1').get();
if (noticeCheck && noticeCheck.count === 0) {
  const insertNotice = db.prepare(`
    INSERT INTO posts (title, content, category, author_name, is_admin, is_notice, password_hash, is_secret, status, likes, views, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date();
  const dNotice = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  insertNotice.run(
    '📢 [공지] 게시판 이용 규칙 및 운영 안내 (필독)',
    '안녕하세요. 게시판 관리자입니다.\n\n누구나 자유롭게 의견을 나누고 정보를 공유할 수 있는 열린 공간입니다.\n\n[이용 수칙 안내]\n1. 상호 존중과 배려의 언어를 사용해 주세요.\n2. 일반 사용자와 관리자 글은 뱃지(👑관리자 / 👤사용자)로 명확히 구분됩니다.\n3. 본인 글은 작성 시 설정한 4자리 비밀번호로 수정/삭제가 가능합니다.\n4. 등록일과 조회수는 목록에서 즉시 확인하실 수 있습니다.\n\n감사합니다.',
    '공지',
    '관리자',
    1, // is_admin
    1, // is_notice (상단 고정)
    hashPassword('admin1234'),
    0,
    'NOTICE',
    15,
    320,
    dNotice
  );
}

module.exports = {
  db,
  hashPassword,
};
