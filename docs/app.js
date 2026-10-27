// Матч-центр (веб): the page. Reads the JSON files that the collector (GitHub Actions) publishes
// to the data branch, keeps the last result in localStorage so it opens instantly and works offline.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Locally (npm run serve) the collector's output is served from data/; on the site it comes from the data branch.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:';
const DATA = LOCAL ? 'data/' : 'https://raw.githubusercontent.com/Kotoryy/hockey/data/';
const REFRESH_MIN = 5; // the collector runs every 20 minutes; checking more often only costs a small request

// The pair comes from the address (#cska-traktor), so a link opens the same match.
const fromHash = () => { const m = location.hash.match(/^#([a-z0-9-]+?)--([a-z0-9-]+)$/); return m ? { a: m[1], b: m[2] } : null; };
let pair = fromHash() || store.get('matchcenter.pair', null);
let data = pair ? store.get(`matchcenter.data.${pair.a}--${pair.b}`, null) : null;
const ui = { newsFilter: 'all', search: '' };

const logoImg = (team, cls = '') => (team?.logo ? `<img class="logo ${cls}" src="${esc(cls === 'sm' ? team.logo : team.logoBig || team.logo)}" alt="">` : '');
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };

// Moscow time regardless of the computer's time zone: KHL schedules are in MSK.
function msk(iso) {
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { day: +p.day, month: MONTHS[+p.month - 1], weekday: p.weekday, time: `${p.hour}:${p.minute}` };
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- loading ----------
async function getJSON(name) {
  const res = await fetch(`${DATA}${name}?v=${Math.floor(Date.now() / 60e3)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${name}: сервер ответил ${res.status}`);
  return res.json();
}

let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  const btn = $('#refresh');
  btn.classList.add('spin');
  const errors = [];
  try {
    const index = await getJSON('index.json');
    if (!pair) pair = index.featured;
    const table = index.standings;
    const [clubA, clubB, news] = await Promise.all([getJSON(`teams/${pair.a}.json`), getJSON(`teams/${pair.b}.json`), getJSON('news.json')]);
    data = {
      at: index.updated, table,
      teamA: table.find((t) => t.slug === pair.a), teamB: table.find((t) => t.slug === pair.b),
      calA: { info: clubA.info, games: clubA.games }, calB: { info: clubB.info, games: clubB.games },
      rosA: clubA.roster, rosB: clubB.roster, stA: clubA.stats, stB: clubB.stats,
      // The league file has every club; keep this pair's news in the old home/away tags.
      news: news.items.filter((n) => n.teams.includes(pair.a) || n.teams.includes(pair.b)).map((n) => ({
        ...n, tags: [...(n.teams.includes(pair.a) ? ['home'] : []), ...(n.teams.includes(pair.b) ? ['away'] : []), ...(n.bets ? ['bets'] : [])],
      })),
    };
    store.set(`matchcenter.data.${pair.a}--${pair.b}`, { ...data, news: data.news.slice(0, 250) });
    if (Date.now() - index.updated > 3 * 36e5) errors.push(`Данные давно не обновлялись (последний раз ${ago(index.updated)}).`);
  } catch (e) {
    errors.push(navigator.onLine === false ? 'Нет интернета.' : `Не удалось загрузить данные: ${e.message}.`);
  } finally {
    loading = false;
    btn.classList.remove('spin');
    showErrors(errors);
    render();
  }
}

function showErrors(list) {
  const el = $('#errors');
  el.hidden = !list.length;
  el.innerHTML = list.length
    ? `${list.map(esc).join('<br>')}${data ? ' Показаны последние сохранённые данные.' : ''}`
    : '';
}

// ---------- derived ----------
function nextMatch() {
  const games = data?.calA?.games || [];
  const now = Date.now() - 3 * 3600e3; // still "the match" for three hours after the face-off
  return games.find((g) => g.oppSlug === pair.b && !g.played && +new Date(g.iso) > now) || null;
}
const totalWins = (t) => t.win + t.otWin;
const played = (cal) => (cal?.games || []).filter((g) => g.played);
const upcoming = (cal) => (cal?.games || []).filter((g) => !g.played && +new Date(g.iso) > Date.now() - 3 * 3600e3);
function playersOf(ros, st) {
  const byName = new Map((st || []).map((p) => [p.name, p]));
  return (ros || []).map((p) => ({ ...p, s: byName.get(p.name) || null }));
}

// ---------- render ----------
function render() {
  if (!data) { $('#tab-match').innerHTML = '<div class="skeleton">Загружаю новости и статистику…</div>'; return; }
  document.title = `${data.teamA?.name || pair.a} — ${data.teamB?.name || pair.b} · Матч-центр`;
  $('#updated').textContent = `обновлено ${ago(data.at)}`;
  renderMatch();
  renderNews();
  renderTeams();
  renderTable();
  renderCalendar();
}

function renderMatch() {
  const A = data.teamA || { name: pair.a }, B = data.teamB || { name: pair.b };
  const g = nextMatch();
  // The hero shows the host on the left.
  const [L, R] = g && !g.home ? [B, A] : [A, B];
  let center = '<div class="muted">Ближайший матч этих команд не найден в календаре</div>';
  if (g) {
    const t = msk(g.iso);
    const ms = +new Date(g.iso) - Date.now();
    let count;
    if (ms > 0) {
      const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
      count = `<span class="count">через ${d ? `${d} ${plural(d, 'день', 'дня', 'дней')} ` : ''}${h} ч ${m} мин</span>`;
    } else count = '<span class="count live">Матч идёт</span>';
    center = `<div class="when">${t.time}</div>
      <div class="day">${t.day} ${t.month}, ${t.weekday}</div>
      <div class="meta">МСК · ${esc(g.tournament)}${g.arena ? ` · ${esc(g.arena)}` : ''}</div>
      ${count}
      <div class="meta">${g.url ? `<a href="${esc(g.url)}" target="_blank">Страница матча на Sports.ru ↗</a>` : ''}</div>`;
  }
  const info = (T) => (T === A ? data.calA?.info : data.calB?.info) || {};
  const side = (T, cls) => `<div class="side ${cls}">${logoImg(T)}<div>
      <h2>${esc(T.name)}</h2>
      <div class="muted">${esc(info(T).city || '')}</div>
      ${T.conf ? `<div class="place"><b>${T.rank} место</b> · ${esc(T.conf)} · ${T.points} ${plural(T.points, 'очко', 'очка', 'очков')}</div>` : ''}
      ${info(T).coach ? `<div class="place">Тренер: <b>${esc(info(T).coach)}</b></div>` : ''}
    </div></div>`;

  $('#tab-match').innerHTML = `
    <div class="card hero">${side(L, '')}<div class="center">${center}</div>${side(R, 'right')}</div>
    <div class="grid3" style="margin-top:16px">
      <div class="card">${compare(L, R)}</div>
      <div class="card">${form(L, R)}</div>
      <div class="card">${h2h(A, B)}</div>
    </div>
    <div class="grid3" style="margin-top:16px">
      <div class="card"><h3>Свежее о матче</h3><div class="news mini">${newsItems(matchNews().slice(0, 6), 'Пока нет новостей про этот матч')}</div></div>
      <div class="card">${leaders(L)}</div>
      <div class="card">${leaders(R)}</div>
    </div>`;
}

function compare(L, R) {
  if (!L.played || !R.played) return '<h3>Сравнение</h3><div class="muted">Нет данных таблицы</div>';
  const per = (t, k) => (t[k] / t.played);
  const rowsDef = [
    ['Очки', L.points, R.points, true],
    ['Победы', totalWins(L), totalWins(R), true],
    ['Поражения', L.loss + L.otLoss, R.loss + R.otLoss, false],
    ['Забито', L.gf, R.gf, true],
    ['Пропущено', L.ga, R.ga, false],
    ['Забито за игру', per(L, 'gf'), per(R, 'gf'), true, 2],
    ['Пропущено за игру', per(L, 'ga'), per(R, 'ga'), false, 2],
    ['Очков за игру', per(L, 'points'), per(R, 'points'), true, 2],
  ];
  const rowsHtml = rowsDef.map(([lbl, a, b, more, dp = 0]) => {
    const max = Math.max(a, b) || 1;
    const better = (x, y) => (x === y ? '' : (more ? x > y : x < y) ? 'better' : '');
    return `<div class="v l ${better(a, b)}">${a.toFixed(dp)}</div>
      <div class="bar l"><span style="width:${(a / max) * 100}%"></span></div>
      <div class="lbl">${lbl}</div>
      <div class="bar r"><span style="width:${(b / max) * 100}%"></span></div>
      <div class="v ${better(b, a)}">${b.toFixed(dp)}</div>`;
  }).join('');
  return `<h3>Сравнение по сезону</h3>
    <div class="cmp">
      <div class="v l">${logoImg(L, 'sm')}</div><div></div><div class="lbl">${L.played} и ${R.played} ${plural(R.played, 'игра', 'игры', 'игр')}</div><div></div><div class="v">${logoImg(R, 'sm')}</div>
      ${rowsHtml}
    </div>`;
}

function form(L, R) {
  const dots = (t) => `<div class="dots">${(t.last5 || []).map((x) => `<span class="dot ${x.res}" title="${esc(x.title)}">${x.res === 'win' ? 'В' : x.res === 'lose' ? 'П' : 'Н'}</span>`).join('')}</div>`;
  const last = (T) => {
    const cal = T.slug === pair.a ? data.calA : data.calB;
    return played(cal).slice(-5).reverse().map(gameRow).join('');
  };
  return `<h3>Форма — последние 5 матчей</h3><p class="muted" style="margin:-6px 0 6px;font-size:12px">слева направо: от старых к новым</p>
    <div class="formrow"><b>${esc(L.name)}</b>${dots(L)}</div>
    <div class="formrow"><b>${esc(R.name)}</b>${dots(R)}</div>
    <h3 style="margin-top:18px">${esc(L.name)}</h3><table class="games">${last(L)}</table>
    <h3 style="margin-top:14px">${esc(R.name)}</h3><table class="games">${last(R)}</table>`;
}

function gameRow(g) {
  const t = msk(g.iso);
  const score = g.played ? `${g.score}${g.extra ? ` ${g.extra}` : ''}` : t.time;
  return `<tr><td class="w"><i class="${g.result}"></i></td><td class="d">${t.day} ${t.month.slice(0, 3)}</td>
    <td class="o">${esc(g.opp)}<small>${g.home ? 'дома' : 'в гостях'}</small></td>
    <td class="s">${g.url ? `<a href="${esc(g.url)}" target="_blank">${esc(score)}</a>` : esc(score)}</td></tr>`;
}

function h2h(A, B) {
  const games = (data.calA?.games || []).filter((g) => g.oppSlug === pair.b);
  const list = games.map((g) => {
    const t = msk(g.iso);
    const [home, away] = g.home ? [A.name, B.name] : [B.name, A.name];
    return `<div><span>${t.day} ${t.month.slice(0, 3)} · ${esc(home)} — ${esc(away)}</span><b>${g.played ? esc(`${g.score}${g.extra ? ` ${g.extra}` : ''}`) : t.time}</b></div>`;
  }).join('');
  const done = games.filter((g) => g.played);
  const wins = done.filter((g) => g.result === 'win').length;
  return `<h3>Личные встречи в сезоне</h3>
    ${done.length ? `<p class="muted" style="margin:0 0 10px">${esc(A.name)} — ${wins} ${plural(wins, 'победа', 'победы', 'побед')} из ${done.length}</p>` : ''}
    <div class="h2h">${list || '<span class="muted">Встреч в календаре нет</span>'}</div>`;
}

function leaders(T) {
  const st = T.slug === pair.a ? data.stA : data.stB;
  const top = [...(st || [])].sort((a, b) => b.points - a.points || b.goals - a.goals).slice(0, 7);
  return `<h3>Лучшие бомбардиры · ${esc(T.name)}</h3>
    <table class="leaders"><tr><th>Игрок</th><th>И</th><th>Г</th><th>П</th><th>О</th><th>+/-</th></tr>
    ${top.map((p) => `<tr><td><span class="num">${esc(p.num)}</span>${esc(p.name)}</td><td>${p.games}</td><td>${p.goals}</td><td>${p.assists}</td>
      <td class="pts">${p.points}</td><td class="${p.plusMinus > 0 ? 'pos' : p.plusMinus < 0 ? 'neg' : ''}">${p.plusMinus > 0 ? '+' : ''}${p.plusMinus}</td></tr>`).join('')}
    </table>`;
}

// ---------- news ----------
const matchNews = () => (data.news || []).filter((n) => n.tags.includes('home') && n.tags.includes('away') && !n.tags.includes('bets'));
function newsItems(list, emptyText) {
  if (!list.length) return `<div class="empty">${emptyText}</div>`;
  const A = data.teamA?.name || pair.a, B = data.teamB?.name || pair.b;
  return list.map((n) => {
    const both = n.tags.includes('home') && n.tags.includes('away');
    const tags = both ? `<span class="tag both">${esc(A)} и ${esc(B)}</span>`
      : `${n.tags.includes('home') ? `<span class="tag home">${esc(A)}</span>` : ''}${n.tags.includes('away') ? `<span class="tag away">${esc(B)}</span>` : ''}`;
    return `<a class="item" href="${esc(n.link)}" target="_blank"><div>
        <div class="m">${tags}${n.tags.includes('bets') ? '<span class="tag bets">прогноз</span>' : ''}<span>${esc(n.source)}</span><span>· ${ago(n.date)}</span></div>
        <div class="t">${esc(n.title)}</div>${n.desc ? `<div class="d">${esc(n.desc)}</div>` : ''}
      </div>${n.image ? `<img src="${esc(n.image)}" alt="">` : ''}</a>`;
  }).join('');
}

function renderNews() {
  const all = data.news || [];
  const hideBets = $('#hide-bets').checked;
  const base = all.filter((n) => !hideBets || !n.tags.includes('bets'));
  const A = data.teamA?.name || pair.a, B = data.teamB?.name || pair.b;
  const filters = [
    ['all', 'Все', () => true],
    ['both', 'Про матч', (n) => n.tags.includes('home') && n.tags.includes('away')],
    ['home', A, (n) => n.tags.includes('home')],
    ['away', B, (n) => n.tags.includes('away')],
  ];
  $('#news-filter').innerHTML = filters.map(([k, label, f]) =>
    `<button class="chip ${ui.newsFilter === k ? 'on' : ''}" data-f="${k}">${esc(label)}<i>${base.filter(f).length}</i></button>`).join('');
  const q = ui.search.trim().toLowerCase();
  const f = filters.find((x) => x[0] === ui.newsFilter)[2];
  const list = base.filter(f).filter((n) => !q || `${n.title} ${n.desc} ${n.source}`.toLowerCase().includes(q));
  $('#news-list').innerHTML = newsItems(list, q ? 'Ничего не найдено' : 'Новостей пока нет');
  $('#news-count').textContent = base.length || '';
}
$('#news-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (b) { ui.newsFilter = b.dataset.f; renderNews(); }
});
$('#hide-bets').addEventListener('change', renderNews);
$('#news-search').addEventListener('input', (e) => { ui.search = e.target.value; renderNews(); });

