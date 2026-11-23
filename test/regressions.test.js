const assert = require('node:assert/strict');
const { execFile, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, beforeEach, test } = require('node:test');
const { promisify } = require('node:util');
const { BskyAgent, RichText } = require('@atproto/api');
const axios = require('axios');
const cron = require('node-cron');

const dir = mkdtempSync(join(tmpdir(), 'photobot-tests-'));
const base = 'https://photos.example.test/gallery';
const adminSecret = 'fixture-dashboard-secret-for-tests';
Object.assign(process.env, {
  CHEVERETO_BASE_URL: base,
  DASHBOARD_PORT: '0',
  DASHBOARD_SECRET: adminSecret,
  STATE_FILE: join(dir, 'state.json'),
  WORLD_STATS_FILE: join(dir, 'world-stats.json'),
  LOG_FILE: join(dir, 'bot.log'),
  POSTS_PER_HOUR: '5',
  PUBLIC_BASE_URL: '',
  KUTT_API_KEY: '',
  OIDC_ISSUER_URL: '',
});
const bsky = require('../src/bluesky');
const buffer = require('../src/buffer');
const chevereto = require('../src/chevereto');
const dashboard = require('../src/dashboard');
const scheduler = require('../src/scheduler');
const stateIO = require('../src/state');
const vrchat = require('../src/vrchat');
const worldstats = require('../src/worldstats');

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(process.env.STATE_FILE, { force: true });
  rmSync(process.env.WORLD_STATS_FILE, { force: true });
});

