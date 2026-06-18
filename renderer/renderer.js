'use strict';

// ---- DOM refs ----
const $ = (id) => document.getElementById(id);
const loginView = $('loginView');
const messengerView = $('messengerView');
const qrImg = $('qrImg');
const loginStatus = $('loginStatus');
const statusPill = $('statusPill');
const statusDot = $('statusDot');
const statusText = $('statusText');
const chatListEl = $('chatList');
const chatSearch = $('chatSearch');
const messagesEl = $('messages');
const emptyState = $('emptyState');
const composer = $('composer');
const msgInput = $('msgInput');
const sendBtn = $('sendBtn');
const convName = $('convName');
const convAvatar = $('convAvatar');
const convSub = $('convSub');
const meName = $('meName');
const meAvatar = $('meAvatar');
const logoutBtn = $('logoutBtn');
const refreshBtn = $('refreshBtn');

// Rolling window: never keep more than this many message bubbles in the DOM.
// Older ones are dropped so a long session can't grow memory without bound.
const MAX_MESSAGES = 80;

let allChats = [];
let activeChatId = null;
let activeChatName = '';
let activeChatIsGroup = false;

// ---- helpers ----
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setStatus(state, text) {
  statusText.textContent = text || state;
  statusPill.className = 'status-pill';
  if (state === 'ready') statusPill.classList.add('ready');
  else if (state === 'error' || state === 'disconnected') statusPill.classList.add('error');
}

function showMessenger() {
  loginView.classList.add('hidden');
  messengerView.classList.remove('hidden');
}

function showLogin() {
  messengerView.classList.add('hidden');
  loginView.classList.remove('hidden');
}

// ---- chat list rendering ----
function renderChats() {
  const term = chatSearch.value.trim().toLowerCase();
  const filtered = term
    ? allChats.filter((c) => c.name.toLowerCase().includes(term))
    : allChats;

  chatListEl.innerHTML = '';
  for (const c of filtered) {
    const li = document.createElement('li');
    li.className = 'chat-item' + (c.isGroup ? ' group' : '') + (c.id === activeChatId ? ' active' : '');
    li.dataset.id = c.id;

    const avatar = document.createElement('span');
    avatar.className = 'ci-avatar';
    avatar.textContent = initials(c.name);

    const body = document.createElement('div');
    body.className = 'ci-body';
    const name = document.createElement('div');
    name.className = 'ci-name';
    name.textContent = c.name;
    const last = document.createElement('div');
    last.className = 'ci-last';
    last.textContent = c.lastMessage || '';
    body.append(name, last);

    li.append(avatar, body);

    if (c.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'ci-badge';
      badge.textContent = c.unread > 99 ? '99+' : c.unread;
      li.append(badge);
    }

    li.addEventListener('click', () => openChat(c.id, c.name, c.isGroup));
    chatListEl.append(li);
  }
}

// ---- conversation ----
function renderBubble(m) {
  const div = document.createElement('div');
  div.className = 'bubble ' + (m.fromMe ? 'out' : 'in');
  div.dataset.id = m.id;

  const text = document.createElement('span');
  text.className = 'bubble-text';
  text.textContent = m.body || (m.type && m.type !== 'chat' ? `[${m.type}]` : '');

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(m.timestamp);

  // Hover actions: edit (own messages only) + delete.
  const actions = document.createElement('span');
  actions.className = 'bubble-actions';
  if (m.fromMe) {
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-act';
    editBtn.title = 'Edit message';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); beginEdit(div, m); });
    actions.append(editBtn);
  }
  const delBtn = document.createElement('button');
  delBtn.className = 'msg-act';
  delBtn.title = m.fromMe ? 'Delete for everyone' : 'Delete for me';
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteMessage(div, m); });
  actions.append(delBtn);

  div.append(actions, text, time);
  return div;
}

async function deleteMessage(div, m) {
  const everyone = !!m.fromMe;
  const ask = everyone
    ? 'Delete this message for everyone?'
    : 'Delete this message for you only?';
  if (!confirm(ask)) return;
  const res = await window.wa.deleteMessage(m.id, everyone);
  if (res && res.error) { alert('Delete failed: ' + res.error); return; }
  div.remove();
}