// ---------- rosters ----------
function renderTeams() {
  const col = (T, ros, st, cal) => {
    const players = playersOf(ros, st);
    const groups = [['вратарь', 'Вратари'], ['защитник', 'Защитники'], ['нападающий', 'Нападающие']];
    const sign = (v) => (v > 0 ? `<span class="pos">+${v}</span>` : v < 0 ? `<span class="neg">${v}</span>` : '0');
    const tables = groups.map(([role, title]) => {
      const list = players.filter((p) => p.role === role).sort((a, b) => (b.s?.points ?? -1) - (a.s?.points ?? -1) || (b.s?.games ?? 0) - (a.s?.games ?? 0));
      if (!list.length) return '';
      const goalie = role === 'вратарь';
      return `<div class="scroll-x"><table class="roster"><caption>${title} · ${list.length}</caption>
        <tr><th>№</th><th>Игрок</th><th>Возр.</th><th>Рост</th>${goalie ? '' : '<th>И</th><th>Г</th><th>П</th><th>О</th><th>+/-</th><th>Время</th>'}</tr>
        ${list.map((p) => `<tr><td>${esc(p.num)}</td>
          <td>${p.url ? `<a href="${esc(p.url)}" target="_blank">${esc(p.name)}</a>` : esc(p.name)}${p.country && p.country !== 'Россия' ? ` <span class="muted">· ${esc(p.country)}</span>` : ''}</td>
          <td>${esc(p.age)}</td><td>${esc(p.height)}</td>
          ${goalie ? ''
            : p.s ? `<td>${p.s.games}</td><td>${p.s.goals}</td><td>${p.s.assists}</td><td class="pts">${p.s.points}</td><td>${sign(p.s.plusMinus)}</td><td>${esc(p.s.toi)}</td>`
              : '<td>—</td><td></td><td></td><td></td><td></td><td></td>'}
        </tr>`).join('')}</table></div>`;
    }).join('');
    return `<div class="card"><div class="teamhead">${logoImg(T, 'md')}<div><h2>${esc(T.name)}</h2>
      <div class="muted">${esc(cal?.info?.city || '')}${cal?.info?.coach ? ` · тренер ${esc(cal.info.coach)}` : ''} · ${players.length} ${plural(players.length, 'игрок', 'игрока', 'игроков')} в заявке</div></div></div>
      ${tables || '<div class="muted">Состав не загрузился</div>'}</div>`;
  };
  $('#tab-teams').innerHTML = `<div class="grid2">
    ${col(data.teamA || { name: pair.a }, data.rosA, data.stA, data.calA)}
    ${col(data.teamB || { name: pair.b }, data.rosB, data.stB, data.calB)}</div>`;
}

