# Crosspost Feature Integration Guide

This document explains how to integrate the crossposting feature into your existing PhotoBot codebase.

---

## Overview

The crosspost feature adds automatic posting to X (Twitter) and Instagram via Buffer after each Bluesky post. It consists of:

- **New module**: `src/crosspost.js` — Buffer API client & image formatting
- **Updated module**: `src/scheduler.js` — calls crosspost after Bluesky posts
- **Updated module**: `src/state.js` — stores crosspost config
- **Updated module**: `src/dashboard.js` — adds config endpoints
- **Updated file**: `dashboard/index.html` — adds UI for crosspost settings
- **Updated file**: `.env.example` — adds Buffer API key option
- **New doc**: `CROSSPOST_SETUP.md` — user-facing setup instructions

---

## Integration Steps

### Step 1: Add the Crosspost Module

Copy the contents of `crosspost.js` into your `src/` directory:

```bash
cp /home/claude/crosspost.js src/
```

This module handles:
- Buffer API authentication and calls
- Image resizing for each platform
- Text formatting for character limits
- VRCX metadata inclusion

### Step 2: Update scheduler.js

Replace `src/scheduler.js` with the updated version:

```bash
cp /home/claude/scheduler.js src/
```

**Key changes:**
- Line 10: Added `const crosspost = require('./crosspost');`
- Line 156–163: In `postBatch()`, after successful Bluesky post, calls:
  ```javascript
  const entriesWithBuffers = downloaded.map(({ image, blob, buffer }) => ({
    image,
    blob: { ...blob, imageBuffer: buffer },
  }));
  await crosspost.triggerCrosspost(entriesWithBuffers, text, state, vrcxByImageId);
  ```

**What it does:**
- Passes downloaded images (with their original buffers)
- Passes VRCX metadata
- Passes state (for templates, mappings, tags)
- Runs *after* Bluesky posts successfully
- Won't break Bluesky posting if it fails

### Step 3: Update state.js

Replace `src/state.js` with the updated version:

```bash
cp /home/claude/state.js src/
```

**Key additions:**
```javascript
crosspost: {
  enabled: true,
  platforms: {
    x: { enabled: true, hashtags: [...] },
    instagram: { enabled: true, hashtags: [...] },
  },
},
stats: {
  // ... existing stats ...
  xPosted: 0,
  instagramPosted: 0,
}
```

This ensures crosspost settings persist across restarts.

### Step 4: Update dashboard.js

Add these endpoint handlers to `src/dashboard.js`. You can find the exact section to add in `dashboard-crosspost-endpoints.js`.

**Insert after the templates endpoints** (around line 160), before the Start/Stop section:

