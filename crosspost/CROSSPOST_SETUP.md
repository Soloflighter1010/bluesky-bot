# Crossposting to X & Instagram via Buffer

This guide walks you through setting up crossposting so your Bluesky photo posts automatically appear on X (Twitter) and Instagram via Buffer.

---

## Prerequisites

1. **Buffer Account** — Free tier is fine, but you'll need an active account at [buffer.com](https://buffer.com)
2. **X (Twitter) Account** — Connected to your Buffer account
3. **Instagram Account** — Connected to your Buffer account (business account recommended)
4. **Buffer API Key** — Generated from your Buffer settings

---

## Step 1: Get Your Buffer API Key

1. Log in to [buffer.com](https://buffer.com)
2. Go to **Settings** → **Apps & Integrations** → **API**
3. Click **Create Access Token**
4. Copy the token (looks like `abc123xyz...`)
5. Paste it into your `.env` file:

```bash
BUFFER_API_KEY=abc123xyz...
```

> ⚠️ **Security**: Never commit your `.env` file to git. This file contains secrets.

---

## Step 2: Connect Your X & Instagram Accounts to Buffer

### X (Twitter)

1. In Buffer, go to **Channels** → **+ Add Channel**
2. Select **X**
3. Click **Connect**, and authorize your X account
4. Confirm the account appears in your Buffer channels list

### Instagram

1. Go to **Channels** → **+ Add Channel**
2. Select **Instagram**
3. You'll need a **Business or Creator account** on Instagram (not personal)
4. Click **Connect**, and authorize the account
5. Confirm it appears in your Buffer channels list

> **Tip**: If you're using a personal Instagram account and can't connect, you'll need to convert it to a Creator or Business account first (Instagram Settings → Account Type).

---

## Step 3: Restart PhotoBot

Once you've added the `BUFFER_API_KEY` to `.env`:

```bash
docker compose restart
```

The bot will now automatically crosspost to Buffer after posting to Bluesky.

---

## Testing the Connection

### Via Dashboard

1. Open the **PhotoBot Dashboard** at `http://localhost:3000`
2. Unlock with your `DASHBOARD_SECRET`
3. Scroll to **Crosspost Configuration** (new section)
4. Click **Test Buffer Connection**
5. You should see your connected X & Instagram accounts listed

### Via Command Line

```bash
curl -H "x-dashboard-secret: YOUR_SECRET" \
  http://localhost:3000/api/crosspost/test
```

Response:
```json
{
  "ok": true,
  "connected": true,
  "profiles": [
    { "id": "xyz123", "service": "twitter", "name": "My X Account" },
    { "id": "abc789", "service": "instagram", "name": "My Instagram" }
  ]
}
```

---

## How Crossposting Works

**When a photo post is made to Bluesky:**

1. ✅ Post succeeds on Bluesky with 4 photos, world info, and viewer links
2. 🔄 Scheduler automatically triggers crosspost
3. 📷 Images are resized for each platform:
   - **X**: 1200×675 px (landscape)
   - **Instagram**: 1080×1350 px (portrait/tall)
4. 📝 Text is adapted for each platform:
   - **X**: Compact version (280 char limit) + top links
   - **Instagram**: Full text (2200 chars) + all metadata
5. 🕐 Posts are queued in Buffer for optimal scheduling
6. ✨ Buffer publishes at your configured best times

---

## Platform-Specific Formatting

### X (Twitter)

```
📸 @alice @bob
Product launch shoot · Team vibes

#photography #VRChat

🔗 Chevereto:
1. https://photos.site/abc123
2. https://photos.site/xyz789
[truncated for space]

🌍 Worlds:
[Img 1] Conference Hall
https://vrchat.com/home/world/wrld_...
```

**Limits:**
- 280 characters (strict)
- Up to 4 images
- Links provided (Chevereto viewer + VRChat world URLs)

### Instagram

```
📸 @alice @bob
Product launch shoot · Team vibes

#photography #VRChat #teamspotlight

🔗 Chevereto:
1. https://photos.site/abc123
2. https://photos.site/xyz789
3. https://photos.site/def456
4. https://photos.site/ghi789

🌍 Worlds:
[Img 1 & 2] Conference Hall
https://vrchat.com/home/world/wrld_...
[Img 3] Studio A
https://vrchat.com/home/world/wrld_...
```

**Limits:**
- 2200 characters (soft)
- Up to 4 images
- Full metadata preserved

---

## Customizing Crosspost Behavior

### Via Dashboard

1. **Crosspost Configuration** section
2. **Enable/Disable** each platform independently
3. **Platform-specific hashtags** — customize tags for X vs Instagram
4. **Test Connection** — verify your accounts are linked

### Via Direct API

Disable X crossposting:
```bash
curl -X POST -H "x-dashboard-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "x",
    "config": { "enabled": false }
  }' \
  http://localhost:3000/api/crosspost/platform-config
```

Toggle all crossposting off (emergency pause):
```bash
curl -X POST -H "x-dashboard-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  http://localhost:3000/api/crosspost/toggle
```

---

## Monitoring Crosspost Activity

### Dashboard Stats

The dashboard shows:
- **X Posts Queued**: Total number of posts sent to Buffer for X
- **Instagram Posts Queued**: Total number of posts sent to Buffer for Instagram
- **Last Post Time**: When the last regular batch was posted

### Log File

View crosspost logs in `./data/bot.log`:

```bash
docker compose logs -f | grep crosspost
```

Example log output:
```
[2026-01-15 14:32:15] INFO   crosspost: processing 4 images for X & Instagram
[2026-01-15 14:32:18] INFO   crosspost: formatted for X and Instagram
[2026-01-15 14:32:25] INFO   crosspost: X post queued — "📸 @alice @bob..."
[2026-01-15 14:32:27] INFO   crosspost: Instagram post queued — "📸 @alice @bob..."
```

### Buffer Dashboard

Log into [buffer.com](https://buffer.com) to see:
- Posts queued for each platform
- When they'll be published
- Engagement metrics once posted

---

## Troubleshooting

### "No X or Instagram profiles connected to Buffer account"

**Problem**: The bot can't find your connected accounts.

**Solution**:
1. Log into [buffer.com](https://buffer.com)
2. Go to **Channels** and confirm X + Instagram are listed
3. Restart the bot: `docker compose restart`
4. Test the connection again via dashboard

### "BUFFER_API_KEY not set"

**Problem**: No API key configured.

**Solution**:
1. Get your API key from buffer.com (see Step 1 above)
2. Add to `.env`:
   ```
   BUFFER_API_KEY=your_key_here
   ```
3. Save and restart: `docker compose restart`

### Posts aren't appearing on X/Instagram

**Problem**: Posts queued in Buffer but not publishing.

**Solution**:
1. Check Buffer's schedule at [buffer.com](https://buffer.com)
2. Verify accounts are still connected (re-auth if needed)
3. Check Buffer plan limits (free tier: max 3 posts/day per platform)
4. Review `./data/bot.log` for crosspost errors

### Images look cropped/wrong aspect ratio

**Problem**: Image resizing not matching your expectation.

**Details**: Sharp resizes images to exact platform specs by center-cropping:
- X: 1200×675 (landscape-heavy)
- Instagram: 1080×1350 (portrait-heavy)

If your photos are mostly one shape, you might want to adjust composition in future shoots, or consider adjusting the resize specs in `src/crosspost.js` (search for `IMAGE_SPECS`).

---

## Advanced: Custom Image Sizes

To change image dimensions for a platform, edit `src/crosspost.js`:

```javascript
const IMAGE_SPECS = {
  x: {
    width: 1200,     // ← change here
    height: 675,     // ← change here
    maxChars: 280,
  },
  // ...
};
```

Then rebuild and restart:
```bash
docker compose up -d --build
```

---

## FAQ

**Q: Will failed crossposting break my Bluesky posts?**
A: No. If Buffer is unavailable or API fails, the bot logs a warning but continues. Bluesky posting is unaffected.

**Q: Can I crosspost to TikTok or other platforms?**
A: Not currently, but you can:
- Add support for Buffer's other platform endpoints (Threads, etc.)
- Contribute a Pull Request to add them
- Use Buffer's own scheduling UI for additional platforms

**Q: Do I need a paid Buffer plan?**
A: No, the free tier works fine. Limitations:
- 3 posts/day per platform (free)
- All features available
- Paid plans unlock more frequent posting

**Q: Can I customize posting times?**
A: Yes, via Buffer's dashboard. Set your optimal posting schedule there, and PhotoBot will queue posts for those times.

**Q: What if X/Instagram accounts change?**
A: Re-connect them in Buffer:
1. buffer.com → Channels
2. Remove old account
3. Add new account
4. Restart bot

---

## Next Steps

1. ✅ Add `BUFFER_API_KEY` to `.env`
2. ✅ Restart the bot
3. ✅ Test connection via dashboard
4. ✅ Trigger a manual post (`!post now` or dashboard button)
5. ✅ Verify posts appear queued in Buffer

**Questions?** Check the bot logs: `docker compose logs bot`
