'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Backend selection (ozone-platform) must be passed as real command-line
// args before Chromium initializes — see launch.js, which is what `npm start`
// runs. Setting it here via appendSwitch is too late to take effect.

let mainWindow = null;
let waClient = null;
let autoRefreshTimer = null;

// How often to auto-refresh the chat list while connected.
const AUTO_REFRESH_MS = 30000;

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => { pushChats(); }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0a3d62',
    title: 'Aero Messenger',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    startWhatsApp();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Safely push an event to the renderer.
function send(channel, payload) {
  if (channel === 'wa:status') console.log('[wa]', payload.state, '-', payload.text);
  if (channel === 'wa:qr') console.log('[wa] qr generated (' + payload.dataUrl.length + ' bytes)');
  if (channel === 'wa:chats') console.log('[wa] chats:', payload.chats.length);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startWhatsApp() {
  if (waClient) return;

  send('wa:status', { state: 'starting', text: 'Starting WhatsApp engine…' });

  waClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(app.getPath('userData'), 'wa-session')
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // Cap on-disk caches so the WhatsApp Web session can't grow to GBs.
        '--disk-cache-size=52428800',   // 50 MB HTTP cache
        '--media-cache-size=10485760'   // 10 MB media cache
      ]
    }
  });

  waClient.on('qr', async (qr) => {
    try {
      const dataUrl = await qrcode.toDataURL(qr, {
        margin: 1,
        width: 320,
        color: { dark: '#0a3d62', light: '#ffffff' }
      });
      send('wa:qr', { dataUrl });
      send('wa:status', { state: 'qr', text: 'Scan the QR with WhatsApp on your phone' });
    } catch (err) {
      send('wa:status', { state: 'error', text: 'Failed to render QR: ' + err.message });
    }
  });

  waClient.on('loading_screen', (percent) => {
    send('wa:status', { state: 'loading', text: `Loading… ${percent}%` });
  });

  waClient.on('authenticated', () => {
    send('wa:status', { state: 'authenticated', text: 'Authenticated — syncing…' });
  });

  waClient.on('auth_failure', (msg) => {
    send('wa:status', { state: 'error', text: 'Auth failure: ' + msg });
  });

  waClient.on('ready', async () => {
    send('wa:status', { state: 'ready', text: 'Connected' });
    try {
      const me = waClient.info ? waClient.info.pushname : '';
      send('wa:me', { name: me || 'You' });
    } catch (_) { /* ignore */ }
    await pushChats();
    startAutoRefresh();
  });

  waClient.on('disconnected', (reason) => {
    send('wa:status', { state: 'disconnected', text: 'Disconnected: ' + reason });
    stopAutoRefresh();
    waClient = null;
  });

  waClient.on('message', async (msg) => {
    await relayMessage(msg, false);
    await pushChats();
  });

  waClient.on('message_create', async (msg) => {
    // Fires for messages we send too, keeping the open chat in sync.
    if (msg.fromMe) {
      await relayMessage(msg, true);
    }
  });

  // Delivery receipts: 1 = sent to server, 2 = delivered to device, 3 = read.
  // This is what drives the single/double/blue ticks in the UI.
  waClient.on('message_ack', (msg, ack) => {
    send('wa:ack', { id: msg.id._serialized, ack });
  });

  // Someone reacted (or removed a reaction). We re-read the whole reaction
  // list of the parent message so counts stay authoritative.
  waClient.on('message_reaction', async (reaction) => {
    try {
      const parentId = msgKeyToId(reaction.msgId);
      if (!parentId) return;
      const parent = await waClient.getMessageById(parentId);
      if (!parent) return; // can't verify: leave the existing chips alone
      send('wa:reaction', { id: parentId, reactions: await collectReactions(parent) });
    } catch (_) { /* ignore */ }
  });

  waClient.on('message_revoke_everyone', (after) => {
    send('wa:revoke', { id: after.id._serialized });
  });

  waClient.on('message_edit', (msg, newBody) => {
    send('wa:edited', { id: msg.id._serialized, body: newBody });
  });

  waClient.initialize().catch((err) => {
    console.error('[wa] FULL INIT ERROR:', err); send('wa:status', { state: 'error', text: 'Init error: ' + (err && err.message) });
  });
}

