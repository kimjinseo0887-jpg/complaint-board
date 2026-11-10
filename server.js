const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPassword } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// 관리자 기본 비밀번호 (환경변수 ADMIN_PASSWORD 또는 기본값 'admin1234')
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// 관리자 세션 토큰 저장소 (메모리)
const activeAdminTokens = new Set();

// CORS 허용 미들웨어 (Live Server, file://, 다른 포트 접속 지원)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-admin-token');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 관리자 토큰 검증 헬퍼
function isAdmin(req) {
  const token = req.headers['x-admin-token'] || req.query.admin_token || (req.body && req.body.admin_token);
  return Boolean(token && activeAdminTokens.has(token));
}

// --------------------------------------------------------------------------
// 1. 관리자 인증 API
// --------------------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomUUID();
    activeAdminTokens.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ success: false, error: '관리자 비밀번호가 일치하지 않습니다.' });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.body && req.body.admin_token);
  if (token) {
    activeAdminTokens.delete(token);
  }
  res.json({ success: true });
});

app.get('/api/admin/verify', (req, res) => {
  res.json({ isAdmin: isAdmin(req) });
});

// --------------------------------------------------------------------------
// 2. 통계 API
// --------------------------------------------------------------------------
app.get('/api/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM posts').get().count;
    const notices = db.prepare('SELECT COUNT(*) as count FROM posts WHERE is_notice = 1').get().count;
    const userPosts = db.prepare('SELECT COUNT(*) as count FROM posts WHERE is_admin = 0').get().count;
    const adminPosts = db.prepare('SELECT COUNT(*) as count FROM posts WHERE is_admin = 1').get().count;
    const totalViews = db.prepare('SELECT SUM(views) as total FROM posts').get().total || 0;

    res.json({ total, notices, userPosts, adminPosts, totalViews });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: '통계 정보를 불러오지 못했습니다.' });
  }
});

// --------------------------------------------------------------------------
// 3. 게시글 목록 조회 API (공지 상단 고정, 날짜/조회/작성자 명확화)
// --------------------------------------------------------------------------
app.get('/api/posts', (req, res) => {
  try {
    const { category, role, search, sort = 'latest' } = req.query;
    const adminMode = isAdmin(req);

    let sql = `
      SELECT 
        p.id, 
        p.title, 
        p.category, 
        p.author_name, 
        p.is_admin, 
        p.is_notice, 
        p.is_secret, 
        p.likes, 
        p.views, 
        p.created_at,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
        CASE 
          WHEN p.is_secret = 1 AND ? = 0 THEN '[비밀글입니다. 작성자와 관리자만 확인할 수 있습니다.]'
          ELSE SUBSTR(p.content, 1, 100)
        END AS preview_content
      FROM posts p
      WHERE 1=1
    `;
    const params = [adminMode ? 1 : 0];

    // 카테고리 필터
    if (category && category !== '전체') {
      sql += ' AND p.category = ?';
      params.push(category);
    }

    // 작성자 역할 필터 (사용자 / 관리자)
    if (role === 'admin') {
      sql += ' AND p.is_admin = 1';
    } else if (role === 'user') {
      sql += ' AND p.is_admin = 0';
    }

    // 검색어 필터 (제목, 내용, 작성자)
    if (search && search.trim() !== '') {
      sql += ' AND (p.title LIKE ? OR p.author_name LIKE ? OR (p.is_secret = 0 AND p.content LIKE ?))';
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    // 정렬 (공지사항은 항상 최상단에 먼저 노출!)
    if (sort === 'views') {
      sql += ' ORDER BY p.is_notice DESC, p.views DESC, p.id DESC';
    } else if (sort === 'likes') {
      sql += ' ORDER BY p.is_notice DESC, p.likes DESC, p.id DESC';
    } else {
      sql += ' ORDER BY p.is_notice DESC, p.id DESC';
    }

    const posts = db.prepare(sql).all(...params);
    res.json({ posts, isAdmin: adminMode });
  } catch (err) {
    console.error('List posts error:', err);
    res.status(500).json({ error: '게시글 목록을 불러오지 못했습니다.' });
  }
});

// --------------------------------------------------------------------------
// 4. 게시글 상세 조회 API (조회수 1 증가)
// --------------------------------------------------------------------------
app.get('/api/posts/:id', (req, res) => {
  try {
    const postId = Number(req.params.id);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);

    if (!post) {
      return res.status(404).json({ error: '존재하지 않는 게시글입니다.' });
    }

    const adminMode = isAdmin(req);
    const clientPin = req.query.pin;
    const pinVerified = clientPin && hashPassword(clientPin) === post.password_hash;
    const canViewSecret = !post.is_secret || adminMode || pinVerified;

    // 상세 조회 시 조회수 증가
    db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(postId);
    post.views += 1;

    // 댓글 목록 조회
    const comments = db.prepare(`
      SELECT id, post_id, author_name, content, is_admin, created_at 
      FROM comments 
      WHERE post_id = ? 
      ORDER BY id ASC
    `).all(postId);

    const responsePost = {
      id: post.id,
      title: post.title,
      category: post.category,
      author_name: post.author_name || (post.is_admin ? '관리자' : '사용자'),
      is_admin: Boolean(post.is_admin),
      is_notice: Boolean(post.is_notice),
      is_secret: Boolean(post.is_secret),
      likes: post.likes,
      views: post.views,
      created_at: post.created_at,
      is_locked: post.is_secret && !canViewSecret,
      content: canViewSecret ? post.content : null,
      comments: canViewSecret ? comments : [],
    };

    res.json({ post: responsePost, isAdmin: adminMode });
  } catch (err) {
    console.error('Get post error:', err);
    res.status(500).json({ error: '게시글을 불러오지 못했습니다.' });
  }
});

