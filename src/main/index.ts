import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createMockClawCliAdapter, createRealClawCliAdapter } from './clawCliAdapter';
import { createSqliteCacheStore } from './cacheStore';
import { registerClawInboxIpc } from './ipc';

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    title: 'ClawInbox',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  const adapter =
    process.env.CLAWINBOX_ADAPTER === 'mock'
      ? createMockClawCliAdapter()
      : createRealClawCliAdapter({
          cacheStore: createSqliteCacheStore(join(app.getPath('userData'), 'clawinbox.sqlite'))
        });
  registerClawInboxIpc(adapter);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
