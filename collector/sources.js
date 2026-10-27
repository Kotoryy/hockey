// Матч-центр (веб): data sources for the collector that GitHub Actions runs on a schedule.
// Plain Node https, no dependencies; everything is parsed into small JSON objects for the site. Sports.ru gives the standings, calendars,
// rosters and player stats; news come from RSS feeds of Russian sports media and Google News.
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36';
const SPORTS = 'https://www.sports.ru';

// One request per fresh connection, with redirects and a hard timeout.
function get(url, redirects = 4) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { agent: false, timeout: 25000, headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, redirects - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${new URL(url).hostname} ответил ${res.statusCode}`));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${new URL(url).hostname}: нет ответа (таймаут)`)));
    req.on('error', (err) => reject(new Error(`${new URL(url).hostname}: ${err.code || err.message}`)));
  });
}

// ---------- html helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', laquo: '«', raquo: '»', hellip: '…' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ENT[e.toLowerCase()] ?? m;
  });
}
const text = (s) => decode(String(s).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const tables = (html) => html.match(/<table[\s\S]*?<\/table>/g) || [];
const rows = (table) => table.match(/<tr[\s\S]*?<\/tr>/g) || [];
const cells = (row) => (row.match(/<td[\s\S]*?(?=<td|<\/tr>)/g) || []);
const attr = (s, name) => (s.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
const abs = (u) => (u && u.startsWith('/') ? SPORTS + u : u);
const slugOf = (href) => ((href || '').match(/\/hockey\/club\/([^/]+)\//) || [])[1];

// Club header: the first table on every club page ("Страна", "Тренер").
function clubInfo(html) {
  const info = {};
  for (const r of rows(tables(html)[0] || '')) {
    const k = text((r.match(/<th[\s\S]*?<\/th>/) || [''])[0]);
    const v = text((r.match(/<td[\s\S]*?<\/td>/) || [''])[0]);
    if (k) info[k] = v;
  }
  return { city: info['Страна'] || '', coach: info['Тренер'] || '' };
}

// ---------- standings ----------
async function standings() {
  const html = await get(`${SPORTS}/hockey/tournament/khl/table/`);
  // Image addresses are signed per size, so a big logo can't be made from the small one;
  // the page carries larger copies of the same pictures elsewhere — match them by file path.
  const big = {};
  for (const m of html.matchAll(/https:\/\/pictures\.cdn\.sports\.ru\/[\w-]+\/fill\/(\d+)\/\d+\/no\/1\/([\w-]+)\.(?:png|webp)/g)) {
    const size = +m[1];
    if (size >= 128 && (!big[m[2]] || big[m[2]].size < size)) big[m[2]] = { size, url: m[0] };
  }
  const out = [];
  for (const t of tables(html)) {
    const conf = (text(t).match(/Турнирная таблица — (\S+)/) || [])[1];
    if (!conf) continue;
    for (const r of rows(t)) {
      if (!/data-testid="stat-table-row"/.test(r)) continue;
      const col = {};
      for (const m of r.matchAll(/<td[^>]*data-col="(\w+)"[^>]*>([\s\S]*?)<\/td>/g)) col[m[1]] = m[2];
      const link = (col.teamName || '').match(/href="([^"]+)"/);
      const logo = (col.teamName || '').match(/<img src="([^"]+)"/);
      const last5 = [...r.matchAll(/last-five-cell__match--(\w+)" title="([^"]*)"/g)].map((m) => ({ res: m[1], title: decode(m[2]) }));
      const n = (k) => +text(col[k] || '0').replace('+', '') || 0;
      out.push({
        conf, slug: slugOf(link && link[1]), name: text(col.teamName || ''), logo: logo ? logo[1] : '',
        logoBig: (logo && big[(logo[1].match(/\/no\/1\/([\w-]+)\./) || [])[1]]?.url) || (logo ? logo[1] : ''),
        rank: n('rank'), played: n('played'), win: n('win'), otWin: n('overtimeWins'), loss: n('loss'), otLoss: n('overtimeLosses'),
        gf: n('goalsFor'), ga: n('goalsAgainst'), gd: n('goalDiff'), points: n('points'), last5,
      });
    }
  }
  if (!out.length) throw new Error('Sports.ru: не удалось разобрать турнирную таблицу');
  return out;
}

// "б 4 : 3" / "3 : 4 от" → { score: '4:3', extra: 'Б' }: shootout and overtime marks.
function scoreOf(s) {
  const m = s.match(/(\d+)\s*:\s*(\d+)/);
  if (!m) return { score: '', extra: '', played: false };
  return { score: `${m[1]}:${m[2]}`, extra: /от/i.test(s) ? 'ОТ' : /б/i.test(s) ? 'Б' : '', played: true };
}

// ---------- calendar ----------
// Score in the calendar is always home : away; the dot colour tells the result for this club.
async function calendar(slug) {
  const html = await get(`${SPORTS}/hockey/club/${slug}/calendar/`);
  const t = tables(html).find((x) => /Соперник/.test(x));
  if (!t) throw new Error('Sports.ru: не найден календарь');
  const games = [];
  for (const r of rows(t).slice(1)) {
    const c = cells(r);
    if (c.length < 5) continue;
    const [d, time] = text(c[0]).split('|').map((s) => s.trim());
    const [dd, mm, yy] = d.split('.');
    const iso = (r.match(/itemprop="startDate" content="([^"]+)"/) || [])[1] || `${yy}-${mm}-${dd}T${time || '00:00'}:00+03:00`;
    const oppA = c[2].match(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/);
    const place = text((r.match(/<td class="alRight padR20">([^<]*)<\/td>/) || [])[1] || '');
    const scoreCell = r.match(/class="score-td">([\s\S]*?)<\/td>/);
    const score = scoreCell ? text(scoreCell[1].replace(/<meta[^>]*>/g, '')) : '';
    const dot = (r.match(/class="dot (\w+)-dot"/) || [])[1];
    const arena = (r.match(/itemprop="location"[\s\S]*?itemprop="name" content="([^"]+)"/) || [])[1];
    const matchHref = (r.match(/class="(?:score|dot \w+-dot)" href="([^"]+)"/) || [])[1];
    games.push({
      iso, date: d, time: time || '', tournament: text(c[1]),
      opp: oppA ? decode(oppA[2]) : '', oppSlug: slugOf(oppA && oppA[1]), home: place === 'Дома',
      ...scoreOf(score),
      result: dot === 'gr' ? 'win' : dot === 'rd' ? 'loss' : '', url: abs(matchHref),
      crowd: text(c[c.length - 1]), arena: arena ? decode(arena) : '',
    });
  }
  return { info: clubInfo(html), games };
}

// ---------- roster + player stats ----------
async function roster(slug) {
  const html = await get(`${SPORTS}/hockey/club/${slug}/team/`);
  const t = tables(html).find((x) => /Амплуа/.test(x));
  if (!t) throw new Error('Sports.ru: не найден состав');
  return rows(t).slice(1).map((r) => {
    const c = cells(r).map(text);
    const a = r.match(/href="([^"]+\/person\/[^"]+)"/);
    return { num: c[0], name: c[1], url: a ? a[1] : '', country: decode(attr(r, 'title') || ''), age: c[2], height: c[3], weight: c[4], role: c[5] };
  }).filter((p) => p.name);
}

async function stats(slug) {
  const html = await get(`${SPORTS}/hockey/club/${slug}/stat/`);
  const t = tables(html).find((x) => /\+\/-/.test(x));
  if (!t) return [];
  return rows(t).slice(1).map((r) => {
    const c = cells(r).map(text);
    return { num: c[0], name: c[1], pos: c[2], games: +c[3] || 0, goals: +c[4] || 0, assists: +c[5] || 0, points: +c[6] || 0,
      plusMinus: +c[7] || 0, pim: +c[8] || 0, toi: c[9] || '' };
  }).filter((p) => p.name);
}

// ---------- news ----------
// Collected once for the whole league: general hockey feeds plus Google News per club and per
// upcoming game, then every item is tagged with the clubs it mentions.
const FEEDS = [
  { name: 'Чемпионат', url: 'https://www.championat.com/rss/news/hockey/' },
  { name: 'Sports.ru', url: 'https://www.sports.ru/rss/rubric.xml?s=209' },
  { name: 'Спорт-Экспресс', url: 'https://www.sport-express.ru/services/materials/news/hockey/se/' },
];
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ru&gl=RU&ceid=RU:ru`;

function parseRss(xml, source) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const it = m[0];
    const tag = (n) => {
      const x = it.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`));
      return x ? x[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1') : '';
    };
    let title = text(tag('title'));
    let src = source;
    const gsrc = it.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    if (gsrc) { src = text(gsrc[1]); title = title.replace(new RegExp(`\\s+-\\s+${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''); }
    const encl = it.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/) || it.match(/<media:content[^>]*url="([^"]+)"/);
    const desc = gsrc ? '' : text(tag('description')).slice(0, 260);
    const date = new Date(text(tag('pubDate')) || Date.now());
    items.push({ title, link: text(tag('link')) || text(tag('guid')), date: isNaN(date) ? Date.now() : +date, source: src, desc, image: encl ? decode(encl[1]) : '' });
  }
  return items;
}

// Word-stem patterns per club (Sports.ru names). Unknown clubs fall back to their first word.
const PATTERNS = {
  'ЦСКА': 'ЦСКА|армейц(?!ы Петербурга)', 'СКА': '(?<![А-ЯЁ])СКА(?![А-ЯЁ])', 'Спартак': 'Спартак|красно-бел',
  'Динамо Москва': '(?<!минск\\S{0,4}\\s«?)Динамо»?(?!»?\\s*\\(?Минск)|динамовц|бело-голуб', 'Динамо Минск': 'Динамо»?\\s*\\(?Минск|минчан|минско\\S* «?Динамо',
  'Локомотив': 'Локомотив|ярославц|железнодорожник', 'Северсталь': 'Северстал|череповчан', 'Торпедо': 'Торпедо|нижегородц',
  'Шанхай Дрэгонс': 'Шанха\\S* Др[эе]гонс|Шанхайски\\S* драконы|драконов', 'Сочи': 'ХК «?Сочи|ХК Сочи|«Сочи»|сочинц', 'Лада': '«Лад[аеуыо]»|Лада(?! Веста)|тольяттинц',
  'Металлург Мг': 'Металлург|магнитогорц|Магнитк', 'Нефтехимик': 'Нефтехимик|нижнекамц', 'Ак Барс': 'Ак Барс|казанц',
  'Амур': '«Амур|Амур»|хабаровчан', 'Барыс': 'Барыс|астанчан', 'Салават Юлаев': 'Салават|уфимц', 'Автомобилист': 'Автомобилист|екатеринбуржц',
  'Адмирал': 'Адмирал|владивостокц', 'Трактор': 'Трактор|челябинц', 'Авангард': 'Авангард|омич', 'Сибирь': '«Сибир[ьиюе]»|Сибирь»|новосибирц',
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patternFor = (name) => new RegExp(PATTERNS[name] || esc(name.split(' ')[0]), 'i');

// Same club names are used in basketball and football; betting previews flood the search.
const OTHER_SPORT = /ПБК|баскетбол|Единая лига|ВТБ|футбол|РПЛ|волейбол|гандбол/i;
const BETTING = /прогноз|(?<![а-яё])став(?:к|ок)|коэффициент|букмекер|кэф/i;

// teams: [{ slug, name }]; games: [{ a, b }] names of games in the next days.
async function news(teams, games, pool) {
  const reqs = [
    ...FEEDS,
    ...teams.map((t) => ({ name: 'Google Новости', url: gnews(`${t.name} КХЛ`) })),
    ...games.map((g) => ({ name: 'Google Новости', url: gnews(`${g.a} ${g.b} хоккей`) })),
  ];
  const pats = teams.map((t) => [t.slug, patternFor(t.name)]);
  const results = await pool(reqs, (r) => get(r.url).then((x) => parseRss(x, r.name)));
  const seen = new Set();
  const items = [];
  const errors = [];
  const since = Date.now() - 14 * 864e5;
  results.forEach((res, i) => {
    if (res.error) { errors.push(`${reqs[i].name}: ${res.error.message}`); return; }
    for (const it of res.value) {
      if (it.date < since) continue;
      const hay = `${it.title} ${it.desc}`;
      const tags = pats.filter(([, re]) => re.test(hay)).map(([slug]) => slug);
      if (!tags.length) continue; // general hockey feeds, and Google results that only matched loosely
      if (OTHER_SPORT.test(`${hay} ${it.source}`) && !/хокке|КХЛ|шайб/i.test(hay)) continue;
      const key = it.title.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '').slice(0, 70);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...it, teams: tags, bets: BETTING.test(`${hay} ${it.source}`) || undefined });
    }
  });
  items.sort((a, b) => b.date - a.date);
  return { items, errors };
}

module.exports = { standings, calendar, roster, stats, news };
