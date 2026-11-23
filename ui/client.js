const $ = (selector, parent = document) => parent.querySelector(selector);
const pages = { overview: '개요', connections: '계정 연결', activity: '게시 활동', insights: 'X 계정 분석', settings: '설정' };
const callbackUrl = 'http://127.0.0.1:53682/callback';
const platforms = {
  threads: { name: 'Threads', mark: '@', role: '원본 계정', description: '게시글과 내가 작성한 쿠팡 링크 댓글을 읽습니다.', docs: 'https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api' },
  x: { name: 'X', mark: '𝕏', role: '게시 계정', description: '원본 글을 올리고 쿠팡 링크 댓글을 답글로 연결합니다.', docs: 'https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code' },
};
const states = {
  posted: ['게시 완료', 'ok'], pending: ['게시 대기', ''], review: ['전송 확인', 'warn'], manual: ['수동 답글', 'warn'], blocked: ['게시 실패', 'warn'],
};
const modal = $('#modal');
let snapshot;
let modalMode;
let toastTimeout;
let refreshPromise;
let activitySignature;
let settingsChanged = false;
let dashboardUnreachable = false;
const pairIds = ['1', '2', '3', '4', '5'];
let selectedPair = localStorage.getItem('relay-pair') || '1';
if (!pairIds.includes(selectedPair)) selectedPair = '1';
let pairSignature;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, callback, primary = false) {
  const node = element('button', `button${primary ? ' button-primary' : ''}`, text);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}

function external(label, url) {
  const node = element('a', 'text-link', `${label} ↗`);
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  node.href = url;
  return node;
}

function sourceUrl(text) {
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' && ['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'].includes(url.hostname)) return url.href;
  } catch {}
  return null;
}

function xUrl(id) { return /^\d+$/.test(id || '') ? `https://x.com/i/web/status/${id}` : null; }

function pill(node, text, tone = '') {
  node.classList.add('pill');
  node.classList.toggle('ok', tone === 'ok');
  node.classList.toggle('warn', tone === 'warn');
  node.replaceChildren(element('i'), document.createTextNode(text));
}

function showSystemError(message) {
  $('#system-error').textContent = message;
  $('#system-error').hidden = !message;
}

function showModalError(message) {
  $('#modal-error').textContent = message;
  $('#modal-error').hidden = !message;
}

function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 3800);
}

function openModal(mode, title, description, content) {
  modalMode = mode;
  $('#modal-title').textContent = title;
  $('#modal-description').textContent = description;
  $('#modal-content').replaceChildren(content);
  showModalError('');
  if (!modal.open) modal.showModal();
}

async function api(path, body, pair = selectedPair) {
  const isPost = body !== undefined;
  const headers = { 'X-Relay-Profile': pair };
  const request = { headers };
  if (isPost) {
    request.method = 'POST';
    headers['Content-Type'] = 'application/json';
    headers['X-Relay-Token'] = csrfToken;
    request.body = JSON.stringify(body);
  }
  const response = await fetch(`/api/${path}`, request);
  const output = await response.json();
  if (!response.ok) throw new Error(output.error || '요청을 처리하지 못했습니다.');
  return output;
}

let csrfToken = '';

function setPair(id) {
  if (id === selectedPair || !pairIds.includes(id)) return;
  selectedPair = id;
  localStorage.setItem('relay-pair', id);
  snapshot = null;
  settingsChanged = false;
  activitySignature = undefined;
  $('#pair-select').value = id;
  $('#main-content').inert = true;
  $('#main-content').setAttribute('aria-busy', 'true');
  $('#preview-top').disabled = true;
  pill($('#run-state'), '연결 확인 중');
  void refresh();
}

function renderPairs(profiles) {
  const signature = JSON.stringify([selectedPair, profiles]);
  if (signature === pairSignature) return;
  pairSignature = signature;
  const picker = $('#pair-select');
  const section = $('#pair-list');
  picker.replaceChildren();
  section.replaceChildren();
  for (const profile of profiles) {
    const option = element('option', '', profile.label);
    option.value = profile.id;
    picker.append(option);
    const tile = button('', () => setPair(profile.id));
    const active = profile.id === selectedPair;
    tile.className = 'panel pair-tile';
    tile.setAttribute('aria-pressed', String(active));
    tile.append(
      element('strong', '', profile.label),
      element('span', '', profile.threads ? `Threads @${profile.threads}` : 'Threads 미연결'),
      element('span', '', profile.x ? `X @${profile.x}` : 'X 미연결'),
    );
    section.append(tile);
    if (active) $('#active-pair').textContent = profile.label;
  }
  picker.value = selectedPair;
}