function beginEdit(div, m) {
  if (div.querySelector('.edit-box')) return; // already editing
  const textEl = div.querySelector('.bubble-text');
  const original = m.body || '';

  const box = document.createElement('div');
  box.className = 'edit-box';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  const save = document.createElement('button');
  save.className = 'msg-act'; save.textContent = '✓'; save.title = 'Save';
  const cancel = document.createElement('button');
  cancel.className = 'msg-act'; cancel.textContent = '✕'; cancel.title = 'Cancel';
  box.append(input, save, cancel);

  textEl.style.display = 'none';
  div.insertBefore(box, textEl);
  input.focus();
  input.select();

  const finish = () => { box.remove(); textEl.style.display = ''; };

  const commit = async () => {
    const next = input.value.trim();
    if (!next || next === original) { finish(); return; }
    save.disabled = true;
    const res = await window.wa.editMessage(m.id, next);
    if (res && res.error) { alert('Edit failed: ' + res.error); save.disabled = false; return; }
    m.body = res.body != null ? res.body : next;
    textEl.textContent = m.body;
    finish();
  };

  save.addEventListener('click', commit);
  cancel.addEventListener('click', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(); }
  });
}

function scrollMessages() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Drop the oldest bubbles so the conversation never exceeds MAX_MESSAGES.
function trimMessages() {
  const bubbles = messagesEl.querySelectorAll('.bubble');
  for (let i = 0; i < bubbles.length - MAX_MESSAGES; i++) {
    bubbles[i].remove();
  }
}

async function openChat(chatId, name, isGroup) {
  activeChatId = chatId;
  activeChatName = name;
  activeChatIsGroup = isGroup;
  renderChats();

  convName.textContent = name;
  convAvatar.textContent = initials(name);
  convSub.textContent = isGroup ? 'Group chat' : 'WhatsApp contact';
  msgInput.disabled = false;
  sendBtn.disabled = false;
  msgInput.focus();

  messagesEl.innerHTML = '<div class="empty-state"><div class="empty-orb"></div><p>Loading messages…</p></div>';

  const msgs = await window.wa.getMessages(chatId);
  if (msgs && msgs.error) {
    messagesEl.innerHTML = `<div class="empty-state"><p>Couldn't load: ${msgs.error}</p></div>`;
    return;
  }
  messagesEl.innerHTML = '';
  for (const m of msgs) messagesEl.append(renderBubble(m));
  scrollMessages();
}

// ---- send ----
composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text || !activeChatId) return;
  msgInput.value = '';
  sendBtn.disabled = true;
  const res = await window.wa.sendMessage(activeChatId, text);
  sendBtn.disabled = false;
  if (res && res.error) {
    alert('Send failed: ' + res.error);
  }
  msgInput.focus();
});

logoutBtn.addEventListener('click', async () => {
  await window.wa.logout();
  allChats = [];
  activeChatId = null;
  chatListEl.innerHTML = '';
  showLogin();
  qrImg.removeAttribute('src');
  loginStatus.textContent = 'Logged out. Re-link to continue.';
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;
  await window.wa.refresh();                       // re-pull the chat list
  if (activeChatId) await openChat(activeChatId, activeChatName, activeChatIsGroup); // reload open convo
  refreshBtn.classList.remove('spinning');
  refreshBtn.disabled = false;
});

chatSearch.addEventListener('input', renderChats);

// ---- events from main ----
window.wa.onStatus((d) => {
  setStatus(d.state, d.text);
  if (loginView && !loginView.classList.contains('hidden')) {
    loginStatus.textContent = d.text;
  }
  if (d.state === 'ready') showMessenger();
  if (d.state === 'disconnected') showLogin();
});

window.wa.onQr((d) => {
  qrImg.src = d.dataUrl;
});

window.wa.onMe((d) => {
  meName.textContent = d.name || 'You';
  meAvatar.textContent = initials(d.name || 'You');
});

window.wa.onChats((d) => {
  allChats = d.chats || [];
  renderChats();
});

window.wa.onMessage((m) => {
  // Append live message if it belongs to the open chat and isn't already shown.
  if (m.chatId === activeChatId) {
    if (!messagesEl.querySelector(`.bubble[data-id="${CSS.escape(m.id)}"]`)) {
      messagesEl.append(renderBubble(m));
      trimMessages();
      scrollMessages();
    }
  }
});
