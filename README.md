# 📸 PhotoBot — Bluesky × Chevereto

An automated Bluesky bot that posts photos from your team's Chevereto instance,
with recency-weighted randomisation, a web dashboard, and DM-based commands.

> **No Node.js or npm knowledge needed** — Docker handles everything.

---

## Features

- **Hourly posting** — posts 4 photos per hour (configurable), staggered 5 min apart
- **Recency bias** — newer uploads are statistically much more likely to be picked
- **Team-aware** — fetches from all photographers on your shared Chevereto instance
- **Album highlights** — announce new albums with their cover photo
- **Member spotlights** — showcase a photographer with an intro + 3 recent shots
- **DM commands** — control the bot from Bluesky direct messages
- **Web dashboard** — browser-based control panel at `localhost:3000`
- **Persistent state** — survives restarts (saved to `./data/` on your machine)

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
| `BLUESKY_APP_PASSWORD` | Generate one at bsky.social → Settings → App Passwords |
| `CHEVERETO_BASE_URL` | Your Chevereto site URL, e.g. `https://photos.yourteam.com` |
| `CHEVERETO_API_KEY` | Found in Chevereto admin → Dashboard → API |
| `ADMIN_HANDLES` | Comma-separated Bluesky handles that can send DM commands |
| `DASHBOARD_SECRET` | A random string to protect the web dashboard — make it long |

**Optional:**

| Variable | Default | Description |
|---|---|---|
| `POSTS_PER_HOUR` | `4` | Photos posted per hour |
| `RECENCY_BIAS` | `3.0` | Higher = newer photos favoured more (1 = uniform random) |
| `DASHBOARD_PORT` | `3000` | Port the dashboard is available on |

### 2. Start the bot

```bash
docker compose up -d
```

Docker will build the image and start the bot in the background. That's it.

The bot will:
1. Log into Bluesky
2. Run an initial post cycle immediately on startup
3. Post every hour at :00
4. Poll DMs every 60 seconds for commands
5. Serve the dashboard at `http://localhost:3000`

---

## Day-to-Day Commands

```bash
docker compose up -d        # start the bot
docker compose down         # stop the bot
docker compose restart      # restart (required after editing .env)
docker compose logs -f      # watch live logs
```

---

## Persistent Data

Bot state (posted image history, queue, stats) and logs are written to a `./data/`
folder in the project directory — not inside the container. This means:

- Restarting or rebuilding the container **never loses your history**
- You can inspect or back up `./data/bot-state.json` at any time
- Logs are at `./data/bot.log`

---

## Web Dashboard

Open `http://localhost:3000` in your browser (or replace `localhost` with your
server's IP/hostname if running remotely).

Enter your `DASHBOARD_SECRET` to unlock controls:

- **Start / Pause** the bot
- **Post Now** — trigger an immediate batch
- **Queue an Album** — enter a Chevereto album ID or hash
- **Queue a Spotlight** — enter a Chevereto username
- Live stats: total posted, last post time, queue depth, uptime

---

## DM Commands

Send direct messages on Bluesky to your bot account from any handle listed in
`ADMIN_HANDLES`. The bot checks for new messages every 60 seconds.

| Command | Effect |
|---|---|
| `!start` | Resume auto-posting |
| `!stop` | Pause auto-posting |
| `!status` | Show running state and stats |
| `!stats` | Posting statistics |
| `!post now` | Trigger an immediate batch post |
| `!highlight <albumId>` | Queue an album highlight |
| `!spotlight <username>` | Queue a member spotlight |
| `!help` | List all commands |

### Examples

```
!highlight abc123def456
!spotlight jane_doe
!post now
!stop
```

> **Note:** Each admin handle needs to send the bot at least one DM first to open
> a conversation thread before commands will work. Just send a `!help` to get started.

---

## How Recency Weighting Works

Images are fetched newest-first from Chevereto. Each image is assigned a weight:

```
weight[i] = (N - i) ^ BIAS
```

Where `N` is the pool size, `i` is the index (0 = newest), and `BIAS` is `RECENCY_BIAS`.

With the default `BIAS=3.0`, the newest image is roughly 1000× more likely to be
picked than the oldest in a pool of 500. Fresh uploads get shared quickly while
older gems still occasionally surface.

---

## Exposing the Dashboard Publicly

If you're running on a server and want the dashboard accessible over the internet,
**do not expose port 3000 directly**. Put it behind a reverse proxy with HTTPS.

**Caddy** (simplest option — handles HTTPS automatically):

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
    }
}
```

---

## Chevereto API Notes

- The bot uses the **Chevereto v3/v4 JSON API** (`/api/1/...`)
- Your API key must have **read** access to images, albums, and users
- Images are fetched up to 5 pages × 100 per page = 500 most recent uploads
- The bot tracks the last 500 posted image IDs to avoid repeats

---

## File Structure

```
bluesky-photo-bot/
├── src/
│   ├── bot.js           Main entry point
│   ├── bluesky.js       AT Protocol / Bluesky API wrapper
│   ├── chevereto.js     Chevereto API + recency weighting
│   ├── scheduler.js     Hourly posting loop
│   ├── commands.js      DM command parser
│   ├── dashboard.js     Express REST API
│   ├── state.js         JSON-backed state persistence
│   └── logger.js        Winston logger
├── dashboard/
│   └── index.html       Web dashboard UI
├── data/                Created automatically — holds state & logs
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .env                 Your credentials (never commit this)
├── package.json
└── README.md
```
