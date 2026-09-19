// Снимает текущие рыночные данные с api.poe2scout.com и кладёт их в data.json.
// Запускается на сервере (GitHub Actions), поэтому CORS тут ни при чём —
// это не браузерный fetch, а обычный серверный запрос.
//
// Снимаются ВСЕ активные лиги реалма (то, что API помечает IsCurrent) — на практике
// это обычно ровно SC + HC текущего сезона. Постоянные лиги (Standard/Hardcore) и
// закончившиеся сезоны не трогаем — это не «активные», а вечные/архивные лиги.
//
// Локальный запуск: node scripts/fetch-snapshot.mjs

const API_ROOT = 'https://api.poe2scout.com';
const OUT_PATH = new URL('../data.json', import.meta.url);
const REALMS = ['poe2', 'pc'];

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000); // без этого зависший запрос может держать job часами
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'poe2-market-snapshot/1.0' }, signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'таймаут 15с' : e.message;
      console.warn(`  попытка ${i + 1}/${tries} для ${url} — ${msg}`);
      if (i === tries - 1) throw new Error(msg);
      await new Promise(r => setTimeout(r, 1500));
    } finally {
      clearTimeout(t);
    }
  }
}

// Список лиг у нового API — путь пробовался вслепую и в браузере несколько
// вариантов отвечали 404, поэтому здесь тоже перебор кандидатов. Если ни один
// не сработал — не падаем, просто возвращаем пустой список (см. вызывающий код).
async function fetchLeagues(realm) {
  const candidates = [
    `${API_ROOT}/${realm}/Leagues`,
    `${API_ROOT}/${realm}/leagues`,
    `${API_ROOT}/leagues?realm=${realm}`,
    `${API_ROOT}/Leagues?realm=${realm}`,
  ];
  for (const url of candidates) {
    try {
      const d = await getJson(url, 1);
      const arr = Array.isArray(d) ? d : (Array.isArray(d?.Leagues) ? d.Leagues : (Array.isArray(d?.Items) ? d.Items : []));
      if (arr.length) { console.log(`  лиги ${realm}: OK через ${url}`); return arr; }
    } catch { /* пробуем следующий */ }
  }
  console.warn(`  не удалось получить список лиг для ${realm} ни по одному из путей`);
  return [];
}

function isPermanent(name) {
  // постоянные лиги (никогда не заканчиваются, не участвуют в сезонной ротации)
  return /^(standard|hardcore|ssf standard|ssf hardcore)$/i.test((name || '').trim());
}
function isHC(name) { return /^HC /i.test(name || ''); }

// «Активные» — всё, что API помечает IsCurrent (обычно SC + HC текущего сезона).
// Постоянные лиги исключаем: они всегда «текущие» по факту существования, но это
// не то, что имеется в виду под «активной лигой сезона».
function pickActiveLeagues(leagues) {
  const active = leagues.filter(l => l.IsCurrent && l.Value && !isPermanent(l.Value));
  if (active.length) return active;
  return leagues[0] ? [leagues[0]] : []; // совсем крайний случай — хоть что-то
}

async function fetchCategoriesResp(realm, league) {
  return await getJson(`${API_ROOT}/${realm}/Leagues/${encodeURIComponent(league)}/Items/Categories`);
}
async function fetchCurrencyCategory(realm, league, cat) {
  const d = await getJson(`${API_ROOT}/${realm}/Leagues/${encodeURIComponent(league)}/Currencies/ByCategory?Category=${encodeURIComponent(cat)}&Page=1&PerPage=250`);
  return Array.isArray(d?.Items) ? d.Items : [];
}
async function fetchUniqueCategory(realm, league, cat) {
  const d = await getJson(`${API_ROOT}/${realm}/Leagues/${encodeURIComponent(league)}/Uniques/ByCategory?Category=${encodeURIComponent(cat)}&Page=1&PerPage=100`);
  return Array.isArray(d?.Items) ? d.Items : [];
}

