'use strict';

const numberFormat = new Intl.NumberFormat();
const pageSize = 20;
const compactMap = window.matchMedia('(max-width: 560px)');
const stackedLayout = window.matchMedia('(max-width: 760px)');
const byId = id => document.getElementById(id);
const searchInput = byId('world-search');
const tagSearch = byId('tag-search');
const mapStage = byId('map-stage');
const worldList = byId('world-list');
const detailPanel = byId('detail-panel');
const detailTitle = byId('detail-title');

const selectedPhotographers = new Set();
const selectedTags = new Set();
const facets = [
  { id: 'photographer', selection: selectedPhotographers, values: [], counts: new Map() },
  { id: 'tag', selection: selectedTags, values: [], counts: new Map() },
];

let worlds = [];
let results = [];
let mapEntries = [];
let selectedId = null;
let view = 'map';
let listLimit = pageSize;
let loaded = false;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatPhotos(count) {
  return `${numberFormat.format(count)} ${count === 1 ? 'photo' : 'photos'}`;
}

function tagHue(tag = '') {
  let hash = 0;
  for (const character of tag) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return [259, 195, 167, 305, 226, 32][hash % 6];
}

function worldHue(world) {
  return tagHue(world.tags.find(tag => selectedTags.has(tag)) ?? world.tags[0]);
}

function photoCount(world) {
  if (!selectedPhotographers.size) return world.totalPhotos;
  return world.credits.reduce((total, [name, count]) =>
    total + (selectedPhotographers.has(name) ? count : 0), 0);
}

function ranked(a, b) {
  return b.count - a.count || a.world.worldName.localeCompare(b.world.worldName);
}

function updateResults() {
  const terms = searchInput.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  results = worlds.flatMap(world => {
    if (!terms.every(term => world.searchText.includes(term))) return [];
    if (selectedTags.size && !world.tags.some(tag => selectedTags.has(tag))) return [];
    const count = photoCount(world);
    return count > 0 ? [{ world, count }] : [];
  }).sort(ranked);
  if (!results.some(({ world }) => world.worldId === selectedId)) {
    selectedId = results[0]?.world.worldId ?? null;
  }

  const count = results.length;
  byId('result-count').textContent =
    `${numberFormat.format(count)} ${count === 1 ? 'world' : 'worlds'}${hasFilters() ? ' matching' : ''}`;
  renderFilterSummary();
  renderView();
  renderDetails();
}

function hasFilters() {
  return Boolean(searchInput.value.trim() || selectedPhotographers.size || selectedTags.size);
}

function renderView() {
  const hasResults = results.length > 0;
  const showingMap = view === 'map';
  byId('map-view').setAttribute('aria-pressed', String(showingMap));
  byId('list-view').setAttribute('aria-pressed', String(!showingMap));
  byId('results-title').textContent = showingMap ? 'World map' : 'World list';
  byId('sort-control').hidden = showingMap || !hasResults;
  byId('map-legend').hidden = !showingMap || !hasResults;
  byId('empty-results').hidden = hasResults;
  byId('map-panel').hidden = !hasResults || !showingMap;
  byId('list-panel').hidden = !hasResults || showingMap;
  if (!hasResults) return;
  if (showingMap) renderMap();
  else renderList();
}

function makeWorldButton(className, { world, count }) {
  const button = make('button', className);
  button.type = 'button';
  button.dataset.worldId = world.worldId;
  button.setAttribute('aria-label', `${world.worldName}, ${formatPhotos(count)}`);
  button.setAttribute('aria-pressed', String(world.worldId === selectedId));
  button.addEventListener('click', () => selectWorld(world.worldId));
  return button;
}

function renderMap() {
  const limit = compactMap.matches ? 18 : 36;
  const rows = results.slice(0, limit);
  const selected = results.find(({ world }) => world.worldId === selectedId);
  if (selected && !rows.includes(selected)) rows[rows.length - 1] = selected;

  mapEntries = rows.map(row => {
    const button = makeWorldButton('world-node', row);
    button.title = `${row.world.worldName} · ${formatPhotos(row.count)}`;
    button.style.setProperty('--hue', worldHue(row.world));
    const label = make('span', 'node-label', row.world.worldName);
    const count = make('span', 'node-count', numberFormat.format(row.count));
    button.append(label, count);
    return { button, label, count, photos: row.count };
  });

  mapStage.replaceChildren(...mapEntries.map(({ button }) => button));
  byId('map-count').textContent = results.length > rows.length
    ? `Showing ${rows.length} of ${numberFormat.format(results.length)} worlds`
    : `Showing all ${numberFormat.format(rows.length)}`;
  byId('view-all-worlds').hidden = results.length <= rows.length;
  positionMap();
}

