/**
 * 열린 게시판 (사용자/관리자 구분 & 날짜·조회수 최적화) 클라이언트 스크립트
 */

// 서버 API 기본 주소 (file:// 또는 Live Server(다른 포트)로 열었을 경우에도 자동으로 http://localhost:3000 연동)
const API_BASE = (window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000'))
  ? 'http://localhost:3000'
  : '';

// 전역 상태
let currentRole = 'all';       // 'all', 'admin', 'user'
let currentCategory = '전체';
let currentViewMode = 'table'; // 'table' or 'card'
let currentPost = null;
let pendingSecretPostId = null;
let adminToken = localStorage.getItem('board_admin_token') || null;

// 공감한 게시글 ID 목록 (로컬 스토리지)
function getLikedPosts() {
  try {
    return JSON.parse(localStorage.getItem('board_liked_posts')) || [];
  } catch (e) {
    return [];
  }
}

function setLikedPost(id) {
  const list = getLikedPosts();
  if (!list.includes(id)) {
    list.push(id);
    localStorage.setItem('board_liked_posts', JSON.stringify(list));
  }
}

// --------------------------------------------------------------------------
// 1. 초기화
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  checkProtocolNotice();
  checkAdminAuth();
  loadStats();
  loadPosts();
});

// file:// 프로토콜로 열렸을 때 브라우저 주소창 권장 안내
function checkProtocolNotice() {
  if (window.location.protocol === 'file:') {
    const banner = document.getElementById('protocolNoticeBanner');
    if (banner) banner.classList.remove('hidden');
  }
}

