export type TaskStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed';

export type ItemStatus = 'pending' | 'success' | 'failed' | 'skipped';

export interface TaskRecord {
  id: string;
  name: string;
  inputPath: string;
  outputPath: string;
  status: TaskStatus;
  currentIndex: number;
  totalCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskItemRecord {
  id: string;
  taskId: string;
  index: number;
  url: string;
  title: string;
  content: string;
  status: ItemStatus;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuleRecord {
  id: string;
  name: string;
  fieldName: string;
  selector: string;
  defaultValue: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AppState {
  task: TaskRecord | null;
  items: TaskItemRecord[];
  rules: RuleRecord[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  content: string;
}

export interface ImportFileResult {
  filePath: string;
  urls: string[];
  count: number;
}

export interface ExportResult {
  filePath: string;
  count: number;
}