async function snapshotLeague(realm, league, tag) {
  console.log(`  -- ${tag}: ${league}`);
  const categoriesResp = await fetchCategoriesResp(realm, league);
  const cats     = (categoriesResp?.CurrencyCategories || []).map(c => c.ApiId);
  const uniqCats = (categoriesResp?.UniqueCategories   || []).map(c => c.ApiId);
  console.log(`     категорий валюты: ${cats.length}, уникалов: ${uniqCats.length}`);

  const byCategory = {};
  for (const cat of cats) {
    try {
      byCategory[cat] = await fetchCurrencyCategory(realm, league, cat);
    } catch (e) {
      console.warn(`     категория «${cat}» не снялась: ${e.message} — пропускаю, остальные категории продолжаю`);
      byCategory[cat] = [];
    }
    await new Promise(r => setTimeout(r, 150)); // не долбим API без пауз
  }

  const uniques = [];
  for (const cat of uniqCats) {
    let items = [];
    try {
      items = await fetchUniqueCategory(realm, league, cat);
    } catch (e) {
      console.warn(`     уникалы «${cat}» не снялись: ${e.message} — пропускаю`);
    }
    items.forEach(u => { if (u?.CurrentPrice > 0) { u.CategoryApiId = u.CategoryApiId || cat; uniques.push(u); } });
    await new Promise(r => setTimeout(r, 150));
  }

  return {
    key: `${realm}|${league}`,
    snapshot: { savedAt: new Date().toISOString(), cats, uniqCats, byCategory, uniques, categoriesResp },
  };
}

// Возвращает МАССИВ снимков — по одному на каждую активную лигу реалма (SC, HC, ...).
async function snapshotRealm(realm, fallbackLeagueNames) {
  console.log(`\n== ${realm} ==`);
  const leagues = await fetchLeagues(realm);

  let names = [], note = '';
  if (leagues.length) names = pickActiveLeagues(leagues).map(l => l.Value);
  if (!names.length) {
    // список лиг недоступен целиком — работаем с тем, что уже было в кэше на прошлый раз
    names = fallbackLeagueNames || [];
    note = ' (список лиг недоступен — взял из прошлого снимка)';
  }
  if (!names.length) throw new Error(`нет активных лиг для ${realm} (ни живого списка, ни прошлого снимка)`);
  console.log(`  активные лиги: ${names.join(', ')}${note}`);

  const out = [];
  for (const name of names) {
    try {
      out.push(await snapshotLeague(realm, name, isHC(name) ? 'HC' : 'SC'));
    } catch (e) {
      console.warn(`  лига «${name}» не снялась: ${e.message} — пропускаю только её`);
    }
  }
  if (!out.length) throw new Error(`ни одна активная лига не снялась для ${realm}`);
  return out;
}

async function main() {
  const fs = await import('node:fs/promises');
  let existing = { snapshots: {} };
  try {
    existing = JSON.parse(await fs.readFile(OUT_PATH, 'utf8'));
  } catch { /* файла нет — начинаем с чистого листа */ }

  const snapshots = { ...(existing.snapshots || {}) };
  let okCount = 0;

  for (const realm of REALMS) {
    try {
      const prevNames = Object.keys(snapshots)
        .filter(k => k.startsWith(realm + '|'))
        .map(k => k.slice(realm.length + 1));

      const results = await snapshotRealm(realm, prevNames);
      const newKeys = results.map(r => r.key);

      // лиги этого реалма, которых больше нет в свежем активном наборе (сезон сменился) — убираем,
      // иначе loadSnapshotData на клиенте может подхватить протухший ключ
      Object.keys(snapshots).forEach(k => { if (k.startsWith(realm + '|') && !newKeys.includes(k)) delete snapshots[k]; });
      results.forEach(({ key, snapshot }) => { snapshots[key] = snapshot; });
      okCount++;
    } catch (e) {
      console.error(`!! ${realm} не снялся: ${e.message} — оставляю прошлый кэш этого реалма как есть`);
    }
  }

  if (okCount === 0) {
    console.error('Ни один реалм не снялся — data.json не трогаю, выходим с ошибкой.');
    process.exit(1);
  }

  await fs.writeFile(OUT_PATH, JSON.stringify({ snapshots }), 'utf8');
  console.log(`\nГотово: ${okCount}/${REALMS.length} реалмов обновлено, data.json записан (лиг всего: ${Object.keys(snapshots).length}).`);
}

main().catch(e => { console.error(e); process.exit(1); });