// --------------------------------------------------------------------------
// 2. 관리자 인증 상태 확인 & UI 갱신
// --------------------------------------------------------------------------
async function checkAdminAuth() {
  if (!adminToken) {
    updateRoleUI(false);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/verify`, {
      headers: { 'x-admin-token': adminToken }
    });
    const data = await res.json();
    if (data.isAdmin) {
      updateRoleUI(true);
    } else {
      adminToken = null;
      localStorage.removeItem('board_admin_token');
      updateRoleUI(false);
    }
  } catch (err) {
    console.warn('Admin verify failed (server might be down):', err);
    updateRoleUI(false);
  }
}

function updateRoleUI(isAdmin) {
  const roleIndicator = document.getElementById('roleIndicator');
  const roleText = document.getElementById('currentRoleText');
  const btnToggle = document.getElementById('btnAdminToggle');
  const btnText = document.getElementById('adminBtnText');
  const banner = document.getElementById('adminBanner');

  if (isAdmin) {
    roleIndicator.className = 'role-badge role-admin';
    roleIndicator.innerHTML = '<span class="role-icon">👑</span> <span>관리자 모드</span>';
    btnToggle.classList.add('hidden');
    banner.classList.remove('hidden');
  } else {
    roleIndicator.className = 'role-badge role-user';
    roleIndicator.innerHTML = '<span class="role-icon">👤</span> <span>일반 사용자 모드</span>';
    btnToggle.classList.remove('hidden');
    btnText.textContent = '관리자 로그인';
    banner.classList.add('hidden');
  }
}

// --------------------------------------------------------------------------
// 3. 통계 지표 로드
// --------------------------------------------------------------------------
async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) return;
    const stats = await res.json();
    document.getElementById('statTotal').textContent = stats.total || 0;
    document.getElementById('statNotices').textContent = stats.notices || 0;
    document.getElementById('statUserPosts').textContent = stats.userPosts || 0;
    document.getElementById('statTotalViews').textContent = (stats.totalViews || 0).toLocaleString();
    
    // 서버 연결 성공 시 경고 배너 숨김
    const errBanner = document.getElementById('serverConnBanner');
    if (errBanner) errBanner.classList.add('hidden');
  } catch (err) {
    console.error('Failed to load stats:', err);
    const errBanner = document.getElementById('serverConnBanner');
    if (errBanner) errBanner.classList.remove('hidden');
  }
}

// --------------------------------------------------------------------------
// 4. 날짜 및 작성자 뱃지 포맷 유틸
// --------------------------------------------------------------------------
function formatDate(isoString) {
  if (!isoString) return '-';
  const d = new Date(isoString);
  const now = new Date();

  if (isNaN(d.getTime())) return '-';

  const isToday = d.getFullYear() === now.getFullYear() &&
                  d.getMonth() === now.getMonth() &&
                  d.getDate() === now.getDate();

  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');

  if (isToday) {
    return `<span title="${formatFullDate(d)}">${hours}:${minutes}</span>`;
  }

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `<span title="${formatFullDate(d)}">${year}.${month}.${day}</span>`;
}

function formatFullDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

function renderAuthorBadge(authorName, isAdmin) {
  if (isAdmin) {
    return `<span class="author-badge author-admin" title="게시판 관리자가 작성한 글입니다">👑 관리자</span>`;
  }
  const name = escapeHtml(authorName || '사용자');
  return `<span class="author-badge author-user" title="일반 사용자가 작성한 글입니다">👤 ${name}</span>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --------------------------------------------------------------------------
// 5. 게시글 목록 로드 및 렌더링 (목록형 / 카드형)
// --------------------------------------------------------------------------
async function loadPosts() {
  const tableBody = document.getElementById('boardTableBody');
  const cardsGrid = document.getElementById('cardViewSection');
  const emptyState = document.getElementById('emptyState');
  const sort = document.getElementById('sortSelect').value;
  const search = document.getElementById('searchInput').value.trim();

  tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 40px; color:#94a3b8;">불러오는 중...</td></tr>';
  cardsGrid.innerHTML = '';

  try {
    const params = new URLSearchParams({
      category: currentCategory,
      role: currentRole,
      sort: sort,
      search: search
    });

    const headers = {};
    if (adminToken) {
      headers['x-admin-token'] = adminToken;
    }

    const res = await fetch(`${API_BASE}/api/posts?${params.toString()}`, { headers });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const posts = data.posts || [];

    tableBody.innerHTML = '';
    cardsGrid.innerHTML = '';

    if (posts.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    posts.forEach((post, index) => {
      tableBody.appendChild(createTableRow(post, posts.length - index));
      cardsGrid.appendChild(createCardItem(post));
    });
  } catch (err) {
    console.error('Failed to load posts:', err);
    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 40px; color:#ef4444;">
      서버와 통신할 수 없습니다. (서버 주소: http://localhost:3000)<br>
      <small style="color:#64748b;">터미널에서 <code>npm start</code> 또는 <code>node server.js</code> 명령어로 서버를 켜주세요.</small>
    </td></tr>`;
  }
}

// 테이블 행 렌더링
function createTableRow(post, displayNumber) {
  const tr = document.createElement('tr');
  if (post.is_notice) {
    tr.className = 'row-notice';
  }
  tr.onclick = () => openPostDetail(post.id);

  const noContent = post.is_notice 
    ? '<span class="badge badge-notice">📌 공지</span>' 
    : `<span class="td-no">${post.id}</span>`;

  const categoryBadge = `<span class="badge badge-category">${escapeHtml(post.category)}</span>`;
  const secretIcon = post.is_secret ? '<span class="secret-icon" title="비밀글">🔒</span>' : '';
  const commentCount = post.comment_count > 0 
    ? `<span class="table-comment-count">[${post.comment_count}]</span>` 
    : '';

  tr.innerHTML = `
    <td class="col-no">${noContent}</td>
    <td class="col-cat">${categoryBadge}</td>
    <td class="col-title td-title">
      <div class="table-title-link">
        ${secretIcon}
        <span>${escapeHtml(post.title)}</span>
        ${commentCount}
      </div>
    </td>
    <td class="col-author td-author">${renderAuthorBadge(post.author_name, post.is_admin)}</td>
    <td class="col-date td-date">${formatDate(post.created_at)}</td>
    <td class="col-views td-views">${post.views.toLocaleString()}</td>
    <td class="col-likes td-likes">❤️ ${post.likes}</td>
  `;
  return tr;
}

// 카드형 아이템 렌더링
function createCardItem(post) {
  const card = document.createElement('article');
  card.className = `post-card ${post.is_notice ? 'card-notice' : ''}`;
  card.onclick = () => openPostDetail(post.id);

  const noticeBadge = post.is_notice ? '<span class="badge badge-notice">📌 공지</span>' : '';
  const secretBadge = post.is_secret ? '<span class="badge badge-secret">🔒 비밀글</span>' : '';

  card.innerHTML = `
    <div>
      <div class="post-card-header">
        <div class="card-badges">
          ${noticeBadge}
          <span class="badge badge-category">${escapeHtml(post.category)}</span>
          ${secretBadge}
        </div>
        ${renderAuthorBadge(post.author_name, post.is_admin)}
      </div>
      <h3 class="post-card-title">${escapeHtml(post.title)}</h3>
      <p class="post-card-desc">${escapeHtml(post.preview_content)}</p>
    </div>
    <div class="post-card-footer">
      <span>📅 ${formatDate(post.created_at)}</span>
      <div class="card-metrics">
        <span title="조회수">👁️ ${post.views}</span>
        <span title="댓글수">💬 ${post.comment_count}</span>
        <span title="추천수">❤️ ${post.likes}</span>
      </div>
    </div>
  `;
  return card;
}

// --------------------------------------------------------------------------
// 6. 뷰 모드 토글 (목록형 테이블 vs 카드형)
// --------------------------------------------------------------------------
function setViewMode(mode) {
  currentViewMode = mode;
  const tableSection = document.getElementById('tableViewSection');
  const cardSection = document.getElementById('cardViewSection');
  const btnTable = document.getElementById('btnViewTable');
  const btnCard = document.getElementById('btnViewCard');

  if (mode === 'table') {
    tableSection.classList.remove('hidden');
    cardSection.classList.add('hidden');
    btnTable.classList.add('active');
    btnCard.classList.remove('active');
  } else {
    tableSection.classList.add('hidden');
    cardSection.classList.remove('hidden');
    btnTable.classList.remove('active');
    btnCard.classList.add('active');
  }
}

// --------------------------------------------------------------------------
// 7. 역할 탭 및 카테고리 필터
// --------------------------------------------------------------------------
function setRoleTab(role) {
  currentRole = role;
  document.querySelectorAll('#roleTabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.role === role);
  });
  loadPosts();
}

function filterByRole(role) {
  setRoleTab(role);
}

function setCategoryPill(category) {
  currentCategory = category;
  document.querySelectorAll('#categoryPills .pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.cat === category);
  });
  loadPosts();
}

function filterByCategory(category) {
  setCategoryPill(category);
}

function resetFilters() {
  currentRole = 'all';
  currentCategory = '전체';
  document.getElementById('searchInput').value = '';
  document.getElementById('sortSelect').value = 'latest';
  setRoleTab('all');
  setCategoryPill('전체');
}

// --------------------------------------------------------------------------
// 8. 게시글 상세 조회 및 비밀글 처리
// --------------------------------------------------------------------------
async function openPostDetail(postId, verifiedPin = null) {
  try {
    let url = `${API_BASE}/api/posts/${postId}`;
    if (verifiedPin) {
      url += `?pin=${encodeURIComponent(verifiedPin)}`;
    }

    const headers = {};
    if (adminToken) {
      headers['x-admin-token'] = adminToken;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      showToast('게시글을 불러올 수 없습니다.', 'error');
      return;
    }

    const data = await res.json();
    const post = data.post;

    if (post.is_locked) {
      pendingSecretPostId = postId;
      document.getElementById('secretInputPin').value = '';
      openModal('secretPinModal');
      return;
    }

    currentPost = post;
    renderPostDetail(post, data.isAdmin);
    openModal('detailModal');
    loadStats();
  } catch (err) {
    console.error('Failed to open post detail:', err);
    showToast('상세 정보를 불러오는 중 서버 통신 오류가 발생했습니다.', 'error');
  }
}

function renderPostDetail(post, isAdmin) {
  document.getElementById('detailCategory').textContent = post.category;
  document.getElementById('detailNoticeBadge').classList.toggle('hidden', !post.is_notice);
  document.getElementById('detailSecret').classList.toggle('hidden', !post.is_secret);

  document.getElementById('detailTitle').textContent = post.title;
  document.getElementById('detailAuthorWrapper').innerHTML = renderAuthorBadge(post.author_name, post.is_admin);
  document.getElementById('detailDate').innerHTML = formatDate(post.created_at);
  document.getElementById('detailViews').textContent = post.views.toLocaleString();
  document.getElementById('detailLikes').textContent = post.likes;
  document.getElementById('detailContent').textContent = post.content;

  updateLikeButtonUI(post.id, post.likes);

  const btnNoticeToggle = document.getElementById('btnAdminNoticeToggle');
  btnNoticeToggle.classList.toggle('hidden', !isAdmin);
  btnNoticeToggle.textContent = post.is_notice ? '📌 공지 해제' : '📌 공지 고정';

  renderComments(post.comments || []);
}

function updateLikeButtonUI(postId, likes) {
  const btnLike = document.getElementById('btnLike');
  const countText = document.getElementById('likeCountText');
  countText.textContent = `추천 ${likes}`;

  const liked = getLikedPosts().includes(postId);
  if (liked) {
    btnLike.style.borderColor = '#f43f5e';
    btnLike.style.backgroundColor = '#fecdd3';
  } else {
    btnLike.style.borderColor = '#fecdd3';
    btnLike.style.backgroundColor = '#fff1f2';
  }
}

// --------------------------------------------------------------------------
// 9. 추천(공감) 기능
// --------------------------------------------------------------------------
async function likePost() {
  if (!currentPost) return;
  const postId = currentPost.id;
  const liked = getLikedPosts().includes(postId);

  if (liked) {
    showToast('이미 추천하신 게시글입니다.', 'info');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/posts/${postId}/like`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      setLikedPost(postId);
      currentPost.likes = data.likes;
      updateLikeButtonUI(postId, data.likes);
      document.getElementById('detailLikes').textContent = data.likes;
      showToast('이 글을 추천했습니다! ❤️', 'success');
      loadPosts();
    }
  } catch (err) {
    showToast('추천 처리 중 통신 오류가 발생했습니다.', 'error');
  }
}

// --------------------------------------------------------------------------
// 10. 비밀글 PIN 검증
// --------------------------------------------------------------------------
async function verifySecretPin(e) {
  e.preventDefault();
  const pin = document.getElementById('secretInputPin').value.trim();
  if (!pin || !pendingSecretPostId) return;

  try {
    const res = await fetch(`${API_BASE}/api/posts/${pendingSecretPostId}/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    if (data.success) {
      closeModal('secretPinModal');
      openPostDetail(pendingSecretPostId, pin);
      pendingSecretPostId = null;
    } else {
      showToast(data.error || '비밀번호가 일치하지 않습니다.', 'error');
    }
  } catch (err) {
    showToast('비밀번호 검증 중 통신 오류가 발생했습니다.', 'error');
  }
}

// --------------------------------------------------------------------------
// 11. 새 글 작성 (사용자 / 관리자 모드 자동 적응)
// --------------------------------------------------------------------------
function openWriteModal() {
  document.getElementById('writeForm').reset();
  const isAdmin = Boolean(adminToken);

  const banner = document.getElementById('writeRoleBanner');
  const noticeGroup = document.getElementById('adminNoticeOptionGroup');
  const optionNotice = document.getElementById('optionNotice');
  const authorInput = document.getElementById('postAuthorName');
  const pinGroup = document.getElementById('writePinGroup');
  const pinInput = document.getElementById('postPin');

  if (isAdmin) {
    banner.className = 'modal-role-banner banner-admin';
    banner.innerHTML = '👑 <strong>관리자</strong> 권한으로 작성합니다. (공지 등록 가능, PIN 생략)';
    noticeGroup.classList.remove('hidden');
    optionNotice.classList.remove('hidden');
    authorInput.value = '관리자';
    pinGroup.classList.add('hidden');
    pinInput.removeAttribute('required');
  } else {
    banner.className = 'modal-role-banner banner-user';
    banner.innerHTML = '👤 <strong>일반 사용자</strong> 권한으로 작성합니다.';
    noticeGroup.classList.add('hidden');
    optionNotice.classList.add('hidden');
    authorInput.value = '';
    pinGroup.classList.remove('hidden');
    pinInput.setAttribute('required', 'required');
  }

  openModal('writeModal');
}

async function submitPost(e) {
  e.preventDefault();
  const category = document.getElementById('postCategory').value;
  const author_name = document.getElementById('postAuthorName').value.trim();
  const title = document.getElementById('postTitle').value.trim();
  const content = document.getElementById('postContent').value.trim();
  const pin = document.getElementById('postPin').value.trim();
  const is_secret = document.getElementById('postIsSecret').checked;
  const is_notice = document.getElementById('postIsNotice').checked;

  const isAdmin = Boolean(adminToken);

  if (!isAdmin && (pin.length < 4 || pin.length > 8)) {
    showToast('비밀번호는 4~8자리로 입력해 주세요.', 'error');
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;

    const res = await fetch(`${API_BASE}/api/posts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        category,
        author_name,
        title,
        content,
        pin,
        is_secret,
        is_notice,
        admin_token: adminToken
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `서버 오류 (${res.status})`);
    }

    const data = await res.json();
    if (data.success) {
      closeModal('writeModal');
      showToast('게시글이 성공적으로 등록되었습니다!', 'success');
      loadStats();
      loadPosts();
      openPostDetail(data.id, is_secret ? pin : null);
    } else {
      showToast(data.error || '게시글 등록 실패', 'error');
    }
  } catch (err) {
    console.error('Post submit error:', err);
    showToast(`서버 통신 오류: ${err.message || '서버가 켜져 있는지 확인해주세요.'}`, 'error');
  }
}

// --------------------------------------------------------------------------
// 12. 글 수정 기능
// --------------------------------------------------------------------------
function openEditModal() {
  if (!currentPost) return;
  document.getElementById('editCategory').value = currentPost.category;
  document.getElementById('editAuthorName').value = currentPost.author_name;
  document.getElementById('editTitle').value = currentPost.title;
  document.getElementById('editContent').value = currentPost.content;
  document.getElementById('editIsSecret').checked = currentPost.is_secret;
  document.getElementById('editPin').value = '';

  const pinGroup = document.getElementById('editPinGroup');
  pinGroup.style.display = adminToken ? 'none' : 'block';

  openModal('editModal');
}

async function submitEditPost(e) {
  e.preventDefault();
  if (!currentPost) return;

  const category = document.getElementById('editCategory').value;
  const author_name = document.getElementById('editAuthorName').value.trim();
  const title = document.getElementById('editTitle').value.trim();
  const content = document.getElementById('editContent').value.trim();
  const pin = document.getElementById('editPin').value.trim();
  const is_secret = document.getElementById('editIsSecret').checked;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;

    const res = await fetch(`${API_BASE}/api/posts/${currentPost.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ category, author_name, title, content, pin, is_secret, admin_token: adminToken })
    });
    const data = await res.json();

    if (data.success) {
      closeModal('editModal');
      showToast('게시글이 수정되었습니다.', 'success');
      openPostDetail(currentPost.id, pin || null);
      loadPosts();
    } else {
      showToast(data.error || '수정 실패', 'error');
    }
  } catch (err) {
    showToast('수정 처리 중 통신 오류가 발생했습니다.', 'error');
  }
}

// --------------------------------------------------------------------------
// 13. 글 삭제 기능
// --------------------------------------------------------------------------
function openDeleteModal() {
  if (!currentPost) return;
  document.getElementById('deletePin').value = '';
  const pinGroup = document.getElementById('deletePinGroup');
  pinGroup.style.display = adminToken ? 'none' : 'block';
  openModal('deleteModal');
}

async function submitDeletePost(e) {
  e.preventDefault();
  if (!currentPost) return;

  const pin = document.getElementById('deletePin').value.trim();

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;

    const res = await fetch(`${API_BASE}/api/posts/${currentPost.id}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ pin, admin_token: adminToken })
    });
    const data = await res.json();

    if (data.success) {
      closeModal('deleteModal');
      closeModal('detailModal');
      showToast('게시글이 삭제되었습니다.', 'info');
      currentPost = null;
      loadStats();
      loadPosts();
    } else {
      showToast(data.error || '삭제 권한이 없습니다.', 'error');
    }
  } catch (err) {
    showToast('삭제 처리 중 통신 오류가 발생했습니다.', 'error');
  }
}

