// Рендерит build/icon.svg в build/icon.png (1024) и собирает build/icon.icns.
// Запуск: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'build');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1024, useContentSize: true,
    transparent: true, frame: false, backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });
  const html = `<!doctype html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  let img = await win.webContents.capturePage();
  if (img.getSize().width !== 1024) img = img.resize({ width: 1024, height: 1024, quality: 'best' });
  const png = path.join(root, 'icon.png');
  fs.writeFileSync(png, img.toPNG());

  if (process.platform === 'darwin') {
    const set = path.join(root, 'icon.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      for (const k of [1, 2]) {
        const px = s * k;
        const out = path.join(set, `icon_${s}x${s}${k === 2 ? '@2x' : ''}.png`);
        execFileSync('sips', ['-z', String(px), String(px), png, '--out', out], { stdio: 'ignore' });
      }
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'icon.icns')]);
    fs.rmSync(set, { recursive: true, force: true });
  }
  app.quit();
});
