const $ = selector => document.querySelector(selector);
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const knownStatuses = new Set(['idle', 'queued', 'running', ...terminalStatuses]);

let selected = null;
let currentUser = null;
let openAiConfigured = null;
let repositories = null;
let toastTimer = null;
const activeSources = new Map();

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) throw new ApiError('The server returned an invalid response', response.status);
    }
  }

  if (!response.ok) throw new ApiError(body?.error || 'Request failed', response.status);
  return body;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character]);
}

function markdown(value) {
  const inline = line => escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const lines = String(value ?? '').replace(/\r/g, '').split('\n');
  let html = '';
  let paragraph = [];
  let list = null;
  let code = [];
  let fenced = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html += `<p>${paragraph.map(inline).join('<br>')}</p>`;
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html += `<${list.type}>${list.items.map(item => `<li>${inline(item)}</li>`).join('')}</${list.type}>`;
    list = null;
  };
  const flushCode = () => {
    if (!code.length) return;
    html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
    code = [];
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (fenced) {
        flushCode();
        fenced = false;
      } else {
        flushParagraph();
        flushList();
        fenced = true;
      }
      continue;
    }
    if (fenced) {
      code.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const item = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      html += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
    } else if (item) {
      flushParagraph();
      const type = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (list?.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(item[2]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      paragraph.push(line);
    }
  }

  if (fenced) flushCode();
  flushParagraph();
  flushList();
  return html;
}

function showToast(message, tone = 'default') {
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast ${tone}`;
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

function setFormError(element, message = '') {
  element.textContent = message;
  element.classList.toggle('hidden', !message);
}

function setFormBusy(form, busy, busyLabel) {
  const button = form.querySelector('button[type="submit"]');
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = busy;
  for (const field of form.querySelectorAll('input, select')) field.disabled = busy;
}

function statusClass(status) {
  return knownStatuses.has(status) ? status : 'idle';
}

function statusLabel(status) {
  return String(status || 'idle').replace(/^./, character => character.toUpperCase());
}

function relative(date) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function statusHtml(status, prUrl) {
  const pullRequest = prUrl
    ? `<a class="pr-action" href="${escapeHtml(prUrl)}" target="_blank" rel="noopener">View pull request <b aria-hidden="true">↗</b></a>`
    : '';
  return `${pullRequest}<span class="badge ${statusClass(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function closeSources() {
  for (const source of activeSources.values()) source.close();
  activeSources.clear();
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  $('#sidebarToggle').setAttribute('aria-expanded', 'false');
  $('#sidebarToggle').setAttribute('aria-label', 'Open navigation');
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
  $('#sidebarToggle').setAttribute('aria-expanded', 'true');
  $('#sidebarToggle').setAttribute('aria-label', 'Close navigation');
}

function markActiveSession() {
  for (const link of document.querySelectorAll('.session')) {
    link.classList.toggle('active', link.dataset.sessionId === selected);
  }
}

async function loadSessions() {
  const items = await api('/api/sessions');
  $('#sessions').innerHTML = items.length
    ? items.map(item => `
      <a class="session" data-session-id="${escapeHtml(item.id)}" href="#${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.title)}</strong>
        <span><i class="dot ${statusClass(item.status)}" aria-hidden="true"></i>${escapeHtml(statusLabel(item.status))} · ${relative(item.updatedAt)}</span>
      </a>
    `).join('')
    : '<div class="muted empty-list">No chats yet.<br>Start with a repository.</div>';
  markActiveSession();
  return items;
}

function eventHtml(event) {
  return `
    <div class="step" data-event-id="${escapeHtml(event.id)}">
      <strong>${escapeHtml(event.title)}</strong>
      ${event.detail ? `<div class="step-detail markdown">${markdown(event.detail)}</div>` : ''}
    </div>
  `;
}

function runActionsHtml(run, artifacts) {
  const downloads = artifacts.map(artifact => `
    <a class="artifact" href="/api/runs/${escapeHtml(run.id)}/artifacts/${escapeHtml(artifact.id)}">↓ ${escapeHtml(artifact.name)}</a>
  `).join('');
  const pullRequest = run.prUrl
    ? `<a class="pr-action run-pr" href="${escapeHtml(run.prUrl)}" target="_blank" rel="noopener">View pull request <b aria-hidden="true">↗</b></a>`
    : '';
  const cancel = ['queued', 'running'].includes(run.status)
    ? `<button class="cancel-run" type="button" data-run-id="${escapeHtml(run.id)}">Cancel run</button>`
    : '';
  return `<div class="run-actions">${downloads}${pullRequest}${cancel}</div>`;
}