function setPage() {
  const key = location.hash.slice(1);
  const page = Object.hasOwn(pages, key) ? key : 'overview';
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== page;
  for (const link of document.querySelectorAll('[data-page]')) {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('#page-name').textContent = pages[page];
  window.scrollTo(0, 0);
}

const accountCards = { threads: [], x: [] };
for (const group of document.querySelectorAll('[data-accounts]')) {
  for (const [key, platform] of Object.entries(platforms)) {
    const fragment = $('#account-template').content.cloneNode(true);
    const card = $('.account-card', fragment);
    const logo = $('.platform-logo', card);
    logo.textContent = platform.mark;
    logo.classList.add(`${key}-logo`);
    $('h3', card).textContent = platform.name;
    $('.account-role', card).textContent = platform.role;
    $('.account-description', card).textContent = platform.description;
    $('a', card).href = platform.docs;
    const connect = $('[data-connect]', card);
    connect.textContent = `${platform.name} 연결`;
    connect.addEventListener('click', () => key === 'threads' ? threadsDialog() : xDialog());
    accountCards[key].push(card);
    group.append(fragment);
  }
}

function emptyState(title, description) {
  const node = $('#empty-template').content.cloneNode(true);
  $('strong', node).textContent = title;
  $('p', node).textContent = description;
  return node;
}

function renderAccounts(connections) {
  for (const [key, cards] of Object.entries(accountCards)) {
    const platform = platforms[key];
    const connection = connections[key];
    for (const card of cards) {
      pill($('.account-state', card), connection.ready ? '연결됨' : connection.saved ? '확인 필요' : '미연결', connection.ready ? 'ok' : connection.saved ? 'warn' : '');
      $('.account-role', card).textContent = connection.username ? `${platform.role} · @${connection.username}` : platform.role;
      const connect = $('[data-connect]', card);
      connect.textContent = connection.ready ? '연결 관리' : `${platform.name} 연결`;
      connect.setAttribute('aria-label', `${platform.name} ${connection.ready ? '연결 관리' : '계정 연결'}`);
    }
  }
}

function formatDate(value) {
  if (!value) return '기록 없음';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

function formatInterval(seconds) {
  if (seconds === 0) return '즉시';
  return seconds % 60 === 0 ? `${seconds / 60}분` : `${seconds}초`;
}

function renderSettings(state) {
  const { settings, task, connections } = state;
  $('#overview-interval').textContent = formatInterval(settings.interval);
  $('#overview-reply-interval').textContent = formatInterval(settings.replyInterval);
  $('#overview-publish-interval').textContent = formatInterval(settings.publishInterval);
  $('#overview-check').textContent = formatDate(state.lastChecked);
  if (!settingsChanged) {
    $('#interval-input').value = settings.interval;
    $('#reply-interval-input').value = settings.replyInterval;
    $('#publish-interval-input').value = settings.publishInterval;
    $('#lookback-input').value = settings.lookback;
    const selected = Date.parse(settings.since);
    $('#since-input').value = Number.isFinite(selected) ? new Date(selected + 9 * 3600_000).toISOString().slice(0, 16) : '';
  }
  $('#since-field').hidden = Boolean(settings.started);
  $('#since-fixed').hidden = !settings.started;
  $('#since-fixed').textContent = settings.started ? `동기화 시작 시각 ${formatDate(settings.started)} (한국 시간)` : '';
  const ready = connections.threads.ready && connections.x.ready;
  pill($('#run-state'), task.unavailable ? '상태 확인 불가' : task.running ? '자동화 실행 중' : ready ? '자동화 중지됨' : '연결 필요', task.running ? 'ok' : task.unavailable ? 'warn' : '');
  $('#hero-action-label').textContent = task.running ? '게시 활동 보기' : ready ? '자동화 시작' : '계정 연결 시작';
  $('#task-title').textContent = task.unavailable ? '상태 확인 불가' : task.running ? '실행 중' : task.installed ? '중지됨' : '자동 실행 미설정';
  $('#task-description').textContent = task.unavailable ? 'Windows 작업 스케줄러를 확인할 수 없습니다.' : task.paused ? '다시 시작할 때까지 로그인 시 자동 실행을 중지합니다.' : task.lastResult && !task.running && task.lastResult !== 267011 ? `이전 실행 결과 코드 ${task.lastResult}` : task.installed ? 'Windows 로그인 때 Relay가 시작됩니다.' : '처음 시작하면 로그인 시 자동 실행도 함께 설정됩니다.';
  $('#task-toggle').textContent = task.running ? '자동화 중지' : '자동화 시작';
  $('#task-toggle').disabled = Boolean(task.unavailable);
}

function renderActivity(force = false) {
  if (!snapshot) return;
  const { counts, activity, sourceErrors } = snapshot;
  const signature = JSON.stringify([counts, activity, sourceErrors]);
  if (!force && signature === activitySignature) return;
  activitySignature = signature;
  $('#count-posted').textContent = counts.posted || 0;
  $('#count-pending').textContent = counts.pending || 0;
  $('#count-review').textContent = (counts.review || 0) + (counts.manual || 0) + (counts.blocked || 0);
  const filter = $('#activity-filter').value;
  const filtered = activity.filter(row => filter === 'all' || (filter === 'review' ? ['review', 'manual', 'blocked'].includes(row.state) : row.state === filter));
  $('#recent-activity').replaceChildren(activityList(activity.slice(0, 3), '아직 게시 기록이 없습니다', '계정을 연결하고 자동화를 시작하면 활동이 여기에 표시됩니다.'));
  const all = $('#all-activity');
  all.replaceChildren(activityList(filtered, '표시할 게시물이 없습니다', filter === 'all' ? '동기화된 본문과 답글이 이곳에 표시됩니다.' : '다른 상태를 선택해 게시 기록을 확인하세요.'));
  if (filter === 'all') {
    for (const issue of sourceErrors) {
      all.append(element('div', 'notice system-error', `Threads 글 ${issue.id} · ${[issue.plan_error, issue.reply_error].filter(Boolean).join(' / ')}`));
    }
  }
}

function activityList(items, title, details) {
  if (!items.length) return emptyState(title, details);
  const list = element('ul', 'activity-list');
  for (const item of items) {
    const row = element('li', 'activity-row');
    const description = element('div', 'activity-content');
    const name = item.reply ? '쿠팡 링크 답글' : 'Threads 게시글';
    description.append(element('strong', '', item.text || name), element('p', '', item.error || name));
    const controls = element('div', 'activity-controls');
    const badge = element('span');
    pill(badge, ...(states[item.state] || ['확인 필요', 'warn']));
    controls.append(badge, button('상세', () => activityDialog(item)));
    row.append(description, controls);
    list.append(row);
  }
  return list;
}

async function refresh() {
  if (refreshPromise?.pair !== selectedPair) {
    const pair = selectedPair;
    const current = { pair };
    refreshPromise = current;
    current.promise = api('state', undefined, pair).then(result => {
      if (pair !== selectedPair) return;
      snapshot = result;
      csrfToken = result.csrf;
      if (dashboardUnreachable) showSystemError('');
      dashboardUnreachable = false;
      renderPairs(result.profiles);
      renderAccounts(result.connections);
      renderSettings(result);
      renderActivity();
      document.dispatchEvent(new CustomEvent('relay:state', { detail: result }));
      $('#main-content').inert = false;
      $('#main-content').removeAttribute('aria-busy');
      $('#preview-top').disabled = false;
      if (modal.open && modalMode === 'x-wait' && result.auth?.state === 'done') {
        modal.close();
        notify(`X @${result.connections.x.username} 계정이 연결되었습니다.`);
      } else if (modal.open && modalMode === 'x-wait' && result.auth?.state === 'failed') {
        xDialog(result.auth.error);
      }
    }).catch(error => {
      if (pair !== selectedPair) return;
      dashboardUnreachable = true;
      console.error(error);
      showSystemError('Relay에 연결할 수 없습니다. 실행 창이 열려 있는지 확인해 주세요.');
    }).finally(() => { if (refreshPromise === current) refreshPromise = null; });
  }
  return refreshPromise.promise;
}

function guide(text, steps, links) {
  const node = element('div', 'guide');
  node.append(element('strong', '', text));
  const list = element('ol');
  for (const step of steps) list.append(element('li', '', step));
  node.append(list);
  for (const [label, url] of links) node.append(external(label, url));
  return node;
}

function field(name, label, placeholder, { secret = false, value = '', hint = '', required = false } = {}) {
  const wrapper = element('label', '', label);
  const input = element('input');
  input.name = name;
  input.type = secret ? 'password' : 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.value = value;
  input.required = required;
  if (hint) wrapper.append(element('small', '', hint));
  wrapper.append(input);
  return wrapper;
}

function submitButton(text) {
  const send = element('button', 'button button-primary', text);
  send.type = 'submit';
  return send;
}

async function busy(control, label, action, showError = showModalError) {
  const title = control.textContent;
  control.disabled = true;
  control.textContent = label;
  showError('');
  try {
    await action();
  } catch (error) {
    showError(error.message);
  } finally {
    control.disabled = false;
    control.textContent = title;
  }
}

function threadsDialog() {
  const saved = snapshot?.connections.threads.saved;
  const container = element('div');
  container.append(guide('Meta 개발자 콘솔에서 준비하기', [
    'Threads 사용 사례가 포함된 앱을 만들고 본인 계정을 앱 역할 또는 Threads Tester로 등록합니다.',
    'threads_basic, threads_read_replies 권한을 선택해 Threads 사용자 토큰을 발급합니다.',
    '단기 토큰을 발급받았다면 앱 시크릿도 함께 입력합니다.',
  ], [['Meta 개발자 콘솔', 'https://developers.facebook.com/apps/']]));
  const form = element('form', 'modal-form');
  form.append(field('token', 'Threads 사용자 토큰', saved ? '저장된 토큰 사용 · 새 토큰이 있으면 입력' : '사용자 토큰 붙여넣기', { secret: true, required: !saved }));
  form.append(field('secret', 'Threads 앱 시크릿 · 선택', '단기 토큰을 교환할 때 입력', { secret: true, hint: '장기 토큰을 사용한다면 비워 두세요.' }));
  const send = submitButton('연결 확인 후 저장');
  form.append(send);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void busy(send, 'Threads 연결 확인 중…', async () => {
      const result = await api('threads', Object.fromEntries(new FormData(form)));
      await refresh();
      if (modalMode === 'threads') modal.close();
      notify(result.repliesChecked ? `Threads @${result.username} 계정과 댓글 읽기 권한을 확인했습니다.` : `Threads @${result.username} 계정을 연결했습니다.`);
    });
  });
  container.append(form);
  openModal('threads', 'Threads 연결', '글과 댓글을 읽을 Threads 사용자 토큰을 등록하세요.', container);
}