// --------------------------------------------------------------------------
// 5. 게시글 등록 API (사용자 vs 관리자 구분)
// --------------------------------------------------------------------------
app.post('/api/posts', (req, res) => {
  try {
    const { title, content, category, author_name, pin, is_secret, is_notice } = req.body;
    const adminMode = isAdmin(req);

    if (!title || !title.trim()) {
      return res.status(400).json({ error: '제목을 입력해 주세요.' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: '내용을 입력해 주세요.' });
    }

    // 일반 사용자는 PIN 필수
    if (!adminMode && (!pin || pin.length < 4 || pin.length > 8)) {
      return res.status(400).json({ error: '글 수정/삭제용 비밀번호는 4~8자리여야 합니다.' });
    }

    const postCategory = category || (adminMode && is_notice ? '공지' : '일반');
    const finalAuthorName = adminMode
      ? (author_name?.trim() || '관리자')
      : (author_name?.trim() || '익명 사용자');
    const finalIsAdmin = adminMode ? 1 : 0;
    const finalIsNotice = (adminMode && is_notice) ? 1 : 0;
    const passwordHash = adminMode ? hashPassword('admin1234') : hashPassword(pin);
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO posts (title, content, category, author_name, is_admin, is_notice, password_hash, is_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      title.trim(),
      content.trim(),
      postCategory,
      finalAuthorName,
      finalIsAdmin,
      finalIsNotice,
      passwordHash,
      is_secret ? 1 : 0,
      now
    );

    res.status(201).json({ success: true, id: Number(result.lastInsertRowid) });
  } catch (err) {
    console.error('Create post error:', err);
    res.status(500).json({ error: '게시글 등록에 실패했습니다.' });
  }
});

// --------------------------------------------------------------------------
// 6. 게시글 비밀번호 검증 API
// --------------------------------------------------------------------------
app.post('/api/posts/:id/verify-pin', (req, res) => {
  try {
    const postId = Number(req.params.id);
    const { pin } = req.body;
    const post = db.prepare('SELECT password_hash FROM posts WHERE id = ?').get(postId);

    if (!post) {
      return res.status(404).json({ error: '게시글이 존재하지 않습니다.' });
    }

    if (hashPassword(pin) === post.password_hash) {
      return res.json({ success: true });
    }
    return res.status(403).json({ success: false, error: '비밀번호가 일치하지 않습니다.' });
  } catch (err) {
    res.status(500).json({ error: '비밀번호 검증 중 오류가 발생했습니다.' });
  }
});

// --------------------------------------------------------------------------
// 7. 게시글 수정 API
// --------------------------------------------------------------------------
app.put('/api/posts/:id', (req, res) => {
  try {
    const postId = Number(req.params.id);
    const { title, content, category, author_name, pin, is_secret, is_notice } = req.body;
    const adminMode = isAdmin(req);

    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post) {
      return res.status(404).json({ error: '게시글이 존재하지 않습니다.' });
    }

    if (!adminMode && hashPassword(pin) !== post.password_hash) {
      return res.status(403).json({ error: '수정 권한이 없습니다. 비밀번호를 확인해주세요.' });
    }

    if (!title || !title.trim() || !content || !content.trim()) {
      return res.status(400).json({ error: '제목과 내용을 모두 입력해 주세요.' });
    }

    const postCategory = category || post.category;
    const finalAuthorName = author_name?.trim() || post.author_name;
    const finalIsNotice = adminMode ? (is_notice ? 1 : 0) : post.is_notice;

    db.prepare(`
      UPDATE posts 
      SET title = ?, content = ?, category = ?, author_name = ?, is_secret = ?, is_notice = ?
      WHERE id = ?
    `).run(
      title.trim(),
      content.trim(),
      postCategory,
      finalAuthorName,
      is_secret ? 1 : 0,
      finalIsNotice,
      postId
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Update post error:', err);
    res.status(500).json({ error: '게시글 수정에 실패했습니다.' });
  }
});

