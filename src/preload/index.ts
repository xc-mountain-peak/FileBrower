import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, ExportResult, ImportFileResult, PageSnapshot, RuleRecord, TaskRecord } from '../shared/types';

type NewRuleInput = {
  name: string;
  fieldName: string;
  selector: string;
  defaultValue?: string;
  enabled?: boolean;
};

type UpdateRuleInput = NewRuleInput & { id: string };

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('app:get-state') as Promise<AppState>,
  subscribeState: (listener: (state: AppState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on('app:state-changed', handler);
    return () => ipcRenderer.removeListener('app:state-changed', handler);
  },
  pickInputFile: () => ipcRenderer.invoke('dialog:pick-input-file') as Promise<ImportFileResult | null>,
  pickOutputFile: () => ipcRenderer.invoke('dialog:pick-output-file') as Promise<string | null>,
  createTask: (input: { name: string; inputPath: string; outputPath: string; urls: string[] }) => ipcRenderer.invoke('task:create', input) as Promise<TaskRecord>,
  setCurrentIndex: (index: number) => ipcRenderer.invoke('task:set-current-index', index) as Promise<TaskRecord | null>,
  saveCurrent: (snapshot: PageSnapshot) => ipcRenderer.invoke('task:save-current', snapshot),
  exportResults: (format: 'csv' | 'tsv', outputPath?: string) => ipcRenderer.invoke('result:export', { format, outputPath }) as Promise<ExportResult | null>,
  listRules: () => ipcRenderer.invoke('rule:list') as Promise<RuleRecord[]>,
  addRule: (input: NewRuleInput) => ipcRenderer.invoke('rule:add', input) as Promise<RuleRecord>,
  updateRule: (input: UpdateRuleInput) => ipcRenderer.invoke('rule:update', input) as Promise<RuleRecord | null>,
  deleteRule: (ruleId: string) => ipcRenderer.invoke('rule:delete', ruleId) as Promise<boolean>,
  useLatestTask: () => ipcRenderer.invoke('task:use-latest') as Promise<AppState>,

  // BrowserView APIs
  bv: {
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('browserview:set-bounds', bounds),
    loadUrl: (url: string) => ipcRenderer.send('browserview:load-url', url),
    setZoom: (factor: number) => ipcRenderer.send('browserview:set-zoom', factor),
    hide: () => ipcRenderer.send('browserview:hide'),
    executeJs: (code: string) => ipcRenderer.invoke('browserview:execute-js', code) as Promise<unknown>,
    getInfo: () => ipcRenderer.invoke('browserview:get-info') as Promise<{ url: string; title: string }>,
    onNavigated: (listener: (data: { url: string; title: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { url: string; title: string }) => listener(data);
      ipcRenderer.on('browserview:navigated', handler);
      return () => ipcRenderer.removeListener('browserview:navigated', handler);
    },
    onTitleUpdated: (listener: (data: { title: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { title: string }) => listener(data);
      ipcRenderer.on('browserview:title-updated', handler);
      return () => ipcRenderer.removeListener('browserview:title-updated', handler);
    },
  },
});

declare global {
  interface Window {
    api: {
      getState: () => Promise<AppState>;
      subscribeState: (listener: (state: AppState) => void) => () => void;
      pickInputFile: () => Promise<ImportFileResult | null>;
      pickOutputFile: () => Promise<string | null>;
      createTask: (input: { name: string; inputPath: string; outputPath: string; urls: string[] }) => Promise<TaskRecord>;
      setCurrentIndex: (index: number) => Promise<TaskRecord | null>;
      saveCurrent: (snapshot: PageSnapshot) => Promise<unknown>;
      exportResults: (format: 'csv' | 'tsv', outputPath?: string) => Promise<ExportResult | null>;
      listRules: () => Promise<RuleRecord[]>;
      addRule: (input: NewRuleInput) => Promise<RuleRecord>;
      updateRule: (input: UpdateRuleInput) => Promise<RuleRecord | null>;
      deleteRule: (ruleId: string) => Promise<boolean>;
      useLatestTask: () => Promise<AppState>;
      bv: {
        setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
        loadUrl: (url: string) => void;
        setZoom: (factor: number) => void;
        hide: () => void;
        executeJs: (code: string) => Promise<unknown>;
        getInfo: () => Promise<{ url: string; title: string }>;
        onNavigated: (listener: (data: { url: string; title: string }) => void) => () => void;
        onTitleUpdated: (listener: (data: { title: string }) => void) => () => void;
      };
    };
  }
}