// --------------------------------------------------------------------------
// 14. 관리자 전용: 공지사항 고정/해제 토글
// --------------------------------------------------------------------------
async function toggleNotice() {
  if (!currentPost || !adminToken) return;

  try {
    const res = await fetch(`${API_BASE}/api/posts/${currentPost.id}/toggle-notice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': adminToken
      }
    });
    const data = await res.json();

    if (data.success) {
      currentPost.is_notice = Boolean(data.is_notice);
      document.getElementById('detailNoticeBadge').classList.toggle('hidden', !currentPost.is_notice);
      document.getElementById('btnAdminNoticeToggle').textContent = currentPost.is_notice ? '📌 공지 해제' : '📌 공지 고정';
      showToast(currentPost.is_notice ? '공지사항으로 상단 고정되었습니다.' : '공지사항 고정이 해제되었습니다.', 'success');
      loadStats();
      loadPosts();
    } else {
      showToast(data.error || '공지 변경 실패', 'error');
    }
  } catch (err) {
    showToast('처리 중 통신 오류가 발생했습니다.', 'error');
  }
}

// --------------------------------------------------------------------------
// 15. 댓글 기능 (작성, 렌더링, 삭제)
// --------------------------------------------------------------------------
function renderComments(comments) {
  const container = document.getElementById('commentsList');
  const countBadge = document.getElementById('commentCountHeader');
  countBadge.textContent = comments.length;
  container.innerHTML = '';

  if (comments.length === 0) {
    container.innerHTML = '<div style="color:#94a3b8; font-size:13px; text-align:center; padding: 14px;">아직 작성된 댓글이 없습니다. 첫 의견을 남겨보세요!</div>';
    return;
  }

  comments.forEach(c => {
    const item = document.createElement('div');
    item.className = `comment-item ${c.is_admin ? 'comment-admin-highlight' : ''}`;

    const authorHtml = renderAuthorBadge(c.author_name, c.is_admin);

    item.innerHTML = `
      <div class="comment-item-header">
        <div>${authorHtml} <span style="color:#94a3b8; margin-left:6px;">${formatDate(c.created_at)}</span></div>
        <button class="btn-comment-del" onclick="deleteComment(${c.id})">삭제</button>
      </div>
      <div class="comment-item-body">${escapeHtml(c.content)}</div>
    `;
    container.appendChild(item);
  });
}

async function submitComment(e) {
  e.preventDefault();
  if (!currentPost) return;

  const content = document.getElementById('commentInput').value.trim();
  const author_name = document.getElementById('commentAuthorInput').value.trim();
  const pin = document.getElementById('commentPinInput').value.trim();

  const isAdmin = Boolean(adminToken);

  if (!isAdmin && (!pin || pin.length < 4)) {
    showToast('댓글 삭제용 비밀번호 4자리를 입력해 주세요.', 'error');
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;

    const res = await fetch(`${API_BASE}/api/posts/${currentPost.id}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content,
        author_name: author_name || (isAdmin ? '관리자' : '익명'),
        pin,
        admin_token: adminToken
      })
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('commentInput').value = '';
      document.getElementById('commentAuthorInput').value = '';
      document.getElementById('commentPinInput').value = '';
      showToast('댓글이 등록되었습니다.', 'success');
      openPostDetail(currentPost.id);
      loadPosts();
    } else {
      showToast(data.error || '댓글 등록 실패', 'error');
    }
  } catch (err) {
    showToast('댓글 등록 중 통신 오류가 발생했습니다.', 'error');
  }
}

