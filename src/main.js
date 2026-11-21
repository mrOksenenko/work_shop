const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setName('OKS Desk');

let win = null;
let proc = null;
let sessionId = null;
let stdoutBuf = '';
let stderrBuf = '';
let stoppedByUser = false;

// ---------- настройки ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = () => ({
  claudePath: '',
  cwd: os.homedir(),
  permissionMode: 'acceptEdits',
  model: '',
});
let settings = defaults();

function loadSettings() {
  try {
    settings = { ...defaults(), ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = defaults();
  }
  if (!fs.existsSync(settings.cwd)) settings.cwd = os.homedir();
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить настройки', e);
  }
}

// ---------- поиск claude ----------
function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findClaude() {
  const home = os.homedir();
  const fixed = [
    process.env.OKS_CLAUDE_PATH,
    settings.claudePath,
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of fixed) if (c && isExecutable(c)) return c;

  // PATH из login-шелла (GUI-приложения его не наследуют)
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-lic', 'command -v claude'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.trim().split('\n').pop();
    if (line && isExecutable(line)) return line;
  } catch {}

  // бинарник, который лежит внутри десктопного приложения Claude
  try {
    const root = path.join(app.getPath('appData'), 'Claude', 'claude-code');
    const versions = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      for (const h of fs.readdirSync(path.join(root, v))) {
        const bin = path.join(root, v, h, 'claude.app/Contents/MacOS/claude');
        if (isExecutable(bin)) return bin;
      }
    }
  } catch {}
  return null;
}

// ---------- процесс claude ----------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startProcess() {
  const bin = findClaude();
  if (!bin) {
    send('claude:error', 'Не найден claude CLI. Установите его (npm i -g @anthropic-ai/claude-code) или задайте путь в claudePath в файле настроек.');
    return false;
  }

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', settings.permissionMode,
  ];
  if (settings.model) args.push('--model', settings.model);
  if (sessionId) args.push('--resume', sessionId);

  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
  const env = { ...process.env, PATH: [...extra, process.env.PATH || ''].join(':') };

  stdoutBuf = '';
  stderrBuf = '';
  stoppedByUser = false;

  const child = spawn(bin, args, { cwd: settings.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc = child;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (proc !== child) return; // хвосты остановленного процесса не пускаем в интерфейс
    stdoutBuf += chunk;
    let i;
    while ((i = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, i).trim();
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.session_id) sessionId = evt.session_id;
        send('claude:event', evt);
      } catch {
        send('claude:event', { type: 'raw', text: line });
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderrBuf = (stderrBuf + d).slice(-4000);
  });

  child.on('error', (err) => {
    send('claude:error', `Не удалось запустить claude: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    const wasCurrent = proc === child;
    if (wasCurrent) proc = null;
    if (!wasCurrent) return; // уже остановлен/заменён — интерфейс об этом знает
    if (!stoppedByUser && code !== 0) {
      if (/No conversation found/i.test(stderrBuf)) {
        // CLI потерял сессию (например, очистили ~/.claude): история в OKS Desk осталась, контекст — нет
        sessionId = null;
        send('claude:error', 'CLI больше не хранит контекст этого чата. Отправьте сообщение ещё раз — разговор продолжится с чистого контекста, прежняя переписка останется в истории.');
      } else {
        send('claude:error', `claude завершился (код ${code ?? signal}).\n${stderrBuf.trim()}`);
      }
    }
    send('claude:exit', { code, stopped: stoppedByUser });
  });

  return true;
}

function stopProcess() {
  if (proc) {
    stoppedByUser = true;
    proc.kill('SIGTERM');
    proc = null;
  }
}

ipcMain.handle('app:getState', () => ({
  settings,
  claudePath: findClaude(),
  sessionId,
}));

ipcMain.handle('app:setSetting', (_e, key, value) => {
  if (!(key in defaults())) return settings;
  const changed = settings[key] !== value;
  settings[key] = value;
  saveSettings();
  // режим/модель/папка применяются при следующем запуске процесса
  if (changed && key !== 'claudePath') stopProcess();
  return settings;
});

ipcMain.handle('app:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: settings.cwd,
  });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.cwd = r.filePaths[0];
  saveSettings();
  stopProcess();
  sessionId = null; // другая папка — другой разговор
  return settings.cwd;
});

ipcMain.handle('claude:send', (_e, text) => {
  if (!proc && !startProcess()) return false;
  const msg = { type: 'user', message: { role: 'user', content: text } };
  proc.stdin.write(JSON.stringify(msg) + '\n');
  return true;
});

ipcMain.handle('claude:stop', () => {
  stopProcess();
});

// Переключение на другой чат (или новый, если sessionId = null)
ipcMain.handle('claude:setSession', (_e, id, cwd) => {
  stopProcess();
  sessionId = id || null;
  if (cwd && fs.existsSync(cwd)) {
    settings.cwd = cwd;
    saveSettings();
  }
  return settings.cwd;
});

// ---------- собственная история чатов OKS Desk ----------
// Хранится в userData/chats/<id>.json и не зависит от истории самого claude CLI.
const chatsDir = () => path.join(app.getPath('userData'), 'chats');
const validId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
let chatIndex = null; // id -> { id, title, cwd, updatedAt }

function metaOf(c) {
  return { id: c.id, title: c.title, cwd: c.cwd, updatedAt: c.updatedAt };
}

function loadIndex() {
  if (chatIndex) return chatIndex;
  chatIndex = new Map();
  try {
    for (const f of fs.readdirSync(chatsDir())) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(chatsDir(), f), 'utf8'));
        if (validId(c.id)) chatIndex.set(c.id, metaOf(c));
      } catch {}
    }
  } catch {}
  return chatIndex;
}

ipcMain.handle('chats:list', () =>
  [...loadIndex().values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
);

ipcMain.handle('chats:load', (_e, id) => {
  if (!validId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(chatsDir(), id + '.json'), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('chats:save', (_e, chat) => {
  if (!chat || !validId(chat.id)) return false;
  try {
    fs.mkdirSync(chatsDir(), { recursive: true });
    const file = path.join(chatsDir(), chat.id + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(chat));
    fs.renameSync(file + '.tmp', file); // атомарная запись
    loadIndex().set(chat.id, metaOf(chat));
    return true;
  } catch (e) {
    console.error('Не удалось сохранить чат', e);
    return false;
  }
});

ipcMain.handle('chats:delete', (_e, id) => {
  if (!validId(id)) return false;
  try {
    fs.rmSync(path.join(chatsDir(), id + '.json'), { force: true });
  } catch {}
  loadIndex().delete(id);
  return true;
});

ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------- окно ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 780,
    minWidth: 560,
    minHeight: 420,
    title: 'OKS Desk',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#1a1a1d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopProcess();
  app.quit();
});