// ---------- standings ----------
function renderTable() {
  if (!data.table?.length) { $('#tab-table').innerHTML = '<div class="empty">Таблица не загрузилась</div>'; return; }
  const confs = [...new Set(data.table.map((t) => t.conf))];
  $('#tab-table').innerHTML = `<div class="grid2">${confs.map((c) => {
    const list = data.table.filter((t) => t.conf === c);
    return `<div class="card"><h3>Конференция «${esc(c)}»</h3><div class="scroll-x"><table class="standings">
      <tr><th>#</th><th>Команда</th><th>Форма</th><th>И</th><th>В</th><th>ВО</th><th>П</th><th>ПО</th><th>Шайбы</th><th>О</th></tr>
      ${list.map((t) => `<tr class="${t.rank === 9 ? 'cut' : ''} ${t.slug === pair.a ? 'me-home' : t.slug === pair.b ? 'me-away' : ''}">
        <td>${t.rank}</td><td>${logoImg(t, 'sm')} ${esc(t.name)}</td>
        <td><span class="mini-dots">${t.last5.map((x) => `<i class="${x.res}" title="${esc(x.title)}"></i>`).join('')}</span></td>
        <td>${t.played}</td><td>${t.win}</td><td>${t.otWin}</td><td>${t.loss}</td><td>${t.otLoss}</td>
        <td>${t.gf}–${t.ga}</td><td class="p">${t.points}</td></tr>`).join('')}
      </table></div><p class="muted" style="font-size:12px;margin:10px 0 0">Пунктир — граница зоны плей-офф (8 команд от конференции).</p></div>`;
  }).join('')}</div>`;
}

