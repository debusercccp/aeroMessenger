'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted bridge between the renderer (UI) and the main process (WhatsApp).
contextBridge.exposeInMainWorld('wa', {
  // Renderer -> main (request/response)
  getMessages: (chatId) => ipcRenderer.invoke('wa:getMessages', chatId),
  sendMessage: (chatId, text) => ipcRenderer.invoke('wa:sendMessage', { chatId, text }),
  refresh: () => ipcRenderer.invoke('wa:refresh'),
  deleteMessage: (messageId, everyone) => ipcRenderer.invoke('wa:deleteMessage', { messageId, everyone }),
  editMessage: (messageId, text) => ipcRenderer.invoke('wa:editMessage', { messageId, text }),
  logout: () => ipcRenderer.invoke('wa:logout'),

  // Main -> renderer (events)
  onStatus: (cb) => ipcRenderer.on('wa:status', (_e, d) => cb(d)),
  onQr: (cb) => ipcRenderer.on('wa:qr', (_e, d) => cb(d)),
  onChats: (cb) => ipcRenderer.on('wa:chats', (_e, d) => cb(d)),
  onMessage: (cb) => ipcRenderer.on('wa:message', (_e, d) => cb(d)),
  onMe: (cb) => ipcRenderer.on('wa:me', (_e, d) => cb(d))
});
