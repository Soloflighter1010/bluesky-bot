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
- **VRChat / VRCX metadata** — detects VRChat screenshots and replies with the world name and a direct VRChat link
- **Album highlights** — announce a new album with its cover photo
- **Member spotlights** — showcase a photographer with an intro post and up to 3 of their recent shots
- **Message templates** — customise exactly what each post type says, with `{variable}` placeholders
- **Creator feature history** — tracks who's been spotlighted and when
- **DM commands** — control the bot by messaging it on Bluesky
- **Web dashboard** — browser-based control panel with live stats, queue viewer, and template editor
- **Persistent state** — history and queue survive container restarts (saved to `./data/` on your machine)

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

Open `.env` in any text editor and fill in your values:

**Required:**

| Variable | Description |
|---|---|
| `BLUESKY_HANDLE` | Your bot's Bluesky handle, e.g. `photobot.bsky.social` |
| `BLUESKY_APP_PASSWORD` | Generate one at bsky.social → Settings → App Passwords — do not use your real password |
| `CHEVERETO_BASE_URL` | Your Chevereto site URL, e.g. `https://photos.yourteam.com` |
| `ADMIN_HANDLES` | Comma-separated Bluesky handles that can send DM commands |
| `DASHBOARD_SECRET` | A long random string to protect the web dashboard |

**Optional:**

| Variable | Default | Description |
|---|---|---|
| `POSTS_PER_HOUR` | `4` | Number of photos included in each hourly gallery post |
| `RECENCY_BIAS` | `3.0` | Higher = newer photos favoured more strongly (1 = uniform random) |
| `DASHBOARD_PORT` | `3000` | Port the dashboard is served on |

> **Tip:** Avoid `#` characters in your `DASHBOARD_SECRET` — the `#` starts a comment in `.env` files
> and will silently truncate the value. Use only letters, numbers, and hyphens.

### 2. Start the bot

```bash
docker compose up -d
```

Docker builds the image and starts the bot in the background. On first start it runs
an immediate post cycle so you don't have to wait for the top of the hour.

---

## Day-to-Day Commands

```bash
docker compose up -d        # start the bot
docker compose down         # stop the bot
docker compose restart      # restart after editing .env
docker compose logs -f      # watch live logs
```

---

## Persistent Data

Everything important is written to a `./data/` folder on your machine, not inside the container:

- `./data/bot-state.json` — posted image history, highlight queue, spotlight history, templates
- `./data/bot.log` — rolling log file (3 × 5 MB)

Rebuilding or updating the container never loses this data.

---

## Web Dashboard