async function copyText(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    notify(`${label}을 복사했습니다.`);
  } catch {
    showModalError('자동 복사를 사용할 수 없습니다. 화면의 값을 선택해 복사해 주세요.');
  }
}

function xDialog(error) {
  if (!error && snapshot?.auth?.state === 'pending' && snapshot.auth.url) return xWaiting(snapshot.auth.url);
  const connection = snapshot?.connections.x;
  const pair = selectedPair;
  const clientId = connection?.clientId || connection?.suggestedClientId;
  const hasSecret = Boolean(connection?.hasSecret || connection?.suggestedHasSecret);
  const container = element('div');
  const instructions = guide('X 개발자 콘솔에서 준비하기', [
    '앱의 사용자 인증 설정에서 읽기 및 쓰기 권한을 선택하고 앱 유형을 Native App으로 설정합니다.',
    '아래 주소를 콜백 URL로 등록하고 OAuth 2.0 Client ID를 복사합니다.',
  ], [['X 개발자 콘솔', 'https://developer.x.com/en/portal/dashboard']]);
  const address = element('div', 'input-tools');
  address.append(element('code', '', callbackUrl), button('복사', () => copyText(callbackUrl, '콜백 주소')));
  $('ol', instructions).after(address);
  container.append(instructions);
  const form = element('form', 'modal-form');
  form.append(field('clientId', 'OAuth 2.0 Client ID', 'X에서 발급한 OAuth 2.0 Client ID', {
    value: clientId, required: true, hint: connection?.suggestedClientId ? '1번 연결의 X 개발자 앱 정보를 가져왔습니다.' : '',
  }));
  const confidential = element('label', 'checkbox-row');
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.checked = hasSecret;
  confidential.append(checkbox, document.createTextNode('Client Secret이 있는 앱을 사용합니다.'));
  const secret = field('secret', 'OAuth 2.0 Client Secret', hasSecret ? '비워 두면 같은 앱의 저장된 값 사용' : 'Client Secret 붙여넣기', { secret: true });
  secret.hidden = !checkbox.checked;
  checkbox.addEventListener('change', () => { secret.hidden = !checkbox.checked; });
  const send = submitButton('X 로그인 준비');
  form.append(confidential, secret, send);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void busy(send, 'X 로그인 준비 중…', async () => {
      const result = await api('x', { ...Object.fromEntries(new FormData(form)), publicClient: !checkbox.checked }, pair);
      if (selectedPair === pair && modal.open && modalMode === 'x') xWaiting(result.url);
      else await api('x/cancel', {}, pair);
    });
  });
  container.append(form);
  openModal('x', 'X 연결', '앱을 설정한 뒤 게시할 X 계정으로 로그인하세요.', container);
  if (error) showModalError(error);
}