function packMap(entries, width, height) {
  // Place circles on a deterministic spiral with a gap, then fit their bounds to the stage.
  const circles = [];
  const maxPhotos = Math.max(...entries.map(({ photos }) => photos));
  const aspect = Math.max(1, Math.min(1.6, width / height * 0.82));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (const { photos } of entries) {
    const radius = 16 + 78 * Math.pow(photos / maxPhotos, 0.34);
    let x;
    let y;
    let step = 0;
    do {
      const distance = 8 * Math.sqrt(step);
      const angle = step * goldenAngle;
      x = Math.cos(angle) * distance * aspect;
      y = Math.sin(angle) * distance;
      step++;
    } while (circles.some(circle =>
      (x - circle.x) ** 2 + (y - circle.y) ** 2 < (radius + circle.radius + 8) ** 2));
    circles.push({ x, y, radius });
  }

  const left = Math.min(...circles.map(({ x, radius }) => x - radius));
  const right = Math.max(...circles.map(({ x, radius }) => x + radius));
  const top = Math.min(...circles.map(({ y, radius }) => y - radius));
  const bottom = Math.max(...circles.map(({ y, radius }) => y + radius));
  const scale = Math.min(1.24, (width - 36) / (right - left), (height - 36) / (bottom - top));
  return circles.map(({ x, y, radius }) => ({
    x: width / 2 + (x - (left + right) / 2) * scale,
    y: height / 2 + (y - (top + bottom) / 2) * scale,
    radius: radius * scale,
  }));
}

function positionMap() {
  const { clientWidth: width, clientHeight: height } = mapStage;
  if (!mapEntries.length || !width || !height || view !== 'map') return;
  packMap(mapEntries, width, height).forEach(({ x, y, radius }, index) => {
    const { button, label, count } = mapEntries[index];
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    button.style.width = button.style.height = `${radius * 2}px`;
    button.style.setProperty('--label-size', `${Math.max(10, Math.min(17, radius / 4.2))}px`);
    button.style.setProperty('--count-size', `${Math.max(9, Math.min(12, radius / 3.3))}px`);
    const labelled = index < (compactMap.matches ? 3 : 8) && radius >= 29;
    label.hidden = radius < 44 && !labelled;
    count.hidden = radius < 11;
  });
}

function tagElement(tag) {
  const element = make('span', 'world-tag', tag);
  element.style.setProperty('--hue', tagHue(tag));
  return element;
}

function vrchatUrl(worldId) {
  if (!/^wrld_[a-z0-9-]+$/i.test(worldId)) return null;
  return `https://vrchat.com/home/world/${encodeURIComponent(worldId)}`;
}

function renderList() {
  const sorted = byId('world-sort').value === 'name'
    ? [...results].sort((a, b) => a.world.worldName.localeCompare(b.world.worldName))
    : results;

  worldList.replaceChildren(...sorted.slice(0, listLimit).map(row => {
    const item = make('li', 'list-world-row');
    const button = makeWorldButton('list-world', row);
    const label = make('span');
    label.append(make('span', 'list-world-title', row.world.worldName));
    if (row.world.tags.length) {
      const tags = make('span', 'world-tags');
      tags.append(...row.world.tags.slice(0, 3).map(tagElement));
      label.append(tags);
    }
    button.append(label, make('span', 'list-world-count', formatPhotos(row.count)));
    item.append(button);
    const url = vrchatUrl(row.world.worldId);
    if (url) {
      const link = make('a', 'list-world-link');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `Open ${row.world.worldName} in VRChat`);
      const icon = make('span', 'external-icon');
      icon.setAttribute('aria-hidden', 'true');
      link.append(icon);
      item.append(link);
    }
    return item;
  }));
  const shown = Math.min(listLimit, results.length);
  byId('list-count').textContent = `Showing ${numberFormat.format(shown)} of ${numberFormat.format(results.length)}`;
  byId('show-more').hidden = shown >= results.length;
}