```javascript
// ── Crosspost Configuration ───────────────────────────────────────────────

app.get('/api/crosspost/config', requireAuth, (req, res) => {
  res.json({
    enabled: state.crosspost?.enabled ?? true,
    platforms: state.crosspost?.platforms ?? {},
    stats: {
      xPosted: state.stats?.xPosted ?? 0,
      instagramPosted: state.stats?.instagramPosted ?? 0,
    },
  });
});

app.post('/api/crosspost/toggle', requireAuth, (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }
  state.crosspost = state.crosspost ?? {};
  state.crosspost.enabled = enabled;
  stateIO.save(state);
  logger.info(`Dashboard: crosspost ${enabled ? 'enabled' : 'disabled'}`);
  res.json({ ok: true, enabled: state.crosspost.enabled });
});

app.post('/api/crosspost/platform-config', requireAuth, (req, res) => {
  const { platform, config } = req.body;
  if (!['x', 'instagram'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be x or instagram' });
  }
  if (typeof config !== 'object') {
    return res.status(400).json({ error: 'config must be an object' });
  }
  state.crosspost = state.crosspost ?? {};
  state.crosspost.platforms = state.crosspost.platforms ?? {};
  state.crosspost.platforms[platform] = config;
  stateIO.save(state);
  logger.info(`Dashboard: ${platform} config updated`);
  res.json({ ok: true, platforms: state.crosspost.platforms });
});

app.get('/api/crosspost/test', requireAuth, async (req, res) => {
  try {
    const crosspost = require('./crosspost');
    const profiles = await crosspost.getProfiles();
    res.json({
      ok: true,
      connected: profiles.length > 0,
      profiles: profiles.map(p => ({
        id: p.id,
        service: p.service,
        name: p.name || 'Unnamed',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Step 5: Update dashboard HTML

Add the new Crosspost Configuration section to `dashboard/index.html`.

**Insert after the "Message Templates" section** (around line 425), before "DM Commands":

Look at `dashboard-crosspost-html.html` for the complete HTML + JavaScript.

**Key pieces:**
- Status indicator + test button
- Global toggle (ON/OFF)
- X settings (enable + hashtags)
- Instagram settings (enable + hashtags)
- Stats counter (posts queued per platform)
- JavaScript functions to manage config

### Step 6: Update .env.example

Add the Buffer configuration:

```bash
# ─── Crossposting (Buffer for X & Instagram) ──────────────
# Get your API key from: https://buffer.com → Settings → Apps & Integrations → API
# Your X (Twitter) and Instagram accounts must already be connected to Buffer
# Leave blank to disable crossposting
BUFFER_API_KEY=
```

### Step 7: Update Your .env

Add your actual Buffer API key (get it from buffer.com):

```bash
BUFFER_API_KEY=your_actual_api_key_here
```

### Step 8: Rebuild and Test

```bash
docker compose down
docker compose up -d --build
```

Watch logs:
```bash
docker compose logs -f
```

---

## Testing the Integration

### 1. Test Buffer Connection (via dashboard)

1. Open dashboard at `http://localhost:3000`
2. Unlock with your `DASHBOARD_SECRET`
3. Scroll to **Crosspost Configuration** section
4. Click **🔗 Test Connection**
5. You should see your connected X & Instagram accounts

### 2. Manual Post Test

Trigger a manual post:
```bash
# Via dashboard: click "⚡ Post Now" button
# Or via DM: send "!post now"
```

Watch the logs:
```bash
docker compose logs -f | grep crosspost
```

You should see:
```
crosspost: processing 4 images for X & Instagram
crosspost: formatted for X and Instagram
crosspost: X post queued — "📸 ..."
crosspost: Instagram post queued — "📸 ..."
```

### 3. Verify in Buffer