// ---------- calendar ----------
function renderCalendar() {
  const col = (T, cal) => `<div class="card"><div class="teamhead">${logoImg(T, 'md')}<h2>${esc(T.name)}</h2></div>
    <h3>Ближайшие матчи</h3><table class="games">${upcoming(cal).slice(0, 6).map(gameRow).join('') || '<tr><td class="muted">нет</td></tr>'}</table>
    <h3 style="margin-top:18px">Последние результаты</h3><table class="games">${played(cal).slice(-12).reverse().map(gameRow).join('') || '<tr><td class="muted">нет</td></tr>'}</table></div>`;
  $('#tab-calendar').innerHTML = `<div class="grid2">${col(data.teamA || { name: pair.a }, data.calA)}${col(data.teamB || { name: pair.b }, data.calB)}</div>`;
}

// News pictures from third-party sites often 404; inline onerror is blocked by the CSP.
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG' && e.target.closest('.item')) e.target.remove(); }, true);

// ---------- tabs, picker, timers ----------
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === `tab-${b.dataset.tab}`));
  store.set('matchcenter.tab', b.dataset.tab);
  b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // the tab strip scrolls sideways on phones
});
const savedTab = store.get('matchcenter.tab', 'match');
document.querySelector(`[data-tab="${savedTab}"]`)?.click();

