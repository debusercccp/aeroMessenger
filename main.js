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

  waClient.initialize().catch((err) => {
    send('wa:status', { state: 'error', text: 'Init error: ' + err.message });
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

async function relayMessage(msg, fromMe) {
  if (!isTextMessage(msg)) return; // skip media in the conversation view
  try {
    const chat = await msg.getChat();
    send('wa:message', {
      chatId: chat.id._serialized,
      id: msg.id._serialized,
      body: msg.body,
      fromMe: fromMe || msg.fromMe,
      timestamp: msg.timestamp,
      type: msg.type,
      author: msg.author || msg.from
    });
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
      lastMessage: c.lastMessage
        ? (isTextMessage(c.lastMessage) ? c.lastMessage.body : mediaLabel(c.lastMessage.type))
        : ''
    }));
    list.sort((a, b) => b.timestamp - a.timestamp);
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
    // Fetch extra so we still have ~40 text messages after dropping media.
    const messages = await chat.fetchMessages({ limit: 80 });
    return messages
      .filter(isTextMessage)
      .slice(-40)
      .map((m) => ({
        id: m.id._serialized,
        body: m.body,
        fromMe: m.fromMe,
        timestamp: m.timestamp,
        type: m.type,
        author: m.author || m.from
      }));
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