function xWaiting(url) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://x.com' || parsed.pathname !== '/i/oauth2/authorize') return;
  const actions = element('div', 'form-actions');
  const link = external('X에서 로그인 및 승인', parsed.href);
  link.className = 'button button-primary';
  actions.append(link, button('연결 취소', () => modal.close()));
  openModal('x-wait', 'X 로그인 승인', '새 탭에서 승인하면 이 화면에서 연결 결과를 확인할 수 있습니다.', actions);
  link.focus();
}

function previewDialog() {
  if (!snapshot?.connections.threads.saved) return threadsDialog();
  openModal('preview', '게시 미리보기', '최근 Threads 글 3개의 본문과 쿠팡 링크 답글을 확인합니다.', element('p', 'subtle', 'Threads에서 가져오는 중입니다…'));
  void api('preview', {}).then(posts => {
    if (!modal.open || modalMode !== 'preview') return;
    const stack = element('div', 'preview-stack');
    for (const post of posts) {
      const card = element('article', 'preview-post');
      const showPart = (part, title) => {
        const node = element('div', 'preview-part');
        node.append(element('strong', '', `${title}${part.media.length ? ` · 첨부 ${part.media.length}개` : ''}`));
        if (part.text) node.append(element('p', '', part.text));
        card.append(node);
      };
      post.parts.forEach((part, index) => showPart(part, index ? '이어지는 답글' : 'X 본문'));
      post.replies.forEach(part => showPart(part, '쿠팡 링크 답글'));
      const url = sourceUrl(post.permalink);
      if (url) card.append(external('Threads 원문', url));
      stack.append(card);
    }
    if (!posts.length) stack.append(emptyState('가져올 게시물이 없습니다', 'Threads에서 글을 게시하면 여기에서 미리 볼 수 있습니다.'));
    $('#modal-content').replaceChildren(stack);
  }).catch(error => {
    if (modal.open && modalMode === 'preview') {
      $('#modal-content').replaceChildren(button('다시 확인', previewDialog));
      showModalError(error.message);
    }
  });
}

