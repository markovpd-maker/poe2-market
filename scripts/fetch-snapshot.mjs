// Снимает текущие рыночные данные с api.poe2scout.com и кладёт их в data.json.
// Запускается на сервере (GitHub Actions), поэтому CORS тут ни при чём —
// это не браузерный fetch, а обычный серверный запрос.
//
// Локальный запуск: node scripts/fetch-snapshot.mjs

const API_ROOT = 'https://api.poe2scout.com';
const OUT_PATH = new URL('../data.json', import.meta.url);

// realm -> { emoji, game } — только для логов, на структуру данных не влияет
const REALMS = ['poe2', 'pc'];

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'poe2-market-snapshot/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      console.warn(`  попытка ${i + 1}/${tries} для ${url} — ${e.message}`);
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 1500));
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

function pickCurrentLeague(leagues) {
  return leagues.find(l => l.IsCurrent && !/^HC /i.test(l.Value))
      || leagues.find(l => l.IsCurrent)
      || leagues[0];
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

async function snapshotRealm(realm, fallbackLeagueGuess) {
  console.log(`\n== ${realm} ==`);
  const leagues = await fetchLeagues(realm);
  const league = pickCurrentLeague(leagues)?.Value || fallbackLeagueGuess;
  if (!league) throw new Error(`нет текущей лиги для ${realm} (список лиг недоступен, и прошлого снимка тоже нет)`);
  console.log(`  лига: ${league}${leagues.length ? '' : ' (список лиг недоступен — взял из прошлого снимка)'}`);

  const categoriesResp = await fetchCategoriesResp(realm, league);
  const cats     = (categoriesResp?.CurrencyCategories || []).map(c => c.ApiId);
  const uniqCats = (categoriesResp?.UniqueCategories   || []).map(c => c.ApiId);
  console.log(`  категорий валюты: ${cats.length}, уникалов: ${uniqCats.length}`);

  const byCategory = {};
  for (const cat of cats) {
    byCategory[cat] = await fetchCurrencyCategory(realm, league, cat);
    await new Promise(r => setTimeout(r, 150)); // не долбим API без пауз
  }

  const uniques = [];
  for (const cat of uniqCats) {
    const items = await fetchUniqueCategory(realm, league, cat);
    items.forEach(u => { if (u?.CurrentPrice > 0) { u.CategoryApiId = u.CategoryApiId || cat; uniques.push(u); } });
    await new Promise(r => setTimeout(r, 150));
  }

  return {
    key: `${realm}|${league}`,
    snapshot: {
      savedAt: new Date().toISOString(),
      cats, uniqCats, byCategory, uniques, categoriesResp,
    },
  };
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
      const prevKey = Object.keys(snapshots).find(k => k.startsWith(realm + '|'));
      const prevLeagueGuess = prevKey ? prevKey.slice(realm.length + 1) : undefined;
      const { key, snapshot } = await snapshotRealm(realm, prevLeagueGuess);
      // старые лиги этого реалма больше не актуальны (лига закончилась) — убираем,
      // иначе loadSnapshotData на клиенте может случайно подхватить протухший ключ
      Object.keys(snapshots).forEach(k => { if (k.startsWith(realm + '|') && k !== key) delete snapshots[k]; });
      snapshots[key] = snapshot;
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
  console.log(`\nГотово: ${okCount}/${REALMS.length} реалмов обновлено, data.json записан.`);
}

main().catch(e => { console.error(e); process.exit(1); });
