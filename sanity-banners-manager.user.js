// ==UserScript==
// @name         Starter Office — менеджер баннеров (Sanity)
// @namespace    starter-office-banners
// @version      2.8.0
// @description  Модалка с превью всех баннеров, статусами, настройками показа и drag-n-drop сортировкой напрямую через Sanity Content API
// @author       you
// @match        https://my.starterapp.ru/*
// @icon         https://www.sanity.io/favicon.ico
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Gnomophile/sanity-banners/main/sanity-banners-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/Gnomophile/sanity-banners/main/sanity-banners-manager.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ==================== НАСТРОЙКИ ====================
  const DATASET = 'production';
  const API_VERSION = 'v2024-05-28';
  const DOC_TYPE = 'banner';
  const SORT_STEP = 100; // отступ от края при перемещении в самое начало/конец списка (абсолютное число не важно — важен только порядок)

  // ==================== ОПРЕДЕЛЕНИЕ ПРОЕКТА (project id) ====================
  // URL вида https://my.starterapp.ru/<project-alias>/... не содержит настоящий
  // project id Sanity. Раньше он подсматривался через перехват fetch/XHR или
  // Resource Timing API — оба способа либо ненадёжны (некоторые браузеры не
  // отдают кросс-доменные записи ресурсов), либо (перехват fetch/XHR в связке
  // с document-start) реально ломали загрузку JS-чанков самой студии.
  //
  // Правильный способ проще и безопаснее: сама студия вшивает project id прямо
  // в HTML страницы — в инлайн-скрипте есть переменная SANITY_STUDIO_API_PROJECT_ID.
  // Это просто чтение уже готового DOM, без единого дополнительного запроса и
  // без вмешательства в чужой код.

  let detectedProjectId = null;
  const PROJECT_ID_KEY_PATTERN = /SANITY_STUDIO_API_PROJECT_ID["']?\s*[:=]\s*["']([a-z0-9]+)["']/i;

  function extractProjectIdFromPage() {
    const scripts = Array.from(document.scripts || []).filter((s) => !s.src);
    for (const s of scripts) {
      const m = s.textContent.match(PROJECT_ID_KEY_PATTERN);
      if (m) return m[1];
    }
    return null;
  }

  async function waitForProjectId(timeoutMs = 8000) {
    const start = Date.now();
    while (!detectedProjectId) {
      detectedProjectId = extractProjectIdFromPage();
      if (detectedProjectId) break;
      if (Date.now() - start > timeoutMs) {
        throw new Error('Не удалось определить проект Sanity — обновите страницу студии и попробуйте снова');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return detectedProjectId;
  }

  function apiBase() {
    return `https://${detectedProjectId}.api.sanity.io/${API_VERSION}`;
  }

  // ==================== ОПРЕДЕЛЕНИЕ МАРШРУТА ====================
  // Кнопка нужна только на странице списка/карточки баннеров и глубже:
  // /<project>/structure/static-item;banners[...]

  function isBannersRoute() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 3) return false;
    if (parts[1] !== 'structure') return false;
    return parts[2].startsWith('static-item;banners');
  }

  // ==================== СЕТЕВЫЕ ЗАПРОСЫ ====================

  async function groqQuery(query) {
    await waitForProjectId();
    const url = `${apiBase()}/data/query/${DATASET}?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`GROQ ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.result;
  }

  async function mutate(mutations) {
    await waitForProjectId();
    const url = `${apiBase()}/data/mutate/${DATASET}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations }),
    });
    if (!res.ok) throw new Error(`Mutate ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // Загружаем ВСЕ баннеры (и опубликованные, и черновики) одним запросом,
  // без необходимости скроллить список в интерфейсе Sanity.
  async function fetchBanners() {
    const query = `*[_type=="${DOC_TYPE}"]{
      _id,
      title,
      status,
      showInApplication,
      showInWeb,
      sortIndex,
      "thumbH": backgroundImage.asset->url,
      "thumbV": verticalBackgroundImage.asset->url,
      "venues": shops[]->{
        "city": address.city.ru,
        "street": address.street.ru,
        "house": address.house.ru
      }
    }`;
    const raw = await groqQuery(query);

    const byBase = new Map();
    for (const doc of raw) {
      const isDraft = doc._id.startsWith('drafts.');
      const baseId = isDraft ? doc._id.slice(7) : doc._id;
      const existing = byBase.get(baseId) || {};
      if (isDraft) existing.draft = doc;
      else existing.published = doc;
      byBase.set(baseId, existing);
    }

    const banners = [];
    for (const [baseId, { draft, published }] of byBase.entries()) {
      const current = draft || published;
      banners.push({
        baseId,
        editId: current._id, // именно этот _id надо патчить
        hasDraft: !!draft,
        title: current.title || '(без названия)',
        status: !!current.status,
        showInApplication: current.showInApplication !== false,
        showInWeb: current.showInWeb !== false,
        sortIndex: typeof current.sortIndex === 'number' ? current.sortIndex : 0,
        thumbH: current.thumbH || null,
        thumbV: current.thumbV || null,
        venues: formatVenues(current.venues),
      });
    }
    banners.sort((a, b) => a.sortIndex - b.sortIndex);
    return banners;
  }

  // Пустое поле «Заведения» в Sanity означает «показывать во всех заведениях» —
  // в этом случае ничего не выводим на превью, чтобы не загромождать карточку.
  // Если заведения указаны — собираем их адреса в короткие читаемые строки.
  function formatVenues(rawVenues) {
    if (!Array.isArray(rawVenues) || !rawVenues.length) return [];
    return rawVenues
      .filter(Boolean)
      .map((v) => [v.city, v.street, v.house].filter(Boolean).map((s) => String(s).trim()).join(', '))
      .filter(Boolean);
  }

  // Все изменения из этого инструмента пишутся ТОЛЬКО в черновик (drafts.<id>),
  // опубликованный документ никогда не патчится напрямую — так публикация
  // остаётся осознанным, ручным действием в самой студии («Опубликовать»),
  // а не происходит незаметно в момент клика по превью.
  //
  // Если черновика ещё нет, перед патчем клонируем туда ПОЛНЫЙ опубликованный
  // документ (createIfNotExists), чтобы не потерять остальные поля баннера —
  // и только затем применяем нужные изменения (set) к этому черновику.

  function cloneForDraft(fullDoc, draftId) {
    const clone = { ...fullDoc, _id: draftId };
    delete clone._rev;
    delete clone._createdAt;
    delete clone._updatedAt;
    return clone;
  }

  // Патч одного баннера (один или несколько полей).
  async function patchBanner(banner, fields) {
    if (banner.hasDraft) {
      await mutate([{ patch: { id: banner.editId, set: fields } }]);
      return;
    }
    const publishedId = banner.editId;
    const draftId = 'drafts.' + banner.baseId;
    const fullDoc = await groqQuery(`*[_id=="${publishedId}"][0]`);
    const mutations = [{ createIfNotExists: cloneForDraft(fullDoc, draftId) }, { patch: { id: draftId, set: fields } }];
    await mutate(mutations);
    banner.editId = draftId;
    banner.hasDraft = true;
  }

  // Вычисляет новое значение sortIndex для баннера, вставленного на позицию newIndex
  // в списке list (после того, как он уже переставлен в этой позиции).
  // Берётся середина между соседями — как «150 между 100 и 200» — поэтому
  // все ОСТАЛЬНЫЕ баннеры остаются с прежними значениями, какая бы схема
  // нумерации (1,2,3 / 10,20,30 / 100,200,300) ни была на проекте раньше.
  const MIN_SORT = 100; // минимальное допустимое значение сортировки на проекте

  // Возвращает целое число для вставки строго между соседями (например 150
  // между 100 и 200), либо null, если места для целого числа не осталось
  // (соседи равны, стоят впритык, или упираемся в минимум 100) — в этом
  // случае вызывающий код сделает полный пересчёт списка.
  function computeInsertSort(list, newIndex) {
    const prev = list[newIndex - 1];
    const next = list[newIndex + 1];

    if (!prev && !next) return MIN_SORT; // единственный баннер в списке

    if (!prev) {
      // вставили в самое начало — но не ниже минимума
      const candidate = Math.round(next.sortIndex - SORT_STEP);
      if (candidate >= MIN_SORT && candidate < next.sortIndex) return candidate;
      if (next.sortIndex > MIN_SORT) return MIN_SORT; // есть хоть немного места над полом
      return null; // сосед и так уже на минимуме — целого места нет
    }

    if (!next) {
      return Math.round(prev.sortIndex + SORT_STEP); // вставили в самый конец
    }

    const gap = next.sortIndex - prev.sortIndex;
    if (gap >= 2) {
      const mid = Math.round((prev.sortIndex + next.sortIndex) / 2);
      if (mid > prev.sortIndex && mid < next.sortIndex) return mid;
    }
    // Соседи равны или стоят впритык (например много одинаковых sortIndex
    // в старых данных, или после многих вставок) — целого числа между ними
    // просто не существует.
    return null;
  }

  // Перенумеровывает ВЕСЬ список целыми значениями с чистым шагом SORT_STEP,
  // начиная с MIN_SORT (100, 200, 300 ...). Используется только как fallback,
  // когда точечная вставка невозможна (см. computeInsertSort выше), либо по
  // явному нажатию «Перенумеровать всё» — то есть когда без этого никак.
  async function renumberAll(list) {
    const changed = [];
    list.forEach((banner, i) => {
      const target = MIN_SORT + i * SORT_STEP;
      if (target !== banner.sortIndex) changed.push({ banner, target });
    });
    if (!changed.length) return false;

    // Баннеры без черновика — заранее одним запросом подтягиваем их полные
    // опубликованные документы, чтобы клонировать в черновик.
    const needIds = changed.filter((c) => !c.banner.hasDraft).map((c) => c.banner.editId);
    let fullDocsById = {};
    if (needIds.length) {
      const idsList = needIds.map((id) => `"${id}"`).join(',');
      const docs = await groqQuery(`*[_id in [${idsList}]]`);
      docs.forEach((d) => { fullDocsById[d._id] = d; });
    }

    const mutations = [];
    changed.forEach(({ banner, target }) => {
      let targetId = banner.editId;
      if (!banner.hasDraft) {
        const draftId = 'drafts.' + banner.baseId;
        const full = fullDocsById[banner.editId];
        if (full) mutations.push({ createIfNotExists: cloneForDraft(full, draftId) });
        targetId = draftId;
        banner.editId = draftId;
        banner.hasDraft = true;
      }
      mutations.push({ patch: { id: targetId, set: { sortIndex: target } } });
      banner.sortIndex = target;
    });

    await mutate(mutations);
    return true;
  }


  // ==================== СТИЛИ ====================

  const STYLE = `
  :root {
    /* Акцентный цвет — единственное место, которое нужно поменять под общий
       брендовый цвет. Всё остальное (фокус, активные фильтры, обводки при
       наведении, включённые тумблеры) ссылается на эти переменные. */
    --sob-accent: #bd5b34;
    --sob-accent-hover: #9c4a29;
    --sob-accent-shadow: rgba(189, 91, 52, .35);
    --sob-accent-soft-bg: #f3e3da;
    --sob-accent-soft-border: #e0b89e;
    --sob-accent-soft-text: #7a3c1e;

    /* Тёплая нейтральная палитра модалки (светлая тема) */
    --sob-bg-page: #fbf9f5;
    --sob-bg-panel: #fffdfa;
    --sob-bg-subtle: #f2ede2;
    --sob-thumb-bg: #ece5d6;
    --sob-border: #e6dfd0;
    --sob-border-soft: #ece6d9;
    --sob-text-primary: #2b2620;
    --sob-text-secondary: #857e6f;
    --sob-text-tertiary: #a89f8c;
  }
  /* Тёмная тема — переопределяет те же переменные внутри модалки, поэтому
     весь остальной CSS (который везде ссылается на var(--sob-*)) трогать не
     пришлось: достаточно навесить класс на #sob-overlay. */
  #sob-overlay.sob-dark {
    --sob-accent: #d97a4f;
    --sob-accent-hover: #e8956d;
    --sob-accent-shadow: rgba(217, 122, 79, .4);
    --sob-accent-soft-bg: #4a2f22;
    --sob-accent-soft-border: #6b4530;
    --sob-accent-soft-text: #edb08a;
    --sob-bg-page: #211d17;
    --sob-bg-panel: #2b251d;
    --sob-bg-subtle: #332c22;
    --sob-thumb-bg: #3a3327;
    --sob-border: #443b2d;
    --sob-border-soft: #3a3327;
    --sob-text-primary: #f1ece1;
    --sob-text-secondary: #b8ae9c;
    --sob-text-tertiary: #8f8672;
  }
  /* У <button> в браузере есть свой UA-паддинг (в Chrome — 1px 6px) поверх
     заданного нами width/height (box-sizing тоже свой, border-box) — без
     сброса он незаметно съедает часть объявленной ширины/высоты, особенно
     заметно на маленьких квадратных кнопках вроде .sob-move-btn. Кнопки,
     которым нужен свой отступ (например .sob-filter-btn), просто объявляют
     padding сами и переопределяют этот сброс. */
  button { margin: 0; padding: 0; font: inherit; }
  #sob-nav-btn {
    display: inline-flex; align-items: center; gap: 6px; margin-left: 4px;
    background: var(--sob-accent); color: #fff; border: none; border-radius: 6px;
    padding: 0 14px; height: 33px; font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: inherit; white-space: nowrap;
  }
  #sob-nav-btn:hover { background: var(--sob-accent-hover); }
  #sob-fab {
    position: fixed; bottom: 22px; right: 22px; z-index: 999998;
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--sob-accent); color: #fff; border: none; border-radius: 24px;
    padding: 11px 18px; font-size: 13px; font-weight: 600; cursor: pointer;
    box-shadow: 0 6px 18px var(--sob-accent-shadow);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  #sob-fab:hover { background: var(--sob-accent-hover); }
  .sob-icon { display: inline-flex; }
  .sob-icon svg { width: 20px; height: 20px; display: block; }
  #sob-overlay {
    position: fixed; inset: 0; background: rgba(23, 20, 14, 0.5);
    z-index: 999999; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  #sob-modal {
    background: var(--sob-bg-page); width: min(1280px, 96vw); height: min(88vh, 960px);
    border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.3);
    display: flex; flex-direction: column; overflow: hidden;
    transition: background-color .3s ease;
  }
  #sob-header {
    display: flex; align-items: center; gap: 12px; padding: 14px 18px;
    background: var(--sob-bg-panel); border-bottom: 1px solid var(--sob-border); flex-shrink: 0;
    transition: background-color .3s ease, border-color .3s ease;
  }
  #sob-header h2 { font-size: 16px; margin: 0; color: var(--sob-text-primary); flex-shrink: 0; transition: color .3s ease; }
  #sob-search {
    flex: 1; padding: 8px 12px; border: 1px solid var(--sob-border); border-radius: 8px;
    font-size: 13px; outline: none; background: var(--sob-bg-panel); color: var(--sob-text-primary);
    transition: background-color .3s ease, border-color .3s ease, color .3s ease;
  }
  #sob-search:focus { border-color: var(--sob-accent); }
  .sob-filter-btn {
    border: 1px solid var(--sob-border); background: var(--sob-bg-panel); border-radius: 8px; padding: 7px 12px;
    font-size: 13px; cursor: pointer; color: var(--sob-text-primary); white-space: nowrap;
    transition: border-color .12s, background-color .3s ease, color .3s ease;
  }
  #sob-refresh, #sob-close {
    border: 1px solid var(--sob-border); background: var(--sob-bg-panel); border-radius: 8px; width: 34px; height: 34px;
    cursor: pointer; font-size: 15px; flex-shrink: 0; color: var(--sob-text-secondary);
    display: inline-flex; align-items: center; justify-content: center;
    transition: border-color .12s, background-color .3s ease, color .3s ease;
  }
  #sob-refresh:hover, #sob-close:hover, .sob-filter-btn:hover { border-color: var(--sob-accent); }

  /* Тройной переключатель "Все / Активные / Неактивные" — та же идея, что
     в button-14 из подборки Химали Сингха (флип цветной плашки поверх метки),
     только на 3 позиции вместо 2 и через radio, а не checkbox. */
  .sob-tri {
    position: relative; display: inline-flex; border: 1px solid var(--sob-border);
    border-radius: 8px; overflow: hidden; flex-shrink: 0;
  }
  .sob-tri input { position: absolute; width: 0; height: 0; opacity: 0; }
  .sob-tri-opt {
    position: relative; overflow: hidden; padding: 7px 12px; font-size: 13px;
    cursor: pointer; color: var(--sob-text-secondary); white-space: nowrap; background: var(--sob-bg-panel);
    transition: background-color .3s ease, border-color .3s ease;
  }
  .sob-tri-opt + .sob-tri-opt { border-left: 1px solid var(--sob-border); }
  .sob-tri-opt:hover .sob-tri-text { color: var(--sob-text-primary); }
  .sob-tri-fill {
    position: absolute; inset: 0; background: var(--sob-accent);
    transform: translateY(-100%);
    transition: transform .5s cubic-bezier(0.22, 1, 0.36, 1), background-color .3s ease;
    z-index: 1;
  }
  .sob-tri-text { position: relative; z-index: 2; transition: color .15s ease; }
  #sob-f-all:checked ~ label[for="sob-f-all"] .sob-tri-fill,
  #sob-f-on:checked ~ label[for="sob-f-on"] .sob-tri-fill,
  #sob-f-off:checked ~ label[for="sob-f-off"] .sob-tri-fill { transform: translateY(0); }
  #sob-f-all:checked ~ label[for="sob-f-all"] .sob-tri-text,
  #sob-f-on:checked ~ label[for="sob-f-on"] .sob-tri-text,
  #sob-f-off:checked ~ label[for="sob-f-off"] .sob-tri-text { color: #fff; }

  /* Переключатель темы — упрощённый вариант механики jkantner/xxyMYKg:
     там это два слоя с взаимно компенсирующимися сдвигами (солнце/луна едут
     в одну сторону, цветная маска — в другую, всё через em), рассчитанный на
     огромный масштаб (в оригинале шрифт демо-страницы — 60–120px). На нашей
     34-пиксельной кнопке та точная механика упирается в субпиксельные
     огрехи. Здесь та же идея (едущая цветная «шайба», солнце слева, луна
     справа), но всего один движущийся слой на фиксированных px: шайба едет
     под нужную иконку, а не наоборот — иконки вообще не двигаются, только
     меняют цвет под шайбой на белый. */
  .sob-theme-switch {
    position: relative; display: inline-flex; align-items: center; cursor: pointer;
    -webkit-tap-highlight-color: transparent; user-select: none; flex-shrink: 0;
  }
  .sob-theme-switch .switch__input {
    margin: 0; width: 68px; height: 34px; background-color: var(--sob-bg-panel);
    border: 1px solid var(--sob-border); border-radius: 8px; outline: transparent;
    -webkit-appearance: none; appearance: none; cursor: pointer;
    transition: background-color .3s ease, border-color .3s ease;
  }
  .sob-theme-switch .switch__input:checked { background-color: var(--sob-bg-subtle); }
  .sob-theme-switch .switch__input:focus-visible { box-shadow: 0 0 0 2px var(--sob-accent-shadow); }
  .sob-theme-switch .switch__icon {
    position: absolute; top: 50%; width: 14px; height: 14px; transform: translateY(-50%) rotate(0deg);
    pointer-events: none; z-index: 2; color: var(--sob-text-tertiary);
    transition: color .25s ease, transform .35s ease;
  }
  .sob-theme-switch .switch__icon--sun { left: 8px; }
  .sob-theme-switch .switch__icon--moon { right: 8px; }
  .sob-theme-switch .switch__input:not(:checked) ~ .switch__icon--sun {
    color: #fff; transform: translateY(-50%) rotate(360deg);
  }
  .sob-theme-switch .switch__input:checked ~ .switch__icon--moon {
    color: #fff; transform: translateY(-50%) rotate(360deg);
  }
  .sob-theme-switch .switch__knob {
    position: absolute; top: 4px; left: 3px; width: 26px; height: 26px; border-radius: 6px;
    background: var(--sob-accent); pointer-events: none; z-index: 1;
    transition: transform .3s cubic-bezier(0.65,0,0.35,1), background-color .3s ease;
  }
  .sob-theme-switch .switch__input:checked ~ .switch__knob { transform: translateX(36px); }
  .sob-theme-switch .switch__sr { overflow: hidden; position: absolute; width: 1px; height: 1px; }
  #sob-hint {
    padding: 12px 18px; font-size: 13px; line-height: 1.6; color: var(--sob-text-secondary);
    background: var(--sob-bg-subtle); border-bottom: 1px solid var(--sob-border); flex-shrink: 0;
    transition: background-color .3s ease, border-color .3s ease, color .3s ease;
  }
  #sob-hint p { margin: 0 0 8px; }
  #sob-hint p:last-child { margin-bottom: 0; }
  #sob-hint b { color: var(--sob-text-primary); transition: color .3s ease; }
  #sob-body { flex: 1; overflow-y: auto; padding: 16px 18px; background: var(--sob-bg-page); transition: background-color .3s ease; }
  #sob-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 14px; align-items: start;
  }
  .sob-card {
    background: var(--sob-bg-panel); border: 1px solid var(--sob-border-soft); border-radius: 10px; overflow: hidden;
    cursor: grab; position: relative;
    transition: box-shadow .15s, opacity .15s, background-color .3s ease, border-color .3s ease;
    display: flex; flex-direction: column;
  }
  .sob-card:hover { box-shadow: 0 4px 14px rgba(43,38,32,.10); }
  .sob-card.dragging { opacity: .35; }
  .sob-card.drag-over { outline: 2px dashed var(--sob-accent); outline-offset: -2px; }
  .sob-thumbs { position: relative; background: var(--sob-bg-subtle); transition: background-color .3s ease; }
  .sob-thumb-box {
    width: 100%; display: flex; align-items: center; justify-content: center;
    overflow: hidden; background: var(--sob-thumb-bg); transition: background-color .3s ease, border-color .3s ease;
  }
  .sob-thumb-box.h { height: 110px; }
  .sob-thumb-box.v { height: 230px; }
  .sob-thumb-box + .sob-thumb-box { border-top: 1px solid var(--sob-border); }
  .sob-thumb-box img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
  .sob-thumb-label {
    position: absolute; left: 6px; font-size: 9.5px; font-weight: 700; letter-spacing: .02em;
    text-transform: uppercase; color: #fff; background: rgba(0,0,0,.5); padding: 2px 6px;
    border-radius: 4px; pointer-events: none;
  }
  .sob-noimg {
    color: var(--sob-text-tertiary); font-size: 11px; text-align: center; padding: 8px; height: 110px;
    display: flex; align-items: center; justify-content: center; transition: color .3s ease;
  }
  .sob-rank {
    position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,.58); color: #fff;
    font-size: 13px; font-weight: 600; padding: 3px 8px; border-radius: 6px; line-height: 1.5; z-index: 2;
  }

  /* Переключатель активности баннера — механика 17-й кнопки из подборки
     Химали Сингха: один «жетон» (цветной блок + текст) едет по треку, при
     этом меняется и его цвет, и подпись (через content на ::before), и фон
     самой подложки (как .btn-bg в оригинале). Едет через transform, а не
     left — left триггерит layout на каждый кадр и дёргается при любой
     нагрузке на поток; transform всегда гладкий, даже во время запроса
     к Sanity. Переключается через прямую мутацию .checked существующего
     чекбокса (см. syncCardToggles) — если пересоздавать DOM на каждый клик,
     переходу физически не на чем анимироваться. */
  .sob-status {
    position: absolute; top: 6px; right: 6px; z-index: 2;
    width: 64px; height: 26px; border-radius: 7px; overflow: hidden;
    background: rgba(93, 45, 26, .55); cursor: pointer;
    transition: background-color .3s ease;
  }
  .sob-status:has(.sob-status-input:checked) { background: rgba(38, 56, 30, .55); }
  .sob-status-input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; z-index: 3; }
  .sob-status-chip {
    position: absolute; top: 3px; left: 3px; width: 28px; height: 20px; border-radius: 5px;
    background: var(--sob-accent); z-index: 1; transform: translateX(0);
    transition: transform .35s cubic-bezier(0.18, 0.89, 0.35, 1.15), background-color .3s ease;
  }
  .sob-status-input:checked ~ .sob-status-chip { transform: translateX(30px); background: #6b8e4e; }
  .sob-status-label {
    position: absolute; top: 3px; left: 3px; width: 28px; height: 20px; z-index: 2;
    display: flex; align-items: center; justify-content: center; pointer-events: none;
    transform: translateX(0);
    transition: transform .35s cubic-bezier(0.18, 0.89, 0.35, 1.15);
  }
  .sob-status-label::before {
    content: "OFF"; color: #fff; font-size: 10px; font-weight: 700; text-transform: uppercase; line-height: 1;
  }
  .sob-status-input:checked ~ .sob-status-label { transform: translateX(30px); }
  .sob-status-input:checked ~ .sob-status-label::before { content: "ON"; }
  .sob-draft-badge {
    position: absolute; bottom: 6px; left: 6px; font-size: 10px; font-weight: 600;
    padding: 2px 7px; border-radius: 20px; background: #e08a2b; color: #fff; z-index: 2;
  }
  .sob-body { padding: 9px 10px 10px; display: flex; flex-direction: column; gap: 7px; flex: 1; }
  .sob-title {
    font-size: 12.5px; font-weight: 600; color: var(--sob-text-primary); line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    min-height: 32px; transition: color .3s ease;
  }
  .sob-venues {
    font-size: 10.5px; color: var(--sob-text-secondary); line-height: 1.35; margin-top: -3px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    transition: color .3s ease;
  }
  .sob-toggles { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .sob-toggle {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10.5px; padding: 3px 7px; border-radius: 6px; border: 1px solid var(--sob-border);
    cursor: pointer; user-select: none; color: var(--sob-text-secondary); background: var(--sob-bg-subtle);
    transition: background-color .3s ease, border-color .3s ease, color .3s ease;
  }
  .sob-toggle svg { display: block; flex-shrink: 0; }
  .sob-toggle.on { background: var(--sob-accent-soft-bg); border-color: var(--sob-accent-soft-border); color: var(--sob-accent-soft-text); }
  .sob-toggle:hover { filter: brightness(0.97); }
  .sob-sortval { font-size: 11px; color: var(--sob-text-tertiary); margin-left: auto; white-space: nowrap; transition: color .3s ease; }
  .sob-sortrow { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: auto; }
  .sob-move-btn {
    width: 22px; height: 22px; border: 1px solid var(--sob-border); background: var(--sob-bg-panel); border-radius: 6px;
    cursor: pointer; color: var(--sob-text-secondary); display: flex; align-items: center; justify-content: center;
    line-height: 1; transition: border-color .12s, background-color .3s ease, color .3s ease;
  }
  .sob-move-btn svg { display: block; width: 20px; height: 20px; }
  .sob-move-btn:hover { border-color: var(--sob-accent); }
  .sob-move-btn:disabled { opacity: .3; cursor: default; }
  #sob-toast {
    position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
    background: #2b2620; color: #fff; padding: 14px 22px; border-radius: 10px; font-size: 15px;
    z-index: 1000001; opacity: 0; transition: opacity .2s; pointer-events: none;
  }
  #sob-toast.show { opacity: 1; }
  #sob-loading {
    display: flex; align-items: center; justify-content: center; height: 100%;
    color: var(--sob-text-secondary); font-size: 13px; transition: color .3s ease;
  }
  `;

  function injectStyle() {
    if (!document.head) return; // документ ещё не готов (document-start) — попробуем на следующем тике
    if (document.getElementById('sob-style')) return;
    const style = document.createElement('style');
    style.id = 'sob-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // ==================== ВСПОМОГАТЕЛЬНОЕ ====================

  let toastTimer = null;
  function toast(msg, isError) {
    let el = document.getElementById('sob-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sob-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = isError ? '#c0362c' : '#2b2620';
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  function cdnUrl(url, extra) {
    if (!url) return null;
    return url + (url.includes('?') ? '&' : '?') + extra;
  }

  function formatSort(value) {
    // Округляем только для отображения — реальное значение, отправленное
    // в Sanity, остаётся точным (это важно для вставки «между» соседями).
    return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }

  // ==================== МОДАЛКА ====================

  let state = {
    banners: [],
    filter: 'all', // all | active | inactive
    search: '',
    saving: false,
  };

  function filteredBanners() {
    let list = state.banners;
    if (state.filter === 'active') list = list.filter((b) => b.status);
    if (state.filter === 'inactive') list = list.filter((b) => !b.status);
    if (state.search.trim()) {
      const q = state.search.trim().toLowerCase();
      list = list.filter((b) => b.title.toLowerCase().includes(q));
    }
    return list;
  }

  function renderGrid() {
    const grid = document.getElementById('sob-grid');
    if (!grid) return;
    const list = filteredBanners();
    const filtering = list.length !== state.banners.length;

    grid.innerHTML = '';
    list.forEach((banner) => {
      const card = document.createElement('div');
      card.className = 'sob-card';
      card.draggable = !filtering; // сортировка доступна только когда не активны поиск/фильтр
      card.dataset.baseId = banner.baseId;

      const globalIndex = state.banners.indexOf(banner);
      const hImg = cdnUrl(banner.thumbH, 'w=440&fit=max&auto=format');
      const vImg = cdnUrl(banner.thumbV, 'w=300&fit=max&auto=format');

      let thumbsHtml = '';
      if (hImg) {
        thumbsHtml += `<div class="sob-thumb-box h"><img src="${hImg}" loading="lazy" alt=""><span class="sob-thumb-label" style="bottom:4px;">гориз.</span></div>`;
      }
      if (vImg) {
        thumbsHtml += `<div class="sob-thumb-box v"><img src="${vImg}" loading="lazy" alt=""><span class="sob-thumb-label" style="bottom:4px;">верт.</span></div>`;
      }
      if (!thumbsHtml) {
        thumbsHtml = `<div class="sob-noimg">Нет превью</div>`;
      }

      const venuesHtml = banner.venues.length
        ? `<div class="sob-venues" title="${banner.venues.join('; ').replace(/"/g, '&quot;')}">📍 ${banner.venues.join(' · ')}</div>`
        : '';

      card.innerHTML = `
        <div class="sob-thumbs">
          <div class="sob-rank">#${globalIndex + 1}</div>
          <div class="sob-status" title="Клик — переключить активность">
            <input type="checkbox" class="sob-status-input" ${banner.status ? 'checked' : ''}>
            <span class="sob-status-chip"></span>
            <span class="sob-status-label"></span>
          </div>
          ${banner.hasDraft ? `<div class="sob-draft-badge">есть черновик</div>` : ''}
          ${thumbsHtml}
        </div>
        <div class="sob-body">
          <div class="sob-title" title="${banner.title.replace(/"/g, '&quot;')}">${banner.title}</div>
          ${venuesHtml}
          <div class="sob-toggles">
            <div class="sob-toggle site ${banner.showInWeb ? 'on' : ''}">${ICON_WEBSITE} Сайт</div>
            <div class="sob-toggle app ${banner.showInApplication ? 'on' : ''}">${ICON_MOBILE} Прил.</div>
            <div class="sob-sortval">Сорт.: ${formatSort(banner.sortIndex)}</div>
          </div>
          <div class="sob-sortrow">
            <button class="sob-move-btn up" ${filtering || globalIndex === 0 ? 'disabled' : ''} title="${filtering ? 'Недоступно при активном поиске/фильтре' : 'Раньше в очереди'}">${ICON_ARROW_LEFT}</button>
            <button class="sob-move-btn down" ${filtering || globalIndex === state.banners.length - 1 ? 'disabled' : ''} title="${filtering ? 'Недоступно при активном поиске/фильтре' : 'Позже в очереди'}">${ICON_ARROW_RIGHT}</button>
          </div>
        </div>
      `;

      card.querySelector('.sob-status').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleField(banner, 'status');
      });
      card.querySelector('.sob-toggle.site').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleField(banner, 'showInWeb');
      });
      card.querySelector('.sob-toggle.app').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleField(banner, 'showInApplication');
      });

      card.querySelector('.sob-move-btn.up').addEventListener('click', (e) => {
        e.stopPropagation();
        moveBanner(globalIndex, globalIndex - 1);
      });
      card.querySelector('.sob-move-btn.down').addEventListener('click', (e) => {
        e.stopPropagation();
        moveBanner(globalIndex, globalIndex + 1);
      });

      card.addEventListener('dragstart', (e) => {
        card.classList.add('dragging');
        e.dataTransfer.setData('text/plain', String(globalIndex));
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const from = Number(e.dataTransfer.getData('text/plain'));
        const to = globalIndex;
        if (from !== to) moveBanner(from, to);
      });

      grid.appendChild(card);
    });

    if (!list.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--sob-text-tertiary);padding:40px 0;">Ничего не найдено</div>`;
    }
  }

  // Точечно обновляет уже отрисованные переключатели одной карточки, не
  // трогая остальной DOM. Полный renderGrid() тут не годится: он сносит и
  // создаёт заново весь чекбокс/тумблеры, а свежесозданный элемент рождается
  // сразу в конечном состоянии — CSS-переходу банально не на чем играть.
  function syncCardToggles(banner) {
    const card = document.querySelector(`.sob-card[data-base-id="${CSS.escape(banner.baseId)}"]`);
    if (!card) return;
    const statusInput = card.querySelector('.sob-status-input');
    if (statusInput) statusInput.checked = banner.status;
    const siteToggle = card.querySelector('.sob-toggle.site');
    if (siteToggle) siteToggle.classList.toggle('on', banner.showInWeb);
    const appToggle = card.querySelector('.sob-toggle.app');
    if (appToggle) appToggle.classList.toggle('on', banner.showInApplication);
  }

  async function toggleField(banner, field) {
    if (state.saving) return;
    const prev = banner[field];
    banner[field] = !prev;
    syncCardToggles(banner);
    state.saving = true;
    try {
      await patchBanner(banner, { [field]: banner[field] });
      renderGrid(); // чтобы сразу показать бейдж «черновик», если он появился
      toast('Сохранено в черновик — не забудьте опубликовать в студии');
    } catch (err) {
      banner[field] = prev;
      renderGrid();
      toast('Ошибка сохранения: ' + err.message, true);
    } finally {
      state.saving = false;
    }
  }

  async function moveBanner(fromIdx, toIdx) {
    if (state.saving) return;
    if (toIdx < 0 || toIdx >= state.banners.length) return;
    const list = state.banners;
    const [item] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, item);

    const newSort = computeInsertSort(list, toIdx);
    state.saving = true;

    if (newSort !== null) {
      item.sortIndex = newSort;
      renderGrid();
      toast('Сохраняю позицию…');
      try {
        await patchBanner(item, { sortIndex: newSort });
        toast(`Готово: sort ${newSort} — остальные баннеры не тронуты`);
        renderGrid();
      } catch (err) {
        toast('Ошибка сохранения порядка: ' + err.message, true);
      } finally {
        state.saving = false;
      }
      return;
    }

    // Целого числа между соседями нет (упёрлись в минимум 100 или соседи
    // стоят впритык/равны) — аккуратно перенумеровываем весь список чистыми
    // целыми значениями с шагом 100. Это единственный случай, когда меняется
    // больше одного баннера.
    renderGrid();
    toast('Не осталось места между соседями — пересчитываю порядок всего списка…');
    try {
      await renumberAll(list);
      toast('Список перенумерован целыми значениями с шагом 100');
      renderGrid();
    } catch (err) {
      toast('Ошибка сохранения порядка: ' + err.message, true);
    } finally {
      state.saving = false;
    }
  }

  async function loadAndRender() {
    const body = document.getElementById('sob-body');
    body.innerHTML = `<div id="sob-loading">Загружаю баннеры…</div>`;
    try {
      // Общий страховочный таймаут — если что-то зависнет (например, сеть или
      // прерванная навигация), модалка не будет висеть на «Загружаю…» вечно.
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Превышено время ожидания (12с)')), 12000)
      );
      state.banners = await Promise.race([fetchBanners(), timeout]);
      body.innerHTML = `<div id="sob-grid"></div>`;
      renderGrid();
    } catch (err) {
      body.innerHTML = `
        <div id="sob-loading" style="flex-direction:column;gap:10px;">
          <div>Ошибка загрузки: ${err.message}</div>
          <button id="sob-retry" class="sob-filter-btn">Повторить</button>
        </div>
      `;
      document.getElementById('sob-retry')?.addEventListener('click', loadAndRender);
    }
  }

  function openModal() {
    if (document.getElementById('sob-overlay')) return;
    injectStyle();

    const overlay = document.createElement('div');
    overlay.id = 'sob-overlay';
    overlay.innerHTML = `
      <div id="sob-modal">
        <div id="sob-header">
          <h2>Баннеры</h2>
          <input id="sob-search" type="text" placeholder="Поиск по названию…" />
          <div class="sob-tri">
            <input type="radio" name="sob-filter-radio" id="sob-f-all" checked>
            <input type="radio" name="sob-filter-radio" id="sob-f-on">
            <input type="radio" name="sob-filter-radio" id="sob-f-off">
            <label for="sob-f-all" class="sob-tri-opt" data-filter="all"><span class="sob-tri-fill"></span><span class="sob-tri-text">Все</span></label>
            <label for="sob-f-on" class="sob-tri-opt" data-filter="active"><span class="sob-tri-fill"></span><span class="sob-tri-text">Активные</span></label>
            <label for="sob-f-off" class="sob-tri-opt" data-filter="inactive"><span class="sob-tri-fill"></span><span class="sob-tri-text">Неактивные</span></label>
          </div>
          <button id="sob-renumber" class="sob-filter-btn" title="Пересчитать sort у всех баннеров целыми значениями с шагом 100">Перенумеровать всё</button>
          <button id="sob-refresh" title="Обновить">⟳</button>
          <label class="sob-theme-switch" title="Переключить тему">
            <span class="switch__sr">Тёмная тема</span>
            <input type="checkbox" class="switch__input" id="sob-theme-toggle">
            ${ICON_SUN}${ICON_MOON}
            <span class="switch__knob"></span>
          </label>
          <button id="sob-close" title="Закрыть">✕</button>
        </div>
        <div id="sob-hint">
          <p>Перетащите превью, чтобы изменить порядок, либо используйте кнопки ◀▶. Кнопки недоступны при активном поиске или
          фильтре — порядок в них относится к полному списку, а не к отфильтрованному.</p>
          <p>Новое целое значение sort (минимум 100) ставится ровно между соседями — например 150 между 100 и 200, —
          и <b>меняется только у перемещённого баннера</b>. Если целого числа между соседями не осталось (несколько баннеров с
          одинаковым sort), весь список автоматически пересчитывается с шагом 100; то же можно сделать вручную кнопкой
          «Перенумеровать всё».</p>
          <p>Клик по бейджу «Активен/Неактивен» переключает активность баннера, клик по «🌐 Сайт» / «📱 Прил.» — видимость.
          Все изменения сохраняются как <b>неопубликованные черновики</b> (бейдж «есть черновик» на карточке) — опубликуйте
          баннер вручную в студии, когда будете готовы.</p>
        </div>
        <div id="sob-body"></div>
      </div>
    `;
    overlay.classList.toggle('sob-dark', getStoredTheme() === 'dark');
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
    document.getElementById('sob-close').addEventListener('click', closeModal);
    document.getElementById('sob-refresh').addEventListener('click', loadAndRender);
    const themeInput = document.getElementById('sob-theme-toggle');
    themeInput.checked = getStoredTheme() === 'dark';
    themeInput.addEventListener('change', () => {
      const next = themeInput.checked ? 'dark' : 'light';
      localStorage.setItem(THEME_KEY, next);
      overlay.classList.toggle('sob-dark', next === 'dark');
    });
    document.getElementById('sob-renumber').addEventListener('click', async () => {
      if (state.saving) return;
      state.saving = true;
      toast('Перенумеровываю всё…');
      try {
        const changed = await renumberAll(state.banners);
        toast(changed ? 'Готово: целые значения с шагом 100 от 100' : 'Уже всё аккуратно — менять нечего');
        renderGrid();
      } catch (err) {
        toast('Ошибка: ' + err.message, true);
      } finally {
        state.saving = false;
      }
    });

    document.getElementById('sob-search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderGrid();
    });

    overlay.querySelectorAll('.sob-tri-opt').forEach((label) => {
      const input = document.getElementById(label.getAttribute('for'));
      input.addEventListener('change', () => {
        state.filter = label.dataset.filter;
        renderGrid();
      });
    });

    document.addEventListener('keydown', escListener);

    loadAndRender();
  }

  function escListener(e) {
    if (e.key === 'Escape') closeModal();
  }

  function closeModal() {
    const overlay = document.getElementById('sob-overlay');
    if (overlay) overlay.remove();
    document.removeEventListener('keydown', escListener);
  }

  // ==================== КНОПКА В ШАПКЕ (рядом со Schedules) ====================
  // Studio — это SPA: переход между Structure/Vision/Media/Schedules и между
  // баннерами не перезагружает страницу, поэтому кнопку нужно постоянно
  // держать синхронизированной с текущим маршрутом (опрос вместо разовой вставки).

  function findNavContainer() {
    const link = Array.from(document.querySelectorAll('a')).find(
      (a) => a.textContent.trim() === 'Schedules'
    );
    return link ? link.parentElement : null;
  }

  // currentColor — иконка автоматически принимает цвет текста кнопки,
  // отдельно её красить не нужно даже при смене --sob-accent.
  const ICON_SVG = '<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M196,80v32a4,4,0,0,1-8,0V84H160a4,4,0,0,1,0-8h32A4.0002,4.0002,0,0,1,196,80ZM96,172H68V144a4,4,0,0,0-8,0v32a4.0002,4.0002,0,0,0,4,4H96a4,4,0,0,0,0-8ZM228,56V200a12.01312,12.01312,0,0,1-12,12H40a12.01312,12.01312,0,0,1-12-12V56A12.01312,12.01312,0,0,1,40,44H216A12.01312,12.01312,0,0,1,228,56Zm-8,0a4.004,4.004,0,0,0-4-4H40a4.004,4.004,0,0,0-4,4V200a4.004,4.004,0,0,0,4,4H216a4.004,4.004,0,0,0,4-4Z"/></svg>';

  // Иконки для переключателя темы (солнце/луна) — не двигаются, только
  // меняют цвет под цветной шайбой (см. .switch__icon в стилях).
  const ICON_SUN = '<svg class="switch__icon switch__icon--sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const ICON_MOON = '<svg class="switch__icon switch__icon--moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  // Стрелки сортировки (◀/▶) и иконки каналов показа (сайт/приложение) —
  // те же svg, что прислал пользователь, с fill/stroke заменённым на currentColor.
  // viewBox обрезан вплотную к самой фигуре (с учётом нахлёста stroke-width),
  // а не «0 0 24 24» с запасом по краям — иначе при масштабировании до 20px
  // нецелый коэффициент даёт разный поднапиксельный сдвиг сверху/справа и
  // снизу/слева (было 4px и 5px вместо одинаковых отступов).
  const ICON_ARROW_LEFT = '<svg viewBox="3 3 18 18" width="20" height="20" aria-hidden="true"><path d="M11 9L8 12M8 12L11 15M8 12H16M7.2 20H16.8C17.9201 20 18.4802 20 18.908 19.782C19.2843 19.5903 19.5903 19.2843 19.782 18.908C20 18.4802 20 17.9201 20 16.8V7.2C20 6.0799 20 5.51984 19.782 5.09202C19.5903 4.71569 19.2843 4.40973 18.908 4.21799C18.4802 4 17.9201 4 16.8 4H7.2C6.0799 4 5.51984 4 5.09202 4.21799C4.71569 4.40973 4.40973 4.71569 4.21799 5.09202C4 5.51984 4 6.07989 4 7.2V16.8C4 17.9201 4 18.4802 4.21799 18.908C4.40973 19.2843 4.71569 19.5903 5.09202 19.782C5.51984 20 6.07989 20 7.2 20Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  const ICON_ARROW_RIGHT = '<svg viewBox="3 3 18 18" width="20" height="20" aria-hidden="true"><path d="M13 15L16 12M16 12L13 9M16 12H8M7.2 20H16.8C17.9201 20 18.4802 20 18.908 19.782C19.2843 19.5903 19.5903 19.2843 19.782 18.908C20 18.4802 20 17.9201 20 16.8V7.2C20 6.0799 20 5.51984 19.782 5.09202C19.5903 4.71569 19.2843 4.40973 18.908 4.21799C18.4802 4 17.9201 4 16.8 4H7.2C6.0799 4 5.51984 4 5.09202 4.21799C4.71569 4.40973 4.40973 4.71569 4.21799 5.09202C4 5.51984 4 6.07989 4 7.2V16.8C4 17.9201 4 18.4802 4.21799 18.908C4.40973 19.2843 4.71569 19.5903 5.09202 19.782C5.51984 20 6.07989 20 7.2 20Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  const ICON_WEBSITE = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(3,4)"><rect x="7" y="12" width="5" height="4.5"/><rect x="0" y="0" width="19" height="12" rx="1"/><line x1="8.5" y1="9.5" x2="10.5" y2="9.5"/><line x1="4.5" y1="16.5" x2="14.5" y2="16.5"/></g></svg>';
  const ICON_MOBILE = '<svg viewBox="0 0 32 32" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M22 1.25h-12c-1.518 0.002-2.748 1.232-2.75 2.75v24c0.002 1.518 1.232 2.748 2.75 2.75h12c1.518-0.002 2.748-1.232 2.75-2.75v-24c-0.002-1.518-1.232-2.748-2.75-2.75h-0zM23.25 28c-0.001 0.69-0.56 1.249-1.25 1.25h-12c-0.69-0.001-1.249-0.56-1.25-1.25v-24c0.001-0.69 0.56-1.249 1.25-1.25h12c0.69 0.001 1.249 0.56 1.25 1.25v0zM15.3 25.299c-0.185 0.173-0.3 0.418-0.3 0.69 0 0.004 0 0.008 0 0.012v-0.001c-0 0.004-0 0.009-0 0.014 0 0.277 0.115 0.527 0.3 0.704l0 0c0.176 0.185 0.424 0.301 0.7 0.301s0.524-0.115 0.699-0.3l0-0c0.186-0.178 0.301-0.429 0.301-0.706 0-0.004-0-0.009-0-0.013v0.001c0-0.003 0-0.007 0-0.010 0-0.273-0.116-0.518-0.3-0.69l-0.001-0.001c-0.181-0.176-0.427-0.284-0.7-0.284s-0.519 0.108-0.7 0.284l0-0z"/></svg>';

  // Тема хранится в localStorage и переживает переоткрытие модалки.
  const THEME_KEY = 'sob-theme';
  function getStoredTheme() {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  }

  function createNavButton() {
    const btn = document.createElement('button');
    btn.id = 'sob-nav-btn';
    btn.type = 'button';
    btn.innerHTML = `<span class="sob-icon">${ICON_SVG}</span> Баннеры`;
    btn.addEventListener('click', openModal);
    return btn;
  }

  function createFallbackFab() {
    const btn = document.createElement('button');
    btn.id = 'sob-fab';
    btn.type = 'button';
    btn.innerHTML = `<span class="sob-icon">${ICON_SVG}</span> Баннеры: превью и сортировка`;
    btn.addEventListener('click', openModal);
    return btn;
  }

  // Даём тулбару время отрисоваться (обычно доли секунды) и только если он
  // так и не появился спустя разумное время — показываем плавающую кнопку.
  // Раньше фолбэк показывался сразу и потом «мигал», перескакивая наверх —
  // это и есть та вспышка кнопки внизу справа, которую было видно при обычной загрузке.
  const FALLBACK_GRACE_MS = 2500;
  let bannersRouteSince = null;

  function syncButton() {
    if (!document.body) return; // документ ещё не готов (document-start) — попробуем на следующем тике
    const shouldShow = isBannersRoute();
    const navBtn = document.getElementById('sob-nav-btn');
    const fab = document.getElementById('sob-fab');

    if (!shouldShow) {
      bannersRouteSince = null;
      if (navBtn) navBtn.remove();
      if (fab) fab.remove();
      return;
    }

    if (bannersRouteSince === null) bannersRouteSince = Date.now();

    injectStyle();
    const container = findNavContainer();

    if (container) {
      // Кнопка встраивается в шапку сразу после «Schedules».
      if (fab) fab.remove();
      if (!navBtn || navBtn.parentElement !== container) {
        if (navBtn) navBtn.remove();
        container.appendChild(createNavButton());
      }
      return;
    }

    // Тулбар ещё не отрисовался — ждём, не показывая ничего преждевременно.
    if (Date.now() - bannersRouteSince > FALLBACK_GRACE_MS && !fab) {
      document.body.appendChild(createFallbackFab());
    }
  }

  setInterval(syncButton, 250);
  syncButton();
})();