async function deleteComment(commentId) {
  let pin = '';
  if (!adminToken) {
    pin = prompt('댓글 작성 시 설정한 비밀번호를 입력해주세요:');
    if (!pin) return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;

    const res = await fetch(`${API_BASE}/api/comments/${commentId}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ pin, admin_token: adminToken })
    });
    const data = await res.json();
    if (data.success) {
      showToast('댓글이 삭제되었습니다.', 'info');
      openPostDetail(currentPost.id);
      loadPosts();
    } else {
      showToast(data.error || '비밀번호가 일치하지 않습니다.', 'error');
    }
  } catch (err) {
    showToast('댓글 삭제 중 오류가 발생했습니다.', 'error');
  }
}

// --------------------------------------------------------------------------
// 16. 관리자 로그인 / 로그아웃
// --------------------------------------------------------------------------
function openAdminModal() {
  document.getElementById('adminPasswordInput').value = '';
  openModal('adminModal');
}

async function submitAdminLogin(e) {
  e.preventDefault();
  const password = document.getElementById('adminPasswordInput').value;

  try {
    const res = await fetch(`${API_BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();

    if (data.success) {
      adminToken = data.token;
      localStorage.setItem('board_admin_token', adminToken);
      closeModal('adminModal');
      updateRoleUI(true);
      showToast('관리자 권한으로 로그인되었습니다 👑', 'success');
      loadPosts();
      if (currentPost) {
        openPostDetail(currentPost.id);
      }
    } else {
      showToast(data.error || '로그인 실패', 'error');
    }
  } catch (err) {
    showToast('로그인 요청 중 통신 오류가 발생했습니다.', 'error');
  }
}

async function adminLogout() {
  try {
    if (adminToken) {
      await fetch(`${API_BASE}/api/admin/logout`, {
        method: 'POST',
        headers: { 'x-admin-token': adminToken }
      });
    }
  } catch (e) {
    // ignore
  }
  adminToken = null;
  localStorage.removeItem('board_admin_token');
  updateRoleUI(false);
  showToast('관리자 모드에서 로그아웃되었습니다.', 'info');
  loadPosts();
  if (currentPost) {
    openPostDetail(currentPost.id);
  }
}

// --------------------------------------------------------------------------
// 17. 모달 & 토스트 유틸리티
// --------------------------------------------------------------------------
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('active');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

window.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    e.target.classList.remove('active');
  }
});

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}