Open `http://localhost:3000` in your browser (replace `localhost` with your server's IP if running remotely).

Enter your `DASHBOARD_SECRET` to unlock the full controls:

| Section | What it does |
|---|---|
| **Bot Controls** | Start, pause, trigger an immediate post, or clear the queue |
| **Album Highlight** | Queue an album by its Chevereto hash — posts an intro + cover photo |
| **Member Spotlight** | Queue a photographer by username — posts an intro + up to 3 recent shots |
| **Post Queue** | Live view of everything waiting to be posted |
| **Creator Feature History** | Log of every member spotlight with the date last featured |
| **Message Templates** | Edit what each post type says — changes take effect immediately |
| **Activity Log** | In-browser record of dashboard actions |

---

## Message Templates

Templates use `{variable}` placeholders. Edit them in the dashboard or directly in
`./data/bot-state.json`.

| Template | Variables | Used for |
|---|---|---|
| `regularPost` | `{username}` `{title}` `{tags}` `{url}` | Every scheduled gallery post |
| `albumHighlight` | `{title}` | Album announcement post |
| `memberSpotlight` | `{name}` `{username}` | Photographer spotlight intro |
| `vrcxReply` | `{worldName}` `{worldId}` `{worldUrl}` `{players}` `{photographers}` | VRChat metadata reply thread |

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

**Requirements for this to work:**

- The image must be a VRChat screenshot taken with VRCX installed
- Chevereto must be serving the **original file** — if your instance re-encodes
  uploaded images to JPEG the PNG metadata will be stripped and detection won't fire

---

## DM Commands

Send direct messages on Bluesky to your bot account from any handle in `ADMIN_HANDLES`.
The bot checks for new messages every 60 seconds.

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

## How Recency Weighting Works

Images are scraped from `/explore/recent` (newest first) and each is assigned a weight:

```
weight[i] = (N - i) ^ BIAS
```

Where `N` is the pool size and `i` is position (0 = newest). With the default `BIAS=3.0`,
the newest image is roughly 1000× more likely to be picked than the oldest in a pool of
500. Fresh uploads surface quickly while older shots still occasionally appear. The bot
tracks the last 500 posted IDs to avoid re-posting the same image.

---

## Chevereto Compatibility

The bot scrapes your Chevereto site's public `/explore/recent` page — no API key is
needed. This works with any publicly accessible Chevereto v3 or v4 instance regardless
of API settings.

Pagination is supported (`/explore/recent?page=2`, etc.) and the bot fetches up to
5 pages per cycle. For user spotlights, it first filters `/explore/recent` by username
before falling back to scraping the user's profile page directly.

---

## Crossposting via Make / Zapier + Buffer

After every successful post the bot fires a webhook to a URL you configure in the
dashboard. Make or Zapier receives a structured JSON payload and can route it to
Buffer (which then schedules it to X, Instagram, Facebook, etc.) or directly to
any platform they support.

### Setting it up

1. Open the dashboard → **📡 Crossposting Webhook** section
2. Paste your Make or Zapier webhook URL
3. Click **Save**, then **Send Test** to confirm delivery
4. Tick **Enabled** and save again

### Webhook payload

Every event includes the same core fields:

```json
{
  "event":         "post",
  "postedAt":      "2026-04-08T12:00:00.000Z",
  "blueskyUrl":    "https://bsky.app/profile/.../post/...",
  "text":          "📸 @alice.bsky.social\n#photography #VRChat",
  "images": [
    {
      "viewerUrl":  "https://images.yoursite.com/image/AbCd123",
      "directUrl":  "https://cdn.yoursite.com/2026/04/image.png",
      "altText":    "The Black Cat | https://vrchat.com/home/world/wrld_...",
      "vrcx": {
        "worldName": "The Black Cat",
        "worldUrl":  "https://vrchat.com/home/world/wrld_4cf4e...",
        "worldId":   "wrld_4cf4e..."
      }
    }
  ],
  "worlds": [
    {
      "worldName":    "The Black Cat",
      "worldUrl":     "https://vrchat.com/home/world/wrld_4cf4e...",
      "worldId":      "wrld_4cf4e...",
      "imageNumbers": [1, 3]
    }
  ],
  "photographers": ["@alice.bsky.social"],
  "replyText":     "🌍 World Information\nImages 1 & 3 — The Black Cat\nVisit: https://...",
  "linkText":      "🔗 View on Chevereto\nImage 1: https://...\nImage 2: https://..."
}
```

`event` can be `"post"` (regular batch), `"spotlight"` (member spotlight), or `"album"`.

### Make scenario

1. **Trigger:** Custom Webhook — copy the webhook URL into the dashboard
2. **Router:** branch on `event` if you want different handling per type
3. **Iterator:** over `images[]` to process each photo
4. **Buffer — Create Post:** map fields:
   - Caption: `{{text}}` + newline + `{{replyText}}` (truncate to platform limit)
   - Media URL: `{{directUrl}}` from the iterator
   - Profile: whichever X / Instagram account you've linked to Buffer
5. Send a test from the dashboard, then run the scenario once manually to confirm

### Zapier scenario

1. **Trigger:** Webhooks by Zapier → Catch Hook
2. **Action:** Buffer → Add to Buffer
   - Caption: combine `text` and `replyText` fields
   - Photo URL: `directUrl` from `images` (use Zapier's line-item support)

### Platform-specific notes

**X (Twitter):** Images must be under 5 MB each. The bot already compresses to
stay under Bluesky's 1 MB limit so this is automatically satisfied.

**Instagram:** Requires a Business or Creator account linked to a Facebook Page.
Buffer handles this via their Instagram integration — the bot just supplies the
image URL and caption.

**Caption length:** Use `text` alone for short captions, or append `replyText`
for the world info block. Truncate at the platform limit before passing to Buffer
(Twitter: 280, Instagram: 2200).

---

## Exposing the Dashboard Publicly

Never expose port 3000 directly. Use a reverse proxy with HTTPS.

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
    location / { proxy_pass http://localhost:3000; }
}
```

---

## File Structure

```
bluesky-photo-bot/
├── src/
│   ├── bot.js           Main entry point
│   ├── bluesky.js       AT Protocol / Bluesky API wrapper
│   ├── chevereto.js     Chevereto scraper + VRCX metadata extraction
│   ├── scheduler.js     Hourly posting loop + template rendering
│   ├── commands.js      DM command parser
│   ├── dashboard.js     Express REST API
│   ├── state.js         JSON-backed state + template defaults
│   └── logger.js        Winston logger
├── dashboard/
│   └── index.html       Web dashboard UI
├── data/                Created automatically — state, logs
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .env                 Your credentials (never commit this)
├── package.json
└── README.md
```