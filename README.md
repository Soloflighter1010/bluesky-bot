# 📸 PhotoBot — Bluesky × Chevereto

An automated Bluesky bot that posts photos from your team's Chevereto instance,
with recency-weighted randomisation, a web dashboard, and DM-based commands.

---

## Features

- **Hourly posting** — posts 4 photos per hour (configurable), staggered 5 min apart
- **Recency bias** — newer uploads are statistically much more likely to be picked
- **Team-aware** — fetches from all photographers on your shared Chevereto instance
- **Album highlights** — announce new albums with their cover photo
- **Member spotlights** — showcase a photographer with an intro + 3 recent shots
- **DM commands** — control the bot from Bluesky direct messages
- **Web dashboard** — browser-based control panel at `localhost:3000`
- **Persistent state** — survives restarts (state saved to `bot-state.json`)

---

## Quick Start

### 1. Install dependencies

```bash
cd bluesky-photo-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

**Required settings:**

| Variable | Description |
|---|---|
| `BLUESKY_HANDLE` | Your bot's Bluesky handle, e.g. `photobot.bsky.social` |
| `BLUESKY_APP_PASSWORD` | Generate one at bsky.social → Settings → App Passwords |
| `CHEVERETO_BASE_URL` | Your Chevereto site URL, e.g. `https://photos.yourteam.com` |
| `CHEVERETO_API_KEY` | Found in Chevereto admin → Dashboard → API |
| `ADMIN_HANDLES` | Comma-separated Bluesky handles that can send DM commands |
| `DASHBOARD_SECRET` | A random secret string to protect the web dashboard |

**Optional settings:**

| Variable | Default | Description |
|---|---|---|
| `POSTS_PER_HOUR` | `4` | Photos posted per hour |
| `RECENCY_BIAS` | `3.0` | Higher = newer photos favoured more (1 = uniform) |
| `DASHBOARD_PORT` | `3000` | Web dashboard port |

### 3. Run the bot

```bash
npm start
```

The bot will:
1. Log into Bluesky
2. Run an initial post cycle immediately
3. Post every hour at :00
4. Poll DMs every 60 seconds for commands
5. Serve the dashboard at `http://localhost:3000`

---

## Web Dashboard

Open `http://localhost:3000` in your browser.

Enter your `DASHBOARD_SECRET` to unlock controls:

- **Start / Pause** the bot
- **Post Now** — trigger an immediate batch
- **Queue an Album** — enter a Chevereto album ID or hash
- **Queue a Spotlight** — enter a Chevereto username
- Live stats: total posted, last post time, queue depth

---

## DM Commands

Send direct messages on Bluesky to your bot account from any handle in `ADMIN_HANDLES`:

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

---

## How Recency Weighting Works

Images are fetched newest-first from Chevereto. Each image is assigned a weight:

```
weight[i] = (N - i)^BIAS
```

Where `N` is the pool size, `i` is the index (0 = newest), and `BIAS` is `RECENCY_BIAS`.

With `BIAS=3.0`, the newest image is ~1000× more likely to be picked than the oldest
in a pool of 500. This means your fresh uploads get shared quickly while older gems
still occasionally appear.

---

## Deployment (Production)

### Using PM2

```bash
npm install -g pm2
pm2 start src/bot.js --name photobot
pm2 save
pm2 startup
```

### Using a systemd service

```ini
[Unit]
Description=PhotoBot Bluesky Bot
After=network.target

[Service]
WorkingDirectory=/path/to/bluesky-photo-bot
ExecStart=/usr/bin/node src/bot.js
Restart=always
EnvironmentFile=/path/to/bluesky-photo-bot/.env

[Install]
WantedBy=multi-user.target
```

### Exposing the dashboard securely

Use a reverse proxy (nginx/Caddy) with HTTPS. Never expose port 3000 directly.

```nginx
location /photobot/ {
  proxy_pass http://localhost:3000/;
}
```

---

## Chevereto API Notes

- The bot uses the **Chevereto v3/v4 JSON API** (`/api/1/...`)
- Your API key must have **read** access to images, albums, and users
- Images are fetched up to 5 pages × 100 per page = 500 most recent
- The bot tracks the last 500 posted image IDs to avoid repeats

---

## File Structure

```
bluesky-photo-bot/
├── src/
│   ├── bot.js          Main entry point
│   ├── bluesky.js      AT Protocol / Bluesky API wrapper
│   ├── chevereto.js    Chevereto API + recency weighting
│   ├── scheduler.js    Hourly posting loop
│   ├── commands.js     DM command parser
│   ├── dashboard.js    Express REST API
│   ├── state.js        JSON-backed state persistence
│   └── logger.js       Winston logger
├── dashboard/
│   └── index.html      Web dashboard UI
├── .env.example
├── package.json
└── README.md
```
