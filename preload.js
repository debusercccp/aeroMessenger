'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted bridge between the renderer (UI) and the main process (WhatsApp).
contextBridge.exposeInMainWorld('wa', {
  // Renderer -> main (request/response)
  getMessages: (chatId) => ipcRenderer.invoke('wa:getMessages', chatId),
  sendMessage: (chatId, text) => ipcRenderer.invoke('wa:sendMessage', { chatId, text }),
  replyMessage: (chatId, text, quotedId) => ipcRenderer.invoke('wa:replyMessage', { chatId, text, quotedId }),
  reactMessage: (messageId, emoji) => ipcRenderer.invoke('wa:reactMessage', { messageId, emoji }),
  starMessage: (messageId, starred) => ipcRenderer.invoke('wa:starMessage', { messageId, starred }),
  setTyping: (chatId, typing) => ipcRenderer.invoke('wa:setTyping', { chatId, typing }),
  chatAction: (chatId, action) => ipcRenderer.invoke('wa:chatAction', { chatId, action }),
  refresh: () => ipcRenderer.invoke('wa:refresh'),
  deleteMessage: (messageId, everyone) => ipcRenderer.invoke('wa:deleteMessage', { messageId, everyone }),
  editMessage: (messageId, text) => ipcRenderer.invoke('wa:editMessage', { messageId, text }),
  logout: () => ipcRenderer.invoke('wa:logout'),

  // Main -> renderer (events)
  onStatus: (cb) => ipcRenderer.on('wa:status', (_e, d) => cb(d)),
  onQr: (cb) => ipcRenderer.on('wa:qr', (_e, d) => cb(d)),
  onChats: (cb) => ipcRenderer.on('wa:chats', (_e, d) => cb(d)),
  onMessage: (cb) => ipcRenderer.on('wa:message', (_e, d) => cb(d)),
  onMe: (cb) => ipcRenderer.on('wa:me', (_e, d) => cb(d)),
  onAck: (cb) => ipcRenderer.on('wa:ack', (_e, d) => cb(d)),
  onReaction: (cb) => ipcRenderer.on('wa:reaction', (_e, d) => cb(d)),
  onRevoke: (cb) => ipcRenderer.on('wa:revoke', (_e, d) => cb(d)),
  onEdited: (cb) => ipcRenderer.on('wa:edited', (_e, d) => cb(d))
});
