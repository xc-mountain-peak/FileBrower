import { app, BrowserView, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { AppDatabase, readInputFileUrls } from './services/db';
import type { AppState, ExportResult, ImportFileResult, PageSnapshot, RuleRecord } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let browserView: BrowserView | null = null;
let database: AppDatabase | null = null;

function getWindowIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png');
  }

  return path.join(process.cwd(), 'build', 'icon.png');
}

function createBrowserView() {
  if (!mainWindow) return;

  browserView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:filebro',
    },
  });
  mainWindow.addBrowserView(browserView);
  // 初始隐藏
  browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  browserView.setAutoResize({ width: false, height: false });

  browserView.webContents.on('did-navigate', () => {
    mainWindow?.webContents.send('browserview:navigated', {
      url: browserView?.webContents.getURL() ?? '',
      title: browserView?.webContents.getTitle() ?? '',
    });
  });
  browserView.webContents.on('did-navigate-in-page', () => {
    mainWindow?.webContents.send('browserview:navigated', {
      url: browserView?.webContents.getURL() ?? '',
      title: browserView?.webContents.getTitle() ?? '',
    });
  });
  browserView.webContents.on('page-title-updated', (_e, title) => {
    mainWindow?.webContents.send('browserview:title-updated', { title });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1840,
    height: 1120,
    minWidth: 1440,
    minHeight: 900,
    backgroundColor: '#08111f',
    title: 'FileBro Desktop',
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  createBrowserView();

  mainWindow.on('closed', () => {
    browserView = null;
    mainWindow = null;
  });
}

function sendState() {
  if (!mainWindow || !database) {
    return;
  }

  const state = database.getState();
  mainWindow.webContents.send('app:state-changed', state);
}

app.whenReady().then(async () => {
  database = await AppDatabase.create();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  database?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app:get-state', async (): Promise<AppState> => {
  if (!database) {
    return { task: null, items: [], rules: [] };
  }

  return database.getState();
});

ipcMain.handle('dialog:pick-input-file', async (): Promise<ImportFileResult | null> => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: '选择 URL 列表文件',
    properties: ['openFile'],
    filters: [
      { name: 'Text/CSV', extensions: ['txt', 'csv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const urls = await readInputFileUrls(filePath);
  return {
    filePath,
    urls,
    count: urls.length,
  };
});

ipcMain.handle('dialog:pick-output-file', async (): Promise<string | null> => {
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: '选择导出文件',
    defaultPath: path.join(app.getPath('documents'), 'filebro-results.csv'),
    filters: [
      { name: 'CSV', extensions: ['csv'] },
      { name: 'TSV', extensions: ['tsv'] },
    ],
  });

  return result.canceled ? null : result.filePath;
});

ipcMain.handle('task:create', async (_event, input: { name: string; inputPath: string; outputPath: string; urls: string[] }) => {
  if (!database) {
    throw new Error('Database is not ready.');
  }

  const task = database.createTask(input);
  sendState();
  return task;
});

ipcMain.handle('task:set-current-index', async (_event, index: number) => {
  if (!database) {
    throw new Error('Database is not ready.');
  }

  const task = database.setCurrentIndex(index);
  sendState();
  return task;
});

ipcMain.handle('task:save-current', async (_event, snapshot: PageSnapshot) => {
  if (!database) {
    throw new Error('Database is not ready.');
  }

  const result = await database.saveCurrent(snapshot);
  sendState();
  return result;
});

ipcMain.handle('result:export', async (_event, input: { format: 'csv' | 'tsv'; outputPath?: string }) => {
  let outputPath = input.outputPath;

  if (!database) {
    throw new Error('Database is not ready.');
  }

  if (!outputPath) {
    const chosenPath = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: '选择导出文件',
      defaultPath: path.join(app.getPath('documents'), `filebro-results.${input.format}`),
      filters: [
        { name: input.format.toUpperCase(), extensions: [input.format] },
      ],
    });

    if (chosenPath.canceled || !chosenPath.filePath) {
      return null;
    }

    outputPath = chosenPath.filePath;
  }

  const result: ExportResult = database.exportResults(input.format, outputPath);
  sendState();
  return result;
});

ipcMain.handle('rule:list', async (): Promise<RuleRecord[]> => {
  if (!database) {
    return [];
  }

  return database.listRules();
});

ipcMain.handle('rule:add', async (_event, input: { name: string; fieldName: string; selector: string; defaultValue?: string; enabled?: boolean }) => {
  if (!database) {
    throw new Error('Database is not ready.');
  }

  const rule = database.addRule(input);
  sendState();
  return rule;
});

ipcMain.handle('rule:update', async (_event, input: { id: string; name: string; fieldName: string; selector: string; defaultValue?: string; enabled?: boolean }) => {
  if (!database) {
    throw new Error('Database is not ready.');
  }

  const rule = database.updateRule(input.id, input);
  sendState();
  return rule;
});

ipcMain.handle('rule:delete', async (_event, ruleId: string) => {
  if (!database) {
    throw new Error('Database is not ready.');
  }

  database.deleteRule(ruleId);
  sendState();
  return true;
});

ipcMain.handle('task:use-latest', async (): Promise<AppState> => {
  if (!database) {
    return { task: null, items: [], rules: [] };
  }

  const state = database.getState();
  sendState();
  return state;
});

// ── BrowserView IPC ──

ipcMain.on('browserview:set-bounds', (_event, bounds: { x: number; y: number; width: number; height: number }) => {
  if (!browserView) return;
  browserView.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
});

ipcMain.on('browserview:load-url', (_event, url: string) => {
  if (!browserView) return;
  browserView.webContents.loadURL(url);
});

ipcMain.on('browserview:set-zoom', (_event, factor: number) => {
  if (!browserView) return;
  browserView.webContents.setZoomFactor(factor);
});

ipcMain.on('browserview:hide', () => {
  if (!browserView) return;
  browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
});

ipcMain.handle('browserview:execute-js', async (_event, code: string) => {
  if (!browserView) return null;
  return browserView.webContents.executeJavaScript(code, true);
});

ipcMain.handle('browserview:get-info', async () => {
  if (!browserView) return { url: '', title: '' };
  return {
    url: browserView.webContents.getURL(),
    title: browserView.webContents.getTitle(),
  };
});
