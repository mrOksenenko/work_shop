const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('sendBtn');
const stopBtn = $('stopBtn');
const statusEl = $('status');
const listEl = $('chatList');

marked.setOptions({ gfm: true, breaks: false });

// ---------------------------------------------------------------------------
// Модель чата. Поля с префиксом "_" (DOM-ссылки) в историю не сохраняются.
//   chat  = { id, title, cwd, sessionId, createdAt, updatedAt, items: [] }
//   item  = { type:'user', text } | { type:'assistant', id, blocks:[] } | { type:'error', text }
//   block = { type:'text', text } | { type:'tool', id, name, input, status, output }
// ---------------------------------------------------------------------------
let state = null;
let chat = null;
let busy = false;

let curItem = null; // сообщение ассистента, которое сейчас стримится
const idxMap = new Map(); // индекс content-блока -> блок/служебный объект
const msgItems = new Map(); // id сообщения API -> item
const toolBlocks = new Map(); // tool_use_id -> block

const newChatObj = (cwd) => ({
  id: crypto.randomUUID(),
  title: 'Новый чат',
  cwd,
  sessionId: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  items: [],
});

const hasMessages = () => chat.items.some((i) => i.type === 'user');
const baseName = (p) => (p || '').split('/').filter(Boolean).pop() || '/';

// ---------- сохранение ----------
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 300);
}
async function persistNow() {
  clearTimeout(saveTimer);
  if (!chat || !hasMessages()) return;
  chat.updatedAt = Date.now();
  const plain = JSON.parse(JSON.stringify(chat, (k, v) => (k.startsWith('_') ? undefined : v)));
  await window.api.saveChat(plain);
  refreshList();
}

// ---------- боковая панель ----------
async function refreshList() {
  const chats = await window.api.listChats();
  listEl.innerHTML = '';
  if (!chats.length) {
    listEl.innerHTML = '<div class="noChats">История пуста</div>';
    return;
  }
  for (const c of chats) {
    const row = document.createElement('div');
    row.className = 'chat' + (c.id === chat?.id ? ' active' : '');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = c.title;
    const d = document.createElement('div');
    d.className = 'd';
    const when = new Date(c.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    d.textContent = `${baseName(c.cwd)} · ${when}`;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Удалить чат';
    x.onclick = (e) => {
      e.stopPropagation();
      removeChat(c.id, c.title);
    };
    row.append(t, d, x);
    row.onclick = () => openChat(c.id);
    listEl.appendChild(row);
  }
}

async function leaveCurrent() {
  if (busy) {
    await window.api.stop();
    setBusy(false);
  }
  await persistNow();
}

async function openChat(id) {
  if (chat && id === chat.id) return;
  await leaveCurrent();
  const loaded = await window.api.loadChat(id);
  if (!loaded) return refreshList();
  chat = loaded;
  chat.items ||= [];
  const cwd = await window.api.setSession(chat.sessionId, chat.cwd);
  state.settings.cwd = cwd;
  chat.cwd = cwd;
  showFolder();
  renderChat();
  refreshList();
}

async function newChat(cwd) {
  await leaveCurrent();
  const dir = cwd ?? chat?.cwd ?? state.settings.cwd;
  state.settings.cwd = await window.api.setSession(null, dir);
  chat = newChatObj(state.settings.cwd);
  showFolder();
  renderChat();
  refreshList();
  inputEl.focus();
}

async function removeChat(id, title) {
  if (!confirm(`Удалить чат «${title}»?\nЭто действие нельзя отменить.`)) return;
  const isCurrent = chat && chat.id === id;
  if (isCurrent) {
    clearTimeout(saveTimer); // иначе отложенное сохранение воскресит удалённый чат
    chat.items = [];
  }
  await window.api.deleteChat(id);
  if (isCurrent) await newChat();
  else refreshList();
}

function showFolder() {
  $('folderName').textContent = baseName(chat.cwd);
  $('folderBtn').title = chat.cwd;
}

// ---------- рендер ----------
function renderMarkdown(el, src) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(src));
  el.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternal(a.href);
    });
  });
  el.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'chip copy';
    btn.textContent = 'Копировать';
    btn.onclick = async () => {
      await window.api.copy(pre.querySelector('code')?.innerText ?? pre.innerText);
      btn.textContent = 'Скопировано';
      setTimeout(() => (btn.textContent = 'Копировать'), 1200);
    };
    pre.appendChild(btn);
  });
}

