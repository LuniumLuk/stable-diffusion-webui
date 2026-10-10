/* Gallery v2 front-end: /gallery/api driven cards, filters, batch actions.
   Mounts into #gallery-v2-root (scripts/gallery_v2_tab.py). ASCII source. */
(function () {
  'use strict';

  var ROOT_ID = 'gallery-v2-root';
  var PAGE = 60;
  var SORTS = [
    ['time_desc', 'Newest first'],
    ['time_asc', 'Oldest first'],
    ['resolution', 'Resolution'],
    ['size', 'File size'],
    ['random', 'Random']
  ];
  var TIMES = [
    ['all', 'Any time'],
    ['1h', 'Last hour'],
    ['1d', 'Last 24h'],
    ['3d', 'Last 3 days'],
    ['7d', 'Last 7 days'],
    ['30d', 'Last 30 days'],
    ['1y', 'Last year']
  ];
  var STATES = [
    ['', 'All'],
    ['active', 'Active'],
    ['staged', 'Staged'],
    ['archived', 'Archived'],
    ['trashed', 'Trash']
  ];
  var RATINGS = [
    ['', 'Any rating'],
    ['endorsed', 'Endorsed'],
    ['disliked', 'Disliked'],
    ['none', 'Unrated']
  ];
  var RESOLUTIONS = [
    ['', 'Any size'],
    ['min1024', '>= 1K'],
    ['min2048', '>= 2K'],
    ['landscape', 'Landscape'],
    ['portrait', 'Portrait'],
    ['square', 'Square']
  ];

  var state = {
    filters: { q: '', preset: 'all', states: [], sources: [], albums: [], show_albumed: false, rating: '', tags: {} },
    sort: 'time_desc',
    limit: PAGE,
    offset: 0,
    total: 0,
    rows: [],
    selected: new Set(),
    facets: null,
    views: [],
    albums: [],
    selectMode: false,
    lastIndex: -1,
    busy: false,
    loadedOnce: false
  };

  function el(id) { return document.getElementById(id); }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function api(path, body) {
    var opts = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) throw new Error((data && data.detail) || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function blobUrl(row, kind) {
    return '/gallery/api/blob?id=' + encodeURIComponent(row.uid) + '&kind=' + kind;
  }

  function fmtTime(mtime) {
    if (!mtime) return '';
    var d = new Date(mtime * 1000);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  function ratingOf(row) {
    var tags = row.tags || [];
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].category === 'rating') return tags[i].name;
    }
    return '';
  }

  function workflowTagsOf(row) {
    var out = [];
    var tags = row.tags || [];
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].category === 'workflow') out.push(tags[i].name);
    }
    return out;
  }

  function expiryText(row) {
    if (row.state !== 'archived' || !row.archive_expires_at) return '';
    var left = row.archive_expires_at - Date.now() / 1000;
    if (left <= 0) return 'expiring';
    var hours = Math.floor(left / 3600);
    var mins = Math.floor((left % 3600) / 60);
    return hours > 0 ? hours + 'h ' + mins + 'm left' : mins + 'm left';
  }

  function activeFilterCount() {
    var f = state.filters;
    var n = 0;
    if (f.q) n++;
    if (f.preset && f.preset !== 'all') n++;
    n += (f.states || []).length;
    n += (f.sources || []).length;
    if (f.rating) n++;
    n += (f.albums || []).length;
    if (f.show_albumed) n++;
    var tags = f.tags || {};
    Object.keys(tags).forEach(function (k) { n += (tags[k] || []).length; });
    if (f.min_width) n++;
    if (f.aspect) n++;
    return n;
  }

  // ---------------------------------------------------------------- chrome

  function chip(label, active, attrs) {
    return '<button class="gv2-chip' + (active ? ' gv2-chip-on' : '') + '" ' + (attrs || '') + '>' +
      esc(label) + '</button>';
  }

  function buildChrome(root) {
    root.innerHTML =
      '<div class="gv2-toolbar">' +
        '<div class="gv2-row gv2-row-main">' +
          '<input id="gv2-q" class="gv2-search" type="search" spellcheck="false" ' +
            'placeholder="search: word, -exclude, &quot;phrase&quot;, tag:x, rating:endorsed, source:qwen, prompt:..., negative:...">' +
          '<select id="gv2-sort" class="gv2-select" title="Sort">' +
            SORTS.map(function (s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('') +
          '</select>' +
          '<select id="gv2-time" class="gv2-select" title="Time range">' +
            TIMES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
          '</select>' +
          '<select id="gv2-rating" class="gv2-select" title="Rating">' +
            RATINGS.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
          '</select>' +
          '<select id="gv2-res" class="gv2-select" title="Resolution">' +
            RESOLUTIONS.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
          '</select>' +
          '<button id="gv2-sync" class="gv2-btn" title="Re-index output folders into the gallery store">Sync</button>' +
          '<button id="gv2-empty-trash" class="gv2-btn gv2-btn-danger" title="Permanently delete all trashed metadata rows">Empty Trash</button>' +
        '</div>' +
        '<div class="gv2-row" id="gv2-states"></div>' +
        '<div class="gv2-row" id="gv2-groups"></div>' +
        '<div class="gv2-row" id="gv2-albums"></div>' +
        '<div class="gv2-row" id="gv2-sources"></div>' +
        '<div class="gv2-row" id="gv2-tags"></div>' +
        '<div class="gv2-row" id="gv2-views"></div>' +
        '<div class="gv2-row gv2-row-status">' +
          '<span id="gv2-count" class="gv2-count"></span>' +
          '<button id="gv2-select" class="gv2-btn gv2-btn-quiet" ' +
            'title="Select multiple items for batch operations (click cards, shift-click for a range)">Select</button>' +
          '<button id="gv2-clear" class="gv2-btn gv2-btn-quiet">Clear filters</button>' +
          '<button id="gv2-refresh" class="gv2-btn gv2-btn-quiet">Refresh</button>' +
        '</div>' +
      '</div>' +
      '<div id="gv2-grid" class="gv2-grid"></div>' +
      '<div id="gv2-more-wrap" class="gv2-more-wrap"><button id="gv2-more" class="gv2-btn gv2-more">Load more</button></div>' +
      '<div id="gv2-batch" class="gv2-batch gv2-batch-hidden">' +
        '<span id="gv2-batch-count"></span>' +
        '<button class="gv2-btn gv2-btn-quiet" data-batch="selectpage" title="Select all items currently loaded in the grid">Select shown</button>' +
        '<button class="gv2-btn" data-batch="endorse">Endorse</button>' +
        '<button class="gv2-btn" data-batch="dislike">Dislike</button>' +
        '<button class="gv2-btn" data-batch="archive">Archive</button>' +
        '<button class="gv2-btn" data-batch="unarchive">Unarchive</button>' +
        '<button class="gv2-btn" data-batch="stage">Stage</button>' +
        '<button class="gv2-btn" data-batch="unstage">Unstage</button>' +
        '<button class="gv2-btn" data-batch="album">Album\u2026</button>' +
        '<button class="gv2-btn gv2-btn-danger" data-batch="trash">Trash</button>' +
        '<button class="gv2-btn gv2-btn-quiet" data-batch="clear">Clear</button>' +
      '</div>' +
      '<div id="gv2-detail" class="gv2-detail gv2-detail-hidden"></div>' +
      '<div id="gv2-toast" class="gv2-toast gv2-toast-hidden"></div>';

    el('gv2-q').addEventListener('input', debounce(function () {
      state.filters.q = el('gv2-q').value.trim();
      resetAndRefresh();
    }, 350));
    el('gv2-sort').addEventListener('change', function () {
      state.sort = el('gv2-sort').value; resetAndRefresh();
    });
    el('gv2-time').addEventListener('change', function () {
      state.filters.preset = el('gv2-time').value; resetAndRefresh();
    });
    el('gv2-rating').addEventListener('change', function () {
      state.filters.rating = el('gv2-rating').value; resetAndRefresh();
    });
    el('gv2-res').addEventListener('change', function () {
      applyResolution(el('gv2-res').value); resetAndRefresh();
    });
    el('gv2-clear').addEventListener('click', function () {
      state.filters = { q: '', preset: 'all', states: [], sources: [], albums: [], show_albumed: false, rating: '', tags: {} };
      el('gv2-q').value = '';
      el('gv2-time').value = 'all';
      el('gv2-rating').value = '';
      el('gv2-res').value = '';
      syncControlsFromFilters();
      resetAndRefresh();
    });
    el('gv2-refresh').addEventListener('click', function () { refreshFacets(); resetAndRefresh(); });
    el('gv2-select').addEventListener('click', function () { setSelectMode(!state.selectMode); });
    el('gv2-more').addEventListener('click', function () { loadPage(true); });
    el('gv2-sync').addEventListener('click', function () { runMaintenance('reindex', 'Sync'); });
    el('gv2-empty-trash').addEventListener('click', function () {
      if (!window.confirm('Permanently remove all trashed items (metadata too)?')) return;
      runMaintenance('empty_trash', 'Empty trash');
    });
    el('gv2-batch').addEventListener('click', function (ev) {
      var action = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-batch') : null;
      if (!action) return;
      if (action === 'clear') { setSelection([]); return; }
      if (action === 'selectpage') { selectPage(); return; }
      if (action === 'album') {
        if (!state.selected.size) { toast('Select items first', true); return; }
        openAlbumForm();
        return;
      }
      var keys = Array.from(state.selected);
      if (action === 'trash' && !window.confirm('Trash ' + keys.length + ' item(s)? The original files and media will be deleted (metadata kept).')) return;
      runAction(action, keys);
    });
  }

  function applyResolution(value) {
    delete state.filters.min_width;
    delete state.filters.aspect;
    if (value === 'min1024') state.filters.min_width = 1024;
    else if (value === 'min2048') state.filters.min_width = 2048;
    else if (value) state.filters.aspect = value;
  }

  function debounce(fn, ms) {
    var t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // ---------------------------------------------------------------- facets

  function refreshFacets() {
    refreshAlbums();
    return api('/gallery/api/facets').then(function (facets) {
      state.facets = facets;
      renderFacetChips();
      renderGroupChips();
      renderStateChips();
    });
  }

  function refreshViews() {
    return api('/gallery/api/views').then(function (data) {
      state.views = (data && data.views) || [];
      renderViews();
    }).catch(function () { renderViews(); });
  }

  function refreshAlbums() {
    return api('/gallery/api/albums').then(function (data) {
      state.albums = (data && data.albums) || [];
      renderAlbums();
    }).catch(function () { renderAlbums(); });
  }

  function albumById(id) {
    var list = state.albums || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function renderAlbums() {
    var box = el('gv2-albums');
    if (!box) return;
    var list = state.albums || [];
    var activeIds = (state.filters.albums || []).filter(function (v) { return typeof v === 'number'; });
    var html = '<span class="gv2-row-label">Albums</span>';
    list.forEach(function (album) {
      var active = activeIds.indexOf(album.id) >= 0;
      var label = album.name + (album.bundled ? ' \u{1F4E6}' : '');
      var title = album.bundled
        ? 'bundled album \u00b7 originals in archive \u00b7 ' + fmtSize(album.bundle_size)
        : 'album \u00b7 click to filter';
      html += countChip(label, album.count, active,
        'data-album="' + album.id + '" title="' + esc(title) + '"');
    });
    var noneActive = (state.filters.albums || []).indexOf('none') >= 0;
    html += countChip('No album', null, noneActive, 'data-album="none" title="items not in any album"');
    html += countChip('Show albumed', null, !!state.filters.show_albumed,
      'data-album-toggle="1" title="Include items that belong to an album (hidden by default; album views show them anyway)"');
    html += '<button class="gv2-btn gv2-btn-quiet" id="gv2-new-album" title="Create an album">+ New album</button>';
    if (activeIds.length === 1) {
      var album = albumById(activeIds[0]);
      if (album) {
        if (album.bundled) {
          html += '<button class="gv2-btn" data-album-act="unbundle" title="Restore originals from the archive">Unbundle</button>';
        } else {
          html += '<button class="gv2-btn" data-album-act="bundle" title="Compress originals into one archive (previews stay viewable)">Bundle</button>';
        }
        html += '<button class="gv2-btn gv2-btn-quiet" data-album-act="rename" title="Rename album">Rename</button>';
        html += '<button class="gv2-btn gv2-btn-danger" data-album-act="delete" title="Delete album (items stay in the gallery)">Delete</button>';
      }
    }
    html += '<span id="gv2-album-create" class="gv2-save-form gv2-save-hidden">' +
      '<input id="gv2-album-create-name" class="gv2-view-name" placeholder="album name\u2026" maxlength="80" spellcheck="false">' +
      '<button class="gv2-btn" id="gv2-album-create-ok">Create</button>' +
      '<button class="gv2-btn gv2-btn-quiet" id="gv2-album-create-cancel">Cancel</button></span>';
    html += '<span id="gv2-album-form" class="gv2-save-form gv2-save-hidden">' +
      '<select id="gv2-album-pick" class="gv2-select" title="Target album"><option value="">new album\u2026</option></select>' +
      '<input id="gv2-album-new" class="gv2-view-name" placeholder="new album name\u2026" maxlength="80" spellcheck="false">' +
      '<button class="gv2-btn" id="gv2-album-apply">Add selected</button>' +
      '<button class="gv2-btn gv2-btn-quiet" id="gv2-album-remove" title="Remove selected items from the picked album">Remove selected</button>' +
      '<button class="gv2-btn gv2-btn-quiet" id="gv2-album-cancel">Cancel</button></span>';
    box.innerHTML = html;

    var pick = el('gv2-album-pick');
    if (pick) {
      list.forEach(function (album) {
        var opt = document.createElement('option');
        opt.value = String(album.id);
        opt.textContent = album.name;
        pick.appendChild(opt);
      });
      if (activeIds.length === 1) pick.value = String(activeIds[0]);
    }
    var newBtn = el('gv2-new-album');
    if (newBtn) {
      newBtn.addEventListener('click', function () {
        var form = el('gv2-album-create');
        if (!form) return;
        form.classList.remove('gv2-save-hidden');
        var input = el('gv2-album-create-name');
        if (input) input.focus();
      });
    }
    var createOk = el('gv2-album-create-ok');
    if (createOk) createOk.addEventListener('click', createAlbumFlow);
    var createCancel = el('gv2-album-create-cancel');
    if (createCancel) {
      createCancel.addEventListener('click', function () {
        var form = el('gv2-album-create');
        if (form) form.classList.add('gv2-save-hidden');
      });
    }
    var createInput = el('gv2-album-create-name');
    if (createInput) {
      createInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') createAlbumFlow();
      });
    }
    var applyBtn = el('gv2-album-apply');
    if (applyBtn) applyBtn.addEventListener('click', applyAlbumForm);
    var removeBtn = el('gv2-album-remove');
    if (removeBtn) removeBtn.addEventListener('click', removeAlbumForm);
    var cancelBtn = el('gv2-album-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', hideAlbumForm);
  }

  function openAlbumForm() {
    renderAlbums();
    var form = el('gv2-album-form');
    if (!form) return;
    form.classList.remove('gv2-save-hidden');
    var input = el('gv2-album-new');
    if (input) input.focus();
  }

  function hideAlbumForm() {
    var form = el('gv2-album-form');
    if (form) form.classList.add('gv2-save-hidden');
  }

  function createAlbumFlow() {
    var input = el('gv2-album-create-name');
    var name = input ? input.value.trim() : '';
    if (!name) { toast('Album name required', true); return; }
    api('/gallery/api/albums', { name: name }).then(function (data) {
      state.albums = (data && data.albums) || [];
      renderAlbums();
      toast('album created: ' + name);
    }).catch(function (err) { toast('Create failed: ' + err.message, true); });
  }

  function applyAlbumForm() {
    if (!state.selected.size) { toast('Select items first', true); return; }
    var keys = Array.from(state.selected);
    var pick = el('gv2-album-pick');
    var newName = el('gv2-album-new').value.trim();
    var body = { add: keys, remove: [] };
    if (newName) body.new_name = newName;
    else if (pick && pick.value) body.album = parseInt(pick.value, 10);
    if (!body.new_name && !body.album) { toast('Pick an album or name a new one', true); return; }
    api('/gallery/api/albums/items', body).then(function (data) {
      state.albums = (data && data.albums) || [];
      renderAlbums();
      var msg = 'added ' + (data.added || 0);
      if (data.moved && data.moved.length) msg += ' (moved from ' + data.moved[0].from + ')'; 
      if (data.errors && data.errors.length) msg += ' \u00b7 ' + data.errors.length + ' failed';
      toast(msg);
      hideAlbumForm();
      resetAndRefresh();
    }).catch(function (err) { toast('Album add failed: ' + err.message, true); });
  }

  function removeAlbumForm() {
    if (!state.selected.size) { toast('Select items first', true); return; }
    var pick = el('gv2-album-pick');
    if (!pick || !pick.value) { toast('Pick an album to remove from', true); return; }
    var keys = Array.from(state.selected);
    api('/gallery/api/albums/items', { album: parseInt(pick.value, 10), add: [], remove: keys })
      .then(function (data) {
        state.albums = (data && data.albums) || [];
        renderAlbums();
        toast('removed ' + (data.removed || 0) + ' from album');
        hideAlbumForm();
        resetAndRefresh();
      })
      .catch(function (err) { toast('Remove failed: ' + err.message, true); });
  }

  function albumAction(act) {
    var activeIds = (state.filters.albums || []).filter(function (v) { return typeof v === 'number'; });
    if (activeIds.length !== 1) return;
    var album = albumById(activeIds[0]);
    if (!album) return;
    if (act === 'bundle') {
      if (!window.confirm('Bundle album "' + album.name + '"? Originals move into one compressed archive; ' +
        'thumbnails and previews stay viewable, but original files need an unbundle first.')) return;
      toast('bundling ' + album.name + '\u2026');
      api('/gallery/api/albums/bundle', { album: album.id }).then(function (data) {
        state.albums = (data && data.albums) || [];
        renderAlbums();
        var msg = 'bundled ' + (data.bundled || 0) + ' item(s) \u00b7 ' + fmtSize(data.bytes || 0);
        if (data.skipped && data.skipped.length) msg += ' \u00b7 skipped ' + data.skipped.length;
        toast(msg);
        resetAndRefresh();
      }).catch(function (err) { toast('Bundle failed: ' + err.message, true); });
      return;
    }
    if (act === 'unbundle') {
      if (!window.confirm('Unbundle "' + album.name + '"? All originals are restored from the archive.')) return;
      toast('unbundling ' + album.name + '\u2026');
      api('/gallery/api/albums/unbundle', { album: album.id }).then(function (data) {
        state.albums = (data && data.albums) || [];
        renderAlbums();
        var msg = 'unbundled \u00b7 restored ' + (data.restored || 0) + ' file(s)';
        if (data.skipped && data.skipped.length) msg += ' \u00b7 skipped ' + data.skipped.length;
        toast(msg);
        resetAndRefresh();
      }).catch(function (err) { toast('Unbundle failed: ' + err.message, true); });
      return;
    }
    if (act === 'delete') {
      if (!window.confirm('Delete album "' + album.name + '"? Items stay in the gallery.')) return;
      api('/gallery/api/albums/delete', { album: album.id }).then(function (data) {
        state.albums = (data && data.albums) || [];
        state.filters.albums = (state.filters.albums || []).filter(function (v) { return v !== album.id; });
        syncControlsFromFilters();
        resetAndRefresh();
        toast('album deleted: ' + album.name);
      }).catch(function (err) { toast('Delete failed: ' + err.message, true); });
      return;
    }
    if (act === 'rename') {
      var name = window.prompt('Rename album "' + album.name + '" to:', album.name);
      if (!name || !name.trim()) return;
      api('/gallery/api/albums/rename', { album: album.id, new_name: name.trim() }).then(function (data) {
        state.albums = (data && data.albums) || [];
        renderAlbums();
        toast('album renamed');
      }).catch(function (err) { toast('Rename failed: ' + err.message, true); });
    }
  }

  function toggleAlbumFilter(value) {
    if (!state.filters.albums) state.filters.albums = [];
    var entry = value === 'none' ? 'none' : parseInt(value, 10);
    var idx = state.filters.albums.indexOf(entry);
    if (idx >= 0) state.filters.albums.splice(idx, 1);
    else state.filters.albums.push(entry);
    syncControlsFromFilters();
    resetAndRefresh();
  }

  function countChip(label, count, active, attr) {
    var badge = (count === null || count === undefined) ? '' : ' <span class="gv2-chip-n">' + count + '</span>';
    return '<button class="gv2-chip' + (active ? ' gv2-chip-on' : '') + '" ' + attr + '>' + esc(label) + badge + '</button>';
  }

  function renderStateChips() {
    var box = el('gv2-states');
    if (!box || !state.facets) return;
    var totals = (state.facets.states) || {};
    var total = 0;
    Object.keys(totals).forEach(function (k) { total += totals[k]; });
    var html = '';
    STATES.forEach(function (entry) {
      var active;
      if (entry[0] === '') active = (state.filters.states || []).length === 0;
      else active = (state.filters.states || []).indexOf(entry[0]) >= 0;
      var count = entry[0] === '' ? total : (totals[entry[0]] || 0);
      html += countChip(entry[1], count, active, 'data-state="' + entry[0] + '"');
    });
    box.innerHTML = html;
  }

  function renderFacetChips() {
    var srcBox = el('gv2-sources');
    if (!srcBox || !state.facets) return;
    var html = '<span class="gv2-row-label">Sources</span>';
    (state.facets.sources || []).forEach(function (src) {
      var active = (state.filters.sources || []).indexOf(src.id) >= 0;
      html += countChip(src.label, src.count, active, 'data-source="' + esc(src.id) + '"');
    });
    srcBox.innerHTML = html;

    var tagBox = el('gv2-tags');
    if (tagBox) {
      var tags = (state.facets.workflow_tags || []).slice(0, 24);
      var html2 = '<span class="gv2-row-label">Tags</span>';
      tags.forEach(function (tag) {
        var active = ((state.filters.tags || {}).workflow || []).indexOf(tag.name) >= 0;
        html2 += countChip(tag.name, tag.count, active, 'data-tag="' + esc(tag.name) + '"');
      });
      html2 += '<span class="gv2-row-hint">' + (state.facets.caption_tags || 0) + ' caption tags indexed (search with tag:name)</span>';
      tagBox.innerHTML = html2;
    }
  }

  function renderGroupChips() {
    var box = el('gv2-groups');
    if (!box || !state.facets) return;
    var html = '<span class="gv2-row-label">Quick filters</span>';
    (state.facets.groups || []).forEach(function (group) {
      html += countChip(group.label, group.count, groupActive(group), 'data-group="' + esc(group.id) + '" title="' +
        esc(groupFilterText(group)) + '"');
    });
    box.innerHTML = html;
  }

  function groupFilterText(group) {
    var f = group.filter || {};
    var parts = [];
    Object.keys(f).forEach(function (k) {
      var v = f[k];
      parts.push(k + '=' + (Array.isArray(v) ? v.join('+') : v));
    });
    return parts.join(' & ');
  }

  function groupActive(group) {
    var f = group.filter || {};
    var keys = Object.keys(f);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var want = f[k];
      var cur = state.filters[k];
      if (Array.isArray(want)) {
        if (!Array.isArray(cur) || cur.length !== want.length) return false;
        for (var j = 0; j < want.length; j++) {
          if (cur.indexOf(want[j]) < 0) return false;
        }
      } else if ((k === 'preset' ? (cur || 'all') : cur) !== want) {
        return false;
      }
    }
    return true;
  }

  function toggleGroup(group) {
    var keys = Object.keys(group.filter || {});
    if (groupActive(group)) {
      keys.forEach(function (k) { delete state.filters[k]; });
    } else {
      keys.forEach(function (k) {
        var v = group.filter[k];
        state.filters[k] = Array.isArray(v) ? v.slice() : v;
      });
    }
    syncControlsFromFilters();
    resetAndRefresh();
  }

  function syncControlsFromFilters() {
    var f = state.filters || {};
    var q = el('gv2-q');
    if (q) q.value = f.q || '';
    var time = el('gv2-time');
    if (time) time.value = f.preset || 'all';
    var rating = el('gv2-rating');
    if (rating) rating.value = f.rating || '';
    var res = el('gv2-res');
    if (res) {
      var value = '';
      if (f.aspect) value = f.aspect;
      else if (f.min_width === 1024) value = 'min1024';
      else if (f.min_width === 2048) value = 'min2048';
      res.value = value;
    }
    renderStateChips();
    renderGroupChips();
    renderAlbums();
    renderFacetChips();
  }

  function canonFilters(f) {
    f = f || {};
    var tags = {};
    Object.keys(f.tags || {}).sort().forEach(function (k) {
      var v = f.tags[k];
      tags[k] = Array.isArray(v) ? v.slice().sort() : v;
    });
    return JSON.stringify({
      q: f.q || '',
      preset: f.preset || 'all',
      states: (f.states || []).slice().sort(),
      sources: (f.sources || []).slice().sort(),
      albums: (f.albums || []).map(String).sort(),
      show_albumed: f.show_albumed ? 1 : 0,
      rating: f.rating || '',
      tags: tags,
      min_width: f.min_width || 0,
      aspect: f.aspect || ''
    });
  }

  function viewIsActive(view) {
    if (!view || !view.filters) return false;
    if ((view.sort || 'time_desc') !== (state.sort || 'time_desc')) return false;
    return canonFilters(view.filters) === canonFilters(state.filters);
  }

  function renderViews() {
    var box = el('gv2-views');
    if (!box) return;
    var html = '<span class="gv2-row-label">Saved filters</span>';
    html += '<button class="gv2-btn gv2-btn-quiet" id="gv2-save-view" ' +
      'title="Save the current filter combination for one-click reuse">Save current</button>';
    (state.views || []).forEach(function (view) {
      html += '<span class="gv2-view-chip">' +
        '<button class="gv2-chip' + (viewIsActive(view) ? ' gv2-chip-on' : '') + '" data-view="' + esc(view.name) + '" title="Apply saved filter">' + esc(view.name) + '</button>' +
        '<button class="gv2-view-x" data-view-del="' + esc(view.name) + '" title="Delete saved filter">\u00d7</button>' +
        '</span>';
    });
    if (!(state.views || []).length) {
      html += '<span class="gv2-row-hint">combine any filters above, then save them here</span>';
    }
    html += '<span id="gv2-save-form" class="gv2-save-form gv2-save-hidden">' +
      '<input id="gv2-view-name" class="gv2-view-name" placeholder="filter name\u2026" maxlength="60" spellcheck="false">' +
      '<button class="gv2-btn" id="gv2-view-ok">Save</button>' +
      '<button class="gv2-btn gv2-btn-quiet" id="gv2-view-cancel">Cancel</button></span>';
    box.innerHTML = html;

    var saveBtn = el('gv2-save-view');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var form = el('gv2-save-form');
        if (!form) return;
        form.classList.remove('gv2-save-hidden');
        var input = el('gv2-view-name');
        if (input) input.focus();
      });
    }
    var okBtn = el('gv2-view-ok');
    if (okBtn) okBtn.addEventListener('click', saveCurrentView);
    var cancelBtn = el('gv2-view-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        var form = el('gv2-save-form');
        if (form) form.classList.add('gv2-save-hidden');
      });
    }
    var nameInput = el('gv2-view-name');
    if (nameInput) {
      nameInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') saveCurrentView();
      });
    }
  }

  function saveCurrentView() {
    var input = el('gv2-view-name');
    var name = input ? input.value.trim() : '';
    if (!name) { toast('Filter name required', true); return; }
    api('/gallery/api/views', { name: name, filters: state.filters, sort: state.sort })
      .then(function (data) {
        state.views = (data && data.views) || [];
        renderViews();
        toast('Filter saved: ' + name);
      })
      .catch(function (err) { toast('Save failed: ' + err.message, true); });
  }

  function applyView(name) {
    var view = (state.views || []).filter(function (v) { return v.name === name; })[0];
    if (!view) return;
    var filters = view.filters || {};
    state.filters = {
      q: filters.q || '',
      preset: filters.preset || 'all',
      states: Array.isArray(filters.states) ? filters.states.slice() : [],
      sources: Array.isArray(filters.sources) ? filters.sources.slice() : [],
      albums: Array.isArray(filters.albums) ? filters.albums.slice() : [],
      show_albumed: !!filters.show_albumed,
      rating: filters.rating || '',
      tags: filters.tags && typeof filters.tags === 'object' ? filters.tags : {}
    };
    if (filters.min_width !== undefined) state.filters.min_width = filters.min_width;
    if (filters.aspect !== undefined) state.filters.aspect = filters.aspect;
    state.sort = view.sort || 'time_desc';
    var sortSelect = el('gv2-sort');
    if (sortSelect) sortSelect.value = state.sort;
    syncControlsFromFilters();
    resetAndRefresh();
    toast('Filter applied: ' + name);
  }

  function deleteView(name) {
    if (!window.confirm('Delete saved filter "' + name + '"?')) return;
    api('/gallery/api/views/delete', { name: name })
      .then(function (data) {
        state.views = (data && data.views) || [];
        renderViews();
        toast('Filter deleted: ' + name);
      })
      .catch(function (err) { toast('Delete failed: ' + err.message, true); });
  }

  function wireChips(root) {
    root.addEventListener('click', function (ev) {
      var albumAct = ev.target.closest ? ev.target.closest('[data-album-act]') : null;
      if (albumAct) { albumAction(albumAct.getAttribute('data-album-act')); return; }
      var delBtn = ev.target.closest ? ev.target.closest('[data-view-del]') : null;
      if (delBtn) { deleteView(delBtn.getAttribute('data-view-del')); return; }
      var target = ev.target.closest ? ev.target.closest('.gv2-chip') : null;
      if (!target) return;
      var view = target.getAttribute('data-view');
      if (view !== null) { applyView(view); return; }
      var albumToggle = target.getAttribute('data-album-toggle');
      if (albumToggle !== null) {
        state.filters.show_albumed = !state.filters.show_albumed;
        syncControlsFromFilters();
        resetAndRefresh();
        return;
      }
      var albumRef = target.getAttribute('data-album');
      if (albumRef !== null) { toggleAlbumFilter(albumRef); return; }
      var groupId = target.getAttribute('data-group');
      if (groupId !== null) {
        var group = ((state.facets || {}).groups || []).filter(function (g) { return g.id === groupId; })[0];
        if (group) toggleGroup(group);
        return;
      }
      var st = target.getAttribute('data-state');
      var src = target.getAttribute('data-source');
      var tag = target.getAttribute('data-tag');
      if (st !== null) {
        state.filters.states = st ? [st] : [];
        resetAndRefresh();
      } else if (src !== null) {
        toggleIn(state.filters, 'sources', src);
        resetAndRefresh();
      } else if (tag !== null) {
        if (!state.filters.tags) state.filters.tags = {};
        if (!state.filters.tags.workflow) state.filters.tags.workflow = [];
        toggleIn(state.filters.tags, 'workflow', tag);
        resetAndRefresh();
      }
    });
  }

  function toggleIn(obj, key, value) {
    if (!obj[key]) obj[key] = [];
    var idx = obj[key].indexOf(value);
    if (idx >= 0) obj[key].splice(idx, 1); else obj[key].push(value);
  }

  // ---------------------------------------------------------------- query

  function resetAndRefresh() {
    state.offset = 0;
    state.limit = PAGE;
    state.rows = [];
    renderViews();
    loadPage(false);
  }

  function loadPage(append) {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    var payload = state.filters;
    payload.limit = state.limit;
    payload.offset = state.offset;
    return api('/gallery/api/query', { filters: payload, sort: state.sort, limit: state.limit, offset: state.offset })
      .then(function (data) {
        state.total = data.total;
        state.stateTotals = data.state_totals || {};
        if (append) {
          state.rows = state.rows.concat(data.rows);
        } else {
          state.rows = data.rows;
          var grid = el('gv2-grid');
          if (grid) grid.innerHTML = '';
        }
        state.offset = state.rows.length;
        renderRows(data.rows, append);
        updateCountLine();
        renderStateChips();
        var more = el('gv2-more-wrap');
        if (more) {
          if (state.rows.length >= state.total) more.classList.add('gv2-more-hidden');
          else more.classList.remove('gv2-more-hidden');
        }
        state.loadedOnce = true;
      })
      .catch(function (err) { toast('Query failed: ' + err.message, true); })
      .finally(function () { state.busy = false; });
  }

  function updateCountLine() {
    var line = el('gv2-count');
    if (!line) return;
    var parts = [state.total + ' item(s)'];
    if (activeFilterCount() > 0) parts.push(activeFilterCount() + ' filter(s)');
    if (state.rows.length < state.total) parts.push('showing ' + state.rows.length);
    line.textContent = parts.join(' \u00b7 ');
  }

  // ---------------------------------------------------------------- cards

  function badge(text, cls) {
    return '<span class="gv2-badge ' + (cls || '') + '">' + esc(text) + '</span>';
  }

  function cardHtml(row) {
    var rating = ratingOf(row);
    var expired = expiryText(row);
    var badges = '';
    if (rating === 'endorsed') badges += badge('\u2605 endorsed', 'gv2-badge-endorsed');
    else if (rating === 'disliked') badges += badge('\u{1F44E} disliked', 'gv2-badge-disliked');
    if (row.state === 'archived') badges += badge('archived' + (expired ? ' \u00b7 ' + expired : ''), 'gv2-badge-archived');
    if (row.state === 'staged') badges += badge('staged', 'gv2-badge-staged');
    if (row.state === 'trashed') badges += badge('trashed', 'gv2-badge-trashed');
    if (row.variant) badges += badge(row.variant, 'gv2-badge-variant');
    if (row.album_id) {
      var album = albumById(row.album_id);
      if (album) badges += badge((album.bundled ? '\u{1F4E6} ' : '') + album.name, 'gv2-badge-album');
    }

    var thumb = row.state === 'trashed'
      ? '<div class="gv2-thumb gv2-thumb-empty">no media</div>'
      : '<img class="gv2-thumb" loading="lazy" src="' + blobUrl(row, 'thumb') + '" alt="">';

    var tags = workflowTagsOf(row).slice(0, 4).map(function (t) {
      return '<span class="gv2-tag">' + esc(t) + '</span>';
    }).join('');

    var meta = [];
    if (row.width && row.height) meta.push(row.width + '\u00d7' + row.height);
    if (row.file_size) meta.push(fmtSize(row.file_size));
    meta.push(row.source);
    meta.push(fmtTime(row.mtime));

    var selected = state.selected.has(row.uid) ? ' gv2-card-selected' : '';
    return '<div class="gv2-card' + selected + '" data-key="' + esc(row.uid) + '">' +
      thumb +
      '<div class="gv2-card-badges">' + badges + '</div>' +
      '<input type="checkbox" class="gv2-check"' + (selected ? ' checked' : '') + ' title="Select">' +
      '<div class="gv2-card-actions">' + actionButtons(row) + '</div>' +
      '<div class="gv2-card-info">' +
        '<div class="gv2-card-meta">' + esc(meta.join(' \u00b7 ')) + '</div>' +
        '<div class="gv2-card-tags">' + tags + '</div>' +
      '</div>' +
    '</div>';
  }

  function actionButtons(row) {
    if (row.state === 'trashed') {
      return '<button data-act="restore" title="Restore metadata (needs live media)">\u21a9</button>' +
        '<button data-act="purge" title="Purge permanently (metadata too)">\u2716</button>';
    }
    var rating = ratingOf(row);
    var html = '';
    html += '<button data-act="endorse" title="Endorse">' + (rating === 'endorsed' ? '\u2605' : '\u2606') + '</button>';
    html += '<button data-act="dislike" title="Dislike">\u{1F44E}</button>';
    html += '<button data-act="archive" title="' + (row.state === 'archived' ? 'Unarchive' : 'Archive (auto-trash in 24h)') + '">\u{1F4E6}</button>';
    if (row.state !== 'archived') {
      html += '<button data-act="stage" title="' + (row.state === 'staged' ? 'Unstage' : 'Stage for review') + '">\u{1F4CC}</button>';
    }
    html += '<button data-act="trash" title="Trash now">\u{1F5D1}</button>';
    return html;
  }

  function renderRows(rows, append) {
    var grid = el('gv2-grid');
    if (!grid) return;
    var html = rows.map(cardHtml).join('');
    if (append) grid.insertAdjacentHTML('beforeend', html);
    else grid.innerHTML = html;
  }

  function updateCard(row) {
    var card = document.querySelector('.gv2-card[data-key="' + cssEscape(row.uid || row.key) + '"]');
    if (!card) return;
    var fresh = state.rows.filter(function (r) { return r.uid === (row.uid || row.key); })[0];
    if (!fresh) return;
    fresh.state = row.state;
    fresh.rating = row.rating;
    fresh.archive_expires_at = row.archive_expires_at;
    var tags = fresh.tags || [];
    tags = tags.filter(function (t) { return t.category !== 'rating'; });
    if (row.rating) tags.push({ category: 'rating', name: row.rating, source: 'user' });
    fresh.tags = tags;
    card.outerHTML = cardHtml(fresh);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function setSelection(keys) {
    state.selected = new Set(keys);
    updateBatchBar();
    document.querySelectorAll('.gv2-card').forEach(function (card) {
      var key = card.getAttribute('data-key');
      var on = state.selected.has(key);
      card.classList.toggle('gv2-card-selected', on);
      var check = card.querySelector('.gv2-check');
      if (check) check.checked = on;
    });
  }

  function updateBatchBar() {
    var bar = el('gv2-batch');
    if (!bar) return;
    var count = el('gv2-batch-count');
    if (count) count.textContent = state.selected.size + ' selected';
    bar.classList.toggle('gv2-batch-hidden', !(state.selectMode || state.selected.size > 0));
    bar.classList.toggle('gv2-batch-off', state.selected.size === 0);
  }

  function setSelectMode(on) {
    state.selectMode = !!on;
    var btn = el('gv2-select');
    if (btn) {
      btn.textContent = state.selectMode ? 'Exit select' : 'Select';
      btn.classList.toggle('gv2-btn-active', state.selectMode);
    }
    var root = el(ROOT_ID);
    if (root) root.classList.toggle('gv2-selecting', state.selectMode);
    if (state.selectMode) {
      updateBatchBar();
      toast('Select mode: click cards to select \u00b7 shift-click selects a range');
    } else {
      setSelection([]);
    }
  }

  function selectPage() {
    state.rows.forEach(function (row) { state.selected.add(row.uid); });
    state.lastIndex = state.rows.length - 1;
    setSelection(Array.from(state.selected));
  }

  function cardSelectClick(key, ev) {
    var idx = -1;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].uid === key) { idx = i; break; }
    }
    if (ev.shiftKey && state.lastIndex >= 0 && idx >= 0) {
      var lo = Math.min(state.lastIndex, idx);
      var hi = Math.max(state.lastIndex, idx);
      for (var j = lo; j <= hi; j++) state.selected.add(state.rows[j].uid);
    } else if (state.selected.has(key)) {
      state.selected.delete(key);
    } else {
      state.selected.add(key);
    }
    state.lastIndex = idx;
    setSelection(Array.from(state.selected));
  }

  // ---------------------------------------------------------------- actions

  function actionFor(row, act) {
    var rating = ratingOf(row);
    if (act === 'endorse') return rating === 'endorsed' ? 'unendorse' : 'endorse';
    if (act === 'dislike') return rating === 'disliked' ? 'undislike' : 'dislike';
    if (act === 'archive') return row.state === 'archived' ? 'unarchive' : 'archive';
    if (act === 'stage') return row.state === 'staged' ? 'unstage' : 'stage';
    if (act === 'restore' || act === 'purge') return act;
    if (act === 'trash') return 'trash';
    return act;
  }

  function runAction(action, keys, params) {
    if (!keys.length) return Promise.resolve();
    return api('/gallery/api/action', { action: action, keys: keys, params: params || {} })
      .then(function (data) {
        (data.changed || []).forEach(function (changed) {
          var row = state.rows.filter(function (r) { return r.uid === changed.key; })[0];
          if (row) {
            changed.uid = row.uid;
            updateCard(changed);
          }
        });
        if (data.errors && data.errors.length) {
          toast('Action "' + action + '" failed for ' + data.errors.length + ' item(s): ' + data.errors[0].error, true);
        } else if (action === 'purge') {
          toast('purged \u00b7 ' + (data.changed || []).length + ' item(s)');
        } else {
          toast(action + ' \u00b7 ' + (data.changed || []).length + ' item(s)');
        }
        if (action === 'trash' || action === 'purge') {
          state.rows = state.rows.filter(function (r) { return keys.indexOf(r.uid) < 0; });
          keys.forEach(function (key) {
            state.selected.delete(key);
            var node = document.querySelector('.gv2-card[data-key="' + cssEscape(key) + '"]');
            if (node) node.parentNode.removeChild(node);
          });
          updateBatchBar();
          updateCountLine();
        }
      })
      .catch(function (err) { toast('Action failed: ' + err.message, true); });
  }

  function runMaintenance(op, label) {
    toast(label + ' running\u2026');
    return api('/gallery/api/maintenance', { op: op })
      .then(function (data) {
        if (op === 'reindex') {
          var stats = (data && data.stats) || {};
          toast(label + ': scanned ' + (stats.scanned || 0) + ', added ' + (stats.added || 0) + ', updated ' + (stats.updated || 0));
        } else {
          toast(label + ' done' + (data && data.removed !== undefined ? ' (' + data.removed + ' removed)' : ''));
        }
        refreshFacets(); resetAndRefresh();
      })
      .catch(function (err) { toast(label + ' failed: ' + err.message, true); });
  }

  // ---------------------------------------------------------------- detail

  function openDetail(uid) {
    var row = state.rows.filter(function (r) { return r.uid === uid; })[0];
    if (!row) return;
    api('/gallery/api/item?id=' + encodeURIComponent(uid)).then(function (item) {
      renderDetail(item);
    }).catch(function (err) { toast('Detail failed: ' + err.message, true); });
  }

  function renderDetail(item) {
    var box = el('gv2-detail');
    if (!box) return;
    var meta = item.meta || {};
    var rows = [
      ['Source', item.source + (item.variant ? ' / ' + item.variant : '')],
      ['Path', item.rel_path || item.path || ''],
      ['Time', fmtTime(item.mtime)],
      ['Size', (item.width || 0) + '\u00d7' + (item.height || 0) + ' \u00b7 ' + fmtSize(item.file_size)],
      ['Seed', meta.seed || ''],
      ['Steps', meta.steps || ''],
      ['Sampler', meta.sampler || ''],
      ['CFG', meta.cfg || ''],
      ['Model', meta.model || '']
    ];
    if (item.album_id) {
      var album = albumById(item.album_id);
      if (album) rows.push(['Album', album.name + (album.bundled ? ' (bundled)' : '')]);
    }
    var img = item.state === 'trashed'
      ? '<div class="gv2-thumb gv2-thumb-empty">no media (trash)</div>'
      : '<img class="gv2-detail-img" src="' + blobUrl(item, 'preview') + '" alt="">';
    var tagPills = (item.tags || []).filter(function (t) { return t.category === 'workflow'; })
      .map(function (t) {
        return '<span class="gv2-tag">' + esc(t.name) +
          ' <button class="gv2-tag-x" data-remove-tag="' + esc(t.name) + '">\u00d7</button></span>';
      }).join('');
    var events = (item.events || []).slice(0, 6).map(function (e) {
      return esc(e.event) + ' \u00b7 ' + esc(e.at);
    }).join('<br>');
    var expiry = expiryText(item);
    box.innerHTML =
      '<div class="gv2-detail-panel">' +
        '<button id="gv2-detail-close" class="gv2-detail-close">\u00d7</button>' +
        img +
        '<div class="gv2-detail-body">' +
          '<div class="gv2-detail-badges">' +
            (item.state && item.state !== 'active' ? badge(item.state, 'gv2-badge-' + item.state) : '') +
            (expiry ? badge(expiry, 'gv2-badge-archived') : '') +
            (item.has_composer ? badge('composer state', 'gv2-badge-variant') : '') +
          '</div>' +
          '<div class="gv2-detail-actions">' +
            '<button class="gv2-btn" data-detail-act="endorse">Endorse</button>' +
            '<button class="gv2-btn" data-detail-act="dislike">Dislike</button>' +
            '<button class="gv2-btn" data-detail-act="archive">Archive</button>' +
            '<button class="gv2-btn" data-detail-act="stage">Stage</button>' +
            '<button class="gv2-btn gv2-btn-danger" data-detail-act="trash">Trash</button>' +
            (item.state === 'trashed'
              ? '<button class="gv2-btn" data-detail-act="restore">Restore metadata</button>' +
                '<button class="gv2-btn gv2-btn-danger" data-detail-act="purge">Purge</button>'
              : '') +
          '</div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">Workflow tags</div>' +
            '<div class="gv2-detail-tags">' + (tagPills || '<span class="gv2-row-hint">none</span>') + '</div>' +
            '<div class="gv2-detail-tagadd"><input id="gv2-detail-taginput" placeholder="add tag\u2026">' +
            '<button class="gv2-btn" id="gv2-detail-tagadd">+</button></div>' +
          '</div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">Prompt</div>' +
            '<div class="gv2-detail-prompt">' + esc(item.prompt || '') + '</div>' +
            '<button class="gv2-btn gv2-btn-quiet" id="gv2-copy-prompt">Copy prompt</button></div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">Negative</div>' +
            '<div class="gv2-detail-prompt">' + esc(item.negative_prompt || '') + '</div></div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">Parameters</div>' +
            rows.filter(function (r) { return r[1] !== '' && r[1] !== null && r[1] !== undefined; })
              .map(function (r) { return '<div class="gv2-detail-row"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>'; }).join('') +
          '</div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">History</div>' +
            '<div class="gv2-detail-history">' + (events || 'none') + '</div></div>' +
        '</div>' +
      '</div>';
    box.classList.remove('gv2-detail-hidden');

    el('gv2-detail-close').addEventListener('click', closeDetail);
    box.addEventListener('click', function (ev) {
      if (ev.target === box) closeDetail();
    });
    box.querySelectorAll('[data-detail-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-detail-act');
        runAction(act, [item.uid], {}).then(function () {
          api('/gallery/api/item?id=' + encodeURIComponent(item.uid)).then(renderDetail).catch(function () {});
        });
      });
    });
    var addBtn = el('gv2-detail-tagadd');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var value = el('gv2-detail-taginput').value.trim();
        if (!value) return;
        runAction('add_tag', [item.uid], { tag: value, category: 'workflow' }).then(function () {
          api('/gallery/api/item?id=' + encodeURIComponent(item.uid)).then(renderDetail).catch(function () {});
          refreshFacets();
        });
      });
    }
    box.querySelectorAll('[data-remove-tag]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        runAction('remove_tag', [item.uid], { tag: btn.getAttribute('data-remove-tag'), category: 'workflow' })
          .then(function () {
            api('/gallery/api/item?id=' + encodeURIComponent(item.uid)).then(renderDetail).catch(function () {});
            refreshFacets();
          });
      });
    });
    var copyBtn = el('gv2-copy-prompt');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(item.prompt || '');
        toast('Prompt copied');
      });
    }
  }

  function closeDetail() {
    var box = el('gv2-detail');
    if (box) box.classList.add('gv2-detail-hidden');
  }

  // ---------------------------------------------------------------- misc

  var toastTimer = null;
  function toast(message, isError) {
    var box = el('gv2-toast');
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('gv2-toast-error', !!isError);
    box.classList.remove('gv2-toast-hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.add('gv2-toast-hidden'); }, 3200);
  }

  function wireGrid(root) {
    root.addEventListener('change', function (ev) {
      var check = ev.target;
      if (!check.classList || !check.classList.contains('gv2-check')) return;
      var card = check.closest('.gv2-card');
      if (!card) return;
      var key = card.getAttribute('data-key');
      if (check.checked) state.selected.add(key); else state.selected.delete(key);
      setSelection(Array.from(state.selected));
    });
    root.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.gv2-check')) return;
      var btn = ev.target.closest ? ev.target.closest('.gv2-card-actions button') : null;
      if (btn) {
        ev.stopPropagation();
        var card = btn.closest('.gv2-card');
        var key = card.getAttribute('data-key');
        var row = state.rows.filter(function (r) { return r.uid === key; })[0];
        if (!row) return;
        var act = actionFor(row, btn.getAttribute('data-act'));
        if (act === 'trash' && !window.confirm('Trash now? The original file and media will be deleted (metadata kept).')) return;
        if (act === 'purge' && !window.confirm('Purge permanently? The trash metadata row will be removed for good.')) return;
        runAction(act, [key], {});
        return;
      }
      var cardClick = ev.target.closest ? ev.target.closest('.gv2-card') : null;
      if (cardClick) {
        if (state.selectMode) cardSelectClick(cardClick.getAttribute('data-key'), ev);
        else openDetail(cardClick.getAttribute('data-key'));
      }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var box = el('gv2-detail');
      if (box && !box.classList.contains('gv2-detail-hidden')) { closeDetail(); return; }
      if (state.selectMode) setSelectMode(false);
    });
  }

  // ---------------------------------------------------------------- init

  var scheduled = false;
  function scheduleInit() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      init();
    }, 250);
  }

  function init() {
    var root = el(ROOT_ID);
    if (!root || root.dataset.gv2Init === '1') return;
    root.dataset.gv2Init = '1';
    buildChrome(root);
    wireChips(root);
    wireGrid(root);
    refreshViews();
    refreshFacets().then(function () { loadPage(false); });
    // infinite scroll
    if (window.IntersectionObserver) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && state.loadedOnce && state.rows.length < state.total && !state.busy) {
            loadPage(true);
          }
        });
      }, { rootMargin: '600px' });
      observer.observe(el('gv2-more-wrap'));
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    startObserver();
    scheduleInit();
  });
  startObserver();
  scheduleInit();

  // gradio renders the tab lazily - watch DOM mutations to mount when it appears
  var _observerStarted = false;
  function startObserver() {
    if (_observerStarted) return;
    var target = document.documentElement;
    if (!target) return;
    _observerStarted = true;
    new MutationObserver(scheduleInit).observe(target, { childList: true, subtree: true });
  }
})();