function buildRunCard(data) {
  const { run, events, artifacts } = data;
  const message = run.error || run.summary || (run.status === 'queued' ? 'Waiting for a cloud worker…' : 'Working through the task…');
  const block = document.createElement('article');
  block.className = 'run';
  block.id = `run-${run.id}`;
  block.innerHTML = `
    <div class="prompt-card markdown">${markdown(run.prompt)}</div>
    <div class="run-head">
      <div class="agent-icon" aria-hidden="true">R</div>
      <div class="run-body">
        <h3>Relay <span class="badge ${statusClass(run.status)}">${escapeHtml(statusLabel(run.status))}</span></h3>
        <div class="summary markdown ${run.error ? 'error' : ''}">${markdown(message)}</div>
        ${runActionsHtml(run, artifacts)}
        <span class="stream-state" aria-live="polite"></span>
      </div>
    </div>
    <details class="run-steps">
      <summary>Activity <span>${events.length}</span></summary>
      <div class="steps">${events.map(eventHtml).join('')}</div>
    </details>
  `;
  return block;
}

function shouldFollowTimeline() {
  const timeline = $('#timeline');
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 180;
}

function scrollToBottom(force = false) {
  const timeline = $('#timeline');
  if (!force && !shouldFollowTimeline()) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    timeline.scrollTop = timeline.scrollHeight;
  }));
}

async function refreshRunCard(runId) {
  const oldBlock = $(`#run-${CSS.escape(runId)}`);
  if (!oldBlock) return null;
  const data = await api(`/api/runs/${runId}`);
  const block = buildRunCard(data);
  oldBlock.replaceWith(block);
  if (!terminalStatuses.has(data.run.status)) watch(runId, data.events.at(-1)?.id);
  return data;
}

async function syncSessionState() {
  if (!selected) return;
  const sessionId = selected;
  const data = await api(`/api/sessions/${sessionId}`);
  if (selected !== sessionId) return;
  $('#title').textContent = data.session.title;
  $('#status').innerHTML = statusHtml(data.session.status, data.session.prUrl);
  await loadSessions();
}