Log into [buffer.com](https://buffer.com):
- **Channels** → Check if posts appear queued for X and Instagram
- **Published** → See posts that have already published

---

## Architecture Details

### Data Flow

```
┌─────────────────────────────────────┐
│  scheduler.js: postBatch()          │
│  ① Fetch images from Chevereto      │
│  ② Download & upload to Bluesky     │
│  ③ Extract VRCX metadata            │
└────────────┬────────────────────────┘
             │
             ├─→ Post to Bluesky (successful)
             │
             ├─→ Save to state.postedIds
             │
             └─→ Call crosspost.triggerCrosspost()
                  ├─→ Load Buffer profiles (X, Instagram)
                  ├─→ Prepare images (resize for each platform)
                  ├─→ Format text (280 chars for X, 2200 for IG)
                  ├─→ Include VRCX metadata & Chevereto links
                  ├─→ POST to Buffer API
                  ├─→ Track stats (xPosted, instagramPosted)
                  └─→ Log success/fail (non-fatal if fails)
```

### Image Resizing

**Sharp library** (already a dependency) handles image processing:

```javascript
// For X: 1200×675 (landscape)
sharp(buffer)
  .resize(1200, 675, { fit: 'cover', position: 'center' })
  .toBuffer()

// For Instagram: 1080×1350 (portrait)
sharp(buffer)
  .resize(1080, 1350, { fit: 'cover', position: 'center' })
  .toBuffer()
```

Uses **center-crop** so all images fit exact dimensions without distortion.

### Text Formatting

Different limits per platform:

| Platform | Limit | What's included |
|----------|-------|-----------------|
| X | 280 chars | Usernames, titles, tags, top Chevereto links |
| Instagram | 2200 chars | All of above + full metadata + all world names |

VRCX world information included in both, formatted compactly.

---

## Troubleshooting Integration Issues

### "Cannot find module './crosspost'"

**Problem**: `crosspost.js` not copied to `src/`

**Solution**:
```bash
cp /home/claude/crosspost.js src/
docker compose up -d --build
```

### "BUFFER_API_KEY not set"

**Problem**: API key not in `.env`

**Solution**:
1. Get key from buffer.com (Settings → Apps & Integrations → API)
2. Add to `.env`: `BUFFER_API_KEY=your_key`
3. Restart: `docker compose restart`

### Dashboard doesn't show Crosspost section

**Problem**: HTML not updated

**Solution**: Review `dashboard-crosspost-html.html` and ensure all HTML + JavaScript are added to `dashboard/index.html`

### "No X or Instagram profiles connected"

**Problem**: Accounts not linked to Buffer

**Solution**:
1. Log into buffer.com
2. Go to Channels → + Add Channel
3. Connect X and/or Instagram
4. Test again

### Crosspost errors in logs but Bluesky posts still work

**Expected behavior!** Crosspost failures won't break Bluesky posting. Check:
- `./data/bot.log` for specific error
- Buffer API key validity
- Account connection status

---

## Customization

### Change Image Dimensions

Edit `src/crosspost.js`:

```javascript
const IMAGE_SPECS = {
  x: {
    width: 1200,      // ← adjust
    height: 675,      // ← adjust
    maxChars: 280,
  },
  // ...
};
```

Rebuild: `docker compose up -d --build`

### Add More Platforms

Buffer API supports Threads, LinkedIn, etc. To add:

1. Add platform to `IMAGE_SPECS` in `crosspost.js`
2. Update dashboard platform list
3. Add to state.js platform config
4. Update HTML/JS UI

(This is left as an exercise for future enhancement!)

### Customize Hashtags Per Platform

Via dashboard or directly in state file (`./data/bot-state.json`):

```json
{
  "crosspost": {
    "platforms": {
      "x": {
        "enabled": true,
        "hashtags": ["#photography", "#VRChat"]
      },
      "instagram": {
        "enabled": true,
        "hashtags": ["#photography", "#VRChat", "#teamspotlight"]
      }
    }
  }
}
```

---

## Files Changed Summary

| File | Change | Lines |
|------|--------|-------|
| `src/crosspost.js` | NEW | ~450 |
| `src/scheduler.js` | Updated | +7 lines, call crosspost |
| `src/state.js` | Updated | +20 lines, crosspost config |
| `src/dashboard.js` | Updated | +50 lines, new endpoints |
| `dashboard/index.html` | Updated | +200 lines HTML + JS |
| `.env.example` | Updated | +5 lines |
| Total | | ~700 lines added |

---

## Dependencies

No new npm packages required! Uses existing:
- `axios` — Buffer API calls ✓
- `sharp` — Image resizing ✓
- `express` — Dashboard endpoints ✓

---

## Next Steps

1. ✅ Copy all files to your repo
2. ✅ Add Buffer API key to `.env`
3. ✅ Rebuild and restart
4. ✅ Test connection via dashboard
5. ✅ Trigger a manual post
6. ✅ Check Buffer for queued posts
7. ✅ Share CROSSPOST_SETUP.md with users

---

## Support

- **Setup help**: See `CROSSPOST_SETUP.md`
- **Logs**: `docker compose logs -f | grep crosspost`
- **Buffer status**: https://buffer.com
- **API reference**: https://buffer.com/developers/api

Good luck! 🚀
