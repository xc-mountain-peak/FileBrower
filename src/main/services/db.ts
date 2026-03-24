import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppState, ExportResult, PageSnapshot, RuleRecord, TaskItemRecord, TaskRecord } from '../../shared/types';
import { normalizeTargetUrl, parseUrlList, readTextFile } from './file';
import { tryScrapePage } from './scrape';
import initSqlJs, { Database as SqlJsDatabase, Statement } from 'sql.js';

type CreateTaskInput = {
  name: string;
  inputPath: string;
  outputPath: string;
  urls: string[];
};

type RuleInput = {
  name: string;
  fieldName: string;
  selector: string;
  defaultValue?: string;
  enabled?: boolean;
};

function now() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function toBoolean(value: unknown) {
  return value === 1 || value === true;
}

export class AppDatabase {
  private readonly db: SqlJsDatabase;
  private readonly dbPath: string;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create() {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', file),
    });

    const dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'filebro.sqlite3');
    let db: SqlJsDatabase;

    if (fs.existsSync(dbPath)) {
      const file = fs.readFileSync(dbPath);
      db = new SQL.Database(new Uint8Array(file));
    } else {
      db = new SQL.Database();
    }

    const instance = new AppDatabase(db, dbPath);
    instance.initialize();
    instance.persist();
    return instance;
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        inputPath TEXT NOT NULL,
        outputPath TEXT NOT NULL,
        status TEXT NOT NULL,
        currentIndex INTEGER NOT NULL,
        totalCount INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_items (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        itemIndex INTEGER NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        errorMessage TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        fieldName TEXT NOT NULL,
        selector TEXT NOT NULL,
        defaultValue TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const ruleCount = this.getOne<{ count: number }>('SELECT COUNT(*) AS count FROM rules');
    if (ruleCount.count === 0) {
      const createdAt = now();
      const defaults: RuleRecord[] = [
        {
          id: createId('rule'),
          name: '页面标题',
          fieldName: 'pageTitle',
          selector: 'title',
          defaultValue: '',
          enabled: true,
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: createId('rule'),
          name: '正文提取',
          fieldName: 'bodyText',
          selector: 'body',
          defaultValue: '',
          enabled: true,
          createdAt,
          updatedAt: createdAt,
        },
      ];

      const transaction = (items: RuleRecord[]) => {
        for (const item of items) {
          this.run(
            'INSERT INTO rules (id, name, fieldName, selector, defaultValue, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [item.id, item.name, item.fieldName, item.selector, item.defaultValue, item.enabled ? 1 : 0, item.createdAt, item.updatedAt],
          );
        }
      };
      transaction(defaults);
    }
  }

  getState(): AppState {
    return {
      task: this.getLatestTask(),
      items: this.getActiveTaskItems(),
      rules: this.listRules(),
    };
  }

  getLatestTask(): TaskRecord | null {
    const row = this.getOne<TaskRecord>('SELECT * FROM tasks ORDER BY datetime(updatedAt) DESC, datetime(createdAt) DESC LIMIT 1');

    return row ?? null;
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.getOne<TaskRecord>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    return row ?? null;
  }

  getActiveTaskItems(): TaskItemRecord[] {
    const task = this.getLatestTask();
    if (!task) {
      return [];
    }

    return this.getAll<TaskItemRecord>('SELECT * FROM task_items WHERE taskId = ? ORDER BY itemIndex ASC', [task.id]);
  }

  listRules(): RuleRecord[] {
    const rows = this.getAll<RuleRecord & { enabled: number }>('SELECT * FROM rules ORDER BY datetime(createdAt) ASC');

    return rows.map((row) => ({
      ...row,
      enabled: toBoolean(row.enabled),
    }));
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const createdAt = now();
    const taskId = createId('task');

    const normalizedUrls = input.urls.map(normalizeTargetUrl).filter(Boolean);
    this.run(
      'INSERT INTO tasks (id, name, inputPath, outputPath, status, currentIndex, totalCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [taskId, input.name, input.inputPath, input.outputPath, 'running', 0, normalizedUrls.length, createdAt, createdAt],
    );

    normalizedUrls.forEach((url, index) => {
      this.run(
        'INSERT INTO task_items (id, taskId, itemIndex, url, title, content, status, errorMessage, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [createId('item'), taskId, index, url, '', '', 'pending', '', createdAt, createdAt],
      );
    });

    this.persist();

    return this.getTask(taskId) as TaskRecord;
  }

  setCurrentIndex(index: number): TaskRecord | null {
    const task = this.getLatestTask();
    if (!task) {
      return null;
    }

    const boundedIndex = Math.max(0, Math.min(index, task.totalCount - 1));
    const updatedAt = now();
    this.run('UPDATE tasks SET currentIndex = ?, updatedAt = ? WHERE id = ?', [boundedIndex, updatedAt, task.id]);
    this.persist();

    return this.getTask(task.id);
  }

  async saveCurrent(snapshot: PageSnapshot): Promise<{ task: TaskRecord | null; item: TaskItemRecord | null }> {
    const task = this.getLatestTask();
    if (!task) {
      return { task: null, item: null };
    }

    const item = this.getOne<TaskItemRecord>('SELECT * FROM task_items WHERE taskId = ? AND itemIndex = ? LIMIT 1', [task.id, task.currentIndex]);

    if (!item) {
      return { task, item: null };
    }

    const updatedAt = now();
    const rules = this.listRules();

    let title = snapshot.title.trim();
    let content = snapshot.content.trim();

    try {
      const enrichment = await tryScrapePage(snapshot.url, rules);
      title = enrichment.title || title;
      content = enrichment.content || content;
    } catch {
      content = content || `URL: ${snapshot.url}`;
    }

    if (!title) {
      title = snapshot.url;
    }

    this.run('UPDATE task_items SET title = ?, content = ?, status = ?, errorMessage = ?, updatedAt = ? WHERE id = ?', [title, content, 'success', '', updatedAt, item.id]);

    const completed = task.currentIndex >= task.totalCount - 1;
    this.run('UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?', [completed ? 'completed' : 'running', updatedAt, task.id]);
    this.persist();

    return { task: this.getTask(task.id), item: this.getItem(item.id) };
  }

  getItem(itemId: string): TaskItemRecord | null {
    const row = this.getOne<TaskItemRecord>('SELECT * FROM task_items WHERE id = ?', [itemId]);
    return row ?? null;
  }

  exportResults(format: 'csv' | 'tsv', outputPath: string): ExportResult {
    const task = this.getLatestTask();
    if (!task) {
      throw new Error('No active task to export.');
    }

    const items = this.getAll<TaskItemRecord>('SELECT * FROM task_items WHERE taskId = ? ORDER BY itemIndex ASC', [task.id]);

    const delimiter = format === 'csv' ? ',' : '\t';
    const escapeCell = (value: string) => {
      const needsQuotes = /[",\n\t]/.test(value) || value.includes(delimiter);
      const escaped = value.replace(/"/g, '""');
      return needsQuotes ? `"${escaped}"` : escaped;
    };

    const header = ['index', 'url', 'title', 'status', 'content', 'errorMessage', 'createdAt', 'updatedAt'];
    const rows = items.map((item) => [
      String(item.index + 1),
      item.url,
      item.title,
      item.status,
      item.content,
      item.errorMessage,
      item.createdAt,
      item.updatedAt,
    ]);

    const lines = [header, ...rows]
      .map((row) => row.map((cell) => escapeCell(cell)).join(delimiter))
      .join('\n');

    fs.writeFileSync(outputPath, lines, 'utf8');

    return {
      filePath: outputPath,
      count: items.length,
    };
  }

  addRule(input: RuleInput): RuleRecord {
    const createdAt = now();
    const id = createId('rule');
    const rule: RuleRecord = {
      id,
      name: input.name,
      fieldName: input.fieldName,
      selector: input.selector,
      defaultValue: input.defaultValue ?? '',
      enabled: input.enabled ?? true,
      createdAt,
      updatedAt: createdAt,
    };

    this.run(
      'INSERT INTO rules (id, name, fieldName, selector, defaultValue, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [rule.id, rule.name, rule.fieldName, rule.selector, rule.defaultValue, rule.enabled ? 1 : 0, rule.createdAt, rule.updatedAt],
    );
    this.persist();

    return rule;
  }

  updateRule(ruleId: string, input: RuleInput): RuleRecord | null {
    const existing = this.getOne<RuleRecord>('SELECT * FROM rules WHERE id = ?', [ruleId]);
    if (!existing) {
      return null;
    }

    const updatedAt = now();
    this.run('UPDATE rules SET name = ?, fieldName = ?, selector = ?, defaultValue = ?, enabled = ?, updatedAt = ? WHERE id = ?', [input.name, input.fieldName, input.selector, input.defaultValue ?? '', (input.enabled ?? true) ? 1 : 0, updatedAt, ruleId]);
    this.persist();

    return this.getOne<RuleRecord>('SELECT * FROM rules WHERE id = ?', [ruleId]) as RuleRecord;
  }

  deleteRule(ruleId: string): void {
    this.run('DELETE FROM rules WHERE id = ?', [ruleId]);
    this.persist();
  }

  close() {
    this.db.close();
  }

  private getAll<T>(sql: string, params: Array<string | number> = []): T[] {
    const statement = this.db.prepare(sql);
    statement.bind(params);
    const rows: T[] = [];

    while (statement.step()) {
      rows.push(statement.getAsObject() as T);
    }

    statement.free();
    return rows;
  }

  private getOne<T>(sql: string, params: Array<string | number> = []): T | undefined {
    return this.getAll<T>(sql, params)[0];
  }

  private run(sql: string, params: Array<string | number | null> = []) {
    const statement = this.db.prepare(sql);
    statement.bind(params);
    statement.step();
    statement.free();
  }

  private persist() {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }
}

export function readInputFileUrls(filePath: string) {
  return readTextFile(filePath).then((content) => parseUrlList(content));
}