function watch(runId, after = 0) {
  if (activeSources.has(runId)) return;
  const source = new EventSource(`/api/events?runId=${encodeURIComponent(runId)}&after=${encodeURIComponent(after || 0)}`);
  activeSources.set(runId, source);

  source.onopen = () => {
    const state = $(`#run-${CSS.escape(runId)} .stream-state`);
    if (state) state.textContent = '';
  };

  source.onmessage = event => {
    const follow = shouldFollowTimeline();
    const item = JSON.parse(event.data);
    const steps = $(`#run-${CSS.escape(runId)} .steps`);
    if (!steps || steps.querySelector(`[data-event-id="${CSS.escape(String(item.id))}"]`)) return;
    steps.insertAdjacentHTML('beforeend', eventHtml(item));
    steps.closest('details').querySelector('summary span').textContent = steps.children.length;
    if (follow) scrollToBottom(true);
  };

  source.onerror = () => {
    const state = $(`#run-${CSS.escape(runId)} .stream-state`);
    if (state) state.textContent = 'Reconnecting to live activity…';
  };

  source.addEventListener('done', async () => {
    source.close();
    activeSources.delete(runId);
    try {
      await refreshRunCard(runId);
      await syncSessionState();
      scrollToBottom();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
}

async function openSession(id) {
  selected = id;
  closeSources();
  markActiveSession();
  $('#empty').classList.add('hidden');
  $('#chat').classList.remove('hidden');
  $('#title').textContent = 'Loading chat…';
  $('#status').innerHTML = '';
  $('#timeline').innerHTML = '<div class="timeline-loading">Loading the conversation…</div>';

  try {
    const data = await api(`/api/sessions/${id}`);
    const runData = await Promise.all(data.runs.map(run => api(`/api/runs/${run.id}`)));
    if (selected !== id) return;

    $('#title').textContent = data.session.title;
    $('#status').innerHTML = statusHtml(data.session.status, data.session.prUrl);
    $('#timeline').innerHTML = '';
    for (const item of runData) {
      $('#timeline').append(buildRunCard(item));
      if (!terminalStatuses.has(item.run.status)) watch(item.run.id, item.events.at(-1)?.id);
    }
    if (!runData.length) {
      $('#timeline').innerHTML = `
        <div class="chat-empty">
          <strong>What should Relay take on?</strong>
          <span>Describe an outcome, bug, or question. Relay will inspect the repository before acting.</span>
        </div>
      `;
    }
    markActiveSession();
    scrollToBottom(true);
    setTimeout(() => $('#prompt').focus(), 0);
  } catch (error) {
    if (selected !== id) return;
    showToast(error.message, 'error');
    goHome();
  }
}

function goHome(updateHistory = true) {
  closeSidebar();
  closeSources();
  selected = null;
  if (updateHistory) history.pushState(null, '', location.pathname);
  $('#chat').classList.add('hidden');
  $('#empty').classList.remove('hidden');
  $('#title').textContent = 'Relay';
  $('#status').innerHTML = '';
  markActiveSession();
}

function setEmptyState(title, message = '') {
  $('#empty h2').textContent = title;
  const intro = $('#empty .intro');
  intro.textContent = message;
  intro.classList.toggle('hidden', !message);
}

function connectGitHub() {
  location.href = '/api/auth/github/start';
}

async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  currentUser = null;
  showSignedOut();
}

function updateModelUi() {
  const connected = openAiConfigured === true;
  const checked = openAiConfigured !== null;
  $('#modelDot').className = connected ? 'connected' : checked ? 'attention' : '';
  $('#openaiConnection span').textContent = connected ? 'OpenAI connected' : checked ? 'Add OpenAI key' : 'Checking model…';
  $('#emptyModelAction').textContent = connected ? 'OpenAI connected' : 'Add OpenAI key';
  $('#emptyModelAction').classList.toggle('connected', connected);
  $('#modelNotice').classList.toggle('hidden', openAiConfigured !== false);
  $('#prompt').disabled = !connected;
  $('#thinkingLevel').disabled = !connected;
  $('#runButton').disabled = !connected;
}

function showSignedOut() {
  closeSources();
  selected = null;
  openAiConfigured = null;
  history.replaceState(null, '', location.pathname);
  $('#chat').classList.add('hidden');
  $('#empty').classList.remove('hidden');
  $('#newSession').classList.add('hidden');
  $('#account').classList.add('hidden');
  $('#emptyModelAction').classList.add('hidden');
  $('#sessions').innerHTML = '<div class="muted">Sign in to view your chats.</div>';
  $('#title').textContent = 'Relay';
  $('#status').innerHTML = '';
  setEmptyState('Sign in to Relay');
  const action = $('#emptyAction');
  action.disabled = false;
  action.textContent = 'Continue with GitHub';
  action.onclick = connectGitHub;
}

function showSignedIn(user) {
  currentUser = user;
  openAiConfigured = null;
  $('#newSession').classList.remove('hidden');
  $('#account').classList.remove('hidden');
  $('#emptyModelAction').classList.remove('hidden');
  $('#githubConnection').textContent = `@${user.login} · Sign out`;
  setEmptyState('Start a chat');
  $('#title').textContent = 'Relay';

  const action = $('#emptyAction');
  action.disabled = false;
  action.textContent = 'Start a chat';
  action.onclick = openCreateDialog;
  updateModelUi();
}

async function loadOpenAiConnection() {
  try {
    const status = await api('/api/connections/openai');
    openAiConfigured = status.configured;
    updateModelUi();
  } catch (error) {
    openAiConfigured = null;
    updateModelUi();
    showToast(`Could not check the model connection: ${error.message}`, 'error');
  }
}

function openModelDialog() {
  setFormError($('#modelError'));
  $('#modelForm').reset();
  $('#modelDialog').showModal();
  setTimeout(() => $('#openaiKey').focus(), 0);
}

async function removeOpenAiKey() {
  if (!confirm('Remove your OpenAI API key? New tasks will be paused until another key is added.')) return;
  try {
    await api('/api/connections/openai', { method: 'DELETE' });
    openAiConfigured = false;
    updateModelUi();
    showToast('OpenAI key removed');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

let activeRepositoryIndex = -1;

function matchingRepositories(query = '') {
  const normalized = query.trim().toLowerCase();
  if (!normalized || repositories?.some(repository => repository.url === query.trim())) return repositories || [];
  return (repositories || []).filter(repository =>
    repository.name.toLowerCase().includes(normalized) || repository.url.toLowerCase().includes(normalized)
  );
}

function renderRepositoryOptions(items) {
  const options = $('#repoOptions');
  options.replaceChildren();
  activeRepositoryIndex = -1;
  for (const [index, repository] of items.entries()) {
    const [owner, ...nameParts] = repository.name.split('/');
    const option = document.createElement('div');
    option.id = `repository-option-${index}`;
    option.className = 'repository-option';
    option.setAttribute('role', 'option');
    option.dataset.url = repository.url;
    option.innerHTML = `
      <span class="repository-icon" aria-hidden="true"></span>
      <span class="repository-name"><small>${escapeHtml(owner)}</small><strong>${escapeHtml(nameParts.join('/') || owner)}</strong></span>
      <span class="repository-meta"><span>${repository.private ? 'Private' : 'Public'}</span><small>${escapeHtml(repository.branch)}</small></span>
    `;
    options.append(option);
  }
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'repository-empty';
    empty.textContent = repositories?.length ? 'No matching repositories' : 'No repositories found';
    options.append(empty);
  }
}

function setRepositoryOptionsOpen(open) {
  const input = $('#repoUrl');
  $('#repoOptions').classList.toggle('hidden', !open);
  input.setAttribute('aria-expanded', String(open));
  if (!open) {
    input.removeAttribute('aria-activedescendant');
    activeRepositoryIndex = -1;
  }
}

function refreshRepositoryOptions(open = true) {
  if (!repositories) return;
  renderRepositoryOptions(matchingRepositories($('#repoUrl').value));
  setRepositoryOptionsOpen(open);
}

function activateRepositoryOption(index) {
  const options = [...document.querySelectorAll('.repository-option')];
  if (!options.length) return;
  activeRepositoryIndex = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => {
    const active = optionIndex === activeRepositoryIndex;
    option.classList.toggle('active', active);
    option.setAttribute('aria-selected', String(active));
  });
  const active = options[activeRepositoryIndex];
  $('#repoUrl').setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
}

function chooseRepositoryOption(option) {
  if (!option) return;
  $('#repoUrl').value = option.dataset.url;
  setRepositoryOptionsOpen(false);
  setFormError($('#createError'));
}

async function loadRepositories() {
  if (repositories) {
    renderRepositoryOptions(repositories);
    setRepositoryOptionsOpen(document.activeElement === $('#repoUrl'));
    return;
  }
  try {
    repositories = await api('/api/connections/github/repos');
    renderRepositoryOptions(repositories);
    $('#createHint').textContent = repositories.length
      ? 'Choose a connected repository or enter an allowed public HTTPS URL.'
      : 'No repositories were returned. Enter an allowed public HTTPS URL.';
    setRepositoryOptionsOpen(document.activeElement === $('#repoUrl'));
  } catch (error) {
    $('#repoOptions').replaceChildren();
    $('#createHint').textContent = `${error.message}. Enter an allowed public HTTPS URL instead.`;
  }
}

function openCreateDialog() {
  const form = $('#createForm');
  form.reset();
  setFormError($('#createError'));
  $('#repoOptions').replaceChildren();
  setRepositoryOptionsOpen(false);
  $('#createHint').textContent = 'Loading your recently updated GitHub repositories…';
  $('#create').showModal();
  void loadRepositories();
  setTimeout(() => $('#repoUrl').focus(), 0);
}

function titleForRepository(repoUrl) {
  try {
    const parts = new URL(repoUrl).pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
    return parts.slice(-2).join('/').slice(0, 100) || 'New chat';
  } catch {
    return 'New chat';
  }
}

async function bootstrap() {
  try {
    const user = await api('/api/me');
    showSignedIn(user);
    await Promise.all([loadSessions(), loadOpenAiConnection()]);
    if (location.hash) await openSession(location.hash.slice(1));
  } catch (error) {
    if (error.status === 401) {
      showSignedOut();
      return;
    }
    $('#title').textContent = 'Connection problem';
    setEmptyState('Relay could not finish loading', error.message);
    const action = $('#emptyAction');
    action.disabled = false;
    action.textContent = 'Try again';
    action.onclick = () => location.reload();
  }
}

$('#sidebarToggle').onclick = () => document.body.classList.contains('sidebar-open') ? closeSidebar() : openSidebar();
$('#sidebarBackdrop').onclick = closeSidebar;
$('#homeButton').onclick = () => goHome();
$('#newSession').onclick = openCreateDialog;
$('#githubConnection').onclick = signOut;
$('#openaiConnection').onclick = () => openAiConfigured ? removeOpenAiKey() : openModelDialog();
$('#emptyModelAction').onclick = () => openAiConfigured ? removeOpenAiKey() : openModelDialog();
$('#modelNotice button').onclick = openModelDialog;

$('#sessions').addEventListener('click', event => {
  const session = event.target.closest('.session');
  if (!session) return;
  closeSidebar();
  if (session.dataset.sessionId === selected) {
    event.preventDefault();
    void openSession(selected);
  }
});

$('#repoUrl').oninput = () => {
  setFormError($('#createError'));
  refreshRepositoryOptions();
};
$('#repoUrl').onfocus = () => refreshRepositoryOptions();
$('#repoUrl').onkeydown = event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if ($('#repoOptions').classList.contains('hidden')) refreshRepositoryOptions();
    activateRepositoryOption(activeRepositoryIndex + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Enter' && activeRepositoryIndex >= 0) {
    event.preventDefault();
    chooseRepositoryOption(document.querySelectorAll('.repository-option')[activeRepositoryIndex]);
  } else if (event.key === 'Escape') {
    setRepositoryOptionsOpen(false);
  }
};
$('#repoOptions').addEventListener('pointerdown', event => {
  const option = event.target.closest('.repository-option');
  if (!option) return;
  event.preventDefault();
  chooseRepositoryOption(option);
});
$('#repoOptions').addEventListener('mousemove', event => {
  const option = event.target.closest('.repository-option');
  if (option) activateRepositoryOption([...document.querySelectorAll('.repository-option')].indexOf(option));
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.repository-picker')) setRepositoryOptionsOpen(false);
});

$('#createForm').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const repoUrl = String(new FormData(form).get('repoUrl') || '').trim();
  const repository = repositories?.find(item => item.url === repoUrl);
  const branch = repository?.branch || '';
  const title = repository?.name || titleForRepository(repoUrl);
  setFormError($('#createError'));
  setFormBusy(form, true, 'Creating chat…');

  try {
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title, repoUrl, branch, agentCount: 1 })
    });
    $('#create').close();
    history.pushState(null, '', `#${session.id}`);
    await loadSessions();
    await openSession(session.id);
  } catch (error) {
    setFormError($('#createError'), error.message);
  } finally {
    setFormBusy(form, false);
  }
};

