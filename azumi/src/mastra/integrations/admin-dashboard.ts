/**
 * Admin Dashboard
 * Self-contained HTML page for viewing candidate conversations
 */

export function getAdminDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Azumi Staff — Conversations</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface-hover: #222632;
    --border: #2a2e3b;
    --text: #e4e6ed;
    --text-muted: #8b8fa3;
    --accent: #6c63ff;
    --accent-light: #8b84ff;
    --user-bg: #2a2e3b;
    --bot-bg: #1e3a5f;
    --green: #34d399;
    --radius: 10px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    overflow: hidden;
  }

  .app {
    display: flex;
    height: 100vh;
  }

  /* ── Sidebar ── */
  .sidebar {
    width: 360px;
    min-width: 360px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }

  .sidebar-header {
    padding: 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .sidebar-header h1 {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .sidebar-header .subtitle {
    font-size: 12px;
    color: var(--text-muted);
  }

  .search-box {
    margin: 12px 20px;
    flex-shrink: 0;
  }

  .search-box input {
    width: 100%;
    padding: 10px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    outline: none;
    transition: border-color 0.2s;
  }

  .search-box input:focus {
    border-color: var(--accent);
  }

  .chat-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .chat-item {
    display: flex;
    align-items: center;
    padding: 14px 20px;
    cursor: pointer;
    transition: background 0.15s;
    border-left: 3px solid transparent;
  }

  .chat-item:hover {
    background: var(--surface-hover);
  }

  .chat-item.active {
    background: var(--surface-hover);
    border-left-color: var(--accent);
  }

  .chat-avatar {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 600;
    flex-shrink: 0;
    color: #fff;
  }

  .chat-info {
    margin-left: 12px;
    flex: 1;
    min-width: 0;
  }

  .chat-name {
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 3px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .chat-time {
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
    margin-left: 8px;
  }

  .chat-preview {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat-badge {
    font-size: 10px;
    color: var(--text-muted);
    background: var(--bg);
    padding: 2px 7px;
    border-radius: 10px;
    margin-left: 8px;
    flex-shrink: 0;
  }

  /* ── Main Panel ── */
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  .main-header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }

  .main-header h2 {
    font-size: 16px;
    font-weight: 600;
  }

  .main-header .chat-id-label {
    font-size: 12px;
    color: var(--text-muted);
    font-family: monospace;
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    color: var(--text-muted);
  }

  .empty-state .icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.4;
  }

  .empty-state p {
    font-size: 14px;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .msg {
    max-width: 70%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
    position: relative;
  }

  .msg.user {
    align-self: flex-end;
    background: var(--user-bg);
    border-bottom-right-radius: 4px;
  }

  .msg.bot {
    align-self: flex-start;
    background: var(--bot-bg);
    border-bottom-left-radius: 4px;
  }

  .msg-time {
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 4px;
    text-align: right;
  }

  .msg-sender {
    font-size: 10px;
    font-weight: 600;
    margin-bottom: 4px;
    color: var(--accent-light);
  }

  .msg.user .msg-sender {
    color: var(--green);
  }

  .date-divider {
    text-align: center;
    font-size: 11px;
    color: var(--text-muted);
    padding: 12px 0;
    position: relative;
  }

  .date-divider::before,
  .date-divider::after {
    content: '';
    position: absolute;
    top: 50%;
    width: calc(50% - 60px);
    height: 1px;
    background: var(--border);
  }

  .date-divider::before { left: 0; }
  .date-divider::after { right: 0; }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px;
    color: var(--text-muted);
    font-size: 13px;
  }

  .refresh-btn, .pause-btn {
    color: #fff;
    border: none;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .refresh-btn {
    background: var(--accent);
  }

  .refresh-btn:hover {
    background: var(--accent-light);
  }

  .pause-btn {
    background: #e67e22;
  }

  .pause-btn:hover {
    background: #f39c12;
  }

  .pause-btn.paused {
    background: var(--green);
  }

  .pause-btn.paused:hover {
    background: #2ecc71;
  }

  .chat-item.paused .chat-avatar {
    background: #e67e22;
  }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

  /* ── Mobile ── */
  @media (max-width: 768px) {
    .sidebar { width: 100%; min-width: 100%; }
    .main { display: none; }
    .app.chat-open .sidebar { display: none; }
    .app.chat-open .main { display: flex; }

    .back-btn {
      display: inline-flex !important;
      margin-right: 12px;
      background: none;
      border: none;
      color: var(--accent);
      font-size: 18px;
      cursor: pointer;
    }
  }

  .back-btn { display: none; }
</style>
</head>
<body>
<div class="app" id="app">
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1>Azumi Conversations</h1>
      <div class="subtitle" id="chat-count">Loading...</div>
    </div>
    <div class="search-box">
      <input type="text" id="search" placeholder="Search by name or chat ID..." />
    </div>
    <div class="chat-list" id="chat-list">
      <div class="loading">Loading conversations...</div>
    </div>
  </aside>

  <main class="main" id="main-panel">
    <div class="empty-state" id="empty-state">
      <div class="icon">💬</div>
      <p>Select a conversation to view messages</p>
    </div>
  </main>
</div>

<script>
  let chats = [];
  let activeChatId = null;
  let pausedChatIds = new Set();

  async function loadPausedChats() {
    try {
      const res = await fetch('/admin/paused');
      const data = await res.json();
      pausedChatIds = new Set(data.paused || []);
    } catch (e) {}
  }

  async function togglePause(chatId, name) {
    const isPaused = pausedChatIds.has(chatId);
    const endpoint = '/admin/chats/' + encodeURIComponent(chatId) + (isPaused ? '/resume' : '/pause');
    await fetch(endpoint, { method: 'POST' });
    await loadPausedChats();
    if (activeChatId === chatId) openChat(chatId, name);
    renderChatList(document.getElementById('search').value);
  }

  async function loadChats() {
    try {
      const [chatsRes] = await Promise.all([fetch('/admin/chats'), loadPausedChats()]);
      chats = await chatsRes.json();
      renderChatList();
    } catch (e) {
      document.getElementById('chat-list').innerHTML = '<div class="loading">Failed to load chats</div>';
    }
  }

  function renderChatList(filter = '') {
    const list = document.getElementById('chat-list');
    const f = filter.toLowerCase();
    const filtered = chats.filter(c => {
      if (!f) return true;
      return (c.first_name || '').toLowerCase().includes(f) ||
             String(c.chat_id).includes(f);
    });

    document.getElementById('chat-count').textContent = filtered.length + ' conversation' + (filtered.length !== 1 ? 's' : '');

    if (filtered.length === 0) {
      list.innerHTML = '<div class="loading">' + (f ? 'No matches' : 'No conversations yet') + '</div>';
      return;
    }

    list.innerHTML = filtered.map(c => {
      const name = c.first_name || 'Chat ' + c.chat_id;
      const initial = (c.first_name || '?')[0].toUpperCase();
      const time = formatRelativeTime(c.last_message_at);
      const preview = (c.last_text || '').substring(0, 60);
      const isActive = c.chat_id === activeChatId ? ' active' : '';
      const isPaused = pausedChatIds.has(String(c.chat_id)) ? ' paused' : '';
      const pauseLabel = isPaused ? '⏸' : '';
      return '<div class="chat-item' + isActive + isPaused + '" onclick="openChat(' + c.chat_id + ', \\'' + escHtml(name) + '\\')">' +
        '<div class="chat-avatar">' + initial + '</div>' +
        '<div class="chat-info">' +
          '<div class="chat-name"><span>' + pauseLabel + ' ' + escHtml(name) + '</span><span class="chat-time">' + time + '</span></div>' +
          '<div class="chat-preview">' + escHtml(preview) + '</div>' +
        '</div>' +
        '<span class="chat-badge">' + (c.message_count || '?') + '</span>' +
      '</div>';
    }).join('');
  }

  async function openChat(chatId, name) {
    activeChatId = chatId;
    renderChatList(document.getElementById('search').value);
    document.getElementById('app').classList.add('chat-open');

    const main = document.getElementById('main-panel');
    const isPaused = pausedChatIds.has(String(chatId));
    const pauseBtnClass = 'pause-btn' + (isPaused ? ' paused' : '');
    const pauseBtnLabel = isPaused ? 'Resume Bot' : 'Pause Bot';
    main.innerHTML =
      '<div class="main-header">' +
        '<div><button class="back-btn" onclick="goBack()">&#8592;</button>' +
        '<h2 style="display:inline">' + escHtml(name) + '</h2>' +
        (isPaused ? ' <span style="color:#e67e22;font-size:12px;margin-left:8px">⏸ Bot paused</span>' : '') + '</div>' +
        '<div><span class="chat-id-label">ID: ' + chatId + '</span>' +
        '&nbsp;&nbsp;<button class="' + pauseBtnClass + '" onclick="togglePause(\\'' + chatId + '\\', \\'' + escHtml(name) + '\\')">' + pauseBtnLabel + '</button>' +
        '&nbsp;&nbsp;<button class="refresh-btn" onclick="openChat(' + chatId + ', \\'' + escHtml(name) + '\\')">Refresh</button></div>' +
      '</div>' +
      '<div class="messages" id="messages"><div class="loading">Loading messages...</div></div>';

    try {
      const res = await fetch('/admin/chats/' + chatId);
      const messages = await res.json();
      renderMessages(messages);
    } catch (e) {
      document.getElementById('messages').innerHTML = '<div class="loading">Failed to load messages</div>';
    }
  }

  function renderMessages(messages) {
    const container = document.getElementById('messages');
    if (!messages.length) {
      container.innerHTML = '<div class="loading">No messages</div>';
      return;
    }

    let html = '';
    let lastDate = '';

    messages.forEach(m => {
      const d = new Date(m.created_at);
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      if (dateStr !== lastDate) {
        html += '<div class="date-divider">' + dateStr + '</div>';
        lastDate = dateStr;
      }

      const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const senderLabel = m.sender === 'user' ? 'Candidate' : 'Azumi Bot';
      const cls = m.sender === 'user' ? 'user' : 'bot';

      html += '<div class="msg ' + cls + '">' +
        '<div class="msg-sender">' + senderLabel + '</div>' +
        escHtml(m.text || '[no text]') +
        '<div class="msg-time">' + timeStr + '</div>' +
      '</div>';
    });

    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
  }

  function goBack() {
    document.getElementById('app').classList.remove('chat-open');
    activeChatId = null;
    renderChatList(document.getElementById('search').value);
    document.getElementById('main-panel').innerHTML =
      '<div class="empty-state"><div class="icon">💬</div><p>Select a conversation to view messages</p></div>';
  }

  function formatRelativeTime(ts) {
    const now = Date.now();
    const diff = now - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h';
    const days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd';
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  document.getElementById('search').addEventListener('input', (e) => {
    renderChatList(e.target.value);
  });

  loadChats();
  setInterval(loadChats, 30000);
</script>
</body>
</html>`;
}
