/* Шар даних: читання з Apps Script, черга записів на випадок поганої мережі,
   ключ доступу і вибір середовища. Нічого не малює — тільки віддає дані. */

const API = (function () {
  const LS_ENV   = 'venya.env';
  const LS_KEY   = 'venya.key';
  const LS_QUEUE = 'venya.queue';
  const LS_CACHE = 'venya.cache';
  const LS_FAIL  = 'venya.failed';

  let listeners = [];
  let sending = false;
  let lastRole = 'view';

  /* ── середовище і ключ ── */

  function env() {
    const q = new URLSearchParams(location.search).get('env');
    if (q) localStorage.setItem(LS_ENV, q);
    return localStorage.getItem(LS_ENV) ||
      (['localhost', '127.0.0.1'].includes(location.hostname) ? 'dev' : 'prod');
  }

  /**
   * Ключ і адресу скрипта забираємо з hash один раз і кладемо в localStorage.
   * Hash не потрапляє ні в Referer, ні в логи сервера, тому це найтихіше
   * місце для таких речей. Заразом це дозволяє налаштувати новий пристрій
   * одним посиланням, не тримаючи адресу в публічному репозиторії:
   *
   *   …/#k=КЛЮЧ&api=https%3A%2F%2Fscript.google.com%2F…%2Fexec
   */
  (function readHash() {
    const h = location.hash || '';
    if (!h) return;
    const slot = env();
    const k = h.match(/[#&]k=([A-Za-z0-9_-]+)/);
    const a = h.match(/[#&]api=([^&]+)/);
    if (k) localStorage.setItem(LS_KEY + '.' + slot, k[1]);
    if (a) localStorage.setItem('venya.api.' + slot, decodeURIComponent(a[1]));
    if (k || a) history.replaceState(null, '', location.pathname + location.search);
  })();

  function key() {
    return localStorage.getItem(LS_KEY + '.' + env()) || '';
  }

  /* Адресу можна перебити локально, не чіпаючи config.js. Так dev-ендпоінт
     не потрапляє в публічний репозиторій, а прод лишається в конфігу — без
     нього GitHub Pages не має звідки взяти адресу.
     Задати:  localStorage.setItem('venya.api.dev', 'https://…/exec') */
  const base = () => (localStorage.getItem('venya.api.' + env()) ||
                      CONFIG.api[env()] || '').trim();

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ── повідомлення для інтерфейсу ── */

  function on(fn) { listeners.push(fn); }
  function notify(kind, detail) { listeners.forEach(fn => fn(kind, detail)); }

  /* ── черга записів ── */

  const queue = () => { try { return JSON.parse(localStorage.getItem(LS_QUEUE) || '[]') } catch (e) { return [] } };
  const setQueue = q => localStorage.setItem(LS_QUEUE, JSON.stringify(q));
  const pending = () => queue().length;

  /* Відхилені сервером операції не викидаємо. Раніше така операція просто
     зникала з черги, а рядок лишався на екрані — застосунок і таблиця тихо
     розходились, і побачити це можна було хіба випадково. */
  const failed = () => { try { return JSON.parse(localStorage.getItem(LS_FAIL) || '[]') } catch (e) { return [] } };
  const setFailed = f => localStorage.setItem(LS_FAIL, JSON.stringify(f));

  async function send(op) {
    try {
      const res = await fetch(base(), {
        method: 'POST',
        /* text/plain, а не application/json: інакше браузер шле preflight
           OPTIONS, який Apps Script не обробляє, і запит падає. */
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: JSON.stringify(Object.assign({k: key()}, op)),
        redirect: 'follow'
      });
      const data = await res.json();
      return data.ok ? {ok: true, data} : {ok: false, fatal: true, error: data.error};
    } catch (e) {
      /* мережа — не вина запису, лишаємо в черзі */
      return {ok: false, fatal: false, error: String(e && e.message || e)};
    }
  }

  async function flush() {
    if (sending || !base()) return;
    sending = true;
    try {
      while (queue().length) {
        const q = queue();
        const res = await send(q[0]);
        if (!res.ok && !res.fatal) break;          /* немає мережі — чекаємо */
        if (!res.ok) {
          const f = failed();
          f.push({op: q[0], error: res.error, at: Date.now()});
          setFailed(f);
          notify('failed', {op: q[0], error: res.error, count: f.length});
        }
        q.shift();
        setQueue(q);
        notify('queue', {pending: q.length});
      }
    } finally {
      sending = false;
      notify('queue', {pending: pending()});
    }
  }

  /**
   * Кладе операцію в чергу і одразу пробує відправити. Повертає id, щоб
   * інтерфейс міг оновитись негайно, не чекаючи на мережу.
   */
  function push(sheet, action, id, data, meds) {
    const op = {sheet, action, id};
    if (data) op.data = data;
    if (meds && meds.length) op.meds = meds;
    const q = queue();
    q.push(op);
    setQueue(q);
    notify('queue', {pending: q.length});
    flush();
    return id;
  }

  /** Повторити відхилені операції: помилка могла бути тимчасовою. */
  function retryFailed() {
    const f = failed();
    if (!f.length) return;
    setFailed([]);
    const q = queue().concat(f.map(x => x.op));
    setQueue(q);
    notify('queue', {pending: q.length});
    flush();
  }

  /** Відмовитись від них: тоді екран треба привести до таблиці, а не навпаки. */
  function dropFailed() {
    setFailed([]);
    notify('failed', {count: 0});
  }

  const create = (sheet, id, data, meds) => push(sheet, 'create', id, data, meds);
  const update = (sheet, id, data) => push(sheet, 'update', id, data);
  const remove = (sheet, id) => push(sheet, 'delete', id);

  /* ── читання ── */

  function cache() {
    try { return JSON.parse(localStorage.getItem(LS_CACHE) || 'null') } catch (e) { return null }
  }

  async function load(days) {
    if (!base()) throw new Error('config: не вказано адресу ' + env() + '-скрипта');
    if (!key())  throw new Error('немає ключа доступу — відкрийте посилання з #k=…');

    const want = days || CONFIG.defaultDays;
    const url = base() + '?k=' + encodeURIComponent(key()) + '&days=' + want;
    const res = await fetch(url, {redirect: 'follow'});
    const data = await res.json();
    if (!data.ok) throw new Error(data.error === 'forbidden' ? 'ключ не підходить' : data.error);
    lastRole = data.role || 'view';
    localStorage.setItem(LS_CACHE, JSON.stringify({at: Date.now(), days, data}));
    return data;
  }

  /** Дані з кешу, коли мережі немає. null, якщо нічого не збережено. */
  function offline() {
    const c = cache();
    if (!c) return null;
    lastRole = c.data.role || 'view';
    return c.data;
  }

  const cachedAt = () => (cache() || {}).at || 0;
  const role = () => lastRole;
  const canWrite = () => lastRole === 'edit';

  window.addEventListener('online', flush);

  return {env, key, base, uid, on, load, offline, cachedAt, role, canWrite,
          create, update, remove, flush, pending,
          failed, retryFailed, dropFailed};
})();

/* Дані з API в ту форму, якою користуються вигляди. Один шов замість
   переписування всіх виглядів. */
function adopt(payload) {
  TODAY = payload.today;

  log = (payload.journal || []).map(r => ({
    id: r.id, date: r.date, time: r.time,
    glucose: r.glucose, hi: !!r.hi,
    insulin: r.insulin, food: r.food || '', note: r.note || '', vet: r.vet || ''
  }));

  urine = (payload.urine || []).map(r => ({
    id: r.id, date: r.date, time: r.time, ml: r.ml, note: r.note || ''
  }));

  meds = (payload.meds || []).map(r => ({
    id: r.id, date: r.date, time: r.time || undefined,
    rid: r.regimenId, qty: r.qty || '', note: r.note || undefined
  }));

  regimens = (payload.regimens || []).map(r => ({
    id: r.id, name: r.name, qty: r.qty || '',
    perDay: r.perDay || 1, from: r.from, to: r.to || null,
    note: r.note || ''
  }));

  /* «Доба» тримає і стул, і підсумки; виглядам потрібен лише стул */
  stool = (payload.days || [])
    .filter(d => d.stool || d.note)
    .map(d => ({id: d.id, date: d.date, cat: d.stool || '', text: d.note || '',
                score: d.score}));

  days = payload.days || [];
  sheetUrl = payload.sheetUrl || '';
  notionUrl = payload.notionUrl || '';
  loadedFrom = payload.from || '';
}
