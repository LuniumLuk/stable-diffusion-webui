/* Gallery screen: paged browsing of the endorsement DB with quick actions. */

import { api_ } from './api.js';
import { emit, on, persist, state } from './state.js';
import { clear, closeSheet, closeViewer, debounce, el, openSheet, openViewer, toast } from './ui.js';
import { galleryAction, makeMetaNode, useAsImage, useMetaInText, viewerSrc } from './send.js';

const VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'endorsed', label: '\u2B50 Endorsed' },
  { id: 'unrated', label: 'Unrated' },
  { id: 'disliked', label: '\u{1F44E} Disliked' },
  { id: 'archived', label: 'Archived' },
  { id: 'staged', label: '\u{1F4CC} Staged' },
  { id: 'composed', label: '\u{1F3A8} Composed' },
  { id: 'qwen', label: '\u{1F916} Qwen' },
];

const PAGE_SIZE = 48;

const feed = {
  view: 'all', query: '', page: 1, total: 0, items: [], loading: false, done: false,
  token: 0, // increments per request; stale responses are dropped (quick view switches)
};

let gridInner;
let sentinel;
let counter;
let searchInput;
let chipsRow;

/* ------------------------------------------------------------------ helpers */

function badgesHtml(item) {
  const badges = [];
  if (item.endorsed) badges.push('\u2B50');
  if (item.disliked) badges.push('\u{1F44E}');
  if (item.archived) badges.push('\u{1F4E6}');
  if (item.staged) badges.push('\u{1F4CC}');
  return badges.join('');
}

export function metaFromItem(item) {
  return {
    prompt: item.prompt,
    negative_prompt: item.negative_prompt,
    seed: item.seed,
    steps: item.steps,
    sampler: item.sampler,
    cfg: item.cfg,
    width: item.width,
    height: item.height,
    model: item.model,
    infotext: '',
  };
}

function itemMetaText(item) {
  if (item.qwen) {
    return ['Qwen-Image 2.1', item.path || ''].filter(Boolean).join('\n');
  }
  return [
    item.prompt || '(no prompt)',
    item.negative_prompt ? `negative: ${item.negative_prompt}` : '',
    `${item.width || '?'}\u00D7${item.height || '?'} \u00B7 seed ${item.seed ?? '?'} \u00B7 ${item.steps ?? '?'} steps \u00B7 ${item.sampler || '?'}`,
    item.model ? `model: ${item.model}` : '',
    item.path || '',
  ].filter(Boolean).join('\n');
}

async function act(action, item) {
  const ok = await galleryAction(action, { key: item.key, path: item.path, meta: metaFromItem(item) });
  if (ok) {
    closeViewer();
    loadPage({ reset: true });
  }
}

/** Quick action button on a card; actions run without opening the viewer. */
function quickAction(item, action) {
  return galleryAction(action, { key: item.key, path: item.path, meta: metaFromItem(item) });
}

function quickButton(label, title, onClick, on = false) {
  return el('button', { class: 'qa' + (on ? ' on' : ''), type: 'button', text: label, title, onClick });
}

function cardNode(item, onTap, withActions) {
  const badges = badgesHtml(item);
  const thumb = el('div', {
    class: 'thumb',
    role: 'button',
    tabindex: '0',
    onClick: () => onTap(item),
    onKeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onTap(item);
      }
    },
  }, [
    el('img', {
      src: item.thumb || item.preview || item.url,
      alt: '',
      loading: 'lazy',
      // a missing original (e.g. endorsed copy removed by hand) must not look like a glitch
      onError: (event) => {
        event.target.classList.add('broken');
        thumb.classList.add('has-broken');
      },
    }),
    badges ? el('span', { class: 'badge', text: badges }) : null,
  ]);

  if (!withActions) return el('div', { class: 'thumb-wrap' }, [thumb]);

  // Qwen outputs are image-only: send them to img2img/inpaint with NO parameters at all,
  // and they can only be archived (never rated)
  const actions = el('div', { class: 'card-actions' }, item.qwen ? [
    quickButton('\u{1F5BC}', 'Use as image (image only)', () => useAsImage(item, { mode: 'img2img', meta: null })),
    quickButton('\u{1F3A8}', 'Use in inpaint (image only)', () => useAsImage(item, { mode: 'inpaint', meta: null })),
    quickButton('\u{1F4E6}', item.archived ? 'Unarchive' : 'Archive', () => quickAction(item, item.archived ? 'unarchive' : 'archive'), item.archived),
  ] : [
    quickButton('\u{1F5BC}', 'Use as image', () => useAsImage(item, { mode: 'img2img' })),
    quickButton('\u{1F3A8}', 'Use in inpaint', () => useAsImage(item, { mode: 'inpaint' })),
    quickButton('\u{1F4DD}', 'Use in text (txt2img) - recovers the seed', () => useMetaInText(metaFromItem(item))),
    quickButton('\u2B50', item.endorsed ? 'Remove endorsement' : 'Endorse', () => quickAction(item, item.endorsed ? 'unendorse' : 'endorse'), item.endorsed),
    quickButton('\u{1F44E}', item.disliked ? 'Remove dislike' : 'Dislike', () => quickAction(item, item.disliked ? 'undislike' : 'dislike'), item.disliked),
    quickButton('\u{1F4E6}', item.archived ? 'Unarchive' : 'Archive', () => quickAction(item, item.archived ? 'unarchive' : 'archive'), item.archived),
  ]);

  return el('div', { class: 'thumb-wrap' }, [thumb, actions]);
}