$('#refresh').addEventListener('click', load);
$('#pick').addEventListener('click', () => {
  const teams = [...(data?.table || [])].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const opts = (sel) => teams.map((t) => `<option value="${esc(t.slug)}" ${t.slug === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  $('#pick-a').innerHTML = opts(pair.a);
  $('#pick-b').innerHTML = opts(pair.b);
  $('#picker').showModal();
});
$('#picker').addEventListener('close', () => {
  if ($('#picker').returnValue !== 'ok') return;
  const a = $('#pick-a').value, b = $('#pick-b').value;
  if (!a || !b || a === b || (a === pair.a && b === pair.b)) return;
  location.hash = `${a}--${b}`; // hashchange does the rest
});
window.addEventListener('hashchange', () => {
  const p = fromHash();
  if (!p || (pair && p.a === pair.a && p.b === pair.b)) return;
  pair = p;
  store.set('matchcenter.pair', pair);
  data = store.get(`matchcenter.data.${pair.a}--${pair.b}`, null);
  render();
  load();
});

$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]').content = next === 'light' ? '#f3f5fa' : '#070c18';
  try { localStorage.setItem('matchcenter.theme', next); } catch {}
});
if (document.documentElement.dataset.theme === 'light') document.querySelector('meta[name="theme-color"]').content = '#f3f5fa';

if (pair) store.set('matchcenter.pair', pair);
render();
load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MIN * 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden && data && Date.now() - data.at > REFRESH_MIN * 60e3) load(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
setInterval(() => { if (data) { renderMatch(); $('#updated').textContent = `обновлено ${ago(data.at)}`; } }, 30e3);
