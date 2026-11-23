# 📸 PhotoBot — Bluesky × Chevereto

An automated Bluesky bot that posts photos from your team's Chevereto instance,
with recency-weighted selection, VRChat/VRCX metadata support, a web dashboard,
and DM-based commands.

> **No Node.js or npm knowledge needed** — Docker handles everything.

---

## Features

- **4 photos per post** — each cycle posts one Bluesky image gallery with up to 4 photos
- **Recency bias** — newer uploads are statistically much more likely to be picked
- **Team-aware** — scrapes `/explore/recent` so all photographers' uploads are included automatically
- **Photographer opt-out** — admin-managed exclusion list for uploaders who've asked not to be auto-posted
- **VRChat / VRCX metadata** — detects VRChat screenshots and replies with the world name and a direct VRChat link
- **Album highlights** — announce a new album with its cover photo
- **Member spotlights** — showcase a photographer with an intro post and up to 3 of their recent shots
- **Message templates** — customise exactly what each post type says, with `{variable}` placeholders
- **Creator feature history** — tracks who's been spotlighted and when
- **DM commands** — control the bot by messaging it on Bluesky
- **Web dashboard** — browser-based control panel with live stats, queue viewer, and template editor
- **OIDC / SSO login** — sign in to the dashboard with Google, Authentik, Keycloak, or any OpenID Connect provider
- **Buffer crossposting** — queue posts directly to X, Instagram, LinkedIn, Mastodon, and more via Buffer's API — no Make or Zapier required
- **Membership post drafts** — Patreon & Ko-fi drafts: immediate for spotlights/albums, weekly & monthly photo-count + map-list roundups for regular batches; neither platform's API supports auto-posting, so this is a copy-paste aid, not a crosspost
- **Persistent state** — history and queue survive container restarts in shared storage

---

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Windows) or Docker + Docker Compose (Linux)
- That's it — Node.js and npm are handled inside the container

---

## Quick Start

### 1. Configure your credentials

```bash
cp .env.example .env
```

Open `.env` in any text editor and fill in your values.

**Required:**

| Variable | Description |
|---|---|
| `BLUESKY_HANDLE` | Your bot's Bluesky handle, e.g. `photobot.bsky.social` |
| `BLUESKY_APP_PASSWORD` | Generate one at bsky.social → Settings → App Passwords — do not use your real password |
| `CHEVERETO_BASE_URL` | Your Chevereto site URL, e.g. `https://photos.yourteam.com` |
| `ADMIN_HANDLES` | Comma-separated Bluesky handles that can send DM commands |
| `DASHBOARD_SECRET` | A unique, long random string to protect the web dashboard. Required for password login. You can leave it empty if OIDC is working. |

**Optional:**

