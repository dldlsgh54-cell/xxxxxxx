(() => {
  const form = $('#analysis-form');
  const result = $('#analysis-result');
  const submit = $('#run-analysis');
  const handles = form.elements.handles;
  const ownAccount = $('#add-my-account');
  const empty = result.firstElementChild.cloneNode(true);
  const reports = new Map();
  let active;
  let xAccount;
  const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
  const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const days = ['월', '화', '수', '목', '금', '토', '일'];
  const hours = [0, 4, 8, 12, 16, 20];
  const formats = { text: '텍스트', image: '사진', video: '영상', gif: 'GIF', link: '외부 링크', poll: '투표', media: '기타 미디어' };
  const placements = { body: '본문', reply: '작성자 답글', both: '본문과 답글', none: '미감지' };
  const label = (value, unit = '') => value == null ? '—' : `${number.format(value)}${unit}`;
  const hour = value => String(value).padStart(2, '0');
  const slot = cell => `${days[cell.weekday]}요일 ${hour(cell.hour)}:00–${hour(cell.hour + 4)}:00`;

  function slotDetails(cell) {
    if (cell.score === null) return `글 ${label(cell.count, '건')} · 점수 비교 표본 ${label(cell.sample, '건')}`;
    return `반응 ${label(cell.score, '점')} · 비교 표본 ${label(cell.sample, '건')} · ${label(cell.accounts, '개 계정')}`;
  }

  function panel(title, description) {
    const node = element('section', 'panel analysis-panel');
    const heading = element('div', 'panel-heading');
    const text = element('div');
    text.append(element('h2', '', title));
    if (description) text.append(element('p', '', description));
    heading.append(text);
    node.append(heading);
    return { node, heading };
  }

  function kpis(report) {
    const grid = element('div', 'analysis-summary');
    for (const [name, value] of [
      ['비교 계정', label(report.accounts.length, '개')], ['확인한 원글', label(report.total, '건')],
      ['계정당 주간 게시 중앙값', label(report.typicalPerWeek, '건')], ['본문 길이 중앙값', label(report.medianLength, '자')],
    ]) {
      const card = element('div', 'panel analysis-kpi');
      card.append(element('span', '', name), element('strong', '', value));
      grid.append(card);
    }
    return grid;
  }

  function timeAnalysis(report) {
    const section = element('div', 'analysis-columns');
    const heatmap = panel('요일·시간대별 성과', '한국 시간 · 4시간 단위');
    const selector = element('select', 'analysis-mode');
    selector.setAttribute('aria-label', '시간대 기준');
    for (const [value, text] of [['score', '반응 점수'], ['count', '게시량']]) {
      const option = element('option', '', text);
      option.value = value;
      selector.append(option);
    }
    heatmap.heading.append(selector);

    const grid = element('div', 'analysis-grid-wrap');
    const table = element('table', 'heatmap');
    const header = table.createTHead().insertRow();
    header.append(element('th', '', '요일'));
    for (const time of hours) {
      const cell = element('th', '', `${hour(time)}–${hour(time + 4)}`);
      cell.scope = 'col';
      header.append(cell);
    }
    const body = table.createTBody();
    const chartCells = new Map();
    const details = element('p', 'heat-detail', '칸을 선택하면 게시 수와 비교 표본을 볼 수 있습니다.');
    details.setAttribute('aria-live', 'polite');
    let selected = null;
    const show = (cell, focus = false) => {
      if (selected) chartCells.get(selected).setAttribute('aria-pressed', 'false');
      selected = cell;
      const target = chartCells.get(cell);
      target.setAttribute('aria-pressed', 'true');
      details.textContent = `${slot(cell)} · ${slotDetails(cell)}`;
      if (focus) target.focus();
    };
    const most = Math.max(1, ...report.heat.map(cell => cell.count));
    function paint() {
      for (const [cell, control] of chartCells) {
        const byCount = selector.value === 'count';
        const value = byCount ? cell.count : cell.score;
        const intensity = byCount ? Math.ceil(4 * cell.count / most) : value === null ? 0 : Math.min(4, 1 + Math.floor(value / 25));
        control.className = `heat-button heat-${intensity}`;
        control.textContent = label(value);
        control.setAttribute('aria-label', `${slot(cell)} · ${slotDetails(cell)}`);
      }
    }
    for (const [index, weekday] of days.entries()) {
      const row = body.insertRow();
      const title = element('th', '', weekday);
      title.scope = 'row';
      row.append(title);
      for (const cell of report.heat.filter(value => value.weekday === index)) {
        const control = button('', () => show(cell));
        control.setAttribute('aria-pressed', 'false');
        chartCells.set(cell, control);
        row.insertCell().append(control);
      }
    }
    selector.addEventListener('change', paint);
    paint();
    grid.append(table);
    heatmap.node.append(grid, details);

    const picks = panel('시험해 볼 게시 시간', `중간 수준을 웃돌고 비교 표본이 ${report.minBucket}건 이상인 구간`);
    if (!report.windows.length) {
      picks.node.append(element('p', 'analysis-note', '조건에 맞는 구간이 없습니다. 조회 기간이나 계정별 조회량을 늘려 볼 수 있습니다.'));
    } else {
      const list = element('ol', 'analysis-list');
      for (const candidate of report.windows) {
        const cell = report.heat.find(value => value.weekday === candidate.weekday && value.hour === candidate.hour);
        if (!cell) continue;
        const item = element('li');
        const slotText = element('div');
        slotText.append(element('strong', '', slot(cell)), element('small', '', slotDetails(cell)));
        item.append(slotText, button('표에서 보기', () => show(cell, true)));
        list.append(item);
      }
      picks.node.append(list);
    }
    section.append(heatmap.node, picks.node);
    return section;
  }

  function breakdown(title, description, items, names, total) {
    const card = panel(title, description);
    const list = element('ul', 'analysis-list');
    for (const item of items) {
      const row = element('li');
      const name = element('div');
      name.append(element('strong', '', names[item.id]), element('small', '', `${label(item.count, '건')} · ${label(100 * item.count / Math.max(1, total), '%')}`));
      const strength = element('div', 'category-strength');
      const bar = element('progress');
      bar.max = 100;
      bar.value = 100 * item.count / Math.max(1, total);
      bar.setAttribute('aria-label', `${names[item.id]} 게시글 비중`);
      strength.append(bar, element('small', '', item.score === null ? '점수 표본 부족' : `반응 ${label(item.score, '점')} · ${label(item.sample, '건')}`));
      row.append(name, strength);
      list.append(row);
    }
    if (items.length) card.node.append(list);
    else card.node.append(element('p', 'analysis-note', '분석할 원글이 없습니다.'));
    return card.node;
  }

  function accountTable(report) {
    const card = panel('계정별 비교', `반응과 노출은 게시 후 ${report.matureDays}일이 지난 글의 중앙값입니다.`);
    const frame = element('div', 'analysis-table-wrap');
    const table = element('table', 'analysis-table');
    const row = table.createTHead().insertRow();
    for (const name of ['계정', '팔로워', '원글', '주간 게시', '노출', '반응', '노출 대비 반응률']) {
      const heading = element('th', '', name);
      heading.scope = 'col';
      row.append(heading);
    }
    const body = table.createTBody();
    for (const account of report.accounts) {
      const item = body.insertRow();
      const title = element('th');
      title.scope = 'row';
      title.append(external(`@${account.username}`, `https://x.com/${encodeURIComponent(account.username)}`));
      if (account.limited) title.append(element('small', '', `조회 한도 · ${timestamp.format(account.sinceObserved)}부터`));
      item.append(title);
      for (const [value, unit] of [[account.followers, ''], [account.count, '건'], [account.perWeek, '건'], [account.medianViews, ''], [account.medianInteractions, ''], [account.medianRate, '%']]) {
        item.insertCell().textContent = label(value, unit);
      }
      if (account.rates) item.lastElementChild.append(element('small', '', `표본 ${label(account.rates, '건')}`));
    }
    frame.append(table);
    card.node.append(frame);
    return card.node;
  }

  function examples(report) {
    const card = panel('반응이 높았던 글', '각 계정의 평소 반응을 기준으로 정렬했습니다.');
    const list = element('ul', 'analysis-list');
    for (const post of report.bestPosts) {
      const url = xUrl(post.id);
      if (!url) continue;
      const row = element('li');
      const info = element('div');
      info.append(external(`@${post.account} 게시물`, url), element('small', '', `${timestamp.format(post.time)} · ${formats[post.format]} · 쿠팡 링크 ${placements[post.placement]}`));
      row.append(info, element('strong', '', label(post.score, '점')));
      list.append(row);
    }
    card.node.append(list.childNodes.length ? list : element('p', 'analysis-note', '계정 내 중간 수준을 웃돈 글이 확인되면 표시됩니다.'));
    return card.node;
  }

  function renderReport(entry) {
    const data = entry.report;
    const report = entry.couponOnly && data.coupang ? { ...data, ...data.coupang } : data;
    const fragment = document.createDocumentFragment();
    if (report.errors.length) {
      fragment.append(element('p', 'notice analysis-errors', report.errors.map(error => `@${error.username} · ${error.reason}`).join(' / ')));
    }
    if (!report.accounts.length) {
      fragment.append(element('p', 'panel empty-state', '분석할 공개 계정 데이터를 가져오지 못했습니다.'));
      return result.replaceChildren(fragment);
    }
    const info = element('div', 'analysis-meta');
    info.append(element('span', '', `${timestamp.format(report.at)} 기준${report.cached ? ' · 저장된 조회 결과' : ''}`));
    const options = element('div', 'form-actions');
    for (const [name, couponOnly] of [['전체 글', false], ['쿠팡 링크 감지 글', true]]) {
      const filter = button(name, () => {
        entry.couponOnly = couponOnly;
        renderReport(entry);
        $(`button[data-scope="${couponOnly}"]`, result).focus();
      });
      filter.dataset.scope = String(couponOnly);
      filter.setAttribute('aria-pressed', String(Boolean(entry.couponOnly) === couponOnly));
      options.append(filter);
    }
    info.append(options);
    fragment.append(info, kpis(report));
    if (!report.total) {
      fragment.append(element('p', 'panel empty-state', '이 범위에서 비교할 원글이 없습니다. 계정별 조회량을 늘리거나 다른 범위를 선택해 보세요.'), accountTable(report));
      return result.replaceChildren(fragment);
    }
    fragment.append(timeAnalysis(report));
    const categories = element('div', 'analysis-columns equal');
    categories.append(
      breakdown('콘텐츠 형식', '형식별 게시 비중과 반응 점수', report.formats, formats, report.total),
      breakdown('쿠팡 링크 위치', '조회한 원글과 해당 작성자의 답글에서 감지', report.placements, placements, report.total),
    );
    if (report.accounts.some(account => account.incompleteThreads)) {
      categories.lastElementChild.append(element('p', 'analysis-note', '일부 응답에 대화 ID가 없어 답글 링크가 빠졌을 수 있습니다.'));
    }
    fragment.append(categories, accountTable(report), examples(report));
    result.replaceChildren(fragment);
  }

  function renderState(state) {
    const ready = xAccount?.ready;
    $('#analysis-connection').hidden = Boolean(ready);
    ownAccount.hidden = !xAccount?.username;
    submit.disabled = !ready || state.pending;
    submit.textContent = state.pending ? '분석 중…' : '분석 시작 →';
    $('#analysis-error').textContent = state.error || '';
    $('#analysis-error').hidden = !state.error;
    result.setAttribute('aria-busy', String(Boolean(state.pending)));
    if (state.report) renderReport(state);
    else if (state.pending) result.replaceChildren(element('p', 'panel empty-state', 'X에서 공개 게시글과 반응 지표를 가져오는 중입니다…'));
    else result.replaceChildren(empty.cloneNode(true));
  }

  function selected(state) {
    const profile = state.profile || selectedPair;
    const changed = profile !== active;
    const readyChanged = xAccount?.ready !== state.connections.x.ready || xAccount?.username !== state.connections.x.username;
    xAccount = state.connections.x;
    if (!changed && !readyChanged) return;
    active = profile;
    if (!reports.has(profile)) reports.set(profile, {});
    const entry = reports.get(profile);
    if (changed) {
      handles.value = entry.values?.handles || '';
      form.elements.days.value = entry.values?.days || '30';
      form.elements.limit.value = entry.values?.limit || '50';
    }
    renderState(entry);
  }

  form.addEventListener('input', () => {
    const entry = reports.get(active);
    if (entry) entry.values = Object.fromEntries(new FormData(form));
  });
  ownAccount.addEventListener('click', () => {
    const username = xAccount?.username;
    if (!username) return;
    const value = `@${username}`;
    if (!handles.value.toLowerCase().split(/[\s,，]+/).includes(value.toLowerCase())) {
      handles.value = [handles.value.trim(), value].filter(Boolean).join('\n');
      handles.dispatchEvent(new Event('input', { bubbles: true }));
    }
    handles.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const profile = active;
    const entry = reports.get(profile);
    if (!entry || entry.pending || !xAccount?.ready) return;
    entry.values = Object.fromEntries(new FormData(form));
    entry.pending = true;
    entry.error = '';
    renderState(entry);
    const { handles, days, limit } = entry.values;
    try {
      entry.report = await api('insights', { handles, days: Number(days), limit: Number(limit) }, profile);
    } catch (error) {
      entry.error = error.message;
    } finally {
      entry.pending = false;
      if (profile === active && profile === selectedPair) renderState(entry);
    }
  });
  document.addEventListener('relay:state', event => selected(event.detail));
  if (snapshot) selected(snapshot);
})();
