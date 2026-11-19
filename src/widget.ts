// Client-side Inline Review Widget injected into previewed HTML pages.
// Uses Shadow DOM for UI isolation + lightweight DOM markers for pins & text highlights.

export function getWidgetScript(filePath: string): string {
  const encodedFile = JSON.stringify(filePath);
  return `
(function() {
  if (window.__CODEX_INLINE_REVIEW_LOADED__) return;
  window.__CODEX_INLINE_REVIEW_LOADED__ = true;

  const FILE_PATH = ${encodedFile};
  const API_BASE = '/__inline_review__/api';
  const SSE_URL = '/__inline_review__/events?file=' + encodeURIComponent(FILE_PATH);

  let state = {
    threads: [],
    generalNote: '',
    submissionCount: 0,
    lastSubmittedAt: null
  };

  let pickMode = false;
  let sidebarOpen = false;
  let activeThreadId = null;
  let filterMode = 'all'; // 'all' | 'open' | 'resolved'
  let pendingTarget = null; // { mode, selector, tagName, selectedText, prefixText, suffixText, htmlSnippet, offsetXRatio, offsetYRatio, anchorEl, clientX, clientY }
  let hoveredEl = null;
  let waitingAgentsCount = 0;
  let codexRun = null;
  let sandboxMode = 'full-access';
  let sandboxInfo = null;
  let sandboxPopoverOpen = false;
  let sendToCodexImmediately = true;
  let popoverMode = null; // null | 'compose' | 'thread'
  let activeRecognition = null;

  // --- Host Page Highlight & Pin Styles ---
  const hostStyle = document.createElement('style');
  hostStyle.id = 'cir-host-styles';
  hostStyle.textContent = \`
    .cir-text-highlight {
      background-color: rgba(251, 191, 36, 0.35);
      border-bottom: 2px solid #f59e0b;
      border-radius: 2px;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }
    .cir-text-highlight:hover, .cir-text-highlight.cir-active {
      background-color: rgba(245, 158, 11, 0.55);
    }
    .cir-text-highlight.cir-resolved {
      background-color: rgba(16, 185, 129, 0.18);
      border-bottom-color: #10b981;
    }
    .cir-text-highlight.cir-answered {
      background-color: rgba(99, 102, 241, 0.25);
      border-bottom-color: #6366f1;
    }
    .cir-element-pulse {
      outline: 3px solid #6366f1 !important;
      outline-offset: 3px !important;
      transition: outline 0.2s ease !important;
    }
    body.cir-pick-mode, body.cir-pick-mode * {
      cursor: crosshair !important;
    }
  \`;
  document.head.appendChild(hostStyle);

  // --- Create Isolated Shadow DOM Root ---
  const hostContainer = document.createElement('div');
  hostContainer.id = 'codex-inline-review-root';
  hostContainer.style.cssText = 'position: fixed; z-index: 2147483640; top: 0; left: 0; width: 0; height: 0; pointer-events: none;';
  document.body.appendChild(hostContainer);

  const shadow = hostContainer.attachShadow({ mode: 'open' });

  const shadowStyle = document.createElement('style');
  shadowStyle.textContent = \`
    * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    }
    .cir-pin {
      position: fixed;
      width: 18px;
      height: 18px;
      border-radius: 50% 50% 50% 3px;
      background: #4f46e5;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25), 0 0 0 1.5px #fff;
      cursor: pointer;
      pointer-events: auto;
      transform: translate(-50%, -100%) rotate(0deg);
      transition: transform 0.15s ease, background 0.15s ease;
      user-select: none;
      z-index: 2147483641;
    }
    .cir-pin:hover, .cir-pin.active {
      transform: translate(-50%, -100%) scale(1.15);
      z-index: 2147483645;
    }
    .cir-pin.status-open {
      background: #f59e0b;
      box-shadow: 0 1px 4px rgba(245, 158, 11, 0.4), 0 0 0 1.5px #fff;
    }
    .cir-pin.status-answered {
      background: #4f46e5;
    }
    .cir-pin.status-resolved {
      background: #10b981;
      opacity: 0.8;
    }

    /* Hover Box for Element Picker */
    .cir-hover-box {
      position: fixed;
      pointer-events: none;
      border: 2px solid #4f46e5;
      background: rgba(79, 70, 229, 0.08);
      border-radius: 4px;
      z-index: 2147483640;
      display: none;
      transition: all 0.05s ease-out;
    }
    .cir-hover-label {
      position: absolute;
      top: -24px;
      left: -2px;
      background: #4f46e5;
      color: #fff;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 2px 7px;
      border-radius: 4px 4px 4px 0;
      white-space: nowrap;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
    }

    /* Selection Floating Pill */
    .cir-selection-pill {
      position: fixed;
      pointer-events: auto;
      background: #18181b;
      color: #fff;
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 12.5px;
      font-weight: 600;
      display: none;
      align-items: center;
      gap: 6px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.12);
      cursor: pointer;
      z-index: 2147483646;
      transform: translate(-50%, -100%);
      margin-top: -10px;
      transition: transform 0.12s ease, background 0.12s ease;
    }
    .cir-selection-pill:hover {
      background: #4f46e5;
    }

    /* Floating Comment / Thread Popover */
    .cir-popover {
      position: fixed;
      width: 340px;
      max-height: 75vh;
      overflow-y: auto;
      background: #1e1e20;
      color: #f4f4f5;
      border-radius: 14px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.1);
      padding: 14px;
      pointer-events: auto;
      z-index: 2147483647;
      display: none;
    }
    .cir-pop-quote {
      font-size: 12.5px;
      color: #a1a1aa;
      border-left: 2px solid #52525b;
      padding-left: 10px;
      margin-bottom: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cir-pop-msg {
      margin-bottom: 12px;
    }
    .cir-pop-msg-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 5px;
      gap: 6px;
    }
    .cir-pop-author-wrap {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12.5px;
      font-weight: 600;
      color: #f4f4f5;
      min-width: 0;
    }
    .cir-pop-avatar {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      color: #fff;
      flex-shrink: 0;
    }
    .cir-pop-avatar.user {
      background: #2563eb;
    }
    .cir-pop-avatar.codex {
      background: #d97706;
    }
    .cir-pop-time {
      font-size: 11.5px;
      color: #71717a;
      font-weight: 400;
    }
    .cir-pop-head-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    .cir-pop-icon-btn {
      background: transparent;
      border: none;
      color: #a1a1aa;
      cursor: pointer;
      padding: 3px 6px;
      border-radius: 5px;
      font-size: 13px;
      line-height: 1;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .cir-pop-icon-btn:hover {
      background: rgba(255,255,255,0.1);
      color: #fff;
    }
    .cir-pop-icon-btn.resolved {
      color: #34d399;
    }
    .cir-pop-msg-body {
      font-size: 13.5px;
      line-height: 1.45;
      color: #e4e4e7;
      white-space: pre-wrap;
      word-break: break-word;
      padding-left: 29px;
    }
    .cir-pop-working {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      color: #a5b4fc;
      padding: 2px 0 8px 29px;
    }
    .cir-pop-input-wrap {
      position: relative;
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 10px;
      padding: 8px 36px 8px 10px;
      margin-top: 4px;
    }
    .cir-pop-input-wrap:focus-within {
      border-color: #6366f1;
    }
    .cir-pop-input {
      width: 100%;
      background: transparent;
      border: none;
      color: #f4f4f5;
      font-size: 13px;
      line-height: 1.4;
      resize: none;
      outline: none;
      min-height: 22px;
      max-height: 110px;
      font-family: inherit;
      display: block;
    }
    .cir-pop-input::placeholder {
      color: #71717a;
    }
    .cir-voice-btn {
      position: absolute;
      right: 6px;
      top: 5px;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: none;
      background: transparent;
      color: #a1a1aa;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      transition: all 0.15s ease;
    }
    .cir-voice-btn:hover {
      background: rgba(255,255,255,0.1);
      color: #fff;
    }
    .cir-voice-btn.recording {
      background: #ef4444;
      color: #fff;
      box-shadow: 0 0 10px rgba(239,68,68,0.6);
      animation: cirPulse 1.2s infinite;
    }
    .cir-pop-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 8px;
      gap: 8px;
    }
    .cir-send-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #a1a1aa;
      cursor: pointer;
      user-select: none;
    }
    .cir-send-toggle input {
      accent-color: #6366f1;
      cursor: pointer;
      margin: 0;
    }
    .cir-pop-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cir-pop-btn-ghost {
      background: transparent;
      border: none;
      color: #a1a1aa;
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .cir-pop-btn-ghost:hover {
      background: rgba(255,255,255,0.08);
      color: #fff;
    }
    .cir-pop-btn-primary {
      background: #4f46e5;
      border: none;
      color: #fff;
      border-radius: 7px;
      padding: 5px 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .cir-pop-btn-primary:hover {
      background: #4338ca;
    }
    .cir-pop-btn-primary:disabled {
      opacity: 0.55;
      cursor: default;
    }
    .cir-textarea {
      width: 100%;
      min-height: 70px;
      border: 1px solid #d4d4d8;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 13px;
      line-height: 1.4;
      resize: vertical;
      outline: none;
      color: #18181b;
      background: #fff;
    }
    .cir-textarea:focus {
      border-color: #4f46e5;
      box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.15);
    }

    /* Buttons */
    .cir-btn {
      border: none;
      border-radius: 7px;
      padding: 6px 12px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .cir-btn-primary {
      background: #4f46e5;
      color: #fff;
    }
    .cir-btn-primary:hover {
      background: #4338ca;
    }
    .cir-btn-success {
      background: #10b981;
      color: #fff;
    }
    .cir-btn-success:hover {
      background: #059669;
    }
    .cir-btn-ghost {
      background: transparent;
      color: #52525b;
    }
    .cir-btn-ghost:hover {
      background: #f4f4f5;
      color: #18181b;
    }
    .cir-btn-sm {
      padding: 4px 8px;
      font-size: 11.5px;
      border-radius: 5px;
    }

    /* Floating Bottom Toolbar */
    .cir-dock {
      position: fixed;
      bottom: 20px;
      right: 24px;
      background: #18181b;
      color: #fff;
      border-radius: 999px;
      padding: 6px 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.12);
      pointer-events: auto;
      z-index: 2147483645;
      transition: right 0.25s ease;
    }
    .cir-dock.sidebar-open {
      right: 316px;
    }
    .cir-dock-btn {
      background: transparent;
      color: #e4e4e7;
      border: none;
      border-radius: 999px;
      padding: 7px 13px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .cir-dock-btn:hover {
      background: rgba(255,255,255,0.12);
      color: #fff;
    }
    .cir-dock-btn.active {
      background: #4f46e5;
      color: #fff;
    }
    .cir-dock-btn.sandbox-full {
      color: #fbbf24;
    }
    .cir-dock-btn.sandbox-locked {
      color: #a1a1aa;
      background: rgba(255,255,255,0.06);
    }
    .cir-sandbox-popover {
      position: fixed;
      width: 340px;
      max-width: calc(100vw - 32px);
      background: #1e1e20;
      color: #f4f4f5;
      border-radius: 14px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.1);
      padding: 14px;
      pointer-events: auto;
      z-index: 2147483647;
      display: none;
    }
    .cir-sandbox-pop-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .cir-sandbox-pop-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 700;
      color: #f4f4f5;
    }
    .cir-sandbox-badge {
      font-size: 10.5px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(255,255,255,0.1);
      color: #d4d4d8;
    }
    .cir-sandbox-pop-body {
      font-size: 12.5px;
      line-height: 1.45;
      color: #d4d4d8;
      margin: 0 0 8px 0;
    }
    .cir-sandbox-pop-hint {
      font-size: 12px;
      line-height: 1.4;
      color: #a1a1aa;
      margin: 0;
    }
    .cir-sandbox-cmd-wrap {
      margin-top: 10px;
      background: #111113;
      border: 1px solid #3f3f46;
      border-radius: 8px;
      padding: 8px 10px;
    }
    .cir-sandbox-cmd {
      display: block;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: #e4e4e7;
      word-break: break-all;
      margin-bottom: 8px;
    }
    .cir-dock-submit {
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      color: #fff;
    }
    .cir-dock-submit:hover {
      background: linear-gradient(135deg, #4338ca, #6d28d9);
    }
    .cir-badge {
      background: #f59e0b;
      color: #18181b;
      font-size: 11px;
      font-weight: 800;
      padding: 1px 6px;
      border-radius: 999px;
    }
    .cir-agent-status {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: #a1a1aa;
      padding: 0 8px;
      border-right: 1px solid rgba(255,255,255,0.12);
    }
    .cir-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #71717a;
    }
    .cir-dot.waiting {
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
      animation: cirPulse 1.5s infinite;
    }
    @keyframes cirPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* Right Sidebar Drawer */
    .cir-sidebar {
      position: fixed;
      top: 0;
      right: 0;
      width: 300px;
      height: 100vh;
      background: #ffffff;
      color: #18181b;
      border-left: 1px solid #e4e4e7;
      box-shadow: -8px 0 28px rgba(0,0,0,0.1);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      z-index: 2147483644;
      transform: translateX(0);
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .cir-sidebar.closed {
      transform: translateX(100%);
    }
    .cir-sidebar-header {
      padding: 8px 10px;
      border-bottom: 1px solid #e4e4e7;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #fafafa;
    }
    .cir-sidebar-title {
      font-size: 13px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cir-filter-bar {
      display: flex;
      gap: 4px;
      padding: 5px 10px;
      border-bottom: 1px solid #f4f4f5;
      background: #fff;
    }
    .cir-filter-tab {
      border: none;
      background: transparent;
      padding: 3px 8px;
      font-size: 11.5px;
      font-weight: 600;
      color: #71717a;
      border-radius: 5px;
      cursor: pointer;
    }
    .cir-filter-tab.active {
      background: #eef2ff;
      color: #4f46e5;
    }
    .cir-threads-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .cir-empty {
      text-align: center;
      padding: 28px 14px;
      color: #71717a;
      font-size: 12.5px;
      line-height: 1.45;
    }
    .cir-thread-card {
      border: 1px solid #e4e4e7;
      border-radius: 8px;
      padding: 7px 9px;
      background: #fff;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
      cursor: pointer;
    }
    .cir-thread-card:hover {
      border-color: #a5b4fc;
    }
    .cir-thread-card.active {
      border-color: #4f46e5;
      box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.15);
    }
    .cir-thread-top {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
      min-width: 0;
    }
    .cir-thread-num {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-weight: 700;
      font-size: 11.5px;
      flex-shrink: 0;
    }
    .cir-thread-target-preview {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      color: #52525b;
    }
    .cir-status-pill {
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .cir-status-pill.open {
      background: #fef3c7;
      color: #b45309;
    }
    .cir-status-pill.answered {
      background: #e0e7ff;
      color: #4338ca;
    }
    .cir-status-pill.resolved {
      background: #d1fae5;
      color: #047857;
    }
    .cir-msg {
      font-size: 12px;
      line-height: 1.35;
      padding: 4px 7px;
      border-radius: 6px;
      margin-bottom: 4px;
    }
    .cir-msg:last-child {
      margin-bottom: 0;
    }
    .cir-msg.user {
      background: #f4f4f5;
      color: #18181b;
    }
    .cir-msg.codex {
      background: #eef2ff;
      color: #1e1b4b;
      border: 1px solid #c7d2fe;
    }
    .cir-msg-author {
      font-size: 11.5px;
      font-weight: 700;
      margin-right: 3px;
      color: #3f3f46;
    }
    .cir-msg.codex .cir-msg-author {
      color: #4f46e5;
    }
    .cir-msg-text {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .cir-thread-reply-box {
      margin-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .cir-sidebar-footer {
      padding: 8px 10px;
      border-top: 1px solid #e4e4e7;
      background: #fafafa;
      display: flex;
      flex-direction: row;
      gap: 6px;
    }

    /* Toast */
    .cir-toast {
      position: fixed;
      top: 18px;
      left: 50%;
      transform: translateX(-50%) translateY(-20px);
      background: #18181b;
      color: #fff;
      padding: 9px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(0,0,0,0.22);
      z-index: 2147483647;
      opacity: 0;
      pointer-events: none;
      transition: all 0.2s ease;
    }
    .cir-toast.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  \`;
  shadow.appendChild(shadowStyle);

  // --- UI Containers in Shadow DOM ---
  const pinsContainer = document.createElement('div');
  const hoverBox = document.createElement('div');
  hoverBox.className = 'cir-hover-box';
  const hoverLabel = document.createElement('div');
  hoverLabel.className = 'cir-hover-label';
  hoverBox.appendChild(hoverLabel);

  const selectionPill = document.createElement('button');
  selectionPill.className = 'cir-selection-pill';
  selectionPill.innerHTML = '💬 Comment on selection';

  const popover = document.createElement('div');
  popover.className = 'cir-popover';

  const sandboxPopover = document.createElement('div');
  sandboxPopover.className = 'cir-sandbox-popover';

  const dock = document.createElement('div');
  dock.className = 'cir-dock';

  const sidebar = document.createElement('div');
  sidebar.className = 'cir-sidebar closed';

  const toast = document.createElement('div');
  toast.className = 'cir-toast';

  shadow.appendChild(pinsContainer);
  shadow.appendChild(hoverBox);
  shadow.appendChild(selectionPill);
  shadow.appendChild(popover);
  shadow.appendChild(sandboxPopover);
  shadow.appendChild(dock);
  shadow.appendChild(sidebar);
  shadow.appendChild(toast);

  let toastTimer = null;
  function showToast(msg, duration = 3200) {
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), duration);
  }

  // --- CSS Selector Generator & Element Resolution ---
  function getCssSelector(el) {
    if (!el || el.nodeType !== 1) return 'body';
    if (el.id && !el.id.startsWith('cir-')) {
      return '#' + CSS.escape(el.id);
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      let selector = cur.tagName.toLowerCase();
      if (cur.id && !cur.id.startsWith('cir-')) {
        selector = '#' + CSS.escape(cur.id);
        parts.unshift(selector);
        break;
      }
      const classes = Array.from(cur.classList || []).filter(c => !c.startsWith('cir-'));
      if (classes.length > 0 && classes.length <= 3) {
        selector += '.' + classes.map(c => CSS.escape(c)).join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          const idx = Array.from(parent.children).indexOf(cur) + 1;
          selector += ':nth-child(' + idx + ')';
        }
      }
      parts.unshift(selector);
      cur = cur.parentElement;
    }
    return parts.length ? parts.join(' > ') : 'body';
  }

  function getOuterHtmlSnippet(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    // Unwrap our highlight marks inside clone so snippet is clean
    const marks = clone.querySelectorAll ? clone.querySelectorAll('.cir-text-highlight') : [];
    marks.forEach(m => {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    });
    const raw = clone.outerHTML || clone.textContent || '';
    return raw.length > 450 ? raw.slice(0, 450) + ' ...' : raw;
  }

  function resolveTargetElement(target) {
    if (!target || !target.selector) return null;
    try {
      const el = document.querySelector(target.selector);
      if (el) return el;
    } catch {}
    return null;
  }

  // --- Text Highlighting on Host Page ---
  function clearHostHighlights() {
    const marks = document.querySelectorAll('mark.cir-text-highlight');
    marks.forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  function applyTextHighlightForThread(thread) {
    const t = thread.target;
    if (!t || t.mode !== 'text' || !t.selectedText) return null;
    const container = resolveTargetElement(t) || document.body;
    const searchStr = t.selectedText;
    if (!searchStr) return null;

    // Walk text nodes inside container to find matching text
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && node.parentElement.closest('#codex-inline-review-root')) continue;
      const val = node.nodeValue || '';
      const idx = val.indexOf(searchStr);
      if (idx !== -1) {
        try {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + searchStr.length);
          const mark = document.createElement('mark');
          mark.className = 'cir-text-highlight cir-' + thread.status + (activeThreadId === thread.id ? ' cir-active' : '');
          mark.dataset.threadId = thread.id;
          range.surroundContents(mark);
          mark.addEventListener('click', (e) => {
            e.stopPropagation();
            selectThread(thread.id, false, true);
          });
          return mark;
        } catch {
          return container;
        }
      }
    }
    return container;
  }

  // --- Render Pins & Highlights ---
  let threadAnchorMap = new Map();

  function renderAnchorsAndPins() {
    clearHostHighlights();
    pinsContainer.innerHTML = '';
    threadAnchorMap.clear();

    for (const thread of state.threads) {
      if (filterMode === 'open' && thread.status === 'resolved') continue;
      if (filterMode === 'resolved' && thread.status !== 'resolved') continue;

      let anchorEl = null;
      if (thread.target.mode === 'text') {
        anchorEl = applyTextHighlightForThread(thread);
      }
      if (!anchorEl) {
        anchorEl = resolveTargetElement(thread.target);
      }
      if (!anchorEl) continue;

      threadAnchorMap.set(thread.id, anchorEl);

      const pin = document.createElement('div');
      pin.className = 'cir-pin status-' + thread.status + (activeThreadId === thread.id ? ' active' : '');
      pin.textContent = String(thread.number);
      pin.title = '#' + thread.number + ': ' + (thread.messages[0]?.text || '');
      pin.dataset.threadId = thread.id;
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        selectThread(thread.id, false, true);
      });
      pinsContainer.appendChild(pin);
    }
    updatePinPositions();
  }

  function updatePinPositions() {
    const pins = pinsContainer.querySelectorAll('.cir-pin');
    pins.forEach(pin => {
      const threadId = pin.dataset.threadId;
      const thread = state.threads.find(t => t.id === threadId);
      const anchorEl = threadAnchorMap.get(threadId);
      if (!thread || !anchorEl) {
        pin.style.display = 'none';
        return;
      }
      const rect = anchorEl.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        pin.style.display = 'none';
        return;
      }
      pin.style.display = 'flex';
      let x = rect.right;
      let y = rect.top;
      if (thread.target.mode === 'element' && typeof thread.target.offsetXRatio === 'number') {
        x = rect.left + rect.width * thread.target.offsetXRatio;
        y = rect.top + rect.height * thread.target.offsetYRatio;
      } else {
        x = Math.min(window.innerWidth - 20, Math.max(20, rect.right - 4));
        y = Math.max(28, rect.top + 6);
      }
      pin.style.left = x + 'px';
      pin.style.top = y + 'px';
    });
    if (popoverMode === 'thread' && activeThreadId) {
      const coords = getThreadAnchorCoords(activeThreadId);
      positionPopoverAt(coords.x, coords.y);
    }
  }

  window.addEventListener('scroll', updatePinPositions, { passive: true });
  window.addEventListener('resize', updatePinPositions, { passive: true });

  // --- Text Selection Detection ---
  document.addEventListener('mouseup', (e) => {
    if (pickMode) return;
    if (e.target && e.target.closest && e.target.closest('#codex-inline-review-root')) return;

    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        selectionPill.style.display = 'none';
        return;
      }
      const text = sel.toString().trim();
      if (!text || text.length < 2) {
        selectionPill.style.display = 'none';
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const commonEl = range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;

      if (!commonEl || commonEl.closest('#codex-inline-review-root')) return;

      const fullText = commonEl.textContent || '';
      const idx = fullText.indexOf(text);
      const prefixText = idx > 0 ? fullText.slice(Math.max(0, idx - 40), idx) : '';
      const suffixText = idx !== -1 ? fullText.slice(idx + text.length, idx + text.length + 40) : '';

      pendingTarget = {
        mode: 'text',
        selector: getCssSelector(commonEl),
        tagName: commonEl.tagName.toLowerCase(),
        selectedText: text,
        prefixText,
        suffixText,
        htmlSnippet: getOuterHtmlSnippet(commonEl),
        clientX: rect.left + rect.width / 2,
        clientY: rect.top
      };

      selectionPill.style.left = Math.min(window.innerWidth - 100, Math.max(100, rect.left + rect.width / 2)) + 'px';
      selectionPill.style.top = Math.max(44, rect.top) + 'px';
      selectionPill.style.display = 'inline-flex';
    }, 15);
  });

  selectionPill.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pendingTarget) return;
    selectionPill.style.display = 'none';
    openComposerPopover(pendingTarget);
  });

  // --- Element Picker Mode ---
  function setPickMode(enabled) {
    pickMode = enabled;
    document.body.classList.toggle('cir-pick-mode', pickMode);
    if (!pickMode) {
      hoverBox.style.display = 'none';
      hoveredEl = null;
    }
    renderDock();
  }

  document.addEventListener('mousemove', (e) => {
    const activePick = pickMode || e.altKey;
    if (!activePick) {
      if (hoverBox.style.display !== 'none') hoverBox.style.display = 'none';
      return;
    }
    const el = e.target;
    if (!el || el === document.body || el === document.documentElement || (el.closest && el.closest('#codex-inline-review-root'))) {
      hoverBox.style.display = 'none';
      hoveredEl = null;
      return;
    }
    hoveredEl = el;
    const rect = el.getBoundingClientRect();
    hoverBox.style.display = 'block';
    hoverBox.style.left = rect.left + 'px';
    hoverBox.style.top = rect.top + 'px';
    hoverBox.style.width = rect.width + 'px';
    hoverBox.style.height = rect.height + 'px';
    const sel = getCssSelector(el);
    hoverLabel.textContent = '<' + el.tagName.toLowerCase() + '> ' + (sel.length > 38 ? '...' + sel.slice(-35) : sel);
  }, true);

  document.addEventListener('click', (e) => {
    const activePick = pickMode || e.altKey;
    if (!activePick) return;
    const el = e.target;
    if (!el || (el.closest && el.closest('#codex-inline-review-root'))) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = el.getBoundingClientRect();
    const offsetXRatio = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0.5;
    const offsetYRatio = rect.height > 0 ? Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) : 0.5;
    const textPreview = (el.innerText || el.textContent || '').trim().slice(0, 140);

    pendingTarget = {
      mode: 'element',
      selector: getCssSelector(el),
      tagName: el.tagName.toLowerCase(),
      selectedText: textPreview || undefined,
      htmlSnippet: getOuterHtmlSnippet(el),
      offsetXRatio: Number(offsetXRatio.toFixed(3)),
      offsetYRatio: Number(offsetYRatio.toFixed(3)),
      clientX: e.clientX,
      clientY: e.clientY
    };

    setPickMode(false);
    openComposerPopover(pendingTarget);
  }, true);

  // --- Popover Helpers, Voice Dictation & Thread Popup ---
  function stopVoiceDictation() {
    if (activeRecognition) {
      try {
        activeRecognition.stop();
      } catch {}
      activeRecognition = null;
    }
  }

  function closePopover() {
    stopVoiceDictation();
    popover.style.display = 'none';
    popoverMode = null;
    pendingTarget = null;
  }

  function positionPopoverAt(anchorX, anchorY) {
    const left = Math.min(window.innerWidth - 356, Math.max(16, anchorX - 60));
    const top = Math.min(window.innerHeight - 320, Math.max(16, anchorY + 12));
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
    popover.style.display = 'block';
  }

  function getThreadAnchorCoords(threadId) {
    const pin = pinsContainer.querySelector('[data-thread-id="' + CSS.escape(threadId) + '"]');
    if (pin && pin.style.display !== 'none') {
      const px = parseFloat(pin.style.left);
      const py = parseFloat(pin.style.top);
      if (!Number.isNaN(px) && !Number.isNaN(py)) {
        return { x: px, y: py };
      }
    }
    const anchorEl = threadAnchorMap.get(threadId);
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      return { x: rect.left + Math.min(120, rect.width / 2), y: rect.bottom };
    }
    return { x: Math.max(40, window.innerWidth / 2 - 140), y: 80 };
  }

  function formatRelativeTime(iso) {
    if (!iso) return 'now';
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSec < 60) return 'now';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return mins + 'm';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h';
    return Math.floor(hrs / 24) + 'd';
  }

  function autoResizeInput(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(110, Math.max(22, el.scrollHeight)) + 'px';
  }

  function attachVoiceDictation(btnEl, inputEl) {
    if (!btnEl || !inputEl) return;
    let listening = false;
    let rec = null;

    btnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        showToast('⚠️ Voice dictation requires Chrome, Edge, or Safari');
        return;
      }

      if (listening && rec) {
        try {
          rec.stop();
        } catch {}
        return;
      }

      stopVoiceDictation();
      rec = new SpeechRecognition();
      activeRecognition = rec;
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language || 'en-US';

      const basePrefix = inputEl.value.trimEnd();
      let finalTranscript = '';

      rec.onstart = () => {
        listening = true;
        btnEl.classList.add('recording');
        btnEl.title = 'Stop voice input';
      };

      rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += (finalTranscript ? ' ' : '') + piece.trim();
          } else {
            interim += piece;
          }
        }
        const spoken = (finalTranscript + (interim ? ' ' + interim : '')).trim();
        inputEl.value = basePrefix ? (spoken ? basePrefix + ' ' + spoken : basePrefix) : spoken;
        autoResizeInput(inputEl);
      };

      rec.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          showToast('⚠️ Microphone access denied in browser');
        } else if (event.error === 'network') {
          showToast('⚠️ Speech recognition network error (check internet connection)');
        } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
          showToast('⚠️ Voice input error: ' + event.error);
        }
      };

      rec.onend = () => {
        listening = false;
        btnEl.classList.remove('recording');
        btnEl.title = 'Dictate comment with voice';
        if (activeRecognition === rec) {
          activeRecognition = null;
        }
        inputEl.focus();
      };

      try {
        rec.start();
      } catch (err) {
        showToast('⚠️ Could not start microphone');
      }
    });
  }

  function openComposerPopover(target) {
    stopVoiceDictation();
    popoverMode = 'compose';
    positionPopoverAt(target.clientX, target.clientY);

    const quoteLabel = target.selectedText
      ? escapeHtml(target.selectedText.slice(0, 120))
      : escapeHtml(target.selector);

    popover.innerHTML = \`
      <div class="cir-pop-quote" title="\${quoteLabel}">\${quoteLabel}</div>
      <div class="cir-pop-msg-head" style="margin-bottom:8px;">
        <div class="cir-pop-author-wrap">
          <span class="cir-pop-avatar user">You</span>
          <span>New \${target.mode === 'text' ? 'Text' : 'Element'} Comment</span>
        </div>
        <div class="cir-pop-head-actions">
          <button class="cir-pop-icon-btn" id="cir-cancel-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="cir-pop-input-wrap">
        <textarea class="cir-pop-input" id="cir-new-comment-input" rows="1" placeholder="What do you want to edit?"></textarea>
        <button class="cir-voice-btn" id="cir-compose-voice" type="button" title="Dictate comment with voice">🎙️</button>
      </div>
      <div class="cir-pop-footer">
        <label class="cir-send-toggle">
          <input type="checkbox" id="cir-send-now" \${sendToCodexImmediately ? 'checked' : ''} />
          <span>Send to Codex</span>
        </label>
        <div class="cir-pop-actions">
          <button class="cir-pop-btn-ghost" id="cir-cancel-btn-2" type="button">Cancel</button>
          <button class="cir-pop-btn-primary" id="cir-save-btn" type="button">Comment</button>
        </div>
      </div>
    \`;

    const textarea = popover.querySelector('#cir-new-comment-input');
    const voiceBtn = popover.querySelector('#cir-compose-voice');
    const sendNowCb = popover.querySelector('#cir-send-now');
    const cancelBtn = popover.querySelector('#cir-cancel-btn');
    const cancelBtn2 = popover.querySelector('#cir-cancel-btn-2');
    const saveBtn = popover.querySelector('#cir-save-btn');

    attachVoiceDictation(voiceBtn, textarea);
    textarea.addEventListener('input', () => autoResizeInput(textarea));
    sendNowCb.addEventListener('change', () => {
      sendToCodexImmediately = sendNowCb.checked;
    });

    setTimeout(() => textarea && textarea.focus(), 20);

    const submitNew = async () => {
      const text = textarea.value.trim();
      if (!text) return;
      stopVoiceDictation();
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      const shouldSendNow = sendNowCb.checked;
      sendToCodexImmediately = shouldSendNow;

      const created = await apiCall('POST', '/comments', {
        file: FILE_PATH,
        target: {
          mode: target.mode,
          selector: target.selector,
          tagName: target.tagName,
          selectedText: target.selectedText,
          prefixText: target.prefixText,
          suffixText: target.suffixText,
          htmlSnippet: target.htmlSnippet,
          offsetXRatio: target.offsetXRatio,
          offsetYRatio: target.offsetYRatio
        },
        text
      });

      window.getSelection()?.removeAllRanges();
      pendingTarget = null;
      if (created && created.thread) {
        activeThreadId = created.thread.id;
        popoverMode = 'thread';
      } else {
        closePopover();
      }

      await fetchState();
      if (shouldSendNow) {
        await submitReviewToCodex();
      } else {
        showToast('💬 Inline comment saved');
      }
    };

    cancelBtn.addEventListener('click', closePopover);
    cancelBtn2.addEventListener('click', closePopover);
    saveBtn.addEventListener('click', submitNew);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitNew();
      } else if (e.key === 'Escape') {
        closePopover();
      }
    });
  }

  function openThreadPopover(threadId, preserveDraft = false) {
    const thread = state.threads.find(t => t.id === threadId);
    if (!thread) {
      closePopover();
      return;
    }

    let prevDraft = '';
    let wasFocused = false;
    if (preserveDraft && popoverMode === 'thread') {
      const oldInput = popover.querySelector('#cir-pop-reply-input');
      if (oldInput) {
        prevDraft = oldInput.value;
        wasFocused = shadow.activeElement === oldInput;
      }
    } else {
      stopVoiceDictation();
    }

    popoverMode = 'thread';
    activeThreadId = threadId;

    const coords = getThreadAnchorCoords(threadId);
    positionPopoverAt(coords.x, coords.y);

    const quoteLabel = thread.target.selectedText
      ? escapeHtml(thread.target.selectedText.slice(0, 120))
      : escapeHtml(thread.target.selector);

    const messagesHtml = thread.messages.map((m, idx) => {
      const isCodex = m.author === 'codex';
      const avatarText = isCodex ? '✴' : 'You';
      const authorLabel = isCodex ? 'Codex · via You' : 'You';
      const timeStr = formatRelativeTime(m.createdAt);
      const topActions = idx === 0
        ? \`<div class="cir-pop-head-actions">
            <button class="cir-pop-icon-btn \${thread.status === 'resolved' ? 'resolved' : ''}" id="cir-pop-resolve" title="\${thread.status === 'resolved' ? 'Reopen thread' : 'Resolve thread'}">✓</button>
            <button class="cir-pop-icon-btn" id="cir-pop-delete" title="Delete thread">🗑</button>
            <button class="cir-pop-icon-btn" id="cir-pop-close" title="Close">✕</button>
          </div>\`
        : '';

      return \`
        <div class="cir-pop-msg">
          <div class="cir-pop-msg-head">
            <div class="cir-pop-author-wrap">
              <span class="cir-pop-avatar \${isCodex ? 'codex' : 'user'}">\${avatarText}</span>
              <span>\${authorLabel}</span>
              <span class="cir-pop-time">\${timeStr}</span>
            </div>
            \${topActions}
          </div>
          <div class="cir-pop-msg-body">\${escapeHtml(m.text)}</div>
        </div>
      \`;
    }).join('');

    const workingHtml = (codexRun && thread.status === 'open')
      ? \`<div class="cir-pop-working"><span class="cir-dot waiting" style="background:#818cf8;"></span><span>Codex is working on this...</span></div>\`
      : '';

    popover.innerHTML = \`
      <div class="cir-pop-quote" title="\${quoteLabel}">\${quoteLabel}</div>
      \${messagesHtml}
      \${workingHtml}
      <div class="cir-pop-input-wrap">
        <textarea class="cir-pop-input" id="cir-pop-reply-input" rows="1" placeholder="What do you want to edit?"></textarea>
        <button class="cir-voice-btn" id="cir-pop-voice" type="button" title="Dictate reply with voice">🎙️</button>
      </div>
      <div class="cir-pop-footer">
        <label class="cir-send-toggle">
          <input type="checkbox" id="cir-pop-send-now" \${sendToCodexImmediately ? 'checked' : ''} />
          <span>Send to Codex</span>
        </label>
        <div class="cir-pop-actions">
          <button class="cir-pop-btn-primary" id="cir-pop-reply-btn" type="button">Reply</button>
        </div>
      </div>
    \`;

    const replyInput = popover.querySelector('#cir-pop-reply-input');
    const voiceBtn = popover.querySelector('#cir-pop-voice');
    const sendNowCb = popover.querySelector('#cir-pop-send-now');
    const replyBtn = popover.querySelector('#cir-pop-reply-btn');
    const resolveBtn = popover.querySelector('#cir-pop-resolve');
    const deleteBtn = popover.querySelector('#cir-pop-delete');
    const closeBtn = popover.querySelector('#cir-pop-close');

    if (prevDraft) {
      replyInput.value = prevDraft;
      autoResizeInput(replyInput);
    }
    if (wasFocused) {
      replyInput.focus();
    }

    attachVoiceDictation(voiceBtn, replyInput);
    replyInput.addEventListener('input', () => autoResizeInput(replyInput));
    sendNowCb.addEventListener('change', () => {
      sendToCodexImmediately = sendNowCb.checked;
    });

    const submitReply = async () => {
      const text = replyInput.value.trim();
      if (!text) return;
      stopVoiceDictation();
      replyBtn.disabled = true;
      replyBtn.textContent = 'Sending...';
      const shouldSendNow = sendNowCb.checked;
      sendToCodexImmediately = shouldSendNow;

      await apiCall('POST', '/reply', {
        file: FILE_PATH,
        commentId: threadId,
        text,
        author: 'user',
        status: 'open'
      });
      replyInput.value = '';
      await fetchState();
      if (shouldSendNow) {
        await submitReviewToCodex();
      } else {
        showToast('Reply added');
      }
    };

    replyBtn.addEventListener('click', submitReply);
    replyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitReply();
      } else if (e.key === 'Escape') {
        closePopover();
      }
    });

    if (resolveBtn) {
      resolveBtn.addEventListener('click', async () => {
        const nextStatus = thread.status === 'resolved' ? 'open' : 'resolved';
        await apiCall('POST', '/status', { file: FILE_PATH, commentId: threadId, status: nextStatus });
        await fetchState();
      });
    }
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        await apiCall('POST', '/delete', { file: FILE_PATH, commentId: threadId });
        if (activeThreadId === threadId) activeThreadId = null;
        closePopover();
        await fetchState();
        showToast('Comment deleted');
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', closePopover);
    }
  }

  document.addEventListener('click', (e) => {
    if (pickMode || e.altKey) return;
    if (popoverMode !== 'thread') return;
    const el = e.target;
    if (el && el.closest && (el.closest('#codex-inline-review-root') || el.closest('.cir-text-highlight'))) {
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    closePopover();
  });

  // --- Select & Scroll to Thread ---
  function selectThread(threadId, scrollToElement = true, openPopup = true) {
    activeThreadId = threadId;
    renderUI();
    const anchorEl = threadAnchorMap.get(threadId);
    if (scrollToElement && anchorEl) {
      anchorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      anchorEl.classList.add('cir-element-pulse');
      setTimeout(() => anchorEl.classList.remove('cir-element-pulse'), 1600);
    }
    if (openPopup) {
      openThreadPopover(threadId);
    }
  }

  function getEffectiveSandboxView() {
    if (sandboxInfo && typeof sandboxInfo === 'object') {
      const effectiveMode = sandboxInfo.effectiveMode || sandboxMode;
      const fallbackLabel = sandboxInfo.controlSource === 'connected-session'
        ? 'Session Sandbox'
        : sandboxInfo.controlSource === 'externally-sandboxed'
          ? 'Host Sandboxed'
          : sandboxInfo.controlSource === 'policy-restricted'
            ? 'Policy Sandboxed'
            : effectiveMode === 'full-access'
              ? 'Full Access'
              : 'Sandboxed';
      return {
        canToggle: Boolean(sandboxInfo.canToggle),
        controlSource: sandboxInfo.controlSource || 'background-codex',
        effectiveMode,
        label: sandboxInfo.label || fallbackLabel,
        reason: sandboxInfo.reason || '',
        hint: sandboxInfo.hint || '',
        restartCommand: sandboxInfo.restartCommand || ''
      };
    }
    if (waitingAgentsCount > 0) {
      return {
        canToggle: false,
        controlSource: 'connected-session',
        effectiveMode: 'session-controlled',
        label: 'Session Sandbox',
        reason: 'Controlled by your connected Codex session. Submissions go directly to the listening Codex CLI/Desktop session and run under its own sandbox permissions.',
        hint: 'To allow network or access outside the workspace, change permissions in your Codex session (e.g., Full Access in Codex Desktop or --sandbox danger-full-access in Codex CLI).',
        restartCommand: ''
      };
    }
    const isFull = sandboxMode === 'full-access';
    return {
      canToggle: true,
      controlSource: 'background-codex',
      effectiveMode: sandboxMode,
      label: isFull ? 'Full Access' : 'Sandboxed',
      reason: isFull
        ? 'Standalone background Codex runs with Full Access (--dangerously-bypass-approvals-and-sandbox). Click to switch to Sandboxed.'
        : 'Standalone background Codex runs in workspace-write sandbox (no network). Click to switch to Full Access.',
      hint: '',
      restartCommand: ''
    };
  }

  function closeSandboxPopover() {
    sandboxPopoverOpen = false;
    sandboxPopover.style.display = 'none';
  }

  function renderSandboxPopover() {
    const view = getEffectiveSandboxView();
    if (!sandboxPopoverOpen || view.canToggle) {
      sandboxPopover.style.display = 'none';
      return;
    }
    const statusIcon = view.controlSource === 'connected-session' ? '🔗' : '🔒';
    const badgeText = view.controlSource === 'connected-session'
      ? 'Session-managed'
      : view.controlSource === 'externally-sandboxed'
        ? 'Host-locked'
        : 'Policy-locked';
    const hintHtml = view.hint
      ? \`<p class="cir-sandbox-pop-hint">\${escapeHtml(view.hint)}</p>\`
      : '';
    const cmdHtml = view.restartCommand
      ? \`<div class="cir-sandbox-cmd-wrap">
          <code class="cir-sandbox-cmd">\${escapeHtml(view.restartCommand)}</code>
          <button class="cir-pop-btn-primary" id="cir-sandbox-copy-cmd" type="button">📋 Copy restart command</button>
        </div>\`
      : '';

    sandboxPopover.innerHTML = \`
      <div class="cir-sandbox-pop-head">
        <div class="cir-sandbox-pop-title">
          <span>\${statusIcon} \${escapeHtml(view.label)}</span>
          <span class="cir-sandbox-badge">\${badgeText}</span>
        </div>
        <button class="cir-pop-icon-btn" id="cir-sandbox-pop-close" type="button" title="Close">✕</button>
      </div>
      <p class="cir-sandbox-pop-body">\${escapeHtml(view.reason)}</p>
      \${hintHtml}
      \${cmdHtml}
    \`;

    sandboxPopover.style.display = 'block';
    const sandboxBtn = dock.querySelector('#cir-dock-sandbox');
    const btnRect = sandboxBtn ? sandboxBtn.getBoundingClientRect() : dock.getBoundingClientRect();
    const popRect = sandboxPopover.getBoundingClientRect();
    const popW = popRect.width || 340;
    const popH = popRect.height || 180;
    const left = Math.min(window.innerWidth - popW - 16, Math.max(16, btnRect.left));
    const top = Math.max(16, btnRect.top - popH - 12);
    sandboxPopover.style.left = left + 'px';
    sandboxPopover.style.top = top + 'px';

    const closeBtn = sandboxPopover.querySelector('#cir-sandbox-pop-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSandboxPopover();
      });
    }
    const copyCmdBtn = sandboxPopover.querySelector('#cir-sandbox-copy-cmd');
    if (copyCmdBtn && view.restartCommand) {
      copyCmdBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(view.restartCommand);
          showToast('📋 Copied restart command to clipboard!');
        } catch {
          showToast('⚠️ Could not copy command to clipboard');
        }
      });
    }
  }

  document.addEventListener('click', (e) => {
    if (!sandboxPopoverOpen) return;
    const el = e.target;
    if (el && el.closest && el.closest('#codex-inline-review-root')) return;
    closeSandboxPopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sandboxPopoverOpen) {
      closeSandboxPopover();
    }
  });

  // --- Render Dock & Sidebar ---
  function renderDock() {
    const openCount = state.threads.filter(t => t.status === 'open').length;
    dock.classList.toggle('sidebar-open', sidebarOpen);

    const agentIndicator = codexRun
      ? \`<div class="cir-agent-status" title="Codex is actively processing your inline comments"><span class="cir-dot waiting" style="background:#818cf8; box-shadow:0 0 8px #818cf8;"></span>🤖 Codex working...</div>\`
      : waitingAgentsCount > 0
        ? \`<div class="cir-agent-status" title="Codex is actively waiting for your submission"><span class="cir-dot waiting"></span>Codex listening</div>\`
        : \`<div class="cir-agent-status" title="Clicking Submit will automatically invoke Codex on your comments"><span class="cir-dot"></span>Ready</div>\`;

    const view = getEffectiveSandboxView();
    let sandboxClass = '';
    let sandboxIcon = '🔒';
    let sandboxAriaDisabled = '';

    if (view.controlSource === 'connected-session') {
      sandboxClass = 'sandbox-locked';
      sandboxIcon = '🔗';
      sandboxAriaDisabled = 'aria-disabled="true"';
    } else if (view.controlSource === 'externally-sandboxed' || view.controlSource === 'policy-restricted') {
      sandboxClass = 'sandbox-locked';
      sandboxIcon = '🔒';
      sandboxAriaDisabled = 'aria-disabled="true"';
    } else if (view.effectiveMode === 'full-access') {
      sandboxClass = 'sandbox-full';
      sandboxIcon = '🔓';
    }

    dock.innerHTML = \`
      \${agentIndicator}
      <button class="cir-dock-btn \${sandboxClass}" id="cir-dock-sandbox" data-sandbox-control="\${escapeHtml(view.controlSource)}" \${sandboxAriaDisabled} title="\${escapeHtml(view.reason)}">
        \${sandboxIcon} \${escapeHtml(view.label)}
      </button>
      <button class="cir-dock-btn \${pickMode ? 'active' : ''}" id="cir-dock-pick" title="Click any element on the page to pin a comment (or hold Option/Alt + Click)">
        🎯 \${pickMode ? 'Picking Element...' : 'Pick Element'}
      </button>
      <button class="cir-dock-btn" id="cir-dock-sidebar">
        💬 Threads <span class="cir-badge">\${openCount}</span>
      </button>
      <button class="cir-dock-btn cir-dock-submit" id="cir-dock-submit" \${codexRun ? 'disabled' : ''} title="Send all open comments to Codex">
        \${codexRun ? '⏳ Codex Responding...' : '🚀 Submit to Codex'}
      </button>
    \`;

    dock.querySelector('#cir-dock-sandbox').addEventListener('click', toggleSandboxMode);
    dock.querySelector('#cir-dock-pick').addEventListener('click', () => setPickMode(!pickMode));
    dock.querySelector('#cir-dock-sidebar').addEventListener('click', () => {
      sidebarOpen = !sidebarOpen;
      renderUI();
    });
    dock.querySelector('#cir-dock-submit').addEventListener('click', submitReviewToCodex);

    if (sandboxPopoverOpen) {
      if (view.canToggle) {
        closeSandboxPopover();
      } else {
        renderSandboxPopover();
      }
    }
  }

  function renderSidebar() {
    sidebar.classList.toggle('closed', !sidebarOpen);
    const openCount = state.threads.filter(t => t.status === 'open').length;
    const resolvedCount = state.threads.filter(t => t.status === 'resolved').length;
    const totalCount = state.threads.length;

    const visibleThreads = state.threads.filter(t => {
      if (filterMode === 'open') return t.status !== 'resolved';
      if (filterMode === 'resolved') return t.status === 'resolved';
      return true;
    });

    const threadsHtml = visibleThreads.length === 0
      ? \`<div class="cir-empty">
          <div style="font-size: 24px; margin-bottom: 8px;">✨</div>
          <strong>No \${filterMode === 'all' ? '' : filterMode + ' '}inline comments yet</strong><br/>
          Highlight any text on the page or click <b>🎯 Pick Element</b> to drop inline comments for Codex.
        </div>\`
      : visibleThreads.map(t => {
          const isSelected = activeThreadId === t.id;
          const targetSummary = t.target.selectedText
            ? '"' + escapeHtml(t.target.selectedText) + '"'
            : escapeHtml(t.target.selector);

          const msgs = t.messages.map(m =>
            \`<div class="cir-msg \${m.author}"><span class="cir-msg-author">\${m.author === 'codex' ? 'Codex:' : 'You:'}</span> <span class="cir-msg-text">\${escapeHtml(m.text)}</span></div>\`
          ).join('');

          const expandedControls = isSelected ? \`
            <div class="cir-thread-reply-box" onclick="event.stopPropagation()">
              <textarea class="cir-textarea" id="cir-reply-\${t.id}" placeholder="Reply to thread..." style="min-height: 46px; font-size: 12px;"></textarea>
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; gap:4px;">
                  <button class="cir-btn cir-btn-ghost cir-btn-sm" data-action="toggle-resolve" data-id="\${t.id}">
                    \${t.status === 'resolved' ? '↩ Reopen' : '✓ Resolve'}
                  </button>
                  <button class="cir-btn cir-btn-ghost cir-btn-sm" data-action="delete" data-id="\${t.id}" style="color:#ef4444;">
                    Delete
                  </button>
                </div>
                <button class="cir-btn cir-btn-primary cir-btn-sm" data-action="reply" data-id="\${t.id}">Reply</button>
              </div>
            </div>
          \` : '';

          return \`
            <div class="cir-thread-card \${isSelected ? 'active' : ''}" data-card-id="\${t.id}">
              <div class="cir-thread-top">
                <span class="cir-thread-num">
                  <span style="color:#4f46e5;">#\${t.number}</span>
                  <span style="font-size:10.5px; color:#71717a; font-weight:500;">&lt;\${escapeHtml(t.target.tagName)}&gt;</span>
                </span>
                <span class="cir-thread-target-preview" title="\${targetSummary}">\${targetSummary}</span>
                <span class="cir-status-pill \${t.status}">\${t.status}</span>
              </div>
              \${msgs}
              \${expandedControls}
            </div>
          \`;
        }).join('');

    sidebar.innerHTML = \`
      <div class="cir-sidebar-header">
        <div class="cir-sidebar-title">
          <span>💬 Codex Review</span>
        </div>
        <button class="cir-btn cir-btn-ghost cir-btn-sm" id="cir-close-sidebar">✕</button>
      </div>
      <div class="cir-filter-bar">
        <button class="cir-filter-tab \${filterMode === 'all' ? 'active' : ''}" data-filter="all">All (\${totalCount})</button>
        <button class="cir-filter-tab \${filterMode === 'open' ? 'active' : ''}" data-filter="open">Active (\${openCount})</button>
        <button class="cir-filter-tab \${filterMode === 'resolved' ? 'active' : ''}" data-filter="resolved">Resolved (\${resolvedCount})</button>
      </div>
      <div class="cir-threads-list">
        \${threadsHtml}
      </div>
      <div class="cir-sidebar-footer">
        <button class="cir-btn cir-btn-primary" id="cir-sidebar-submit" \${codexRun ? 'disabled' : ''} style="flex:1; justify-content:center; padding:7px 10px;">
          \${codexRun ? '🤖 Answering...' : \`🚀 Submit to Codex (\${openCount})\`}
        </button>
        <button class="cir-btn cir-btn-ghost" id="cir-sidebar-copy" title="Copy Markdown prompt to clipboard (for manual paste into chat)" style="padding:7px 9px; border:1px solid #e4e4e7;">
          📋
        </button>
      </div>
    \`;

    sidebar.querySelector('#cir-close-sidebar').addEventListener('click', () => {
      sidebarOpen = false;
      renderUI();
    });

    sidebar.querySelectorAll('.cir-filter-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        filterMode = btn.dataset.filter;
        renderUI();
      });
    });

    sidebar.querySelectorAll('.cir-thread-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.cardId;
        selectThread(id, true);
      });
    });

    sidebar.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'reply') {
          const input = sidebar.querySelector('#cir-reply-' + id);
          const text = input ? input.value.trim() : '';
          if (!text) return;
          await apiCall('POST', '/reply', { file: FILE_PATH, commentId: id, text, author: 'user' });
          await fetchState();
          showToast('Reply added');
        } else if (action === 'toggle-resolve') {
          const thread = state.threads.find(t => t.id === id);
          const nextStatus = thread && thread.status === 'resolved' ? 'open' : 'resolved';
          await apiCall('POST', '/status', { file: FILE_PATH, commentId: id, status: nextStatus });
          await fetchState();
        } else if (action === 'delete') {
          await apiCall('POST', '/delete', { file: FILE_PATH, commentId: id });
          if (activeThreadId === id) {
            activeThreadId = null;
            closePopover();
          }
          await fetchState();
          showToast('Comment deleted');
        }
      });
    });

    sidebar.querySelector('#cir-sidebar-submit').addEventListener('click', submitReviewToCodex);
    sidebar.querySelector('#cir-sidebar-copy').addEventListener('click', copyPromptForCodex);
  }

  async function toggleSandboxMode() {
    const view = getEffectiveSandboxView();
    if (!view.canToggle) {
      sandboxPopoverOpen = !sandboxPopoverOpen;
      renderSandboxPopover();
      return;
    }
    closeSandboxPopover();
    const nextMode = sandboxMode === 'full-access' ? 'workspace-write' : 'full-access';
    const res = await apiCall('POST', '/sandbox', { file: FILE_PATH, sandboxMode: nextMode });
    if (res && res.sandbox) {
      sandboxInfo = res.sandbox;
    }
    if (res && res.applied === false) {
      renderDock();
      sandboxPopoverOpen = true;
      renderSandboxPopover();
      showToast('ℹ️ ' + (res.error || view.reason), 4500);
      return;
    }
    if (res && res.sandboxMode) {
      sandboxMode = res.sandboxMode;
      renderDock();
      const suffix = codexRun ? ' (applies to next submission)' : '';
      showToast(
        (sandboxMode === 'full-access'
          ? '🔓 Switched to Full Access mode'
          : '🔒 Switched to Sandboxed mode (workspace-write)') + suffix
      );
    }
  }

  async function submitReviewToCodex() {
    const view = getEffectiveSandboxView();
    const payload = view.canToggle ? { file: FILE_PATH, sandboxMode } : { file: FILE_PATH };
    const res = await apiCall('POST', '/submit', payload);
    await fetchState();
    if (res && res.notifiedWaiters > 0) {
      showToast('🚀 Submitted! Codex received your inline comments and is responding...');
    } else if (res && res.spawnedCodex) {
      showToast('🤖 Submitted! Codex is now working on your inline comments...', 5000);
    } else if (res && res.prompt) {
      try {
        await navigator.clipboard.writeText(res.prompt);
        showToast('🚀 Review saved & prompt copied! Tell Codex to address comments.');
      } catch {
        showToast('🚀 Review saved! Tell Codex to check inline comments.');
      }
    }
  }

  async function copyPromptForCodex() {
    const res = await apiCall('GET', '/prompt?file=' + encodeURIComponent(FILE_PATH));
    if (res && res.prompt) {
      await navigator.clipboard.writeText(res.prompt);
      showToast('📋 Copied inline comments prompt to clipboard!');
    }
  }

  function renderUI() {
    renderAnchorsAndPins();
    renderDock();
    renderSidebar();
    if (popoverMode === 'thread' && activeThreadId && !activeRecognition) {
      openThreadPopover(activeThreadId, true);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function apiCall(method, endpoint, body) {
    try {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(API_BASE + endpoint, opts);
      return await res.json();
    } catch (err) {
      console.error('[Codex Inline Review] API error:', err);
      return null;
    }
  }

  async function fetchState() {
    const data = await apiCall('GET', '/state?file=' + encodeURIComponent(FILE_PATH));
    if (data && data.state) {
      state = data.state;
      waitingAgentsCount = data.waitingAgentsCount || 0;
      codexRun = data.codexRun || null;
      if (data.sandboxMode) sandboxMode = data.sandboxMode;
      if (data.sandbox) sandboxInfo = data.sandbox;
      renderUI();
    }
  }

  // --- SSE Live Reload & Real-Time Updates ---
  function connectSSE() {
    const es = new EventSource(SSE_URL);
    es.addEventListener('comments-updated', async (e) => {
      const payload = JSON.parse(e.data || '{}');
      await fetchState();
      if (payload.reason === 'codex-reply') {
        showToast('🤖 Codex replied to #' + (payload.number || payload.commentId || ''));
      } else if (payload.reason === 'codex-status') {
        showToast('✓ Codex updated #' + (payload.number || payload.commentId || ''));
      }
    });
    es.addEventListener('waiters-updated', (e) => {
      const payload = JSON.parse(e.data || '{}');
      waitingAgentsCount = payload.waitingAgentsCount || 0;
      if (payload.sandbox) sandboxInfo = payload.sandbox;
      renderDock();
    });
    es.addEventListener('agent-status', async (e) => {
      const payload = JSON.parse(e.data || '{}');
      if (payload.running) {
        codexRun = payload;
        renderUI();
        showToast('🤖 ' + (payload.statusText || 'Codex is working on your comments...'), 4500);
      } else {
        codexRun = null;
        await fetchState();
        if (payload.sandboxWarning) {
          showToast('⚠️ ' + payload.sandboxWarning, 7000);
        } else if (payload.error) {
          showToast('⚠️ ' + payload.error, 5000);
        } else {
          showToast('✅ Codex finished responding to your comments!', 4000);
        }
      }
    });
    es.addEventListener('html-updated', () => {
      showToast('✨ HTML updated by Codex — reloading preview...');
      setTimeout(() => window.location.reload(), 300);
    });
  }

  fetchState();
  connectSSE();
})();
`;
}