// Text messages in WhatsApp have type 'chat'. Everything else (image, video,
// audio, ptt/voice-note, document, sticker, …) is media we deliberately skip.
function isTextMessage(msg) {
  return msg.type === 'chat';
}

// Short label for the chat-list preview when the latest message is media,
// so the list still updates/sorts without showing the media itself.
function mediaLabel(type) {
  const labels = {
    image: '📷 Photo', video: '🎬 Video', audio: '🎵 Audio',
    ptt: '🎤 Voice message', document: '📄 Document', sticker: '🇸 Sticker',
    location: '📍 Location', vcard: '👤 Contact'
  };
  return labels[type] || '📎 Attachment';
}

// The reaction event's parent key is JSON-serialized out of the browser page,
// where `_serialized` is a getter and so may not survive the crossing. Fall
// back to WhatsApp's own key format: fromMe_remote_id[_participant].
function msgKeyToId(key) {
  if (!key) return null;
  if (typeof key === 'string') return key;
  if (key._serialized) return key._serialized;
  const jid = (v) => (typeof v === 'string' ? v : (v && v._serialized) || '');
  const remote = jid(key.remote);
  if (!remote || !key.id) return null;
  const parts = [key.fromMe ? 'true' : 'false', remote, key.id];
  const participant = jid(key.participant);
  if (participant) parts.push(participant);
  return parts.join('_');
}

// Collapse WhatsApp's per-sender reaction records into one chip per emoji.
async function collectReactions(msg) {
  if (!msg.hasReaction) return [];
  try {
    const groups = await msg.getReactions();
    if (!groups) return [];
    return groups.map((g) => ({
      emoji: g.aggregateEmoji || g.id,
      count: (g.senders || []).length,
      mine: !!g.hasReactionByMe
    }));
  } catch (_) {
    return [];
  }
}

// The one shape every message crosses the IPC bridge in. `notifyName` may be
// pre-resolved by the caller (history loads batch the contact lookups).
async function serializeMessage(msg, notifyName) {
  const out = {
    id: msg.id._serialized,
    body: msg.body,
    fromMe: msg.fromMe,
    timestamp: msg.timestamp,
    type: msg.type,
    author: msg.author || msg.from,
    notifyName: notifyName || msg.notifyName || '',
    ack: typeof msg.ack === 'number' ? msg.ack : 0,
    starred: !!msg.isStarred,
    reactions: await collectReactions(msg)
  };

  if (msg.hasQuotedMsg) {
    try {
      const q = await msg.getQuotedMessage();
      if (q) {
        out.quoted = {
          id: q.id._serialized,
          body: isTextMessage(q) ? q.body : mediaLabel(q.type),
          fromMe: q.fromMe,
          author: q.notifyName || (q.author || q.from || '').split('@')[0]
        };
      }
    } catch (_) { /* quoted message may be out of the local cache */ }
  }

  return out;
}

async function relayMessage(msg, fromMe) {
  if (!isTextMessage(msg)) return; // skip media in the conversation view
  try {
    const chat = await msg.getChat();
    let notifyName = msg.notifyName || '';
    if (!notifyName && msg.author && !msg.fromMe) {
      try {
        const c = await waClient.getContactById(msg.author);
        notifyName = c.pushname || c.name || '';
      } catch (_) {}
    }
    const payload = await serializeMessage(msg, notifyName);
    payload.chatId = chat.id._serialized;
    payload.chatName = chat.name || chat.id.user;
    payload.fromMe = fromMe || msg.fromMe;
    send('wa:message', payload);
  } catch (_) { /* ignore */ }
}

