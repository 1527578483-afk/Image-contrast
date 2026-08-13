const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: '视频档案',
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Minimal menu — macOS needs at least an app menu
  const isMac = process.platform === 'darwin';
  const template = [];

  if (isMac) {
    template.push({
      label: '视频档案',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: '工具',
    submenu: [
      {
        label: '数据迁移',
        accelerator: 'CmdOrCtrl+Shift+M',
        click: () => openMigration(),
      },
      { type: 'separator' },
      {
        label: '开发者工具',
        accelerator: 'CmdOrCtrl+Shift+I',
        click: () => {
          if (mainWindow) mainWindow.webContents.toggleDevTools();
        },
      },
    ],
  });

  // Window menu on macOS
  if (isMac) {
    template.push({ role: 'windowMenu' });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  mainWindow.loadFile('index.html');

  // Setup console log capture for diagnostics
  setupDiagLogs();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Migration window ──────────────────────────────────────────
let migrationWin = null;

function openMigration(autoMode) {
  if (migrationWin && !migrationWin.isDestroyed()) {
    migrationWin.focus();
    return;
  }

  migrationWin = new BrowserWindow({
    width: 800,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: '数据迁移 — 视频档案',
    backgroundColor: '#0d0d0d',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Pass auto mode via hash (loadFile supports query but hash is more reliable)
  const hash = autoMode ? `auto=${autoMode}` : '';
  migrationWin.loadFile('migrate.html', hash ? { hash } : {});

  migrationWin.on('closed', () => {
    migrationWin = null;
  });
}

// ─── IPC handlers ──────────────────────────────────────────────

// Expose migration server port for the import page
ipcMain.handle('get-server-url', () => {
  return 'http://localhost:9877';
});

// Diagnostic: run arbitrary JS in renderer and return result
ipcMain.handle('diag-exec', async (event, code) => {
  try {
    const result = await mainWindow.webContents.executeJavaScript(code);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Capture renderer console messages for diagnostics
ipcMain.handle('diag-logs', () => {
  const logs = diagLogs.slice(-200);
  diagLogs.length = 0;
  return logs;
});
let diagLogs = [];
function setupDiagLogs() {
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levels = ['VERBOSE', 'INFO', 'WARN', 'ERROR'];
    const entry = `[${levels[level] || '?'}] ${message}  (line ${line})`;
    diagLogs.push(entry);
    if (diagLogs.length > 1000) diagLogs.shift();
    // Also log to stdout for --diag mode
    if (process.argv.includes('--diag')) {
      console.log('[Renderer]', entry);
    }
  });
}

// ─── App lifecycle ─────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  // Auto-start migration import if --migrate flag is set
  if (process.argv.includes('--migrate')) {
    // Small delay to let main window settle
    setTimeout(() => openMigration('import'), 800);
  }

  // Auto-run audio diagnostics if --diag flag is set
  if (process.argv.includes('--diag')) {
    // Capture all console output to file
    const fs = require('fs');
    const diagFile = '/tmp/filmarchive-audio-diag.txt';
    fs.writeFileSync(diagFile, '=== Audio Diagnostic ===\\n', 'utf-8');

    let rounds = 0;
    let diagStarted = false;

    const pollState = async () => {
      if (diagStarted) return;
      rounds++;
      try {
        const stateCheck = await mainWindow.webContents.executeJavaScript(`
          (function() {
            try {
              if (typeof state === 'undefined') return 'STATE_UNDEFINED';
              if (!state.groups) return 'GROUPS_NULL';
              const gs = state.groups.filter(g => g.videos && g.videos.length > 0);
              return 'OK:' + state.groups.length + ':' + gs.length + ':' + gs.map(g => g.name).join('|');
            } catch(e) { return 'ERR:' + e.message; }
          })()
        `);
        console.log('[Diag Round ' + rounds + '] State check:', stateCheck);

        // Guard again — a previous poll might have started the diagnostic
        // while we were awaiting executeJavaScript.
        if (diagStarted) return;

        if (stateCheck.startsWith('OK:')) {
          const parts = stateCheck.split(':');
          const totalGroups = parseInt(parts[1]);
          const nonEmptyGroups = parseInt(parts[2]);

          if (nonEmptyGroups > 0) {
            diagStarted = true;
            const groupName = parts[3]?.split('|')[0] || '';
            console.log('[Diag] Running debugAlignGroup on "' + groupName + '"...');
            try {
              const alignResult = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  try {
                    const result = await debugAlignGroup('${groupName.replace(/'/g, "\\'")}');
                    return 'ALIGN_OK:' + JSON.stringify(result);
                  } catch(e) {
                    return 'ALIGN_ERR:' + e.message + '\\n' + (e.stack || '');
                  }
                })()
              `);
              console.log('[Diag] Alignment result:', alignResult);
              fs.appendFileSync(diagFile, '\\nAlignment result: ' + alignResult + '\\n', 'utf-8');
            } catch (err) {
              console.log('[Diag] Align error:', err.message);
              fs.appendFileSync(diagFile, '\\nAlign error: ' + err.message + '\\n', 'utf-8');
            }

            fs.appendFileSync(diagFile, '\\n=== Renderer Console Logs (audio-related) ===\\n' + diagLogs.filter(l => l.toLowerCase().includes('audio') || l.toLowerCase().includes('align') || l.includes('ERROR') || l.includes('WARN')).join('\\n') + '\\n', 'utf-8');
            fs.appendFileSync(diagFile, '\\nDiagnostic complete.\\n', 'utf-8');
            console.log('[Diag] Report written to ' + diagFile);
            return; // all done
          }
        }
      } catch (err) {
        console.log('[Diag Round ' + rounds + '] Error:', err.message);
      }

      if (rounds >= 30) {
        fs.appendFileSync(diagFile, 'TIMEOUT: App state never loaded after ' + rounds + ' rounds\\n', 'utf-8');
        console.log('[Diag] TIMEOUT');
        return;
      }

      // Schedule next poll — recursive setTimeout avoids the race
      // condition inherent in setInterval + async handler.
      setTimeout(pollState, 2000);
    };

    // Kick off the first poll
    pollState();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