function appendItems(container, items, onTap, withActions = true) {
  for (const item of items) container.append(cardNode(item, onTap, withActions));
}

function openItemViewer(item) {
  const items = feed.items.length ? feed.items : [item];
  let position = items.indexOf(item);
  if (position < 0) position = 0;

  const show = () => {
    const current = items[position];
    openViewer({
      src: viewerSrc(current),
      title: current.seed !== undefined && current.seed !== null ? `seed ${current.seed}` : '',
      meta: makeMetaNode(itemMetaText(current), { folded: true }),
      actions: current.qwen ? [
        { label: 'Use as Image', accent: true, onClick: () => useAsImage(current, { mode: 'img2img', meta: null }) },
        { label: 'Inpaint', onClick: () => useAsImage(current, { mode: 'inpaint', meta: null }) },
        current.archived
          ? { label: '\u{1F4E6} Unarchive', onClick: () => act('unarchive', current) }
          : { label: '\u{1F4E6} Archive', onClick: () => act('archive', current) },
      ] : [
        { label: 'Use as Image', accent: true, onClick: () => useAsImage(current, { mode: 'img2img' }) },
        { label: 'Inpaint', onClick: () => useAsImage(current, { mode: 'inpaint' }) },
        { label: 'Use in Text', onClick: () => useMetaInText(metaFromItem(current)) },
        current.endorsed
          ? { label: '\u2B50 Un-endorse', onClick: () => act('unendorse', current) }
          : { label: '\u2B50 Endorse', onClick: () => act('endorse', current) },
        current.disliked
          ? { label: 'Undislike', onClick: () => act('undislike', current) }
          : { label: '\u{1F44E}', onClick: () => act('dislike', current) },
        current.archived
          ? { label: 'Unarchive', onClick: () => act('unarchive', current) }
          : { label: '\u{1F4E6}', onClick: () => act('archive', current) },
      ],
      onNavigate: move,
      canNavigate: canMove,
    });
  };

  const canMove = (direction) => {
    const next = position + (direction === 'next' ? 1 : -1);
    return next >= 0 && next < items.length;
  };

  const move = (direction) => {
    if (!canMove(direction)) return false;
    position += direction === 'next' ? 1 : -1;
    show();
    return true;
  };

  show();
}

async function loadPage({ reset = false } = {}) {
  // A view switch may supersede an in-flight load (quick chip taps); the token makes the
  // stale response harmless instead of leaving the previous view's grid on screen.
  if (feed.loading && !reset) return;
  if (!reset && feed.done) return;
  const token = (feed.token += 1);
  feed.loading = true;

  if (reset) {
    feed.page = 1;
    feed.items = [];
    feed.done = false;
    clear(gridInner);
    gridInner.append(el('div', { class: 'gallery-more', text: 'loading\u2026' }));
  }

  try {
    const data = await api_.gallery({ view: feed.view, q: feed.query, page: feed.page, size: PAGE_SIZE });
    if (token !== feed.token) return; // superseded by a newer request
    const start = reset ? 0 : feed.items.length;
    feed.items = feed.items.concat(data.items);
    feed.total = data.total;

    if (reset) clear(gridInner);
    appendItems(gridInner, feed.items.slice(start), openItemViewer);

    feed.done = !data.has_more;
    feed.page += 1;

    if (sentinel.parentElement) sentinel.remove();
    if (!feed.done) gridInner.append(sentinel);

    counter.textContent = `${feed.items.length} / ${data.total}`;
    if (feed.done && feed.items.length === 0) {
      gridInner.append(el('div', { class: 'gallery-more', text: feed.query ? 'no matches' : 'nothing here yet' }));
    }
  } catch (error) {
    if (token !== feed.token) return;
    clear(gridInner);
    gridInner.append(el('div', { class: 'gallery-more', text: `load failed: ${error.message}` }));
    feed.done = true;
  } finally {
    if (token === feed.token) feed.loading = false;
  }
}

function selectView(view) {
  feed.view = view;
  state.ui.galleryView = view;
  persist();
  for (const chip of chipsRow.children) chip.classList.toggle('on', chip.dataset.view === view);
  loadPage({ reset: true });
}