async function pushChats() {
  if (!waClient) return;
  try {
    const chats = await waClient.getChats();
    const list = chats.slice(0, 60).map((c) => ({
      id: c.id._serialized,
      name: c.name || (c.id && c.id.user) || 'Unknown',
      isGroup: c.isGroup,
      unread: c.unreadCount || 0,
      timestamp: c.timestamp || 0,
      pinned: !!c.pinned,
      archived: !!c.archived,
      muted: !!c.isMuted,
      // Ack of the last message, but only meaningful when we sent it — that's
      // what lets the chat list show ticks next to the preview.
      lastAck: c.lastMessage && c.lastMessage.fromMe ? (c.lastMessage.ack || 0) : null,
      lastMessage: c.lastMessage
        ? (isTextMessage(c.lastMessage) ? c.lastMessage.body : mediaLabel(c.lastMessage.type))
        : ''
    }));
    // Pinned chats float to the top, then most-recent-first, exactly like WhatsApp.
    list.sort((a, b) => (b.pinned - a.pinned) || (b.timestamp - a.timestamp));
    send('wa:chats', { chats: list });
  } catch (err) {
    send('wa:status', { state: 'error', text: 'Could not load chats: ' + err.message });
  }
}

// ----- IPC handlers (renderer -> main) -----

