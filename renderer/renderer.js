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
const emojiBtn = $('emojiBtn');
const emojiPanel = $('emojiPanel');
const replyBar = $('replyBar');
const replyAuthor = $('replyAuthor');
const replyText = $('replyText');
const replyCancel = $('replyCancel');
const convName = $('convName');
const convAvatar = $('convAvatar');
const convSub = $('convSub');
const meName = $('meName');
const meAvatar = $('meAvatar');
const logoutBtn = $('logoutBtn');
const refreshBtn = $('refreshBtn');
const chatMenu = $('chatMenu');

// Rolling window: never keep more than this many message bubbles in the DOM.
// Older ones are dropped so a long session can't grow memory without bound.
const MAX_MESSAGES = 80;

// Typing presence is cleared this long after the last keystroke.
const TYPING_IDLE_MS = 2500;

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const EMOJI_SET = [
  '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊',
  '😍','🥰','😘','😗','😜','🤪','🤗','🤔','🤐','😐','😶','😏',
  '😒','🙄','😬','😴','😪','😷','🤒','🥳','😎','🤓','🧐','😕',
  '😟','😢','😭','😤','😡','🤬','😱','😨','😰','🥺','👍','👎',
  '👏','🙌','🤝','🙏','💪','✌️','🤞','👌','🖐️','✋','👋','🤙',
  '❤️','🧡','💛','💚','💙','💜','🖤','💔','💕','✨','🔥','🎉'
];

let allChats = [];
let activeChatId = null;
let activeChatName = '';
let activeChatIsGroup = false;
let replyTo = null;          // { id, body, author, fromMe } when composing a reply
let typingTimer = null;
let typingActive = false;
let lastDayKey = null;       // day of the last bubble appended, for date separators

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

function dayKey(ts) {
  const d = new Date((ts || 0) * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  const d = new Date((ts || 0) * 1000);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (dayKey(ts) === dayKey(today.getTime() / 1000)) return 'Today';
  if (dayKey(ts) === dayKey(yesterday.getTime() / 1000)) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
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

// ---- delivery ticks ----
// WhatsApp's ack ladder: -1 error, 0 queued, 1 sent to server (single tick),
// 2 delivered to the recipient's device (double tick), 3+ read (blue double tick).
function tickGlyph(ack) {
  if (ack === -1) return '⚠';
  if (ack <= 0) return '🕓';
  if (ack === 1) return '✓';
  return '✓✓';
}

function tickClass(ack) {
  if (ack === -1) return 'tick error';
  if (ack <= 0) return 'tick pending';
  if (ack >= 3) return 'tick read';
  return 'tick';
}

function renderTick(ack) {
  const span = document.createElement('span');
  span.className = tickClass(ack);
  span.textContent = tickGlyph(ack);
  span.dataset.ack = ack;
  return span;
}

function updateTick(el, ack) {
  el.className = tickClass(ack);
  el.textContent = tickGlyph(ack);
  el.dataset.ack = ack;
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

    const nameRow = document.createElement('div');
    nameRow.className = 'ci-name-row';
    const name = document.createElement('div');
    name.className = 'ci-name';
    name.textContent = c.name;
    nameRow.append(name);
    if (c.pinned) {
      const pin = document.createElement('span');
      pin.className = 'ci-flag';
      pin.title = 'Pinned';
      pin.textContent = '📌';
      nameRow.append(pin);
    }
    if (c.muted) {
      const mute = document.createElement('span');
      mute.className = 'ci-flag';
      mute.title = 'Muted';
      mute.textContent = '🔕';
      nameRow.append(mute);
    }

    const last = document.createElement('div');
    last.className = 'ci-last';
    // Ticks in the chat list, but only when the last message is ours.
    if (c.lastAck != null) last.append(renderTick(c.lastAck), document.createTextNode(' '));
    last.append(document.createTextNode(c.lastMessage || ''));

    body.append(nameRow, last);
    li.append(avatar, body);

    if (c.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'ci-badge';
      badge.textContent = c.unread > 99 ? '99+' : c.unread;
      li.append(badge);
    }

    li.addEventListener('click', () => openChat(c.id, c.name, c.isGroup));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openChatMenu(e.clientX, e.clientY, c);
    });
    chatListEl.append(li);
  }
}