| Variable | Default | Description |
|---|---|---|
| `POSTS_PER_HOUR` | `4` | Number of photos per hourly gallery post, from 1 to 4 |
| `CHEVERETO_MEDIA_ORIGINS` | _(unset)_ | Comma-separated origins for image downloads from a separate CDN or storage host. The Chevereto site origin is included automatically. |
| `PHOTOBOT_DATA_DIR` | See [Persistent Data](#persistent-data) | Shared named volume or absolute host directory |
| `SESSION_SECRET` | _(unset)_ | A separate long random string shared by both services. Required for high-resolution Buffer renders. |
| `RECENCY_BIAS` | `1.5` | Higher = newer photos favoured more strongly (1 = uniform random) |
| `DASHBOARD_PORT` | `3000` | Port the dashboard is served on |
| `TRUST_PROXY` | _(unset)_ | Set to `true` when running behind a reverse proxy (nginx, Caddy) — required for secure cookies over HTTPS |
| `PUBLIC_BASE_URL` | _(unset)_ | Your externally-reachable dashboard URL, e.g. `https://photobot.yourdomain.com`. Used with a shared `SESSION_SECRET` to enable high-resolution Twitter/Instagram crossposts — see [Image Quality](#image-quality-for-crossposts) below. Safe to leave unset; crossposting just falls back to the standard thumbnail until it's set. |
| `VRCHAT_API_CONTACT` | _(unset)_ | An email or URL identifying you to VRChat's API, used to fetch each world's tags for the `/worlds` page (e.g. `you@example.com` or `https://yoursite.com`). VRChat requires clients to identify themselves properly — see [World Tags](#world-tags--grouping) below. Safe to leave unset; tag fetching still works but logs a one-time warning, and VRChat may moderate improperly-identified requests. |

> **Tip:** Avoid `#` characters in secret values — `#` starts a comment in `.env` files and will
> silently truncate the value. Use only letters, numbers, and hyphens.

### 2. Start the bot

```bash
docker compose up -d
```

Docker builds the image and starts the bot in the background. It runs
its first scheduled cycle at the next top of the hour. Use **Post Now** in the dashboard to post sooner.

### Deploy from GitHub Container Registry

GitHub Actions tests the image and publishes it from `main` as `ghcr.io/soloflighter1010/bluesky-bot:latest` for Linux AMD64 and ARM64. Each published commit also gets a `sha-<full commit SHA>` tag.

Put `docker-compose.yml`, `docker-compose.ghcr.yml`, and `.env` in the same directory on the deployment host. When switching an existing deployment, use its current Compose project directory and `.env` so Compose keeps using the same storage. If the package is private, run `docker login ghcr.io` with a GitHub account that can read the package and use a classic personal access token with `read:packages` as the password. [GitHub Container Registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry)

With a current Docker Compose v2 release, pull the image and start both services with the same overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

Run the same commands when updating. Set `PHOTOBOT_IMAGE` in `.env` to a specific tag or digest to pin a version. Keep your existing `PHOTOBOT_DATA_DIR` and `CHEVERETO_MEDIA_ORIGINS` values when switching to the registry image.

---

## Day-to-Day Commands

```bash
docker compose up -d        # start the bot or apply .env changes
docker compose down         # stop the bot
docker compose restart      # restart the running containers
docker compose logs -f      # watch live logs
```

---

## Persistent Data

Both containers store their data in `/app/data`. New deployments that copy `.env.example` use the Docker-managed `photobot-data` volume. Existing deployments with no `PHOTOBOT_DATA_DIR` setting keep the bind mount at `/media/Sea1/AppData/photobot`. Set `PHOTOBOT_DATA_DIR` to an absolute host path to use a different directory.

The shared data includes `bot-state.json`, `world-stats.json`, the URL cache, and rotating logs. To back up the files from the active storage location, run this from the Compose project directory:

```bash
mkdir -p photobot-backup
docker compose cp photobot-worker:/app/data/. ./photobot-backup
```

Use the same `PHOTOBOT_DATA_DIR` when updating an existing installation. If you change it, copy the backed-up data into the new location before starting the services.

---

## Web Dashboard

Open `http://localhost:3000` in your browser (replace `localhost` with your server's IP if running remotely).

| Section | What it does |
|---|---|
| **Bot Controls** | Start, pause, trigger an immediate post, or clear the queue |
| **Album Highlight** | Queue an album by its Chevereto hash — posts an intro + cover photo |
| **Member Spotlight** | Queue a photographer by username — posts an intro + up to 3 recent shots |
| **Post Queue** | Live view of everything waiting to be posted |
| **Creator Feature History** | Log of every member spotlight with the date last featured |
| **Bluesky Account Mappings** | Link Chevereto usernames to Bluesky handles for proper @mentions |
| **Excluded Photographers** | Opt out an uploader from all future auto-posting — see below |
| **Custom Tags** | Override the `{tags}` variable injected into every regular post |
| **Message Templates** | Edit what each post type says — changes take effect immediately |
| **Buffer Crossposting** | Connect Buffer directly and select which channels to crosspost to |
| **World Stats** | Rebuild the public world-visit map from the bot's Bluesky history |
| **Activity Log** | In-browser record of dashboard actions |

### Dashboard authentication

The dashboard supports two auth methods simultaneously — either is sufficient:

**Shared secret (default)** — enter the value of `DASHBOARD_SECRET` in the password field on the
login screen. This is the simplest option and requires no extra setup.

**OIDC / SSO** — sign in with Google, Authentik, Keycloak, or any OpenID Connect provider.
When OIDC is configured a **Sign in with SSO** button replaces the password field. After a
successful login your name and avatar initial appear in the header with a Sign out button.
The secret field remains available as a fallback if both are configured.

See [OIDC / SSO Setup](#oidc--sso-setup) below for configuration details.

---

## Excluded Photographers

For uploaders who've asked not to have their photos auto-posted. This is
admin-managed — someone asks you (via Discord, DM, wherever), you add their
Chevereto username to the list in the dashboard, done. There's no
self-service opt-out form.

**What it does:** an excluded username is skipped during selection for
regular batches, in both recency-biased and random mode, and can't be
queued for a new spotlight or album highlight (`!spotlight`/`!highlight`
DM commands and their dashboard equivalents all reject the request with a
clear message). If they already had a spotlight sitting in the queue when
you exclude them, it's removed immediately. An album highlight where every
photo turns out to be from an excluded uploader is rejected outright rather
than posted with no cover image.

**What it doesn't do:** this only ever affects *future* selection. Nothing
already posted gets touched, edited, or taken down — if someone wants
existing posts removed too, that's a separate, manual action (deleting a
real public post is a bigger, more consequential step than this feature is
meant to cover, and isn't something PhotoBot does on its own).

Matching is case-insensitive (`Alice`, `alice`, and `ALICE` are all the same
exclusion) and only ever needs the bare Chevereto username — no `@`, no
platform handle.

### Temporary vs. permanent

Every exclusion is one or the other, chosen when you add it:

- **Temporary** — pick a duration (1 week up to 1 year). It reverts on its
  own once that period passes — nobody needs to remember to go remove it.
  The revert check runs once per scheduler cycle, so it takes effect within
  about an hour of actually expiring, and — like the weekly/monthly roundup
  check — runs even while the bot is paused, so a temporary exclusion
  doesn't end up "stuck on" just because posting happened to be paused when
  it should have expired.
- **Permanent** — stays until you manually remove it. No duration to pick.

Either kind can be removed early at any time with the **Remove** button —
"permanent" means "no expiry date," not "can't be undone." Re-excluding an
already-excluded username (with a new duration, or switching to permanent)
simply overwrites their existing entry — no need to remove and re-add.

---

## OIDC / SSO Setup

OIDC is entirely optional. If none of the `OIDC_*` variables are set, the bot starts normally
with secret-only auth.

### Environment variables

Add these to your `.env`:

| Variable | Required | Description |
|---|---|---|
| `OIDC_ISSUER_URL` | Yes | Discovery URL of your identity provider |
| `OIDC_CLIENT_ID` | Yes | Client ID from your IdP |
| `OIDC_CLIENT_SECRET` | Yes | Client secret from your IdP |
| `OIDC_REDIRECT_URI` | Yes | Must exactly match what you registered with your IdP |
| `OIDC_ALLOWED_EMAILS` | No | Comma-separated allow-list — see below |

### `OIDC_REDIRECT_URI`

Must be your public dashboard URL followed by `/auth/callback`, for example:

```
OIDC_REDIRECT_URI=https://photobot.yourdomain.com/auth/callback
```

This must match the redirect URI you register with your identity provider exactly.

### `OIDC_ALLOWED_EMAILS`

Controls who can log in after authenticating with the IdP. Two formats are supported:

```
# Exact email addresses
OIDC_ALLOWED_EMAILS=alice@example.com,bob@example.com

# Entire domain (anyone at that domain)
OIDC_ALLOWED_EMAILS=@yourteam.com

# Mix of both
OIDC_ALLOWED_EMAILS=contractor@gmail.com,@yourteam.com
```

Leave `OIDC_ALLOWED_EMAILS` unset to allow **any** user your IdP successfully authenticates.
This is fine when your IdP already restricts access (e.g. a self-hosted Authentik instance with
only your team's accounts).

### Provider examples

**Google**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → Create OAuth 2.0 Client ID
2. Application type: **Web application**
3. Add `https://photobot.yourdomain.com/auth/callback` as an Authorised redirect URI
4. Copy the Client ID and Client Secret

```env
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_CLIENT_ID=123456789-abc.apps.googleusercontent.com
OIDC_CLIENT_SECRET=GOCSPX-...
OIDC_REDIRECT_URI=https://photobot.yourdomain.com/auth/callback
OIDC_ALLOWED_EMAILS=@yourteam.com
```

**Authentik**

1. In Authentik admin → Applications → Create — choose **OAuth2/OpenID Provider**
2. Client type: **Confidential**, redirect URI: `https://photobot.yourdomain.com/auth/callback`
3. Note your slug — the issuer URL is `https://auth.yourdomain.com/application/o/<slug>/`

```env
OIDC_ISSUER_URL=https://auth.yourdomain.com/application/o/photobot/
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URI=https://photobot.yourdomain.com/auth/callback
```

**Keycloak**

```env
OIDC_ISSUER_URL=https://keycloak.yourdomain.com/realms/your-realm
OIDC_CLIENT_ID=photobot
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URI=https://photobot.yourdomain.com/auth/callback
```

### Security details

The OIDC implementation uses **PKCE** (`S256`) on every login, which prevents authorization code
interception attacks even if the client secret were compromised. A `nonce` is verified on every
callback to prevent token replay. The session ID is regenerated on successful login to prevent
session fixation. If the identity provider exposes an `end_session_endpoint`, clicking **Sign out**
in the dashboard redirects the browser there to also terminate the IdP session.

---

## Message Templates

Templates use `{variable}` placeholders. Edit them in the dashboard, or directly in
`bot-state.json` in shared storage (see [Persistent Data](#persistent-data)
above for how to get a file in or out of it).

| Template | Variables | Used for |
|---|---|---|
| `regularPost` | `{username}` `{title}` `{tags}` `{url}` | Every scheduled gallery post |
| `albumHighlight` | `{title}` | Album announcement post |
| `memberSpotlight` | `{name}` `{username}` | Photographer spotlight intro |
| `vrcxReply` | `{worldName}` `{worldId}` `{worldUrl}` `{players}` `{photographers}` | VRChat metadata reply thread |
| `patreonPost` | `{sourceTitle}` `{worldInfo}` `{photographers}` `{tags}` | Patreon spotlight/album draft — see [Membership Posts](#membership-posts-patreon--ko-fi) below |
| `kofiPost` | `{sourceTitle}` `{worldInfo}` `{photographers}` | Ko-fi spotlight/album draft — see [Membership Posts](#membership-posts-patreon--ko-fi) below |
| `patreonWeekly` | `{sourceTitle}` `{weekCount}` `{monthToDate}` `{mapList}` | Patreon weekly roundup draft — see [Membership Posts](#membership-posts-patreon--ko-fi) below |
| `kofiWeekly` | `{sourceTitle}` `{weekCount}` `{monthToDate}` `{mapList}` | Ko-fi weekly roundup draft — see [Membership Posts](#membership-posts-patreon--ko-fi) below |
| `patreonMonthly` | `{sourceTitle}` `{monthCount}` `{mapList}` | Patreon monthly roundup draft — see [Membership Posts](#membership-posts-patreon--ko-fi) below |
| `kofiMonthly` | `{sourceTitle}` `{monthCount}` `{mapList}` | Ko-fi monthly roundup draft — see [Membership Posts](#membership-posts-patreon--ko-fi) below |

`{photographers}` in the VRCX reply is only populated when the batch contains photos
from more than one uploader — if the whole post is from one person it stays blank
since they're already credited in the main post.

---

## VRChat / VRCX Metadata

When the bot posts a VRChat screenshot it checks the image file for VRCX metadata
(stored in PNG `tEXt` chunks). If found, it posts a reply to the photo with the
world name and a direct link:

```
🌍 World: 1's Optimized Box
🔗 https://vrchat.com/home/world/wrld_1a8b8684-3b19-4770-a4a7-288762f57b29
```

The format of this reply is controlled by the `vrcxReply` template — edit it in the
dashboard like any other template.

**Requirements for this to work:**

- The image must be a VRChat screenshot taken with VRCX installed
- Chevereto must be serving the **original file** — if your instance re-encodes
  uploaded images to JPEG the PNG metadata will be stripped and detection won't fire

---

## DM Commands

Send direct messages on Bluesky to your bot account from any handle in `ADMIN_HANDLES`.
The bot checks for new messages every 60 seconds and ignores any messages that arrived
before the bot started (so restarting the bot doesn't re-run old commands).

| Command | Effect |
|---|---|
| `!start` | Resume auto-posting |
| `!stop` | Pause auto-posting |
| `!status` | Show running state and stats |
| `!stats` | Posting statistics |
| `!post now` | Trigger an immediate post cycle |
| `!highlight <albumId>` | Queue an album highlight |
| `!spotlight <username>` | Queue a member spotlight |
| `!help` | List all commands |

**Examples:**
```
!highlight abc123def456
!spotlight jane_doe
!post now
!stop
```

> **First-time setup:** Each admin handle needs to send the bot at least one DM first to
> open a conversation thread. Just send `!help` to get started.

---

## Random image selection

Random mode follows Chevereto's random viewer redirect and uses the image's uploader profile for photographer credit. Chevereto usernames use the same per-platform handle mappings as recency-based posts. Random mode skips images whose uploader cannot be identified. Captions omit raw image filenames.

## How Recency Weighting Works

Images are scraped from `/explore/recent` (newest first) and each is assigned a weight:

```
weight[i] = (N - i) ^ BIAS
```

Where `N` is the pool size and `i` is position (0 = newest). With the default `BIAS=1.5`,
the newest images are significantly more likely to be picked while older shots still
occasionally surface. The bot tracks the last 500 posted IDs to avoid re-posting the
same image.

---

## Chevereto Compatibility

The bot scrapes your Chevereto site's public `/explore/recent` page — no API key is
needed. This works with any publicly accessible Chevereto v3 or v4 instance regardless
of API settings.

Pagination is supported (`/explore/recent?page=2`, etc.) and the bot fetches up to
5 pages per cycle. For user spotlights, it first filters `/explore/recent` by username
before falling back to scraping the user's profile page directly.

---

## Buffer Crossposting

After every Bluesky post, PhotoBot can automatically queue the same content to your
connected social channels via Buffer — X, Instagram, LinkedIn, Mastodon, Threads,
and more. This uses Buffer's API directly; no Make, Zapier, or other middleware is
required.

### How it works

PhotoBot calls Buffer's GraphQL API immediately after each successful Bluesky post,
passing the post caption and the Chevereto CDN image URLs. Buffer fetches the images
itself and queues or schedules the post according to your chosen mode. Each configured
channel is posted to independently, so a failure on one channel doesn't affect the others.

### Setting it up

1. Go to [publish.buffer.com/settings/api](https://publish.buffer.com/settings/api) and generate a personal API token
2. Open the PhotoBot dashboard → **📡 Buffer Crossposting**
3. Paste the token into the **Step 1** field and click **Save & Verify** — the dashboard confirms which account it belongs to and shows the token's expiry countdown
4. The **Step 2** channel picker loads automatically — tick every channel you want to receive posts
5. Choose a scheduling mode in **Step 3** (see below), click **Save Config**
6. Click **Send Test Post** to confirm a real post lands in your Buffer queue
7. Click **Enable** to activate crossposting

### Scheduling modes

| Mode | Behaviour |
|---|---|
| **Add to queue** | Post is added to Buffer's pre-set posting schedule for that channel — the next available slot is used |
| **Post immediately** | Post is sent to the platform as soon as Buffer processes it, bypassing the queue schedule |

"Add to queue" is recommended for most setups so posts are spaced out rather than
flooding your followers right after each Bluesky batch.

### Token expiry

Buffer personal API tokens expire **30 days** after creation. The dashboard displays
a countdown and turns it amber when fewer than 5 days remain. When it expires:

1. Go back to [publish.buffer.com/settings/api](https://publish.buffer.com/settings/api)
2. Generate a new token
3. Paste it into the dashboard and click **Save & Verify** — your channel selection and mode are preserved

### What gets crossposted

| Post type | Caption | Images |
|---|---|---|
| Regular batch | `regularPost` template text | Up to 4 shared with Bluesky (Twitter) / up to 10, orientation-matched (Instagram) |
| Member spotlight | `memberSpotlight` template text | Spotlight images (up to 3) |
| Album highlight | `albumHighlight` template text | Text only |

Album highlights are text-only because the cover image comes from a scrape of the
album page rather than a stable CDN URL that Buffer can reliably fetch.

### Threading

Bluesky has always gotten a full reply thread — world info, then per-image links.
Twitter/X and Instagram now get an equivalent, using each platform's own mechanism:

- **Twitter/X:** if the caption plus world info would overflow 280 characters,
  PhotoBot posts a real native thread (via Buffer's `TwitterPostMetadataInput.thread`
  field) instead of truncating — same idea as the Bluesky reply chain, just as
  additional tweets in the thread rather than replies to a separate post.
- **Instagram:** the world info + image links go into the post's first comment
  (Buffer's `firstComment` field) immediately after publishing, mirroring what
  Bluesky does as a reply. Two caveats worth knowing: Instagram doesn't hyperlink
  URLs in captions *or* comments, so these links are plain text there even once
  this works; and as of this writing, Buffer has an open bug where Instagram's
  `firstComment` is silently dropped server-side (it works for Facebook/LinkedIn).
  PhotoBot sends it regardless — it'll start appearing the moment Buffer ships a fix.

### Image quality for crossposts

Twitter and Instagram used to get Chevereto's own `.md.` thumbnail (~1280px,
downscaled for fast page loads on the photo site) — noticeably softer than what
Bluesky gets, since Bluesky's copy comes from the bot's own upload, compressed
only as much as its 1MB blob cap actually requires.

With `PUBLIC_BASE_URL` and a shared `SESSION_SECRET` set, Twitter and Instagram get a purpose-built JPEG
instead — resized from the *original* file (long edge capped at 2048px, quality
88), served from PhotoBot's own `/api/render` endpoint rather than Chevereto's
thumbnail. Buffer fetches from a signed URL pointing at your own dashboard, which
re-renders the image on demand; the signature is derived from `SESSION_SECRET`
(no separate secret to manage) and only ever accepts URLs already hosted on your
own `CHEVERETO_BASE_URL`. When either setting is missing, crossposts use Chevereto thumbnails.

### Instagram orientation matching

Twitter and Bluesky post whatever mix of portrait/landscape shots a batch happens
to have — a mixed carousel doesn't look wrong there. Instagram's carousel does
look inconsistent with mixed orientation, so its image list is curated instead of
transformed: PhotoBot looks at the primary batch's own orientations, picks
whichever orientation is in the majority (ties favor landscape), and builds
Instagram's carousel only from images matching that orientation — filling out
extra slots (up to 10) with other same-orientation images rather than whatever's
next in the queue. No cropping or padding involved, so nothing gets trimmed off a
shot to force a match — Instagram's carousel may just end up smaller than 10 (or
smaller than the other platforms' post) if there aren't enough same-orientation
candidates available that cycle.

### Platform-specific notes

**X (Twitter):** Images must be under 5 MB each — comfortably satisfied by the
re-rendered 2048px JPEG described above.

**Instagram:** Requires a Business or Creator account linked to a Facebook Page in
Buffer. Buffer handles the Facebook API handshake — PhotoBot just supplies the image
URL and caption.

**Caption length:** PhotoBot sends the full `regularPost` template text, then
appends world info if it fits (Instagram: up to 2,200 chars) or threads/comments
it separately if it doesn't (see Threading above).

---

## World Stats — the public world map

A bubble map of every VRChat world the team's photographed in, open to anyone
at `/worlds` — **no login required**. Rebuilding it or triggering a resync is
an admin action and stays behind your dashboard login like everything else;
only *viewing* the map is public.

**Not exhaustive.** A world only shows up here when a photo carries VRCX
metadata — see [VRChat / VRCX Metadata](#vrchat--vrcx-metadata) above for
what that requires. Photographers without VRCX installed won't have their
worlds represented, so this reflects what the bot could detect, not
necessarily everywhere the team has actually shot. The public page carries
the same caveat.

### How the data gets there

Regular batch posts already detect VRCX world metadata and know exactly which
photographer shot which image in which world (that's what builds the Bluesky
reply thread). Going forward, that same data is tallied straight into
`world-stats.json` the moment a post succeeds — no extra scraping, no parsing,
fully accurate.

For anything posted *before* this feature existed, there's no structured
record left — only the reply thread text actually posted to Bluesky. The
**Rebuild from Bluesky History** button in the dashboard's World Stats section
walks the bot's own post history and reconstructs that data from the reply
text instead. The historical scan tracks its own checkpoint and skips posts already counted by the worker. Older state files stored per-world totals without individual post IDs. The backfill preserves those totals and skips dates that overlap those older records for the same world, where it cannot reliably tell which posts were already counted.

Backfill accuracy: world names, URLs, and total photo counts per world are
fully reliable however old the post is. Per-photographer credit is exact for
posts from a single photographer, and exact for posts from multiple
photographers where more than one contributed to the *same* world (the reply
thread explicitly credits who shot what in that case). The one soft spot is
a multi-photographer post where the reply text's format doesn't parse
cleanly — very unlikely with the default `vrcxReply` template, more likely if
that template's been heavily customized on older posts; those get skipped
rather than guessed at, and a summary of anything skipped shows up in the
logs.

### Filtering

The public page includes a photographer filter — selecting one or more people
resizes every bubble to reflect just their contribution to that world (and
fades a world out if the current selection has zero photos there), so it
doubles as a way to compare who's shot where, not just a show/hide toggle.

### World tags & grouping

VRChat lets creators tag their own worlds (visible on the world's official
VRChat page) — PhotoBot pulls the **first two** of those tags for each world
it tracks and uses them to visually group similar maps: same-tagged bubbles
are colored alike and drift toward each other on the map, and there's a tag
filter alongside the photographer one. A world with no author tags is tracked
exactly as before — untagged bubbles are never affected by the tag filter or
the grouping, they just don't participate in it.

A few things worth knowing about where this data comes from:

- **Fetched once, cached forever.** Tags are looked up the first time a world
  is ever recorded (live or via backfill) and never re-checked after —
  VRChat's own API guidance says their rate limits aren't predictable, so
  this avoids hammering them for data that essentially never changes.
- **Unofficial API.** This uses VRChat's community-reverse-engineered API
  (`api.vrchat.cloud`), not an officially documented integration — see
  [vrchat.community](https://vrchat.community) for reference. It could change
  without notice.
- **Identify yourself.** VRChat requires API clients to send a proper
  `appName/version contactInfo` User-Agent, and warns that identifying
  improperly can result in moderation action against the request. Set
  `VRCHAT_API_CONTACT` in `.env` to an email or URL — PhotoBot builds the
  header from that automatically. Works without it, but logs a warning and
  isn't really compliant with VRChat's own rules until it's set.
- **Only the descriptive tags.** VRChat's raw tag list mixes in system,
  admin, and content-warning tags alongside the creator's own; PhotoBot only
  ever pulls the author-set ones (what actually shows as tags on the world's
  page), never content warnings.
- **A failed fetch retries later; an empty result doesn't.** If VRChat can't
  be reached or rate-limits the request, PhotoBot leaves that world untagged
  for now and tries again on the next backfill. If VRChat responds and the
  world genuinely has no author tags, that's treated as a final answer —
  it won't keep re-checking a world that just doesn't have any.

---

## Membership Posts (Patreon & Ko-fi)

**This doesn't auto-post to Patreon or Ko-fi** — it can't. Neither platform's
public API supports creating posts from a third-party app: Patreon's API v2
only exposes `GET` endpoints for reading a campaign's existing posts (no
`POST`/create endpoint exists, and Patreon hasn't provided general developer
support since 2020), and Ko-fi's API is inbound-only, built for payment
notifications, not content. Buffer doesn't support either platform as a
channel either.

What this does instead: prepare ready-to-copy drafts in the dashboard's
**Membership Posts** section, on two different cadences depending on what
kind of post it is —

- **Spotlights and albums** are already occasional, one-off events, so each
  one still gets its own draft immediately, the same way it always has.
- **Regular batch posts** happen far more often (up to `POSTS_PER_HOUR`
  times an hour) — a draft per batch would just mean Patreon/Ko-fi mirroring
  every other platform's cadence, which is exactly what this was changed to
  avoid. Instead, every successful batch quietly adds to a running **weekly**
  and **monthly** tally (image count, plus which VRCX-tagged worlds were shot
  in), and once a week or month actually ends, that tally turns into a single
  roundup draft — a photo count for the period and a list of maps used.

Either way, you review the list, copy whichever ones are worth sharing, and
paste into a new post on each platform manually. The composition work is
automated; the actual publish click isn't, because there's no API for it to
go through.

### What's in a draft

**Spotlight / album drafts:**
- **Title** — "Spotlight: {name}" or the album's title.
- **Body text** — rendered from the `Patreon Post` / `Ko-fi Post` templates.
  Variables: `{sourceTitle}`, `{worldInfo}` (spotlights/albums don't carry
  VRCX world data, so this is always empty for these two — kept for template
  consistency), `{photographers}`, `{tags}` (from your Custom Tags).
- **Image links** — the same high-quality re-rendered images Buffer
  crossposts get (see [Image Quality](#image-quality-for-crossposts) above),
  shown as a separate download list for you to attach manually.

**Weekly / monthly roundup drafts:**
- **Title** — "Weekly Roundup — Jul 20 – Jul 26, 2026" or "Monthly Roundup —
  July 2026".
- **Body text** — rendered from the `Patreon Weekly Roundup` / `Ko-fi Weekly
  Roundup` / `Patreon Monthly Roundup` / `Ko-fi Monthly Roundup` templates.
  Variables: `{weekCount}` / `{monthCount}` (a pre-formatted count line,
  e.g. "📸 47 new photos this week"), `{monthToDate}` (weekly drafts only —
  a running month-to-date count, automatically omitted when it wouldn't add
  new information, e.g. a month's first week), and `{mapList}` — every
  VRCX-tagged world shot in during that period, formatted as a list with a
  built-in disclaimer that **the list isn't necessarily exhaustive, since
  not every photographer uses VRCX metadata** (same caveat as the `/worlds`
  page). `{mapList}` renders empty (no disclaimer either) if nothing was
  VRCX-tagged that period.
- **No image links.** A week or month's worth of shots is too many to
  sensibly attach — these are text-only summaries by design. Attach a
  favorite shot or two yourself if you want images alongside it.

All six templates use blank lines between sections for paragraph spacing,
since these are long-form posts rather than a single compact caption — a
variable that renders empty collapses cleanly rather than leaving a stack
of blank lines.

### Using it

Drafts appear automatically — there's no manual "generate" step for any of
the four types. The dashboard section shows a live **so far this
week/month** counter so you're not wondering whether tracking is actually
happening between roundups, keeps the 50 most recent drafts (newest first),
and is filterable by type (Weekly / Monthly / Spotlight / Album). Each draft
has a **Copy for Patreon** and **Copy for Ko-fi** button, an **Open Patreon
Dashboard** / **Open Ko-fi Dashboard** shortcut at the top of the section,
and a **Dismiss** button once you've used it or decided to skip it.

Weekly periods run Monday–Sunday (UTC); monthly periods are calendar months
(UTC). The rollover check runs once per scheduler cycle (hourly, or on a
manual trigger) rather than on its own separate timer, and — importantly —
runs even while the bot is paused, so a completed week/month doesn't get
stuck waiting for posting to resume. A period with zero photos simply rolls
forward with no draft generated; there's no "0 photos this week" post.

**Previewing without waiting.** Since none of this can be triggered by an
actual post to Patreon or Ko-fi (there's no API for that — see above), the
dashboard has four **🧪 Preview with sample data** buttons, one per draft
shape, for checking what your current templates actually produce without
waiting for a real spotlight, a real album, or an actual week/month to end.
These use obviously-fake sample data (a made-up photographer name, made-up
world names, round numbers) and are unmistakably marked so they can't be
confused with a real draft: the card title is prefixed `[TEST]`, the card
itself gets a dashed amber border and a 🧪 badge, and — the part that
matters if you copy first and look later — **the warning is baked directly
into the copyable text itself**, not just shown in the dashboard UI. Only
the most recent preview of each type is kept; generating a new one replaces
the last rather than piling up. A dedicated **🧪 Test** filter isolates them
from the real Weekly/Monthly/Spotlight/Album views, so a preview never shows
up mixed in with drafts you're actually about to publish.

This section is admin-only, same as the rest of the dashboard (OIDC or
secret auth) — unlike the public `/worlds` page, nothing here is exposed
without logging in.

---

Never expose port 3000 directly. Use a reverse proxy with HTTPS. Set `TRUST_PROXY=true`
in your `.env` when running behind a proxy — this is required for session cookies to work
correctly over HTTPS and for the rate limiter to see real client IPs instead of the
proxy's address.

**Caddy** (handles HTTPS automatically):
```
photobot.yourdomain.com {
    reverse_proxy localhost:3000
}
```

**nginx:**
```nginx
server {
    listen 443 ssl;
    server_name photobot.yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then in `.env`:
```
TRUST_PROXY=true
```

---

## File Structure

```
bluesky-photo-bot/
├── bot.js           Main entry point
├── bluesky.js       AT Protocol / Bluesky API wrapper
├── buffer.js        Buffer GraphQL API client + crossposting + Twitter threading
├── imagerender.js   Signed on-demand image renderer for Twitter/Instagram quality
├── secrets.js        Shared secret resolution (dashboard sessions + render URL signing)
├── textchunk.js     Shared line-aware text chunking (Bluesky replies + Twitter threads)
├── chevereto.js     Chevereto scraper + VRCX metadata + orientation detection
├── scheduler.js     Hourly posting loop + template rendering
├── commands.js      DM command parser
├── dashboard.js     Express REST API + OIDC auth routes + image render route
├── state.js         JSON-backed state + template defaults
├── logger.js        Winston logger
├── webhook.js       Outbound webhook payload builder (generic / custom use)
├── worldstats.js    Per-world photo stats — live recording + Bluesky backfill
├── vrchat.js         Minimal VRChat API client — world tag lookup
├── membershipdrafts.js Patreon/Ko-fi drafts — immediate for spotlight/album, weekly/monthly roundups for batches
├── index.html       Web dashboard UI
├── worlds.html      Public world-visit bubble map (no login required)
├── data/            Created automatically — state, logs
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .env             Your credentials (never commit this)
├── package.json
└── README.md
```