$('#modelForm').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const key = String(new FormData(form).get('key') || '').trim();
  setFormError($('#modelError'));
  setFormBusy(form, true, 'Validating key…');

  try {
    await api('/api/connections/openai', { method: 'PUT', body: JSON.stringify({ key }) });
    openAiConfigured = true;
    updateModelUi();
    $('#modelDialog').close();
    showToast('OpenAI is connected');
    if (selected) setTimeout(() => $('#prompt').focus(), 0);
  } catch (error) {
    setFormError($('#modelError'), error.message);
  } finally {
    setFormBusy(form, false);
  }
};

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.querySelector('.close').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
}

$('#composer').onsubmit = async event => {
  event.preventDefault();
  if (!openAiConfigured) {
    openModelDialog();
    return;
  }

  const input = $('#prompt');
  const prompt = input.value.trim();
  if (!prompt || !selected) return;
  const button = $('#runButton');
  button.disabled = true;
  button.textContent = 'Queuing…';

  try {
    const run = await api(`/api/sessions/${selected}/runs`, {
      method: 'POST',
      body: JSON.stringify({ prompt, thinkingLevel: $('#thinkingLevel').value || null })
    });
    input.value = '';
    input.style.height = '';
    const data = await api(`/api/runs/${run.id}`);
    const empty = $('#timeline .chat-empty');
    if (empty) empty.remove();
    $('#timeline').append(buildRunCard(data));
    watch(run.id, data.events.at(-1)?.id);
    await loadSessions();
    $('#status').innerHTML = statusHtml('queued', null);
    scrollToBottom(true);
  } catch (error) {
    input.focus();
    showToast(error.message, 'error');
  } finally {
    button.textContent = 'Run task ↑';
    updateModelUi();
  }
};

$('#timeline').addEventListener('click', async event => {
  const button = event.target.closest('.cancel-run');
  if (!button) return;
  button.disabled = true;
  button.textContent = 'Stopping…';
  try {
    await api(`/api/runs/${button.dataset.runId}/cancel`, { method: 'POST' });
    showToast('Cancellation requested');
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Cancel run';
    showToast(error.message, 'error');
  }
});

$('#prompt').addEventListener('input', event => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
});

$('#prompt').onkeydown = event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') $('#composer').requestSubmit();
};

addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSidebar();
});

addEventListener('hashchange', () => {
  if (location.hash && currentUser) void openSession(location.hash.slice(1));
  else if (!location.hash && selected) goHome(false);
});

void bootstrap();