function mockPosting(t) {
  const posted = [];
  t.mock.method(cron, 'schedule', () => {});
  t.mock.method(chevereto, 'downloadImage', async () => ({ buffer: Buffer.from('fixture'), mimeType: 'image/png' }));
  t.mock.method(chevereto, 'extractVRCXMetadata', async () => null);
  t.mock.method(bsky, 'uploadBlob', async () => ({}));
  t.mock.method(bsky, 'postPhotosWithText', async (entries, caption, canPublish) => {
    if (!canPublish()) return null;
    posted.push({ ids: entries.map(({ image }) => image.id), caption });
    return { uri: 'at://did:plc:fixture/app.bsky.feed.post/test', cid: 'fixture' };
  });
  t.mock.method(bsky, 'replyToPost', async root => root);
  return posted;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function viewer(title, photographer) {
  const author = photographer
    ? `<div class="header-content-breadcrum"><a class="user-link" href="/gallery/user/${photographer}">Display Name</a></div>`
    : '<div class="header-content-breadcrum"><span class="user-link">Guest</span></div>';
  return `<meta property="og:title" content="fallback-asset.png">
    <meta property="og:image" content="/gallery/uploads/asset.md.png">
    <nav><a href="/gallery/api-v1">API</a><a href="/gallery/othermember">Other member</a></nav>
    <button data-type="album" data-id="wrongAlbum"></button>
    ${author}<h1 class="viewer-title" data-text="image-title">${title}</h1>`;
}

test('random uploads credit the actual profiles, skip opted-out and unidentified owners, and keep real titles', async t => {
  const posted = mockPosting(t);
  await stateIO.update(state => {
    state.randomMode = true;
    state.userMappings = { Luna: { bluesky: 'luna.example.test' }, kai: { bluesky: 'kai.example.test' } };
    state.excludedUsers = { privateuser: { expiresAt: null } };
  });
  const pages = new Map([
    ['ZZ01', viewer('Anonymous photo', '')],
    ['ZZ02', viewer('Excluded photo', 'PrivateUser')],
    ['AA01', viewer('VRChat_2025-10-11_02-33-44.421_1920x1080.png', 'luna')],
    ['AA02', viewer('Moonlit Bridge', 'kai')],
    ['AA03', viewer('capture-001', 'luna')],
    ['AA04', viewer('capture-002.webp', 'kai')],
    ['AA05', viewer('Unpublished fifth photo', 'kai')],
  ]);
  const ids = pages.keys();
  t.mock.method(axios, 'get', async url => {
    if (url === `${base}/?random`) {
      const id = ids.next().value;
      assert.ok(id, 'only the required viewer pages should be requested');
      return { headers: { location: `/gallery/image/photo.${id}` } };
    }
    const id = url.split('.').at(-1);
    assert.ok(pages.has(id), `unexpected URL: ${url}`);
    return { data: pages.get(id) };
  });

  const trigger = scheduler.startScheduler();
  await trigger().completion;
  assert.deepEqual(posted, [{
    ids: ['AA01', 'AA02', 'AA03', 'AA04'],
    caption: '📸 @luna.example.test @kai.example.test\nMoonlit Bridge\n#photography #VRChat',
  }]);
  assert.deepEqual(stateIO.load().postedIds, ['AA01', 'AA02', 'AA03', 'AA04']);
  assert.equal(stateIO.load().stats.totalPosted, 4);
  assert.equal(ids.next().value, 'AA05');

  await stateIO.update(state => { state.randomMode = false; });
  t.mock.method(chevereto, 'fetchRecentImages', async () => [{
    id: 'BB01', title: 'Morning Light', user: { username: 'Luna' },
  }]);
  await trigger().completion;
  assert.equal(posted.at(-1).caption, '📸 @luna.example.test\nMorning Light\n#photography #VRChat');
});

test('Instagram credits and links match its carousel when it swaps a Bluesky photo', async t => {
  const posted = mockPosting(t);
  const landscape = {
    id: 'AA01', title: 'The Dam', user: { username: 'luna' },
    url: `${base}/uploads/dam.jpg`, url_viewer: `${base}/image/AA01`,
  };
  const portrait = {
    id: 'AA02', title: 'The Tower', user: { username: 'kai' },
    url: `${base}/uploads/tower.jpg`, url_viewer: `${base}/image/AA02`,
  };
  const extra = {
    id: 'AA03', title: 'capture-124', user: { username: 'sol' },
    url: `${base}/uploads/capture-124.jpg`, url_viewer: `${base}/image/AA03`,
  };
  await stateIO.update(state => {
    state.randomMode = true;
    state.buffer.enabled = true;
    state.buffer.token = 'fixture-buffer-token';
    state.buffer.channels = [{ id: 'fixture', service: 'instagram' }];
    state.userMappings = {
      luna: { bluesky: 'luna.example.test', instagram: 'luna.photos' },
      kai: { bluesky: 'kai.example.test', instagram: 'kai.photos' },
      sol: { bluesky: 'sol.example.test', instagram: 'sol.photos' },
    };
  });
  t.mock.method(chevereto, 'fetchRandomImages', async (_limit, seen) =>
    seen.length ? [extra] : [landscape, portrait]);
  t.mock.method(chevereto, 'downloadImage', async ({ id }) => ({
    buffer: Buffer.from(id === portrait.id ? 'portrait' : 'landscape'),
    mimeType: 'image/jpeg',
  }));
  t.mock.method(chevereto, 'getOrientation', async bytes => bytes.toString());
  const crosspost = t.mock.method(buffer, 'crosspost', async () => {});

  const trigger = scheduler.startScheduler();
  await trigger().completion;
  assert.deepEqual(posted[0].ids, [landscape.id, portrait.id]);
  assert.match(posted[0].caption, /@luna\.example\.test @kai\.example\.test/);
  assert.equal(crosspost.mock.callCount(), 1);
  const [, options] = crosspost.mock.calls[0].arguments;
  assert.deepEqual(options.platformImageUrls.instagram, [landscape.url, extra.url]);
  assert.equal(options.platformTexts.instagram, '📸 @luna.photos @sol.photos\nThe Dam\n#photography #VRChat');
  assert.equal(options.firstCommentText.split('\n').slice(1).join('\n'),
    `Image 1: ${landscape.url_viewer}\nImage 2: ${extra.url_viewer}`);
});

test('an opt-out saved during upload removes the photo and its credit from the current batch', async t => {
  const posted = mockPosting(t);
  const excluded = { id: 'AA01', title: 'The Tower', user: { username: 'Kai' } };
  const allowed = { id: 'AA02', title: 'The Dam', user: { username: 'luna' } };
  await stateIO.update(state => { state.randomMode = true; });
  t.mock.method(chevereto, 'fetchRandomImages', async () => [excluded, allowed]);
  t.mock.method(chevereto, 'downloadImage', async ({ id }) => ({
    buffer: Buffer.from(id), mimeType: 'image/jpeg',
  }));
  t.mock.method(bsky, 'uploadBlob', async bytes => {
    if (bytes.toString() === excluded.id) {
      await stateIO.update(state => { state.excludedUsers.kai = { expiresAt: null }; });
    }
    return {};
  });

  const trigger = scheduler.startScheduler();
  await trigger().completion;
  assert.deepEqual(posted, [{ ids: [allowed.id], caption: '📸 luna\nThe Dam\n#photography #VRChat' }]);
  const state = stateIO.load();
  assert.deepEqual(state.postedIds, [allowed.id]);
  assert.equal(state.stats.totalPosted, 1);
  assert.equal(stateIO.isExcluded(state, 'Kai'), true);
});

test('Pause during a cycle prevents publication and a concurrent trigger is rejected', async t => {
  const posted = mockPosting(t);
  const server = await dashboard.startDashboard();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const app = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-dashboard-secret': adminSecret };
  const photo = { id: 'AA01', title: 'Photo', user: { username: 'luna' } };
  const reachedScrape = deferred();
  const finishScrape = deferred();
  t.mock.method(chevereto, 'fetchRecentImages', () => {
    reachedScrape.resolve();
    return finishScrape.promise;
  });

  const trigger = scheduler.startScheduler();
  const running = trigger(false);
  await reachedScrape.promise;
  assert.deepEqual(trigger(), { started: false, reason: 'A posting cycle is already running' });
  const [pause, tags] = await Promise.all([
    fetch(app + '/api/stop', { method: 'POST', headers }),
    fetch(app + '/api/tags', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['fixture'] }),
    }),
  ]);
  assert.equal(pause.status, 200);
  assert.equal(tags.status, 200);
  finishScrape.resolve([photo]);
  await running.completion;
  assert.deepEqual(posted, []);
  assert.equal(stateIO.load().running, false);
  assert.deepEqual(stateIO.load().customTags, ['#fixture']);
  assert.deepEqual(trigger(), { started: false, reason: 'The bot is paused' });

  const logs = await fetch(app + '/api/logs?tail=2', { headers });
  assert.equal(logs.status, 200);
  const body = await logs.json();
  assert.ok(body.lines.length > 0 && body.lines.length <= 2);
});

