// В dev-режиме macOS берёт имя приложения (меню, Dock) из Info.plist самого Electron.app.
// Подменяем его на "OKS Desk". Операция идемпотентна и безопасна, если Electron ещё не скачан.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

const plist = path.join(__dirname, '..', 'node_modules/electron/dist/Electron.app/Contents/Info.plist');
if (!fs.existsSync(plist)) process.exit(0);

// иконка приложения (Dock, переключатель приложений) вместо стандартной иконки Electron
const icns = path.join(__dirname, '..', 'build', 'icon.icns');
const target = path.join(path.dirname(plist), 'Resources', 'electron.icns');
try {
  if (fs.existsSync(icns) && fs.existsSync(target)) fs.copyFileSync(icns, target);
} catch {}

for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  try {
    execFileSync('plutil', ['-replace', key, '-string', 'OKS Desk', plist]);
  } catch {}
}