function scrollDown(force) {
  const near = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;
  if (force || near) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function emptyView() {
  const w = document.createElement('div');
  w.id = 'empty';
  w.innerHTML = '<h1>Чем займёмся?</h1><p id="emptyHint"></p>';
  w.querySelector('p').textContent = state.claudePath ? chat.cwd : 'claude CLI не найден';
  return w;
}

function toolSummary(input) {
  if (!input) return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  return typeof v === 'string' ? v : JSON.stringify(input).slice(0, 200);
}

function syncTool(b) {
  let d = b._el;
  if (!d) {
    d = b._el = document.createElement('details');
    d.innerHTML = '<summary><span class="name"></span><span class="arg"></span><span class="st"></span></summary><pre class="inp" hidden></pre><pre class="out" hidden></pre>';
    d.querySelector('.name').textContent = b.name;
  }
  d.className = 'tool ' + (b.status || 'running');
  d.querySelector('.arg').textContent = toolSummary(b.input);
  const inp = d.querySelector('.inp');
  inp.hidden = !b.input;
  if (b.input) inp.textContent = JSON.stringify(b.input, null, 2);
  const out = d.querySelector('.out');
  out.hidden = b.output == null;
  if (b.output != null) out.textContent = b.output;
  return d;
}

const renderTextNow = (b) => {
  b._dirty = false;
  renderMarkdown(b._el, b.text);
  scrollDown();
};
function renderText(b) {
  if (!b._el) {
    b._el = document.createElement('div');
    b._el.className = 'text';
  }
  if (!b._dirty) {
    b._dirty = true;
    requestAnimationFrame(() => renderTextNow(b)); // не чаще одного раза за кадр
  }
  return b._el;
}

function blockEl(b) {
  if (b.type === 'text') {
    b._el ||= Object.assign(document.createElement('div'), { className: 'text' });
    renderTextNow(b);
    return b._el;
  }
  return syncTool(b);
}

function itemEl(item) {
  const el = document.createElement('div');
  item._el = el;
  if (item.type === 'user') {
    el.className = 'msg user';
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = item.text;
    el.appendChild(b);
  } else if (item.type === 'error') {
    el.className = 'error';
    el.textContent = item.text;
  } else {
    el.className = 'msg assistant';
    for (const b of item.blocks) el.appendChild(blockEl(b));
  }
  return el;
}

function renderChat() {
  messagesEl.innerHTML = '';
  idxMap.clear();
  msgItems.clear();
  toolBlocks.clear();
  curItem = null;
  if (!chat.items.length) {
    messagesEl.appendChild(emptyView());
  } else {
    for (const item of chat.items) {
      if (item.type === 'assistant') {
        if (item.id) msgItems.set(item.id, item);
        for (const b of item.blocks) {
          if (b.type !== 'tool') continue;
          if (b.status === 'running') b.status = 'error'; // прерванный запуск
          toolBlocks.set(b.id, b);
        }
      }
      messagesEl.appendChild(itemEl(item));
    }
  }
  setStatus(chat.sessionId ? '' : '');
  scrollDown(true);
}

function setStatus(t) {
  statusEl.textContent = t;
}

function pushItem(item) {
  chat.items.push(item);
  $('empty')?.remove();
  messagesEl.appendChild(itemEl(item));
  scrollDown(true);
  return item;
}

function addError(text) {
  if (!chat) return;
  pushItem({ type: 'error', text });
  persist();
}

function newAssistant(id) {
  const item = { type: 'assistant', id, blocks: [] };
  if (id) msgItems.set(id, item);
  pushItem(item);
  return item;
}

function appendBlock(item, block) {
  item.blocks.push(block);
  item._el.appendChild(blockEl(block));
  if (block.type === 'tool') toolBlocks.set(block.id, block);
}

// ---------- события claude ----------
function handleStreamEvent(ev) {
  if (ev.type === 'message_start') {
    curItem = newAssistant(ev.message?.id);
    idxMap.clear();
    return;
  }
  if (!curItem) curItem = newAssistant(null);
  switch (ev.type) {
    case 'content_block_start': {
      const cb = ev.content_block;
      if (cb.type === 'text') {
        const b = { type: 'text', text: '' };
        appendBlock(curItem, b);
        idxMap.set(ev.index, b);
      } else if (cb.type === 'tool_use') {
        const b = { type: 'tool', id: cb.id, name: cb.name, input: null, status: 'running', output: null, _json: '' };
        appendBlock(curItem, b);
        idxMap.set(ev.index, b);
      } else if (cb.type === 'thinking') {
        const el = document.createElement('div');
        el.className = 'thinking';
        el.textContent = 'Думает…';
        curItem._el.appendChild(el);
        idxMap.set(ev.index, { type: 'thinking', _el: el });
      }
      break;
    }
    case 'content_block_delta': {
      const b = idxMap.get(ev.index);
      if (!b) break;
      if (ev.delta.type === 'text_delta' && b.type === 'text') {
        b.text += ev.delta.text;
        renderText(b);
      } else if (ev.delta.type === 'input_json_delta' && b.type === 'tool') {
        b._json += ev.delta.partial_json;
      }
      break;
    }
    case 'content_block_stop': {
      const b = idxMap.get(ev.index);
      if (b?.type === 'tool' && b._json) {
        try {
          b.input = JSON.parse(b._json);
          syncTool(b);
        } catch {}
      }
      if (b?.type === 'thinking') b._el.remove();
      break;
    }
  }
  scrollDown();
}

function handleAssistant(evt) {
  const msg = evt.message;
  if (!msg) return;
  let item = (msg.id && msgItems.get(msg.id)) || null;
  if (!item) item = newAssistant(msg.id);
  for (const part of msg.content ?? []) {
    if (part.type === 'tool_use') {
      let b = toolBlocks.get(part.id);
      if (!b) {
        b = { type: 'tool', id: part.id, name: part.name, input: null, status: 'running', output: null };
        appendBlock(item, b);
      }
      b.input = part.input;
      syncTool(b);
    } else if (part.type === 'text' && part.text && !item.blocks.some((x) => x.type === 'text')) {
      // сообщение пришло без стриминга
      appendBlock(item, { type: 'text', text: part.text });
    }
  }
  scrollDown();
}

function handleToolResults(content) {
  for (const part of content) {
    if (part.type !== 'tool_result') continue;
    const b = toolBlocks.get(part.tool_use_id);
    if (!b) continue;
    let text = part.content;
    if (Array.isArray(text)) text = text.map((c) => c.text ?? '').join('\n');
    b.status = part.is_error ? 'error' : 'done';
    b.output = String(text ?? '').slice(0, 20000);
    syncTool(b);
  }
  persist();
}

function handleEvent(evt) {
  if (!chat) return;
  if (evt.session_id && chat.sessionId !== evt.session_id) {
    chat.sessionId = evt.session_id;
    persist();
  }
  if (evt.parent_tool_use_id) return; // события саб-агентов не показываем
  switch (evt.type) {
    case 'system':
      if (evt.subtype === 'init') setStatus(evt.model ?? '');
      break;
    case 'stream_event':
      handleStreamEvent(evt.event);
      break;
    case 'assistant':
      handleAssistant(evt);
      break;
    case 'user':
      if (Array.isArray(evt.message?.content)) handleToolResults(evt.message.content);
      break;
    case 'result': {
      curItem = null;
      for (const b of toolBlocks.values()) if (b.status === 'running') { b.status = 'done'; syncTool(b); }
      setBusy(false);
      if (evt.is_error) {
        const r = evt.result || 'Ошибка выполнения';
        if (/not logged in|please run \/login/i.test(r)) {
          auth.loggedIn = false;
          renderAccount();
          const last = [...chat.items].reverse().find((i) => i.type === 'user');
          pendingPrompt = last?.text ?? null;
          chat.sessionId = null; // сессия не создана, resume по ней не сработает
          window.api.setSession(null, chat.cwd);
          addError('Вход не выполнен. Войдите в аккаунт — и повторите сообщение.');
          showAuth();
        } else {
          addError(r);
        }
      }
      const bits = [];
      if (evt.duration_ms) bits.push(`${(evt.duration_ms / 1000).toFixed(1)} с`);
      setStatus(bits.join(' · '));
      persistNow();
      break;
    }
  }
}


// ---------- вход в аккаунт ----------
let auth = { loggedIn: null, info: null }; // loggedIn: null = неизвестно
let authUrl = null;
let pendingPrompt = null; // сообщение, которое не ушло из-за отсутствия входа

function accountLabel(info) {
  return info?.email || info?.account?.email || info?.emailAddress || ({ claude_ai: 'Подписка Claude', console: 'Anthropic Console', oauth_token: 'Подписка Claude', api_key: 'API-ключ' })[info?.authMethod] || 'Вход выполнен';
}

function renderAccount() {
  const t = $('accText');
  const b = $('accBtn');
  b.hidden = auth.loggedIn === null;
  if (auth.loggedIn === true) {
    t.className = 'ok';
    t.textContent = accountLabel(auth.info);
    b.textContent = 'Выйти';
  } else if (auth.loggedIn === false) {
    t.className = 'no';
    t.textContent = 'Вход не выполнен';
    b.textContent = 'Войти';
  } else {
    t.className = '';
    t.textContent = '';
  }
}

async function checkAuth() {
  const st = await window.api.authStatus();
  auth.info = st;
  auth.loggedIn = st.unknown ? null : st.loggedIn === true;
  renderAccount();
  return auth.loggedIn;
}

function showAuth(err) {
  $('auth').hidden = false;
  $('authChoose').hidden = false;
  $('authWait').hidden = true;
  $('authErr').hidden = !err;
  $('authErr').textContent = err || '';
}

function hideAuth() {
  $('auth').hidden = true;
}

async function startLogin(method) {
  authUrl = null;
  $('authCode').value = '';
  $('authErr').hidden = true;
  const r = await window.api.authLogin(method);
  if (!r.ok) return showAuth(r.error);
  $('authChoose').hidden = true;
  $('authWait').hidden = false;
  $('authUrl').value = '';
  $('authOpen').disabled = $('authCopy').disabled = true;
}

window.api.onAuthUrl((url) => {
  authUrl = url;
  $('authUrl').value = url;
  $('authOpen').disabled = $('authCopy').disabled = false;
});

window.api.onAuthDone(async (r) => {
  if (r.cancelled) return;
  if (r.ok) {
    auth.loggedIn = true;
    auth.info = r.status;
    renderAccount();
    hideAuth();
    setStatus('Вход выполнен');
    if (pendingPrompt && !inputEl.value) {
      inputEl.value = pendingPrompt; // возвращаем неотправленное сообщение, чтобы нажать Enter
      autosize();
    }
    pendingPrompt = null;
    inputEl.focus();
  } else {
    showAuth('Вход не завершён.' + (r.output ? '\n' + r.output.trim() : '') + (r.error ? '\n' + r.error : ''));
  }
});

$('loginSub').onclick = () => startLogin('claudeai');
$('loginApi').onclick = () => startLogin('console');
$('authOpen').onclick = () => authUrl && window.api.openExternal(authUrl);
$('authCopy').onclick = async () => {
  if (!authUrl) return;
  await window.api.copy(authUrl); // через main: navigator.clipboard в окне может быть заблокирован
  $('authCopy').textContent = 'Скопировано ✓';
  setTimeout(() => ($('authCopy').textContent = 'Копировать'), 1500);
};
$('authUrl').addEventListener('focus', (e) => e.target.select());
$('authSend').onclick = async () => {
  const code = $('authCode').value.trim();
  if (code) {
    await window.api.authCode(code);
    $('authCode').value = '';
  }
};
$('authCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('authSend').click());
$('authCancel').onclick = async () => {
  await window.api.authCancel();
  showAuth();
};
$('authClose').onclick = async () => {
  await window.api.authCancel();
  hideAuth();
};
$('accBtn').onclick = async () => {
  if (auth.loggedIn) {
    if (!confirm('Выйти из аккаунта Claude? История чатов в OKS Desk сохранится.')) return;
    const st = await window.api.authLogout();
    auth.info = st;
    auth.loggedIn = st.unknown ? null : st.loggedIn === true;
    renderAccount();
  } else {
    showAuth();
  }
};

// ---------- ввод ----------
function setBusy(b) {
  busy = b;
  sendBtn.hidden = b;
  stopBtn.hidden = !b;
  sendBtn.disabled = !inputEl.value.trim();
}

async function submit() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  if (auth.loggedIn === false) {
    pendingPrompt = text; // сообщение остаётся в поле, пока человек не войдёт
    showAuth();
    return;
  }
  inputEl.value = '';
  autosize();
  pushItem({ type: 'user', text });
  if (chat.title === 'Новый чат') chat.title = text.replace(/\s+/g, ' ').slice(0, 48);
  persist();
  setBusy(true);
  setStatus('Claude работает…');
  const ok = await window.api.send(text);
  if (!ok) setBusy(false);
}

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
  sendBtn.disabled = !inputEl.value.trim();
}

