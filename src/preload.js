const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('app:getState'),
  setSetting: (k, v) => ipcRenderer.invoke('app:setSetting', k, v),
  pickFolder: () => ipcRenderer.invoke('app:pickFolder'),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  send: (text) => ipcRenderer.invoke('claude:send', text),
  stop: () => ipcRenderer.invoke('claude:stop'),
  setSession: (id, cwd) => ipcRenderer.invoke('claude:setSession', id, cwd),
  listChats: () => ipcRenderer.invoke('chats:list'),
  loadChat: (id) => ipcRenderer.invoke('chats:load', id),
  saveChat: (chat) => ipcRenderer.invoke('chats:save', chat),
  deleteChat: (id) => ipcRenderer.invoke('chats:delete', id),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: (method) => ipcRenderer.invoke('auth:login', method),
  authCode: (code) => ipcRenderer.invoke('auth:code', code),
  authCancel: () => ipcRenderer.invoke('auth:cancel'),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  onAuthUrl: on('auth:url'),
  onAuthDone: on('auth:done'),
  onEvent: on('claude:event'),
  onError: on('claude:error'),
  onExit: on('claude:exit'),
});
