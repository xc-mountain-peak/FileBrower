import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, PageSnapshot, TaskItemRecord } from '../../shared/types';

const defaultDraftRule = {
  name: '',
  fieldName: '',
  selector: '',
  defaultValue: '',
  enabled: true,
};

function formatIndex(currentIndex: number, totalCount: number) {
  if (totalCount === 0) {
    return '0 / 0';
  }

  return `${currentIndex + 1} / ${totalCount}`;
}

export default function App() {
  const [state, setState] = useState<AppState>({ task: null, items: [], rules: [] });
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [draftRule, setDraftRule] = useState(defaultDraftRule);
  const [statusText, setStatusText] = useState('');
  const [zoomFactor, setZoomFactor] = useState(() => {
    const stored = localStorage.getItem('ui.browserZoomFactor');
    const value = stored ? Number(stored) : 1.0;
    if (Number.isNaN(value)) {
      return 1.0;
    }

    return Math.max(0.5, Math.min(2, value));
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    const stored = localStorage.getItem('ui.sidebarCollapsed');
    return stored ? stored === 'true' : true;
  });
  const [urlTxtPath, setUrlTxtPath] = useState<string | null>(() => localStorage.getItem('ui.urlTxtPath'));
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.api.getState().then(setState);
    return window.api.subscribeState(setState);
  }, []);

  useEffect(() => {
    localStorage.setItem('ui.sidebarCollapsed', String(isSidebarCollapsed));
  }, [isSidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem('ui.browserZoomFactor', String(zoomFactor));
    window.api.bv.setZoom(zoomFactor);
  }, [zoomFactor]);

  const currentItem = useMemo<TaskItemRecord | null>(() => {
    if (!state.task || state.items.length === 0) {
      return null;
    }

    return state.items[state.task.currentIndex] ?? null;
  }, [state]);

  // 同步 BrowserView 边界到 browser-frame 所在位置
  const syncBounds = useCallback(() => {
    const f = frameRef.current;
    if (!f) return;
    const rect = f.getBoundingClientRect();
    window.api.bv.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, []);

  // 加载 URL 到 BrowserView
  useEffect(() => {
    if (currentItem) {
      window.api.bv.loadUrl(currentItem.url);
      // 给布局一帧时间再同步
      requestAnimationFrame(syncBounds);
    } else {
      window.api.bv.hide();
    }
  }, [currentItem, syncBounds]);

  // 监听容器尺寸变化实时同步 BrowserView
  useEffect(() => {
    const f = frameRef.current;
    if (!f || !currentItem) return;

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(syncBounds);
    });
    ro.observe(f);
    // 窗口移动时也要同步（BrowserView 用窗口坐标）
    window.addEventListener('resize', syncBounds);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [currentItem, syncBounds]);

  // 监听 BrowserView 导航事件
  useEffect(() => {
    const unsub1 = window.api.bv.onNavigated((data) => {
      setStatusText(`正在浏览：${data.url || 'about:blank'}`);
    });
    const unsub2 = window.api.bv.onTitleUpdated((data) => {
      setStatusText(`页面已加载：${data.title}`);
    });
    return () => { unsub1(); unsub2(); };
  }, []);

  useEffect(() => {
    if (!state.task && state.items.length === 0) {
      setStatusText('导入 URL 后开始任务。');
      return;
    }

    if (state.task) {
      setStatusText(`任务「${state.task.name}」已加载，当前进度 ${formatIndex(state.task.currentIndex, state.task.totalCount)}。`);
    }
  }, [state.task, state.items.length]);

  function adjustZoom(next: number) {
    setZoomFactor((value) => {
      const target = next === 0 ? 1 : value + next;
      return Math.max(0.5, Math.min(2, Number(target.toFixed(2))));
    });
  }

  async function handleImport() {
    const input = await window.api.pickInputFile();
    if (!input) {
      return;
    }

    const outputPath = await window.api.pickOutputFile();
    const task = await window.api.createTask({
      name: input.filePath.split(/[\\/]/).pop() || 'URL采集任务',
      inputPath: input.filePath,
      outputPath: outputPath || '',
      urls: input.urls,
    });

    const latestState = await window.api.getState();
    setState(latestState);
    setSelectedRuleId(latestState.rules[0]?.id ?? null);
    setStatusText(`已创建任务「${task.name}」，共 ${task.totalCount} 条 URL。`);
  }

  function showToast(message: string, type: 'success' | 'error') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 2500);
  }

  async function handlePickUrlTxtFile() {
    const filePath = await window.api.pickUrlTxtFile();
    if (!filePath) return;
    setUrlTxtPath(filePath);
    localStorage.setItem('ui.urlTxtPath', filePath);
    showToast(`已选择文件：${filePath.split(/[\\/]/).pop()}`, 'success');
  }

  async function handleSaveCurrent() {
    if (!currentItem) {
      return;
    }

    const snapshot = await captureSnapshot();
    await window.api.saveCurrent(snapshot);
    const latestState = await window.api.getState();
    setState(latestState);
    setStatusText(`已保存第 ${formatIndex(latestState.task?.currentIndex ?? 0, latestState.task?.totalCount ?? 0)} 条。`);

    // 同步将当前 URL 追加到 txt 文件
    if (urlTxtPath && currentItem.url) {
      try {
        await window.api.appendUrlToTxt(urlTxtPath, currentItem.url);
        showToast('URL 已保存 ✓', 'success');
      } catch {
        showToast('URL 写入文件失败', 'error');
      }
    }
  }

  async function captureSnapshot(): Promise<PageSnapshot> {
    try {
      const payload = await window.api.bv.executeJs(
        `(() => ({
          url: location.href,
          title: document.title || '',
          content: document.body ? document.body.innerText.slice(0, 5000) : ''
        }))()`,
      ) as { url?: string; title?: string; content?: string } | null;

      return {
        url: typeof payload?.url === 'string' ? payload.url : currentItem?.url ?? '',
        title: typeof payload?.title === 'string' ? payload.title : currentItem?.title ?? '',
        content: typeof payload?.content === 'string' ? payload.content : currentItem?.content ?? '',
      };
    } catch {
      return {
        url: currentItem?.url ?? '',
        title: currentItem?.title ?? '',
        content: currentItem?.content ?? '',
      };
    }
  }

  async function moveTo(index: number) {
    const task = await window.api.setCurrentIndex(index);
    if (!task) {
      return;
    }

    const latestState = await window.api.getState();
    setState(latestState);
  }

  async function handleExport(format: 'csv' | 'tsv') {
    const result = await window.api.exportResults(format);
    if (!result) {
      setStatusText('导出已取消。');
      return;
    }

    setStatusText(`已导出 ${result.count} 条到 ${result.filePath}`);
  }

  async function handleAddRule() {
    if (!draftRule.name || !draftRule.fieldName || !draftRule.selector) {
      setStatusText('规则名称、字段名和选择器不能为空。');
      return;
    }

    await window.api.addRule(draftRule);
    const latestState = await window.api.getState();
    setState(latestState);
    setDraftRule(defaultDraftRule);
    setSelectedRuleId(latestState.rules[0]?.id ?? null);
    setStatusText('规则已保存。');
  }

  async function handleDeleteRule(ruleId: string) {
    await window.api.deleteRule(ruleId);
    const latestState = await window.api.getState();
    setState(latestState);
    setSelectedRuleId(latestState.rules[0]?.id ?? null);
    setStatusText('规则已删除。');
  }

  async function handleCopyUrl() {
    const url = currentItem?.url;
    if (!url) {
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const temp = document.createElement('textarea');
        temp.value = url;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.focus();
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
      setStatusText('链接已复制到剪贴板。');
    } catch {
      setStatusText('复制失败，请手动复制链接。');
    }
  }

  const selectedRule = state.rules.find((rule) => rule.id === selectedRuleId) ?? null;

  return (
    <div className="shell">
      {/* ── 顶栏：始终紧凑 ── */}
      <header className="topbar">
        <span className="topbar-brand">FileBro</span>
        <div className="topbar-center">
          <button className="primary compact-btn" onClick={handleImport}>导入 URL</button>
          <button className="compact-btn" onClick={() => handleExport('csv')}>导出 CSV</button>
          <button className="compact-btn" onClick={() => handleExport('tsv')}>导出 TSV</button>
          <span className="topbar-sep"></span>
          <button
            className={`compact-btn ${urlTxtPath ? 'txt-file-set' : ''}`}
            onClick={handlePickUrlTxtFile}
            title={urlTxtPath ?? '未选择导出文件'}
          >
            {urlTxtPath ? `📄 ${urlTxtPath.split(/[\\/]/).pop()}` : '📄 选导出 TXT'}
          </button>
        </div>
        <div className="topbar-right">
          <div className="progress-chip">
            {state.task ? formatIndex(state.task.currentIndex, state.task.totalCount) : '0 / 0'}
          </div>
          <button className="icon-btn" onClick={() => setIsSidebarCollapsed((v) => !v)} title={isSidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
            {isSidebarCollapsed ? '☰' : '✕'}
          </button>
        </div>
      </header>

      {/* ── 地址栏 + 导航栏 ── */}
      <div className="browser-bar">
        <div className="address-bar">
          <span className="address-text">{currentItem?.url || '尚未导入 URL'}</span>
          <button className="ghost compact-btn" onClick={handleCopyUrl} disabled={!currentItem?.url}>复制</button>
        </div>
        <nav className="nav-bar">
          <div className="nav-group">
            <button className="ghost compact-btn" onClick={() => adjustZoom(-0.1)} disabled={!currentItem}>−</button>
            <span className="zoom-chip">{Math.round(zoomFactor * 100)}%</span>
            <button className="ghost compact-btn" onClick={() => adjustZoom(0)}>100%</button>
            <button className="ghost compact-btn" onClick={() => adjustZoom(0.1)} disabled={!currentItem}>+</button>
          </div>
          <div className="nav-group nav-main">
            <button className="nav-btn" onClick={() => moveTo(Math.max(0, (state.task?.currentIndex ?? 0) - 1))} disabled={!state.task || state.task.currentIndex <= 0}>← 上一条</button>
            <button className="nav-btn primary" onClick={() => handleSaveCurrent()} disabled={!currentItem}>保存当前</button>
            <button className="nav-btn" onClick={() => moveTo(Math.min((state.task?.totalCount ?? 1) - 1, (state.task?.currentIndex ?? 0) + 1))} disabled={!state.task || state.task.currentIndex >= (state.task.totalCount - 1)}>下一条 →</button>
          </div>
          <span className="status-text">{statusText}</span>
        </nav>
      </div>

      {/* ── 主体：浏览区 + 侧栏 ── */}
      <main className={`layout ${isSidebarCollapsed ? 'layout-wide' : ''}`}>
        <div className="browser-frame" ref={frameRef}>
          {!currentItem && (
            <div className="empty-state">
              <h3>等待导入</h3>
              <p>点击「导入 URL」按钮，选择 txt/csv 文件后开始浏览。</p>
            </div>
          )}
        </div>

        <aside className={`sidebar ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          {/* 任务概况 */}
          <div className="task-summary">
            <div className="summary-item">
              <span>状态</span>
              <strong>{state.task?.status ?? '未开始'}</strong>
            </div>
            <div className="summary-item">
              <span>总数</span>
              <strong>{state.task?.totalCount ?? 0}</strong>
            </div>
            <div className="summary-item">
              <span>当前</span>
              <strong>{state.task ? state.task.currentIndex + 1 : 0}</strong>
            </div>
            <div className="summary-item">
              <span>规则</span>
              <strong>{state.rules.length}</strong>
            </div>
          </div>

          {/* URL 列表 */}
          <div className="url-list-section">
            <h3 className="section-title">URL 列表</h3>
            <div className="item-list">
              {state.items.length === 0 ? (
                <div className="list-empty">暂无任务数据</div>
              ) : (
                state.items.map((item) => (
                  <button
                    key={item.id}
                    className={`item-row ${state.task?.currentIndex === item.index ? 'active' : ''}`}
                    onClick={() => moveTo(item.index)}
                  >
                    <span className={`dot ${item.status}`}></span>
                    <span className="item-index">{item.index + 1}</span>
                    <span className="item-url">{item.url}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 规则管理（可折叠） */}
          <details className="collapsible-section">
            <summary className="section-title">规则管理</summary>
            <div className="rule-form">
              <input placeholder="规则名称" value={draftRule.name} onChange={(event) => setDraftRule((previous) => ({ ...previous, name: event.target.value }))} />
              <input placeholder="字段名" value={draftRule.fieldName} onChange={(event) => setDraftRule((previous) => ({ ...previous, fieldName: event.target.value }))} />
              <input placeholder="CSS 选择器" value={draftRule.selector} onChange={(event) => setDraftRule((previous) => ({ ...previous, selector: event.target.value }))} />
              <input placeholder="默认值" value={draftRule.defaultValue} onChange={(event) => setDraftRule((previous) => ({ ...previous, defaultValue: event.target.value }))} />
              <button className="primary compact-btn" onClick={handleAddRule}>保存规则</button>
            </div>
            <div className="rule-list">
              {state.rules.map((rule) => (
                <article key={rule.id} className={`rule-card ${selectedRule?.id === rule.id ? 'selected' : ''}`}>
                  <header>
                    <strong>{rule.name}</strong>
                    <span>{rule.enabled ? '启用' : '停用'}</span>
                  </header>
                  <p>{rule.fieldName} · {rule.selector}</p>
                  <div className="rule-actions">
                    <button className="compact-btn" onClick={() => setSelectedRuleId(rule.id)}>查看</button>
                    <button className="compact-btn" onClick={() => handleDeleteRule(rule.id)}>删除</button>
                  </div>
                </article>
              ))}
            </div>
          </details>

          {/* 当前条目（可折叠） */}
          <details className="collapsible-section">
            <summary className="section-title">当前条目</summary>
            {currentItem ? (
              <div className="current-card">
                <p className="current-title">{currentItem.title || '未保存标题'}</p>
                <p className="current-url">{currentItem.url}</p>
                <p className={`badge ${currentItem.status}`}>{currentItem.status}</p>
                <pre>{currentItem.content || '尚未保存内容'}</pre>
              </div>
            ) : (
              <div className="list-empty">尚未加载当前条目</div>
            )}
          </details>
        </aside>
      </main>
      {toast && (
        <div className={`toast toast-${toast.type}`}>{toast.message}</div>
      )}
    </div>
  );
}