function selectWorld(worldId) {
  selectedId = worldId;
  const visibleButtons = view === 'map' ? mapStage : worldList;
  for (const button of visibleButtons.querySelectorAll('[data-world-id]')) {
    button.setAttribute('aria-pressed', String(button.dataset.worldId === selectedId));
  }
  renderDetails();
  if (stackedLayout.matches) {
    detailTitle.focus({ preventScroll: true });
    detailPanel.scrollIntoView({ block: 'nearest' });
  }
}

function renderDetails() {
  const selected = results.find(({ world }) => world.worldId === selectedId);
  detailPanel.hidden = !selected;
  if (!selected) return;
  const { world, count } = selected;
  detailPanel.style.setProperty('--hue', worldHue(world));
  detailTitle.textContent = world.worldName;
  byId('detail-photo-count').textContent = formatPhotos(count);
  byId('detail-tags').replaceChildren(...world.tags.map(tagElement));
  byId('detail-tags').hidden = !world.tags.length;

  const credits = world.credits
    .filter(([name]) => !selectedPhotographers.size || selectedPhotographers.has(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const attributed = credits.reduce((total, [, photos]) => total + photos, 0);
  if (count > attributed) credits.push(['Unattributed', count - attributed]);
  byId('detail-credits').hidden = !credits.length;
  byId('credit-list').replaceChildren(...credits.map(([name, photos]) => {
    const item = make('li', 'credit-row');
    const bar = make('span', 'credit-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = make('span');
    fill.style.width = `${Math.min(100, photos / count * 100)}%`;
    bar.append(fill);
    item.append(make('span', 'credit-name', name), make('span', 'credit-count', numberFormat.format(photos)), bar);
    return item;
  }));

  const link = byId('visit-world');
  const url = vrchatUrl(world.worldId);
  link.hidden = !url;
  if (url) link.href = url;
}

function renderFacet(facet) {
  const query = facet.id === 'tag' ? tagSearch.value.toLowerCase().trim() : '';
  const options = facet.values.filter(value => value.toLowerCase().includes(query));
  const container = byId(`${facet.id}-options`);
  if (!options.length) {
    container.replaceChildren(make('p', 'no-options', 'No matching tags.'));
    return;
  }
  container.replaceChildren(...options.map(value => {
    const label = make('label', 'option-row');
    const checkbox = make('input');
    checkbox.value = value;
    checkbox.type = 'checkbox';
    checkbox.checked = facet.selection.has(value);
    const count = make('span', 'option-count', numberFormat.format(facet.counts.get(value) ?? 0));
    count.setAttribute('aria-hidden', 'true');
    label.append(checkbox, make('span', 'option-name', value), count);
    return label;
  }));
}

function renderFilterSummary() {
  const chips = [];
  let total = 0;
  for (const facet of facets) {
    const badge = byId(`${facet.id}-count`);
    badge.hidden = !facet.selection.size;
    badge.textContent = String(facet.selection.size);
    total += facet.selection.size;
    for (const value of facet.selection) {
      if (chips.length >= 5) break;
      const button = make('button', 'filter-chip', value);
      button.type = 'button';
      button.setAttribute('aria-label', `Remove ${value} filter`);
      const cross = make('span', '', '×');
      cross.setAttribute('aria-hidden', 'true');
      button.append(cross);
      button.addEventListener('click', () => {
        facet.selection.delete(value);
        renderFacet(facet);
        listLimit = pageSize;
        updateResults();
        const summary = byId(`${facet.id}-facet`).querySelector('summary');
        summary.focus();
      });
      chips.push(button);
    }
  }
  if (total > chips.length) chips.push(make('span', 'filter-chip', `+${total - chips.length}`));
  byId('filter-chips').replaceChildren(...chips);
  byId('active-filters').hidden = !hasFilters();
}

function clearFilters() {
  searchInput.value = '';
  tagSearch.value = '';
  for (const facet of facets) {
    facet.selection.clear();
    renderFacet(facet);
  }
  listLimit = pageSize;
  updateResults();
  searchInput.focus();
}

function showLoadState(heading, message, retry = false) {
  byId('load-state').hidden = false;
  byId('load-heading').textContent = heading;
  byId('load-message').textContent = message;
  byId('load-message').hidden = !message;
  byId('retry-load').hidden = !retry;
  byId('explorer').hidden = true;
}

async function loadWorlds() {
  try {
    const response = await fetch('/api/world-stats');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.worlds)) throw new Error('World data is missing');

    worlds = data.worlds.map(({ worldId, worldName, totalPhotos, tags, photographers }) => {
      // Older random posts sometimes recorded the gallery API link as the uploader.
      const credits = Object.entries(photographers ?? {}).filter(([name, count]) =>
        count > 0 && name.trim().toLowerCase().replace(/^@/, '') !== 'api-v1');
      const worldTags = tags ?? [];
      const searchText = [worldName, ...worldTags, ...credits.map(([name]) => name)].join(' ').toLowerCase();
      return { worldId, worldName, totalPhotos, tags: worldTags, credits, searchText };
    });
    const [photographers, tags] = facets;
    photographers.counts = new Map();
    tags.counts = new Map();
    for (const world of worlds) {
      for (const [name] of world.credits) photographers.counts.set(name, (photographers.counts.get(name) ?? 0) + 1);
      for (const tag of world.tags) tags.counts.set(tag, (tags.counts.get(tag) ?? 0) + 1);
    }
    photographers.values = [...photographers.counts.keys()].sort((a, b) => a.localeCompare(b));
    tags.values = [...tags.counts.keys()].sort((a, b) => tags.counts.get(b) - tags.counts.get(a) || a.localeCompare(b));
    byId('stat-worlds').textContent = numberFormat.format(worlds.length);
    byId('stat-photos').textContent = numberFormat.format(worlds.reduce((total, world) => total + world.totalPhotos, 0));
    byId('stat-photographers').textContent = numberFormat.format(photographers.values.length);
    const refreshed = data.updatedAt ? new Date(data.updatedAt) : new Date();
    byId('updated').textContent = `Refreshed ${refreshed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    loaded = true;

    if (!worlds.length) {
      showLoadState('No worlds yet', 'Worlds appear here when photos with VRCX metadata are recorded.');
      return;
    }
    for (const facet of facets) {
      byId(`${facet.id}-facet`).hidden = !facet.values.length;
      renderFacet(facet);
    }
    byId('load-state').hidden = true;
    byId('explorer').hidden = false;
    updateResults();
  } catch {
    if (!loaded) showLoadState('Worlds could not load', 'Please try again in a moment.', true);
    else byId('updated').textContent = 'Refresh unavailable';
  }
}

for (const facet of facets) {
  const panel = byId(`${facet.id}-facet`);
  panel.addEventListener('toggle', () => {
    if (!panel.open) return;
    for (const other of document.querySelectorAll('.facet[open]')) {
      if (other !== panel) other.open = false;
    }
    if (facet.id === 'tag') tagSearch.focus();
  });
  panel.addEventListener('change', ({ target }) => {
    if (target.type !== 'checkbox') return;
    if (target.checked) facet.selection.add(target.value);
    else facet.selection.delete(target.value);
    listLimit = pageSize;
    updateResults();
  });
}
document.addEventListener('pointerdown', ({ target }) => {
  for (const panel of document.querySelectorAll('.facet[open]')) {
    if (!panel.contains(target)) panel.open = false;
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const panel = event.target.closest('.facet[open]');
  if (!panel) return;
  panel.open = false;
  panel.querySelector('summary').focus();
  event.preventDefault();
});

searchInput.addEventListener('input', () => {
  listLimit = pageSize;
  updateResults();
});
tagSearch.addEventListener('input', () => renderFacet(facets[1]));
byId('map-view').addEventListener('click', () => { view = 'map'; renderView(); });
byId('list-view').addEventListener('click', () => { view = 'list'; renderView(); });
byId('view-all-worlds').addEventListener('click', () => {
  view = 'list';
  renderView();
  byId('list-view').focus();
});
byId('world-sort').addEventListener('change', () => { listLimit = pageSize; renderList(); });
byId('show-more').addEventListener('click', () => {
  const previousLimit = listLimit;
  listLimit += pageSize;
  renderList();
  worldList.children[previousLimit]?.querySelector('button').focus();
});
byId('clear-filters').addEventListener('click', clearFilters);
byId('reset-results').addEventListener('click', clearFilters);
byId('retry-load').addEventListener('click', loadWorlds);
compactMap.addEventListener('change', () => { if (view === 'map' && results.length) renderMap(); });
new ResizeObserver(positionMap).observe(mapStage);

loadWorlds();
setInterval(loadWorlds, 5 * 60_000);
