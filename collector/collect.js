// Матч-центр (веб): collects the whole KHL into JSON files for the site.
//   node collector/collect.js [outDir]      (default: ./out)
// Writes index.json (standings, featured match), teams/<slug>.json (calendar, roster, stats)
// and news.json (league news tagged with clubs). GitHub Actions publishes outDir to the data branch.
const fs = require('fs');
const path = require('path');
const src = require('./sources');
const config = require('./config.json');

const OUT = path.resolve(process.argv[2] || 'out');

// Runs fn over items, a few at a time, so Sports.ru and Google aren't hit with dozens of requests at once.
async function pool(items, fn, size = 4) {
  const res = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      try { res[i] = { value: await fn(items[i]) }; } catch (error) { res[i] = { error }; }
    }
  }));
  return res;
}

const write = (rel, obj) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
};
const read = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(OUT, rel), 'utf8')); } catch { return null; } };

(async () => {
  const t0 = Date.now();
  const errors = [];
  const table = await src.standings(); // without the table there is nothing to build: fail the run
  const teams = table.map((t) => ({ slug: t.slug, name: t.name }));

  // Per club: a failed page keeps the previous file (if outDir holds the last run's data).
  const clubs = await pool(teams, async (t) => {
    const prev = read(`teams/${t.slug}.json`) || {};
    const part = async (what, fn) => {
      try { return await fn(t.slug); } catch (e) { errors.push(`${t.name}, ${what}: ${e.message}`); return null; }
    };
    const cal = await part('календарь', src.calendar);
    const club = {
      slug: t.slug, name: t.name,
      info: cal?.info || prev.info || {}, games: cal?.games || prev.games || [],
      roster: (await part('состав', src.roster)) || prev.roster || [],
      stats: (await part('статистика', src.stats)) || prev.stats || [],
    };
    write(`teams/${t.slug}.json`, club);
    return club;
  }, 3);

  // Games in the next three days get their own news search ("ЦСКА Трактор хоккей").
  const soon = new Map();
  const horizon = Date.now() + 3 * 864e5;
  for (const r of clubs) {
    const c = r.value;
    for (const g of c?.games || []) {
      const at = +new Date(g.iso);
      if (g.played || at < Date.now() - 3 * 36e5 || at > horizon || !g.oppSlug) continue;
      const [home, away] = g.home ? [c.slug, g.oppSlug] : [g.oppSlug, c.slug];
      const name = (s) => teams.find((x) => x.slug === s)?.name || s;
      soon.set(`${home}-${away}-${g.iso}`, { a: name(home), b: name(away) });
    }
  }
  const news = await src.news(teams, [...soon.values()], (items, fn) => pool(items, fn, 3));
  errors.push(...news.errors.map((e) => `Новости — ${e}`));
  const prevNews = read('news.json');
  write('news.json', { updated: Date.now(), items: news.items.length ? news.items : prevNews?.items || [] });

  write('index.json', { updated: Date.now(), featured: config.featured, standings: table, errors });
  console.log(`${teams.length} клубов, ${news.items.length} новостей, ${soon.size} матчей впереди, ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  if (errors.length) console.log(`Не удалось (${errors.length}):\n  ${errors.join('\n  ')}`);
})().catch((e) => { console.error(e); process.exit(1); });