// ---- chat context menu (pin / mute / archive / …) ----
function openChatMenu(x, y, chat) {
  chatMenu.innerHTML = '';
  const items = [
    { label: chat.pinned ? '📌 Unpin chat' : '📌 Pin chat', action: chat.pinned ? 'unpin' : 'pin' },
    { label: chat.muted ? '🔔 Unmute' : '🔕 Mute notifications', action: chat.muted ? 'unmute' : 'mute' },
    { label: chat.archived ? '📤 Unarchive' : '📥 Archive chat', action: chat.archived ? 'unarchive' : 'archive' },
    { label: chat.unread > 0 ? '📖 Mark as read' : '📩 Mark as unread', action: chat.unread > 0 ? 'markRead' : 'markUnread' },
    { label: '🧹 Clear messages', action: 'clear', confirm: `Clear all messages in "${chat.name}"?` }
  ];

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'menu-item';
    btn.textContent = item.label;
    btn.addEventListener('click', async () => {
      closeChatMenu();
      if (item.confirm && !confirm(item.confirm)) return;
      const res = await window.wa.chatAction(chat.id, item.action);
      if (res && res.error) alert('Action failed: ' + res.error);
      else if (item.action === 'clear' && chat.id === activeChatId) messagesEl.innerHTML = '';
    });
    chatMenu.append(btn);
  }

  chatMenu.classList.remove('hidden');
  // Keep the menu inside the window.
  const rect = chatMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  chatMenu.style.left = left + 'px';
  chatMenu.style.top = top + 'px';
}

function closeChatMenu() {
  chatMenu.classList.add('hidden');
}

document.addEventListener('click', closeChatMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChatMenu(); });

// ---- helpers ----
const URL_RE = /https?:\/\/[^\s<>"']+/g;

function linkify(str) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of (str || '').matchAll(URL_RE)) {
    if (m.index > last) frag.append(document.createTextNode(str.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[0];
    a.textContent = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
    last = m.index + m[0].length;
  }
  if (last < (str || '').length) frag.append(document.createTextNode(str.slice(last)));
  return frag;
}

// ---- conversation ----
function renderReactions(div, reactions) {
  const existing = div.querySelector('.reactions');
  if (existing) existing.remove();
  if (!reactions || !reactions.length) return;

  const row = document.createElement('div');
  row.className = 'reactions';
  for (const r of reactions) {
    const chip = document.createElement('button');
    chip.className = 'reaction-chip' + (r.mine ? ' mine' : '');
    chip.title = r.mine ? 'Remove your reaction' : 'React with ' + r.emoji;
    chip.textContent = r.count > 1 ? `${r.emoji} ${r.count}` : r.emoji;
    // Tapping your own reaction removes it; tapping someone else's adds yours.
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      window.wa.reactMessage(div.dataset.id, r.mine ? '' : r.emoji);
    });
    row.append(chip);
  }
  div.append(row);
}