test('the dashboard and worker can update a shared state file concurrently', async () => {
  const run = promisify(execFile);
  const writes = `
    const stateIO = require('./src/state');
    (async () => {
      const kind = process.argv[1];
      for (let index = 0; index < 12; index++) {
        await stateIO.update(state => {
          if (kind === 'worker') state.stats.totalPosted++;
          else state.customTags.push('#tag-' + index);
        });
      }
    })().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  await Promise.all(['worker', 'dashboard'].map(kind => run(process.execPath, ['-e', writes, kind])));
  const state = stateIO.load();
  assert.equal(state.stats.totalPosted, 12);
  assert.equal(state.customTags.length, 14);
});

test('dashboard rejects old placeholder credentials and image rendering falls back without a shared key', () => {
  const env = { ...process.env, DASHBOARD_SECRET: 'change_me', SESSION_SECRET: '', PUBLIC_BASE_URL: 'https://bot.example.test' };
  const processResult = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { startDashboard } = require('./src/dashboard');
    const { buildRenderUrl } = require('./src/imagerender');
    assert.equal(buildRenderUrl(process.env.CHEVERETO_BASE_URL + '/asset.png'), null);
    assert.rejects(startDashboard, /Set a unique DASHBOARD_SECRET/).catch(err => {
      console.error(err);
      process.exitCode = 1;
    });
  `], { encoding: 'utf8', env });
  assert.equal(processResult.status, 0, processResult.stderr);
});

test('Bluesky rejects oversized photo batches before publishing', async () => {
  await assert.rejects(bsky.postPhotosWithText(new Array(5), 'fixture'), /requires 1–4 images/);
});