ipcMain.handle('wa:getMessages', async (_evt, chatId) => {
  if (!waClient) return [];
  try {
    const chat = await waClient.getChatById(chatId);
    await chat.sendSeen().catch(() => {});
    // Fetch extra so we still have ~40 text messages after dropping media.
    const messages = await chat.fetchMessages({ limit: 80 });
    const filtered = messages.filter(isTextMessage).slice(-40);

    // notifyName is not populated on history messages — batch-lookup contacts.
    const authorIds = [...new Set(
      filtered.filter((m) => !m.fromMe && m.author).map((m) => m.author)
    )];
    const nameMap = {};
    await Promise.all(authorIds.map(async (id) => {
      try {
        const c = await waClient.getContactById(id);
        nameMap[id] = c.pushname || c.name || '';
      } catch (_) {}
    }));

    return await Promise.all(
      filtered.map((m) => serializeMessage(m, nameMap[m.author]))
    );
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('wa:sendMessage', async (_evt, { chatId, text }) => {
  if (!waClient) return { error: 'Not connected' };
  try {
    await waClient.sendMessage(chatId, text);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Send as a reply to `quotedId`. WhatsApp threads it under the quoted bubble.
ipcMain.handle('wa:replyMessage', async (_evt, { chatId, text, quotedId }) => {
  if (!waClient) return { error: 'Not connected' };
  try {
    const quoted = await waClient.getMessageById(quotedId);
    if (!quoted) return { error: 'Original message not found' };
    await quoted.reply(text, chatId);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Passing an empty string removes our reaction — that's the WhatsApp protocol.
ipcMain.handle('wa:reactMessage', async (_evt, { messageId, emoji }) => {
  if (!waClient) return { error: 'Not connected' };
  try {
    const msg = await waClient.getMessageById(messageId);
    if (!msg) return { error: 'Message not found' };
    await msg.react(emoji || '');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('wa:starMessage', async (_evt, { messageId, starred }) => {
  if (!waClient) return { error: 'Not connected' };
  try {
    const msg = await waClient.getMessageById(messageId);
    if (!msg) return { error: 'Message not found' };
    if (starred) await msg.star(); else await msg.unstar();
    return { ok: true, starred: !!starred };
  } catch (err) {
    return { error: err.message };
  }
});

// Broadcast "typing…" presence to the other side, like the real client.
ipcMain.handle('wa:setTyping', async (_evt, { chatId, typing }) => {
  if (!waClient) return { error: 'Not connected' };
  try {
    const chat = await waClient.getChatById(chatId);
    if (typing) await chat.sendStateTyping(); else await chat.clearState();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('wa:chatAction', async (_evt, { chatId, action }) => {
  if (!waClient) return { error: 'Not connected' };
  try {
    const chat = await waClient.getChatById(chatId);
    switch (action) {
      case 'pin': await chat.pin(); break;
      case 'unpin': await chat.unpin(); break;
      case 'archive': await chat.archive(); break;
      case 'unarchive': await chat.unarchive(); break;
      // WhatsApp treats a far-future expiry as "muted until I say otherwise".
      case 'mute': await chat.mute(new Date(Date.now() + 365 * 24 * 3600 * 1000)); break;
      case 'unmute': await chat.unmute(); break;
      case 'markUnread': await chat.markUnread(); break;
      case 'markRead': await chat.sendSeen(); break;
      case 'clear': await chat.clearMessages(); break;
      default: return { error: 'Unknown action: ' + action };
    }
    await pushChats();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('wa:refresh', async () => {
  if (!waClient) return { error: 'Not connected' };
  await pushChats();
  return { ok: true };
});

ipcMain.handle('wa:deleteMessage', async (_evt, { messageId, everyone }) => {
  if (!waClient) return { error: 'Not connected' };
  try {
    const msg = await waClient.getMessageById(messageId);
    if (!msg) return { error: 'Message not found' };
    await msg.delete(!!everyone); // everyone=true deletes for all (own msgs only)
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('wa:editMessage', async (_evt, { messageId, text }) => {
  if (!waClient) return { error: 'Not connected' };
  const clean = (text || '').trim();
  if (!clean) return { error: 'Empty message' };
  try {
    const msg = await waClient.getMessageById(messageId);
    if (!msg) return { error: 'Message not found' };
    const updated = await msg.edit(clean);
    // edit() returns null when WhatsApp refuses (not your message, or the
    // ~15-minute edit window has passed).
    if (updated === null) return { error: 'Edit not allowed (only your own messages, within 15 min)' };
    return { ok: true, body: updated.body };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('wa:logout', async () => {
  if (!waClient) return { ok: true };
  try {
    await waClient.logout();
    stopAutoRefresh();
    waClient = null;
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

app.whenReady().then(createWindow);

// ----- Graceful shutdown -----
// whatsapp-web.js keeps a headless Chromium (Puppeteer) alive. If we quit
// without closing it, that Chromium tree orphans and keeps running (and the
// app may be force-killed → the SIGKILL you saw). We must (1) keep the event
// loop alive long enough to close it, and (2) hard-kill the browser tree as a
// fallback in case destroy() hangs.

let isQuitting = false;

// Kill the Puppeteer Chromium and all its children, given the root pid.
function killBrowserTree(pid) {
  if (!pid) return;
  try {
    // Negative pid signals the whole process group when available.
    process.kill(-pid, 'SIGKILL');
  } catch (_) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ }
  }
}

async function shutdown() {
  if (isQuitting) return;
  isQuitting = true;
  stopAutoRefresh();

  const client = waClient;
  waClient = null;
  if (client) {
    // Grab the Chromium root pid now, before destroy() detaches it.
    let pid = null;
    try { pid = client.pupBrowser && client.pupBrowser.process() && client.pupBrowser.process().pid; }
    catch (_) { /* ignore */ }

    // Try a clean close, but don't wait forever.
    try {
      await Promise.race([
        client.destroy(),
        new Promise((resolve) => setTimeout(resolve, 4000))
      ]);
    } catch (_) { /* ignore — we're exiting anyway */ }

    killBrowserTree(pid); // safety net: ensure no orphaned Chromium remains
  }

  app.exit(0); // immediate, does not re-fire before-quit
}

// Window close: hold the quit, close the browser cleanly, then exit. This path
// (an app-initiated quit) reliably awaits our async cleanup. Signal-based exits
// (Ctrl+C / kill) are handled by the supervisor in launch.js, which sweeps the
// engine's Chromium — Electron tends to swallow those signals natively.
app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  shutdown();
});

app.on('window-all-closed', () => {
  app.quit(); // → before-quit → shutdown()
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