function activityDialog(item) {
  const content = element('div', 'preview-stack');
  if (item.error) content.append(element('p', 'notice', item.error));
  if (item.text) content.append(element('p', 'post-copy', item.text));
  if (item.mediaCount) content.append(element('p', 'subtle', `첨부 파일 ${item.mediaCount}개`));
  const links = element('div', 'form-actions');
  const source = sourceUrl(item.source);
  const parent = xUrl(item.parent_x_id);
  const target = xUrl(item.x_id);
  if (source) links.append(external('Threads 원문', source));
  if (parent) links.append(external('X 답글 대상 열기', parent));
  if (target) links.append(external('게시한 X 글 열기', target));
  if (item.text && ['review', 'manual', 'blocked'].includes(item.state)) links.append(button('본문 복사', () => copyText(item.text, '본문')));
  if (links.childNodes.length) content.append(links);
  if (['review', 'manual', 'blocked'].includes(item.state)) {
    const form = element('form', 'modal-form');
    form.append(field('url', 'X에 이미 게시했다면 게시물 주소를 입력하세요.', 'https://x.com/계정/status/…', { required: true }));
    const actions = element('div', 'form-actions');
    const submit = submitButton('게시 완료 기록');
    const retry = button('다시 게시 요청', () => {
      const confirm = button('다시 게시 요청 확인', () => resolve(confirm, 'retry'), true);
      const panel = element('div', 'preview-stack');
      panel.append(element('p', '', '이 글이 X에 아직 게시되지 않았는지 확인해 주세요.'), confirm, button('뒤로', () => activityDialog(item)));
      openModal('activity', '게시 다시 요청', '다음 동기화에서 이 항목을 다시 전송합니다.', panel);
    });
    function resolve(control, action, url) {
      void busy(control, '처리 중…', async () => {
        await api('activity', { key: item.key, action, url });
        if (modalMode === 'activity') modal.close();
        await refresh();
        notify(action === 'retry' ? '다시 게시할 항목으로 저장했습니다.' : '게시 완료를 기록했습니다.');
      });
    }
    actions.append(submit, retry);
    form.append(actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      resolve(submit, 'posted', new FormData(form).get('url'));
    });
    content.append(form);
  }
  openModal('activity', item.reply ? '쿠팡 링크 답글' : '게시 상세', states[item.state]?.[0] || '확인 필요', content);
}