async function init() {
  state = await window.api.getState();
  chat = newChatObj(state.settings.cwd);
  showFolder();
  $('modeSel').value = state.settings.permissionMode;
  $('modelSel').value = state.settings.model;
  renderChat();
  if (!state.claudePath) addError('Не найден claude CLI. Установите его (npm i -g @anthropic-ai/claude-code) и перезапустите приложение.');
  refreshList();
  if (state.claudePath && (await checkAuth()) === false) showAuth();
}

$('folderBtn').onclick = async () => {
  const dir = await window.api.pickFolder();
  if (!dir) return;
  // main уже сбросил сессию; старый чат остаётся в истории, начинаем новый в этой папке
  if (busy) setBusy(false);
  await persistNow();
  chat = newChatObj(dir);
  state.settings.cwd = dir;
  showFolder();
  renderChat();
  refreshList();
};
$('modeSel').onchange = (e) => window.api.setSetting('permissionMode', e.target.value).then(() => setBusy(false));
$('modelSel').onchange = (e) => window.api.setSetting('model', e.target.value).then(() => setBusy(false));
$('newBtn').onclick = () => newChat();
stopBtn.onclick = async () => {
  await window.api.stop();
  setBusy(false);
  setStatus('Остановлено');
  persistNow();
};
sendBtn.onclick = submit;
inputEl.addEventListener('input', autosize);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

window.api.onEvent(handleEvent);
window.api.onError((m) => {
  addError(m);
  setBusy(false);
});
window.api.onExit(() => {
  curItem = null;
  if (busy) setBusy(false);
});

init();
autosize();
inputEl.focus();