/** Bulk action: archive everything still unrated (two taps: arm, then confirm). */
function archiveUnratedButton() {
  let armedAt = 0;
  const button = el('button', {
    class: 'btn tiny archive-unrated', type: 'button', text: '\u{1F4E6} archive unrated',
    title: 'Archive every image that is neither endorsed, disliked, archived nor staged',
    onClick: async () => {
      if (!armedAt || performance.now() - armedAt > 6000) {
        armedAt = performance.now();
        let count = null;
        try {
          count = (await api_.gallery({ view: 'unrated', page: 1, size: 1 })).total;
        } catch (_error) { count = null; }
        button.classList.add('armed');
        button.textContent = count === null ? '\u26A0 confirm' : `\u26A0 archive ${count}?`;
        toast('tap again to archive all unrated images', 'warn', 4200);
        return;
      }
      armedAt = 0;
      button.classList.remove('armed');
      button.disabled = true;
      try {
        const result = await api_.galleryAction({ action: 'archive-unrated' });
        toast(`archived ${result.archived || 0} unrated image(s)`, 'ok', 2600);
        emit('gallery-refresh');
      } catch (error) {
        toast(`archive unrated failed: ${error.message}`, 'err', 4500);
      } finally {
        button.disabled = false;
        button.textContent = '\u{1F4E6} archive unrated';
      }
    },
  });
  return button;
}

/* ------------------------------------------------------------------ screen */

export function init(container) {
  searchInput = el('input', {
    type: 'search', placeholder: 'search prompt / model / sampler\u2026', value: state.ui.galleryQuery,
    autocapitalize: 'off', autocomplete: 'off', spellcheck: false, enterkeyhint: 'search',
  });
  searchInput.addEventListener('input', debounce(() => {
    feed.query = searchInput.value.trim();
    state.ui.galleryQuery = feed.query;
    persist();
    loadPage({ reset: true });
  }, 350));

  chipsRow = el('div', { class: 'view-chips' }, VIEWS.map((view) => el('button', {
    class: `chip ${state.ui.galleryView === view.id ? 'on' : ''}`,
    type: 'button', text: view.label, dataset: { view: view.id },
    onClick: () => selectView(view.id),
  })));

  counter = el('span', { class: 'small muted' });
  gridInner = el('div', { class: 'gallery-grid' });
  sentinel = el('div', { class: 'gallery-more', text: '\u2026' });

  const body = el('div', { class: 'scr-body' }, [
    el('div', { class: 'card gallery-toolbar' }, [
      searchInput,
      chipsRow,
      el('div', { class: 'row tight' }, [counter, el('div', { style: { flex: '1 1 auto' } }), archiveUnratedButton()]),
    ]),
    gridInner,
  ]);
  container.append(body);

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadPage();
  }, { root: body, rootMargin: '600px' });
  observer.observe(sentinel);

  feed.view = state.ui.galleryView || 'all';
  feed.query = state.ui.galleryQuery || '';

  on('gallery-refresh', () => loadPage({ reset: true }));
  on('job-finished', () => {
    if (document.body.dataset.tab === 'gallery') loadPage({ reset: true });
  });

  loadPage({ reset: true });
}

export function onShow() {
  loadPage({ reset: true });
}

/* ------------------------------------------------------------------ picker mode */

export function openGalleryPicker() {
  return new Promise((resolve) => {
    let finished = false;
    const gridNode = el('div', { class: 'gallery-grid' });
    const status = el('div', { class: 'gallery-more', text: '' });
    const moreButton = el('button', { class: 'btn wide', type: 'button', text: 'Load more', hidden: true });
    const pickerFeed = { page: 1, done: false, loading: false, query: '' };

    const finish = (item) => {
      if (finished) return;
      finished = true;
      closeSheet();
      resolve(item || null);
    };

    const loadMore = async () => {
      if (pickerFeed.loading || pickerFeed.done) return;
      pickerFeed.loading = true;
      try {
        const data = await api_.gallery({ view: 'all', q: pickerFeed.query, page: pickerFeed.page, size: 36 });
        appendItems(gridNode, data.items || [], finish, false);
        pickerFeed.done = !data.has_more;
        pickerFeed.page += 1;
        moreButton.hidden = pickerFeed.done;
        status.textContent = data.total ? `${data.total} images` : '';
      } catch (error) {
        status.textContent = `load failed: ${error.message}`;
        pickerFeed.done = true;
      } finally {
        pickerFeed.loading = false;
      }
    };
    moreButton.addEventListener('click', loadMore);

    const search = el('input', {
      type: 'search', placeholder: 'search\u2026', autocapitalize: 'off', spellcheck: false,
    });
    search.addEventListener('input', debounce(() => {
      pickerFeed.query = search.value.trim();
      pickerFeed.page = 1;
      pickerFeed.done = false;
      clear(gridNode);
      loadMore();
    }, 350));

    openSheet({
      title: 'Pick an image',
      body: el('div', {}, [search, gridNode, status, moreButton]),
      onClose: () => { if (!finished) { finished = true; resolve(null); } },
    });

    loadMore();
  });
}
