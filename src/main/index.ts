import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createClawMailServer } from '../server/server';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return address.port;
}

function createWindow(url: string): void {
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
    void mainWindow.loadURL(url);
  }
}

let server: Server | null = null;

void app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  server = await createClawMailServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    databasePath: join(dataDir, 'clawmail.sqlite'),
    secretFilePath: join(dataDir, 'imap-secrets.json'),
    staticDir: join(__dirname, '../renderer'),
    adminUsername: process.env.CLAWMAIL_ADMIN_USERNAME || 'admin',
    adminPassword: process.env.CLAWMAIL_ADMIN_PASSWORD || 'admin',
    masterKey: process.env.CLAWMAIL_MASTER_KEY || 'clawmail-desktop-master-key',
    refreshCooldownMs: Number(process.env.CLAWMAIL_REFRESH_COOLDOWN_MS || 60_000)
  });
  const port = await listen(server);
  createWindow(`http://127.0.0.1:${port}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(`http://127.0.0.1:${port}`);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    server?.close();
    app.quit();
  }
});

app.on('before-quit', () => {
  server?.close();
});