// --------------------------------------------------------------------------
// 8. 게시글 삭제 API
// --------------------------------------------------------------------------
app.delete('/api/posts/:id', (req, res) => {
  try {
    const postId = Number(req.params.id);
    const { pin } = req.body;
    const adminMode = isAdmin(req);

    const post = db.prepare('SELECT password_hash FROM posts WHERE id = ?').get(postId);
    if (!post) {
      return res.status(404).json({ error: '게시글이 존재하지 않습니다.' });
    }

    if (!adminMode && hashPassword(pin) !== post.password_hash) {
      return res.status(403).json({ error: '삭제 권한이 없습니다. 비밀번호를 확인해주세요.' });
    }

    db.prepare('DELETE FROM comments WHERE post_id = ?').run(postId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(postId);

    res.json({ success: true });
  } catch (err) {
    console.error('Delete post error:', err);
    res.status(500).json({ error: '게시글 삭제에 실패했습니다.' });
  }
});

// --------------------------------------------------------------------------
// 9. 공지사항 토글 API (관리자 전용)
// --------------------------------------------------------------------------
app.post('/api/posts/:id/toggle-notice', (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    const postId = Number(req.params.id);
    const post = db.prepare('SELECT is_notice FROM posts WHERE id = ?').get(postId);
    if (!post) {
      return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    }

    const nextNotice = post.is_notice === 1 ? 0 : 1;
    db.prepare('UPDATE posts SET is_notice = ? WHERE id = ?').run(nextNotice, postId);
    res.json({ success: true, is_notice: nextNotice });
  } catch (err) {
    res.status(500).json({ error: '공지 설정 변경 실패' });
  }
});

// --------------------------------------------------------------------------
// 10. 공감(추천) API
// --------------------------------------------------------------------------
app.post('/api/posts/:id/like', (req, res) => {
  try {
    const postId = Number(req.params.id);
    db.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?').run(postId);
    const updated = db.prepare('SELECT likes FROM posts WHERE id = ?').get(postId);
    res.json({ success: true, likes: updated.likes });
  } catch (err) {
    res.status(500).json({ error: '공감 처리에 실패했습니다.' });
  }
});

// --------------------------------------------------------------------------
// 11. 댓글 작성 API (사용자 vs 관리자 구분)
// --------------------------------------------------------------------------
app.post('/api/posts/:id/comments', (req, res) => {
  try {
    const postId = Number(req.params.id);
    const { content, author_name, pin } = req.body;
    const adminMode = isAdmin(req);

    if (!content || !content.trim()) {
      return res.status(400).json({ error: '댓글 내용을 입력해 주세요.' });
    }

    if (!adminMode && (!pin || pin.length < 4 || pin.length > 8)) {
      return res.status(400).json({ error: '댓글 삭제용 비밀번호(4~8자리)를 입력해 주세요.' });
    }

    const finalAuthor = adminMode ? '관리자' : (author_name?.trim() || '사용자');
    const now = new Date().toISOString();
    const passwordHash = adminMode ? hashPassword('admin1234') : hashPassword(pin);

    const result = db.prepare(`
      INSERT INTO comments (post_id, author_name, content, password_hash, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(postId, finalAuthor, content.trim(), passwordHash, adminMode ? 1 : 0, now);

    res.status(201).json({
      success: true,
      comment: {
        id: Number(result.lastInsertRowid),
        post_id: postId,
        author_name: finalAuthor,
        content: content.trim(),
        is_admin: adminMode ? 1 : 0,
        created_at: now
      }
    });
  } catch (err) {
    console.error('Add comment error:', err);
    res.status(500).json({ error: '댓글을 등록하지 못했습니다.' });
  }
});

// --------------------------------------------------------------------------
// 12. 댓글 삭제 API
// --------------------------------------------------------------------------
app.delete('/api/comments/:id', (req, res) => {
  try {
    const commentId = Number(req.params.id);
    const { pin } = req.body;
    const adminMode = isAdmin(req);

    const comment = db.prepare('SELECT password_hash FROM comments WHERE id = ?').get(commentId);
    if (!comment) {
      return res.status(404).json({ error: '존재하지 않는 댓글입니다.' });
    }

    if (!adminMode && hashPassword(pin) !== comment.password_hash) {
      return res.status(403).json({ error: '비밀번호가 일치하지 않습니다.' });
    }

    db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '댓글 삭제 실패' });
  }
});

// SPA Fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` 단순 게시판 (사용자/관리자 구분 & 날짜·조회수 최적화) 실행!`);
  console.log(` - 접속 주소: http://localhost:${PORT}`);
  console.log(` - 관리자 비밀번호: ${ADMIN_PASSWORD}`);
  console.log(`=======================================================`);
});

