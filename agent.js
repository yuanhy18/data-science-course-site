const config = window.COURSE_AGENT_CONFIG || {};
const apiBaseUrl = String(config.apiBaseUrl || '').replace(/\/$/, '');
const healthPath = config.healthPath || '/health';
const chatPath = config.chatPath || '/api/chat';
const timeoutMs = Number(config.timeoutMs) || 30000;

// DeepSeek 配置
const dsConfig = config.deepseek || {};
const dsEnabled = dsConfig.enabled === true;
const dsApiKey = dsConfig.apiKey || '';
const dsBaseUrl = String(dsConfig.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
const dsModel = dsConfig.model || 'deepseek-chat';
const dsSystemPrompt = dsConfig.systemPrompt || '你是课程智能学习助手。';

const chatMessages = document.querySelector('#chat-messages');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const submitButton = document.querySelector('#chat-submit');
const resetButton = document.querySelector('#reset-chat');
const statusDot = document.querySelector('#api-status-dot');
const statusText = document.querySelector('#api-status-text');
const endpointText = document.querySelector('#endpoint-text');
const requestIdText = document.querySelector('#request-id-text');
const serverTimeText = document.querySelector('#server-time-text');
const testPromptButton = document.querySelector('#create-test-prompt');

// 对话历史（用于多轮对话）
let conversationHistory = [];

// ===== 账号登录：会话 Cookie 跨站访问 =====
// GitHub Pages 与后端不同源，所有请求需 credentials: 'include'；
// 后端 Cookie 已设置为 SameSite=None; Secure。
const LOGIN_PATH = '/api/login';
const ME_PATH = '/api/me';
const CHANGE_PASSWORD_PATH = '/api/change-password';
let isLocked = true;             // 是否处于未登录状态
let currentUser = null;          // 当前登录用户
let pendingOldPassword = '';     // 首次改密时暂存登录密码（仅内存）
let needChangePassword = false;  // 是否处于首次改密状态

function setLocked(locked) {
  isLocked = locked;
  if (locked) {
    chatInput.placeholder = '第一行输入学号，第二行输入密码';
    chatInput.rows = 2;
    submitButton.textContent = '登录';
    submitButton.title = '输入学号和密码后点击登录';
  } else {
    chatInput.placeholder = '输入你的课程问题，例如：请解释什么是标准差……';
    chatInput.rows = 3;
    submitButton.textContent = '发送';
    submitButton.title = '';
  }
  chatInput.disabled = false;
}

function setChangePasswordMode() {
  isLocked = true;
  needChangePassword = true;
  chatInput.placeholder = '首次登录需设置新密码：第一行新密码，第二行确认新密码';
  chatInput.rows = 2;
  submitButton.textContent = '保存密码';
  submitButton.title = '设置新密码后才能开始提问';
  chatInput.disabled = false;
}

function userLabel() {
  if (!currentUser) return '';
  return currentUser.name ? currentUser.name + '（' + currentUser.student_no + '）' : currentUser.student_no;
}

function splitTwoLines(raw) {
  const lines = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  return { first: lines[0] || '', second: lines[1] || '' };
}

async function login(studentNo, password) {
  try {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(getEndpoint(LOGIN_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ student_no: studentNo, password: password }),
      signal: controller.signal
    });
    window.clearTimeout(timeoutId);
    if (!resp.ok) {
      let message = '学号或密码错误';
      try {
        const data = await resp.json();
        if (data.detail) message = data.detail;
      } catch (e) {}
      return { ok: false, message: message };
    }
    const data = await resp.json();
    // 跨站场景下若浏览器拦截第三方 Cookie，登录接口会成功但会话无法保存
    const check = await fetch(getEndpoint(ME_PATH), { credentials: 'include' });
    if (!check.ok) {
      return { ok: false, message: '登录成功但浏览器未保存登录状态，请允许本站使用 Cookie 后重试。' };
    }
    currentUser = data.user || null;
    pendingOldPassword = password;
    return { ok: true, mustChange: data.must_change_password === true };
  } catch (e) {
    console.error('login failed:', e);
    return { ok: false, message: '无法连接登录服务，请稍后再试' };
  }
}

async function changePassword(newPassword) {
  try {
    const resp = await fetch(getEndpoint(CHANGE_PASSWORD_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ old_password: pendingOldPassword, new_password: newPassword })
    });
    if (!resp.ok) {
      let message = '密码修改失败';
      try {
        const data = await resp.json();
        if (data.detail) message = data.detail;
      } catch (e) {}
      return { ok: false, message: message };
    }
    const data = await resp.json();
    currentUser = data.user || currentUser;
    pendingOldPassword = '';
    return { ok: true };
  } catch (e) {
    console.error('change password failed:', e);
    return { ok: false, message: '无法连接服务器，请稍后再试' };
  }
}

