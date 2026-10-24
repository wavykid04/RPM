const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const loudness = require('loudness');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');

let widget;
let tray;
let spotifyClientId = null;
let spotifyToken = null;

// Load client ID from config
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  if (cfg.spotifyClientId && cfg.spotifyClientId !== 'YOUR_CLIENT_ID_HERE') {
    spotifyClientId = cfg.spotifyClientId;
  }
} catch (e) {}

const { authenticate, getValidToken } = require('./spotify-auth');
const { searchTrackId, checkIfSaved, saveTrack, removeTrack } = require('./spotify-api');

function createWidget() {
  widget = new BrowserWindow({
    width: 170,
    height: 170,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    icon: path.join(__dirname, 'installer-icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  widget.loadFile('index.html');
  widget.setIgnoreMouseEvents(true, { forward: true });

  // Hide to tray on close instead of quitting
  widget.on('close', (e) => {
    e.preventDefault();
    widget.hide();
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Now Playing Widget');

  const buildMenu = () => Menu.buildFromTemplate([
    {
      label: widget && widget.isVisible() ? 'Hide Widget' : 'Show Widget',
      click: () => {
        if (widget.isVisible()) { widget.hide(); } else { widget.show(); widget.focus(); }
        tray.setContextMenu(buildMenu());
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0); } }
  ]);

  tray.setContextMenu(buildMenu());

  // Left-click tray icon = toggle widget visibility
  tray.on('click', () => {
    if (widget.isVisible()) { widget.hide(); } else { widget.show(); widget.focus(); }
    tray.setContextMenu(buildMenu());
  });
}

// VBScript for instant media keys
const vbsPath = path.join(os.tmpdir(), 'fast-media-keys.vbs');
if (!fs.existsSync(vbsPath)) {
  fs.writeFileSync(vbsPath, `
    Set ws = CreateObject("WScript.Shell")
    Select Case WScript.Arguments(0)
      Case "toggle" ws.SendKeys(chr(179))
      Case "next" ws.SendKeys(chr(176))
      Case "prev" ws.SendKeys(chr(177))
    End Select
  `);
}

ipcMain.on('media-command', (event, cmd) => {
  if (cmd === 'loop') {
    exec(`powershell -command "$wsh = New-Object -ComObject wscript.shell; $wsh.AppActivate('Spotify'); Start-Sleep -Milliseconds 80; $wsh.SendKeys('^+r')"`);
  } else {
    exec(`wscript.exe "${vbsPath}" ${cmd}`);
  }
});

ipcMain.on('set-ignore-mouse', (event, ignore) => {
  if (widget) widget.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('drag-window', (event, { dx, dy }) => {
  if (!widget) return;
  const [x, y] = widget.getPosition();
  widget.setPosition(x + dx, y + dy);
});

// --- Spotify API IPC ---

async function ensureToken() {
  if (!spotifyClientId) return null;
  if (!spotifyToken || Date.now() > (spotifyToken.expires_at - 60000)) {
    spotifyToken = await getValidToken(spotifyClientId);
  }
  return spotifyToken;
}

// Renderer asks us to connect Spotify
ipcMain.handle('spotify-connect', async () => {
  if (!spotifyClientId) return { error: 'No client ID configured in config.json' };
  try {
    spotifyToken = await authenticate(spotifyClientId);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

// Renderer asks: is this track saved?
ipcMain.handle('spotify-check-saved', async (event, { title, artist }) => {
  try {
    const token = await ensureToken();
    if (!token) return { saved: null, authenticated: false };
    const trackId = await searchTrackId(title, artist, token.access_token);
    if (!trackId) return { saved: null, trackId: null, authenticated: true };
    const saved = await checkIfSaved(trackId, token.access_token);
    return { saved, trackId, authenticated: true };
  } catch (e) {
    return { saved: null, authenticated: false };
  }
});

// Renderer toggles saved state
ipcMain.handle('spotify-toggle-saved', async (event, { trackId, currentlySaved }) => {
  // Try API path first
  if (spotifyClientId) {
    try {
      let token = await ensureToken();
      // No token yet — trigger auth flow now
      if (!token) {
        token = await authenticate(spotifyClientId);
        spotifyToken = token;
      }
      if (token && trackId) {
        if (currentlySaved) await removeTrack(trackId, token.access_token);
        else await saveTrack(trackId, token.access_token);
        return { ok: true, saved: !currentlySaved };
      }
    } catch (e) {
      console.error('Spotify API error:', e.message);
    }
  }
  // Fallback: Ctrl+S to Spotify window
  exec(`powershell -command "$wsh = New-Object -ComObject wscript.shell; $wsh.AppActivate('Spotify'); Start-Sleep -Milliseconds 100; $wsh.SendKeys('^s')"`);
  return { ok: true, saved: !currentlySaved };
});

// Volume
ipcMain.handle('get-system-volume', async () => {
  try { return await loudness.getVolume(); } catch { return 50; }
});
ipcMain.on('change-volume', async (event, data) => {
  if (!data || data.value === undefined) return;
  try { await loudness.setVolume(data.value); } catch (e) {}
});

// Worker-based media tracker
function startMediaTracker() {
  let workerPath = path.join(__dirname, 'media-worker.js');
  if (app.isPackaged) workerPath = workerPath.replace('app.asar', 'app.asar.unpacked');
  const worker = new Worker(workerPath);
  worker.on('message', (trackInfo) => { if (widget) widget.webContents.send('update-track', trackInfo); });
  worker.on('error', (err) => console.error('Worker crashed:', err));
}

app.whenReady().then(async () => {
  createWidget();
  createTray();
  startMediaTracker();
  if (spotifyClientId) spotifyToken = await getValidToken(spotifyClientId);
});

// Prevent auto-quit when window closes (we hide to tray instead)
app.on('window-all-closed', () => {});