function renderQuoted(q) {
  const box = document.createElement('div');
  box.className = 'quoted';
  const who = document.createElement('span');
  who.className = 'quoted-author';
  who.textContent = q.fromMe ? 'You' : (q.author || 'Contact');
  const body = document.createElement('span');
  body.className = 'quoted-body';
  body.textContent = q.body || '';
  box.append(who, body);
  // Jump to the original message when it's still on screen.
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = messagesEl.querySelector(`.bubble[data-id="${CSS.escape(q.id)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('highlight');
    setTimeout(() => target.classList.remove('highlight'), 1200);
  });
  return box;
}

function renderBubble(m) {
  const div = document.createElement('div');
  div.className = 'bubble ' + (m.fromMe ? 'out' : 'in');
  div.dataset.id = m.id;

  if (!m.fromMe && activeChatIsGroup && (m.notifyName || m.author)) {
    const author = document.createElement('span');
    author.className = 'bubble-author';
    author.textContent = m.notifyName || m.author.split('@')[0];
    div.append(author);
  }

  if (m.quoted) div.append(renderQuoted(m.quoted));

  const text = document.createElement('span');
  text.className = 'bubble-text';
  const rawText = m.body || (m.type && m.type !== 'chat' ? `[${m.type}]` : '');
  text.append(linkify(rawText));

  const meta = document.createElement('span');
  meta.className = 'meta';
  if (m.starred) {
    const star = document.createElement('span');
    star.className = 'starred';
    star.title = 'Starred';
    star.textContent = '★';
    meta.append(star);
  }
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(m.timestamp);
  meta.append(time);
  // Ticks only exist for messages we sent.
  if (m.fromMe) meta.append(renderTick(m.ack ?? 0));

  // Hover actions: react, reply, star, edit (own messages only), delete.
  const actions = document.createElement('span');
  actions.className = 'bubble-actions';

  const reactBtn = document.createElement('button');
  reactBtn.className = 'msg-act';
  reactBtn.title = 'React';
  reactBtn.textContent = '😊';
  reactBtn.addEventListener('click', (e) => { e.stopPropagation(); openReactionPicker(div, m); });
  actions.append(reactBtn);

  const replyBtn = document.createElement('button');
  replyBtn.className = 'msg-act';
  replyBtn.title = 'Reply';
  replyBtn.textContent = '↩';
  replyBtn.addEventListener('click', (e) => { e.stopPropagation(); beginReply(m); });
  actions.append(replyBtn);

  const starBtn = document.createElement('button');
  starBtn.className = 'msg-act';
  starBtn.title = m.starred ? 'Unstar message' : 'Star message';
  starBtn.textContent = m.starred ? '★' : '☆';
  starBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = !m.starred;
    const res = await window.wa.starMessage(m.id, next);
    if (res && res.error) { alert('Star failed: ' + res.error); return; }
    m.starred = next;
    starBtn.textContent = next ? '★' : '☆';
    starBtn.title = next ? 'Unstar message' : 'Star message';
    const existing = meta.querySelector('.starred');
    if (next && !existing) {
      const star = document.createElement('span');
      star.className = 'starred';
      star.textContent = '★';
      meta.prepend(star);
    } else if (!next && existing) {
      existing.remove();
    }
  });
  actions.append(starBtn);

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

  div.append(actions, text, meta);
  renderReactions(div, m.reactions);
  return div;
}

// Small floating emoji row anchored to a bubble.
function openReactionPicker(div, m) {
  const old = document.querySelector('.reaction-picker');
  if (old) old.remove();

  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  for (const emoji of QUICK_REACTIONS) {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      picker.remove();
      const res = await window.wa.reactMessage(m.id, emoji);
      if (res && res.error) alert('Reaction failed: ' + res.error);
    });
    picker.append(btn);
  }
  div.append(picker);

  // One-shot outside click to dismiss; the capture below runs after this tick.
  setTimeout(() => {
    document.addEventListener('click', () => picker.remove(), { once: true });
  }, 0);
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

// ---- reply composing ----
function beginReply(m) {
  replyTo = m;
  replyAuthor.textContent = m.fromMe ? 'You' : (m.notifyName || activeChatName);
  replyText.textContent = m.body || '';
  replyBar.classList.remove('hidden');
  msgInput.focus();
}

function cancelReply() {
  replyTo = null;
  replyBar.classList.add('hidden');
}

replyCancel.addEventListener('click', cancelReply);

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

// Insert a "Today"/"Yesterday"/date chip whenever the day rolls over.
function appendMessage(m) {
  const key = dayKey(m.timestamp);
  if (key !== lastDayKey) {
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = dayLabel(m.timestamp);
    messagesEl.append(sep);
    lastDayKey = key;
  }
  messagesEl.append(renderBubble(m));
}

async function openChat(chatId, name, isGroup) {
  activeChatId = chatId;
  activeChatName = name;
  activeChatIsGroup = isGroup;
  cancelReply();
  const entry = allChats.find((c) => c.id === chatId);
  if (entry) entry.unread = 0;
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
  lastDayKey = null;
  for (const m of msgs) appendMessage(m);
  scrollMessages();
}

// ---- typing presence ----
function stopTyping() {
  if (!typingActive || !activeChatId) return;
  typingActive = false;
  window.wa.setTyping(activeChatId, false);
}

msgInput.addEventListener('input', () => {
  if (!activeChatId) return;
  if (!typingActive) {
    typingActive = true;
    window.wa.setTyping(activeChatId, true);
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
});

// ---- emoji picker (composer) ----
function buildEmojiPanel() {
  emojiPanel.innerHTML = '';
  for (const emoji of EMOJI_SET) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      const start = msgInput.selectionStart ?? msgInput.value.length;
      const end = msgInput.selectionEnd ?? msgInput.value.length;
      msgInput.value = msgInput.value.slice(0, start) + emoji + msgInput.value.slice(end);
      msgInput.focus();
      msgInput.selectionStart = msgInput.selectionEnd = start + emoji.length;
    });
    emojiPanel.append(btn);
  }
}

emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPanel.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (!emojiPanel.contains(e.target) && e.target !== emojiBtn) {
    emojiPanel.classList.add('hidden');
  }
});

buildEmojiPanel();

// ---- send ----
composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text || !activeChatId) return;
  msgInput.value = '';
  sendBtn.disabled = true;
  clearTimeout(typingTimer);
  stopTyping();

  const quoted = replyTo;
  cancelReply();

  const res = quoted
    ? await window.wa.replyMessage(activeChatId, text, quoted.id)
    : await window.wa.sendMessage(activeChatId, text);

  sendBtn.disabled = false;
  if (res && res.error) {
    alert('Send failed: ' + res.error);
  }
  msgInput.focus();
});

// Escape in the composer cancels a pending reply.
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && replyTo) { e.preventDefault(); cancelReply(); }
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

// ---- theme switching ----
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  localStorage.setItem('aero-theme', name);
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === name);
  });
}

document.querySelectorAll('.theme-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

applyTheme(localStorage.getItem('aero-theme') || 'aero');

// ---- desktop notifications ----
function notify(m) {
  // Only for incoming messages in a chat we're not currently looking at.
  if (m.fromMe || m.chatId === activeChatId || document.hasFocus()) return;
  const chat = allChats.find((c) => c.id === m.chatId);
  if (chat && chat.muted) return;
  try {
    const n = new Notification(m.chatName || 'New message', {
      body: (m.notifyName ? m.notifyName + ': ' : '') + (m.body || '')
    });
    n.onclick = () => {
      if (chat) openChat(chat.id, chat.name, chat.isGroup);
    };
  } catch (_) { /* notifications unavailable */ }
}

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
  notify(m);
  // Append live message if it belongs to the open chat and isn't already shown.
  if (m.chatId === activeChatId) {
    if (!messagesEl.querySelector(`.bubble[data-id="${CSS.escape(m.id)}"]`)) {
      appendMessage(m);
      trimMessages();
      scrollMessages();
    }
  }
});

window.wa.onAck((d) => {
  const bubble = messagesEl.querySelector(`.bubble[data-id="${CSS.escape(d.id)}"]`);
  const tick = bubble && bubble.querySelector('.meta .tick');
  if (tick) updateTick(tick, d.ack);
});

window.wa.onReaction((d) => {
  const bubble = messagesEl.querySelector(`.bubble[data-id="${CSS.escape(d.id)}"]`);
  if (bubble) renderReactions(bubble, d.reactions);
});

window.wa.onRevoke((d) => {
  const bubble = messagesEl.querySelector(`.bubble[data-id="${CSS.escape(d.id)}"]`);
  if (!bubble) return;
  bubble.classList.add('revoked');
  bubble.querySelector('.bubble-text').textContent = '🚫 This message was deleted';
});

window.wa.onEdited((d) => {
  const bubble = messagesEl.querySelector(`.bubble[data-id="${CSS.escape(d.id)}"]`);
  if (!bubble) return;
  const textEl = bubble.querySelector('.bubble-text');
  textEl.textContent = '';
  textEl.append(linkify(d.body || ''));
  if (!bubble.querySelector('.edited-tag')) {
    const tag = document.createElement('span');
    tag.className = 'edited-tag';
    tag.textContent = 'edited';
    bubble.querySelector('.meta').prepend(tag);
  }
});