async function restoreSession() {
  try {
    const resp = await fetch(getEndpoint(ME_PATH), { credentials: 'include' });
    if (!resp.ok) { setLocked(true); return; }
    const data = await resp.json();
    currentUser = data.user || null;
    if (currentUser && currentUser.must_change_password) {
      setChangePasswordMode();
      addMessage('🔑 首次登录需要修改初始密码，请按“第一行新密码、第二行确认新密码”的格式输入。', 'assistant');
      return;
    }
    setLocked(false);
    setStatus('online', '已登录 · ' + userLabel());
    addMessage('你好，' + userLabel() + '！我是财数学习助手，已接入 DeepSeek 大模型。你可以向我提问数据科学、统计分析、Python 编程等课程相关问题。', 'assistant');
  } catch (e) {
    console.error('restore session failed:', e);
    setLocked(true);
  }
}

// ===== Markdown 转 HTML 解析器 =====
function parseMarkdown(text) {
  if (!text) return '';

  // 先转义 HTML 特殊字符，防止 XSS
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 收集 LaTeX 公式，用占位符替换，避免被后续处理破坏
  const latexBlocks = [];
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, function(match, formula) {
    const id = latexBlocks.length;
    latexBlocks.push({ type: 'block', content: formula.trim() });
    return '<!--LATEX:' + id + '-->';
  });
  html = html.replace(/\\\((.+?)\\\)/g, function(match, formula) {
    const id = latexBlocks.length;
    latexBlocks.push({ type: 'inline', content: formula.trim() });
    return '<!--LATEX:' + id + '-->';
  });

  html = html.replace(/\$\$([\s\S]*?)\$\$/g, function(match, formula) {
    const id = latexBlocks.length;
    latexBlocks.push({ type: 'block', content: formula.trim() });
    return '<!--LATEX:' + id + '-->';
  });
  html = html.replace(/\$([^$\n]+?)\$/g, function(match, formula) {
    const id = latexBlocks.length;
    latexBlocks.push({ type: 'inline', content: formula.trim() });
    return '<!--LATEX:' + id + '-->';
  });
  // 收集 mermaid 图表，用占位符替换，避免被后续处理破坏
  const mermaidBlocks = [];
  html = html.replace(/```mermaid\n?([\s\S]*?)```/g, function(match, code) {
    const id = 'mermaid-' + mermaidBlocks.length;
    mermaidBlocks.push(code.trim());
    return '<!--MERMAID:' + id + '-->';
  });

  // 处理代码块（```...```）
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(match, lang, code) {
    const escapedCode = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<pre><code class="language-' + (lang || 'plaintext') + '">' + escapedCode + '</code></pre>';
  });

  // 处理行内代码（`...`）
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 处理标题（### ...）
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 处理粗体+斜体（***...***）
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');

  // 处理粗体（**...**）
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // 处理斜体（*...*），但不匹配列表项开头的 *
  html = html.replace(/(^|[^*])\*([^*\n]+?)\*($|[^*])/gm, '$1<em>$2</em>$3');

  // 处理无序列表（- 或 * 开头）
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // 处理有序列表（1. 2. 等）
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, function(match) {
    if (!match.startsWith('<ul>')) {
      return '<ol>' + match + '</ol>';
    }
    return match;
  });

  // 处理水平线（但不匹配表格分隔行）
  html = html.replace(/^---$/gm, '<hr>');

  // 处理 Markdown 表格
  html = html.replace(/((?:^\|.+\|\n?)+)/gm, function(tableBlock) {
    const rows = tableBlock.trim().split('\n');
    if (rows.length < 2) return tableBlock;
    if (!/^\|[\s\-:|]+\|$/.test(rows[1].trim())) return tableBlock;

    let tableHtml = '<div class="table-scroll"><table>';
    tableHtml += '<thead><tr>';
    const parseRow = (r) => { let s = r.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map(c => c.trim()); };
    const headers = parseRow(rows[0]);
    for (const h of headers) {
      tableHtml += '<th>' + h.trim() + '</th>';
    }
    tableHtml += '</tr></thead>';

    tableHtml += '<tbody>';
    for (let i = 2; i < rows.length; i++) {
      const cells = parseRow(rows[i]);
      if (cells.length === 0) continue;
      tableHtml += '<tr>';
      for (const c of cells) {
        tableHtml += '<td>' + c.trim() + '</td>';
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table></div>';
    return tableHtml;
  });

  // 处理段落：将连续的非空行包裹在 <p> 中
  const lines = html.split('\n');
  const result = [];
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      result.push('<p>' + paragraph.join('\n') + '</p>');
      paragraph = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^<(h[1-4]|ul|ol|li|pre|hr|blockquote|table|div|\/ul|\/ol|\/pre|!--(LATEX|MERMAID))/.test(line.trim())) {
      flushParagraph();
      result.push(line);
    } else if (line.trim() === '') {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();

  let output = result.join('\n');

  // 将 Mermaid 占位符替换为图表容器
  for (let i = 0; i < mermaidBlocks.length; i++) {
    const escapedCode = mermaidBlocks[i]
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    output = output.replace(
      '<!--MERMAID:mermaid-' + i + '-->',
      '<div class="mermaid">' + escapedCode + '</div>'
    );
  }

  // 将 LaTeX 占位符替换为 KaTeX 可渲染的容器
  for (let i = 0; i < latexBlocks.length; i++) {
    const block = latexBlocks[i];
    const escapedFormula = block.content;
    if (block.type === 'block') {
      output = output.replace(
        '<!--LATEX:' + i + '-->',
        '<div class="math-block">\\[' + escapedFormula + '\\]</div>'
      );
    } else {
      output = output.replace(
        '<!--LATEX:' + i + '-->',
        '<span class="math-inline">\\( ' + escapedFormula + ' \\)</span>'
      );
    }
  }

  return output;
}

function addMessage(text, type, meta = '', useMarkdown = false) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${type === 'user' ? 'user-message' : 'assistant-message'}`;

  const content = document.createElement('div');
  content.className = 'message-content';

  if (useMarkdown && type === 'assistant') {
    content.innerHTML = parseMarkdown(text);
  } else {
    content.textContent = text;
  }

  wrapper.appendChild(content);

  if (meta) {
    const metaLine = document.createElement('small');
    metaLine.className = 'message-meta';
    metaLine.textContent = meta;
    wrapper.appendChild(metaLine);
  }

  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrapper;
}

function setStatus(state, text) {
  statusDot.dataset.state = state;
  statusText.textContent = text;
}

function setBusy(busy) {
  submitButton.disabled = busy;
  chatInput.disabled = busy;
  if (busy) {
    submitButton.textContent = '思考中…';
  } else if (isLocked) {
    submitButton.textContent = needChangePassword ? '保存密码' : '登录';
  } else {
    submitButton.textContent = '发送';
  }
}

function resetMeta() {
  requestIdText.textContent = '尚无请求';
  serverTimeText.textContent = '尚无响应';
}

function getEndpoint(path) {
  return `${apiBaseUrl}${path}`;
}

function isLivePage() {
  return window.location.protocol === 'https:';
}

function validateConfig() {
  if (dsEnabled) {
    if (!dsApiKey || dsApiKey === 'YOUR_DEEPSEEK_API_KEY_HERE') {
      setStatus('waiting', '请先在 agent-config.js 中填入 DeepSeek API Key');
      endpointText.textContent = 'DeepSeek API';
      return false;
    }
    endpointText.textContent = `${dsModel} @ DeepSeek`;
    return true;
  }

  if (!apiBaseUrl) {
    setStatus('waiting', '等待学生配置服务器入口');
    endpointText.textContent = '尚未配置';
    return false;
  }

  if (isLivePage() && !apiBaseUrl.startsWith('https://')) {
    setStatus('error', '线上页面只能连接HTTPS接口');
    endpointText.textContent = apiBaseUrl;
    return false;
  }

  endpointText.textContent = apiBaseUrl;
  return true;
}

async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(getEndpoint(path), {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body.detail || body.message || '';
      } catch (parseErr) {
        detail = '';
      }
      const err = new Error(detail || `HTTP ${response.status}`);
      err.status = response.status;
      err.detail = detail;
      throw err;
    }

    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function checkHealth() {
  if (dsEnabled) {
    if (!dsApiKey || dsApiKey === 'YOUR_DEEPSEEK_API_KEY_HERE') {
      setStatus('waiting', '等待填入 DeepSeek API Key');
      endpointText.textContent = 'DeepSeek API';
      return;
    }
    setStatus('online', `DeepSeek · ${dsModel}`);
    endpointText.textContent = `${dsModel} @ DeepSeek`;
    return;
  }

  if (!validateConfig()) return;

  setStatus('checking', '正在检查测试服务器');
  try {
    const data = await requestJson(healthPath);
    if (data.status !== 'ok') throw new Error('Unexpected health response');
    setStatus('online', `测试服务器在线 · ${data.version || 'phase-1'}`);
  } catch (error) {
    console.error('Course agent health check failed:', error);
    setStatus('error', '测试服务器暂时不可用');
  }
}

async function callDeepSeek(messages) {
  const response = await fetch(`${dsBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${dsApiKey}`
    },
    body: JSON.stringify({
      model: dsModel,
      messages: messages,
      temperature: 0.7,
      max_tokens: 2000
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`DeepSeek API 返回错误 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return data;
}

async function answerQuestion(question) {
  // ===== 登录强制闸门 =====
  // 未登录或未完成首次改密时一律拦截，不发起任何模型请求。
  if (isLocked || needChangePassword) {
    addMessage(needChangePassword
      ? '🔑 请先按提示设置新密码。'
      : '🔒 请先按“第一行学号、第二行密码”的格式登录后再提问。', 'assistant');
    return;
  }

  addMessage(question, 'user');
  const waitingMessage = addMessage('正在思考……', 'assistant');

  if (!validateConfig()) {
    waitingMessage.querySelector('.message-content').textContent =
      'DeepSeek API Key 尚未配置。请在 agent-config.js 中将 YOUR_DEEPSEEK_API_KEY_HERE 替换为您的真实 API Key。';
    return;
  }

  setBusy(true);

  if (dsEnabled) {
    try {
      const messages = [
        { role: 'system', content: dsSystemPrompt }
      ];

      const recentHistory = conversationHistory.slice(-20);
      for (const item of recentHistory) {
        messages.push({ role: item.role, content: item.content });
      }

      messages.push({ role: 'user', content: question });

      const data = await callDeepSeek(messages);

      const reply = data.choices?.[0]?.message?.content || 'DeepSeek 未返回有效回复。';
      const usage = data.usage || {};
      const requestId = data.id || '未返回';

      // 使用 Markdown 渲染
      waitingMessage.querySelector('.message-content').innerHTML = parseMarkdown(reply);

      // 渲染 Mermaid 图表
      try {
        await mermaid.run({ querySelector: '.mermaid' });
      } catch (e) {
        console.warn('Mermaid 渲染失败:', e.message);
      }

      // 渲染 KaTeX 数学公式
      try {
        renderMathInElement(waitingMessage.querySelector('.message-content'), {
          delimiters: [
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false,
          strict: false
        });
      } catch (e) {
        console.warn('KaTeX 渲染失败:', e.message);
      }

      const meta = document.createElement('small');
      meta.className = 'message-meta';
      meta.textContent = `模型：${dsModel} · tokens：${usage.total_tokens || '?'} · ID：${requestId}`;
      waitingMessage.appendChild(meta);

      conversationHistory.push({ role: 'user', content: question });
      conversationHistory.push({ role: 'assistant', content: reply });

      requestIdText.textContent = requestId;
      serverTimeText.textContent = new Date().toLocaleString('zh-CN');
      setStatus('online', `DeepSeek · ${dsModel}`);
    } catch (error) {
      console.error('DeepSeek API request failed:', error);
      waitingMessage.querySelector('.message-content').textContent =
        `DeepSeek 请求失败：${error.message}。请检查 API Key 是否正确、网络是否通畅。`;
      setStatus('error', error.name === 'TimeoutError' ? '请求超时' : 'API 调用失败');
    } finally {
      setBusy(false);
      chatInput.focus();
    }
  } else {
    try {
      const data = await requestJson(chatPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: question })
      });

      const answerContent = waitingMessage.querySelector('.message-content');
      answerContent.innerHTML = parseMarkdown(data.answer || '服务器已响应，但没有返回answer字段。');
      const mathDelimBS = String.fromCharCode(92);
      if (typeof renderMathInElement === 'function') {
        renderMathInElement(answerContent, {
          delimiters: [
            { left: mathDelimBS + '[', right: mathDelimBS + ']', display: true },
            { left: mathDelimBS + '(', right: mathDelimBS + ')', display: false }
          ],
          throwOnError: false,
          strict: false
        });
      }
      try { await mermaid.run({ querySelector: '.mermaid' }); } catch (e) { console.warn('Mermaid 渲染失败:', e.message); }
      const meta = document.createElement('small');
      meta.className = 'message-meta';
      meta.textContent = `联调编号：${data.request_id || '未返回'} · 模式：${data.mode || 'fixed'}`;
      waitingMessage.appendChild(meta);
      requestIdText.textContent = data.request_id || '未返回';
      serverTimeText.textContent = data.server_time || '未返回';
      setStatus('online', '最近一次文本联调成功');
    } catch (error) {
      console.error('Course agent API request failed:', error);
      if (error && error.status === 401) {
        setLocked(true);
        currentUser = null;
        setStatus('waiting', '登录已失效，请重新登录');
        waitingMessage.querySelector('.message-content').textContent =
          '登录已失效，请按“第一行学号、第二行密码”的格式重新登录。';
      } else if (error && error.status === 403 && error.detail === 'PASSWORD_CHANGE_REQUIRED') {
        setChangePasswordMode();
        setStatus('waiting', '首次登录需修改密码');
        waitingMessage.querySelector('.message-content').textContent =
          '首次登录需要修改初始密码，请按“第一行新密码、第二行确认新密码”的格式输入。';
      } else {
        waitingMessage.querySelector('.message-content').textContent =
          (error && error.detail) ? error.detail : '测试服务器没有正常响应。课程主页仍可使用，请学生检查API网关、服务器进程和浏览器控制台。';
        setStatus('error', (error && error.status === 429) ? '今日次数已用完' : (error.name === 'AbortError' ? '请求超时' : '文本联调失败'));
      }
    } finally {
      setBusy(false);
      chatInput.focus();
    }
  }
}

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const raw = chatInput.value.trim();
  if (!raw) return;

  // 首次登录：第一行新密码、第二行确认新密码
  if (needChangePassword) {
    const lines = splitTwoLines(raw);
    if (!lines.first || !lines.second) {
      addMessage('请按“第一行新密码、第二行确认新密码”的格式输入。', 'assistant');
      return;
    }
    if (lines.first !== lines.second) {
      addMessage('两次输入的新密码不一致，请重新输入。', 'assistant');
      return;
    }
    const result = await changePassword(lines.first);
    chatInput.value = '';
    if (!result.ok) {
      setStatus('error', '密码修改失败');
      addMessage('❌ ' + result.message, 'assistant');
      return;
    }
    needChangePassword = false;
    setLocked(false);
    setStatus('online', '已登录 · ' + userLabel());
    addMessage('✅ 密码已更新，现在可以开始提问了！', 'assistant');
    return;
  }

  // 未登录：第一行学号、第二行密码
  if (isLocked) {
    const lines = splitTwoLines(raw);
    if (!lines.first || !lines.second) {
      addMessage('请输入两行内容：第一行学号，第二行密码。', 'assistant');
      return;
    }
    setStatus('waiting', '正在登录……');
    const result = await login(lines.first, lines.second);
    chatInput.value = '';
    if (!result.ok) {
      setStatus('error', '登录失败');
      addMessage('❌ ' + result.message, 'assistant');
      return;
    }
    if (result.mustChange) {
      setChangePasswordMode();
      setStatus('waiting', '首次登录需修改密码');
      addMessage('🔑 登录成功。首次登录需要修改初始密码，请按“第一行新密码、第二行确认新密码”的格式输入。', 'assistant');
      return;
    }
    setLocked(false);
    setStatus('online', '已登录 · ' + userLabel());
    addMessage('✅ 登录成功，' + userLabel() + '。现在可以开始提问了！', 'assistant');
    return;
  }

  // 已登录：正常发送聊天消息
  answerQuestion(raw);
  chatInput.value = '';
});

resetButton.addEventListener('click', () => {
  chatMessages.innerHTML = '';
  conversationHistory = [];
  if (needChangePassword) {
    addMessage('🔑 请先设置新密码后再开始对话。', 'assistant');
  } else if (isLocked) {
    addMessage('🔒 请按“第一行学号、第二行密码”的格式登录后开始对话。', 'assistant');
  } else {
    addMessage(
      '你好！我是财数学习助手，已接入 DeepSeek 大模型。你可以向我提问数据科学、统计分析、Python 编程等课程相关问题。',
      'assistant'
    );
  }
  resetMeta();
});

testPromptButton.addEventListener('click', () => {
  const prompts = [
    '请解释什么是标准差，并举例说明它在数据分析中的作用。',
    'Python 中 Pandas 和 NumPy 的主要区别是什么？',
    '什么是线性回归？请用通俗的语言解释。',
    '数据清洗通常包含哪些步骤？'
  ];
  const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];
  chatInput.value = randomPrompt;
  chatInput.focus();
});

// 初始化：先显示登录状态，再检测服务并恢复已有会话
setLocked(true);
checkHealth();
restoreSession();
