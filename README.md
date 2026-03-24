# FileBro Desktop

基于 Electron + React + TypeScript + SQLite 的桌面端采集工具原型。

## 功能

- 导入 txt/csv URL 列表
- 在桌面端逐条浏览页面
- 手动确认后保存当前条目
- 将结果写入 SQLite
- 导出 CSV / TSV
- 管理简单规则模板

## 启动

```bash
npm install
npm run dev
```

如果要启用 Playwright 的页面抽取能力，首次安装后再执行：

```bash
npx playwright install chromium
```

## 打包

```bash
npm run build
```

生成 Windows 免安装便携包（Portable）：

```bash
npm run dist:win
```

或使用等价命令：

```bash
npm run dist:portable
```

打包产物会输出到 `release/` 目录，文件名为 `FileBro Desktop-Portable-<version>-x64.exe`。

当前版本号：`1.0.0`

## 项目结构

- `src/main`：主进程、IPC、SQLite、导出、抽取服务
- `src/preload`：安全桥接 API
- `src/renderer`：React 界面
- `src/shared`：共享类型