test('an unresolved Bluesky handle remains visible credit without an invalid mention facet', async t => {
  t.mock.method(RichText.prototype, 'detectFacets', async function () {
    this.facets = [
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: '' }] },
      { features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'photography' }] },
    ];
  });
  const post = t.mock.method(BskyAgent.prototype, 'post', async () => ({ uri: 'fixture' }));
  const caption = '📸 @luna.example.test #photography';
  await bsky.postPhotosWithText([{ image: { title: 'Fixture' }, blob: {} }], caption);
  const [record] = post.mock.calls[0].arguments;
  assert.equal(record.text, caption);
  assert.deepEqual(record.facets, [{ features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'photography' }] }]);
});

test('world history uses a separate checkpoint, retries failed threads, and preserves exact live credit', async t => {
  t.mock.method(vrchat, 'fetchWorldTags', async () => ({ ok: false }));
  const world = { worldId: 'wrld_fixture', worldName: 'Fixture World', worldUrl: 'https://vrchat.com/home/world/wrld_fixture' };
  const live = { uri: 'at://live', createdAt: new Date().toISOString() };
  const older = { uri: 'at://old', createdAt: '2025-10-11T00:00:00Z', text: '📸 @kai.example.test' };
  const groups = new Map([[world.worldId, { vrcx: world, nums: [1, 2, 3] }]]);
  await worldstats.recordBatch(groups, ['luna', 'luna', 'kai'].map(username => ({
    image: { user: { username } },
  })), username => `${username}.example.test`, live.uri);

  const stops = [];
  t.mock.method(bsky, 'getMyDid', async () => 'did:plc:fixture');
  t.mock.method(bsky, 'getMyRootPosts', async ({ stopAtUri }) => {
    stops.push(stopAtUri);
    return stopAtUri ? [] : [live, older];
  });
  let calls = 0;
  t.mock.method(bsky, 'getThreadText', async uri => {
    assert.equal(uri, older.uri);
    if (++calls === 1) throw new Error('temporary fixture failure');
    return `Image 1 — ${world.worldName}\n🔗 ${world.worldUrl}`;
  });

  assert.equal((await worldstats.runBackfill()).failed, 1);
  assert.equal((await worldstats.runBackfill()).worldHits, 1);
  assert.equal((await worldstats.runBackfill()).worldHits, 0);
  assert.deepEqual(stops, [null, null, live.uri]);
  const entry = worldstats.getPublicData().worlds.find(item => item.worldId === world.worldId);
  assert.equal(entry.totalPhotos, 4);
  assert.equal(entry.photographers['luna.example.test'], 2);
  assert.equal(entry.photographers['kai.example.test'], 2);
});

test('legacy world totals survive the first backfill and older photos can be added', async t => {
  const worldId = 'wrld_legacy';
  const worldUrl = 'https://vrchat.com/home/world/' + worldId;
  const old = { uri: 'at://historical', createdAt: '2024-01-01T14:00:00Z', text: '' };
  const legacy = { uri: 'at://legacy', createdAt: '2025-01-01T14:00:00Z', text: '' };
  writeFileSync(process.env.WORLD_STATS_FILE, JSON.stringify({
    lastSyncedPostUri: legacy.uri,
    worlds: {
      [worldId]: {
        worldId, worldName: 'Legacy World', worldUrl, totalPhotos: 4, photographers: {},
        tags: [], tagsFetchedAt: '2025-01-01T14:00:00Z',
        firstSeen: '2025-01-01T14:00:00Z', lastSeen: '2025-01-01T14:00:00Z',
      },
    },
  }));
  t.mock.method(bsky, 'getMyDid', async () => 'did:plc:fixture');
  t.mock.method(bsky, 'getMyRootPosts', async ({ stopAtUri }) => {
    assert.equal(stopAtUri, null);
    return [legacy, old];
  });
  t.mock.method(bsky, 'getThreadText', async uri => {
    assert.equal(uri, old.uri);
    return `Image 1 — Legacy World\n🔗 ${worldUrl}`;
  });

  assert.equal((await worldstats.runBackfill()).worldHits, 1);
  assert.equal(worldstats.getPublicData().worlds[0].totalPhotos, 5);
});