function startStopDialog() {
  if (!snapshot) return;
  const { connections, task, settings } = snapshot;
  if (!task.running && (!connections.threads.ready || !connections.x.ready)) {
    location.hash = 'connections';
    if (!connections.threads.ready) threadsDialog();
    else xDialog();
    return;
  }
  const action = task.running ? 'stop' : 'start';
  const title = task.running ? '자동화를 중지할까요?' : '자동화를 시작할까요?';
  const panel = element('div', 'preview-stack');
  const timing = settings.started ? `기존 시작 시각 (${formatDate(settings.started)})` : settings.since ? `설정한 시각 (${formatDate(settings.since)})` : '지금 시각';
  panel.append(element('p', '', task.running ? '자동 게시를 중지합니다. 다시 시작하면 저장된 동기화 기록에서 이어서 처리합니다.' : `${timing}부터의 Threads 글을 찾아 실제 X에 게시합니다.`));
  const actions = element('div', 'form-actions');
  const confirm = button(task.running ? '중지하기' : '시작하기', () => {
    void busy(confirm, 'Windows 작업 처리 중…', async () => {
      await api(`automation/${action}`, {});
      if (modalMode === 'automation') modal.close();
      await refresh();
      notify(action === 'start' ? '자동화 시작을 요청했습니다.' : '자동화를 중지했습니다.');
    });
  }, true);
  actions.append(confirm, button('취소', () => modal.close()));
  panel.append(actions);
  const label = snapshot.profiles.find(profile => profile.id === selectedPair)?.label;
  openModal('automation', title, `${label} · Windows 백그라운드 실행`, panel);
}

function renamePairDialog() {
  const pair = selectedPair;
  const current = snapshot?.profiles.find(profile => profile.id === pair);
  if (!current) return;
  const form = element('form', 'modal-form');
  const label = field('label', '연결 이름', '예: 생활용품, 디지털, 반려동물', { value: current.label, required: true });
  $('input', label).maxLength = 36;
  const save = submitButton('이름 저장');
  form.append(label, save);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void busy(save, '저장 중…', async () => {
      await api('profile', { label: new FormData(form).get('label') }, pair);
      if (modalMode === 'rename') modal.close();
      await refresh();
      if (pair === selectedPair) notify('연결 이름을 저장했습니다.');
    });
  });
  openModal('rename', '연결 이름 변경', '계정의 주제나 용도를 이름으로 적어두세요.', form);
}

$('#settings-form').addEventListener('input', () => { settingsChanged = true; });
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  const settings = new FormData(event.currentTarget);
  void busy(event.submitter, '저장 중…', async () => {
    await api('settings', {
      interval: Number(settings.get('interval')),
      replyInterval: Number(settings.get('replyInterval')),
      publishInterval: Number(settings.get('publishInterval')),
      lookback: Number(settings.get('lookback')),
      since: settings.get('since'),
    });
    settingsChanged = false;
    await refresh();
    notify('자동화 설정을 저장했습니다.');
  }, showSystemError);
});
$('#preview-top').addEventListener('click', previewDialog);
$('#pair-select').addEventListener('change', event => setPair(event.target.value));
$('#rename-pair').addEventListener('click', renamePairDialog);
$('#task-toggle').addEventListener('click', startStopDialog);
$('#hero-action').addEventListener('click', () => snapshot?.task.running ? (location.hash = 'activity') : startStopDialog());
$('#modal-close').addEventListener('click', () => modal.close());
$('#activity-filter').addEventListener('change', () => renderActivity(true));
modal.addEventListener('close', () => {
  if (modalMode === 'x-wait' && snapshot?.auth?.state !== 'done') void api('x/cancel', {}, snapshot?.profile).catch(() => {});
  modalMode = null;
});
window.addEventListener('hashchange', setPage);
setPage();
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 3500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
