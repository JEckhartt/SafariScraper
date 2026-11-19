# SafariScraper

Two Safari extensions for iPhone/iPad in one app:

- **SafariScraper**: finds every image on a page and saves them in bulk to Photos, through the share sheet, or as a zip.
- **CardScraper**: turns a character page into a Tavern/SillyTavern **character card PNG**: the main image with Scenario, Personality, First message and Example dialogs embedded.

No Mac required: GitHub Actions builds an unsigned `.ipa` that you install with TrollStore, or sign with Sideloadly, AltStore, or your own certificate.

## Get the IPA

- **Direct link (always the newest build):** https://github.com/JEckhartt/SafariScraper/releases/download/latest/SafariScraper.ipa
- **Any push:** open the **Actions** tab → latest **Build IPA** run → download the `SafariScraper-ipa` artifact (a zip containing `SafariScraper.ipa`).
- **Release (easier from a phone):** on GitHub go to **Releases → Draft a new release**, create a tag such as `v1.0`, and publish. The workflow attaches `SafariScraper.ipa` to the release.

## Install & enable

1. Install the IPA (TrollStore: open the file with TrollStore; signing tools: sign and install as usual).
2. Open the **SafariScraper** app once and tap **Allow Photos Access**.
3. **Settings → Safari → Extensions** (iOS 18+: **Settings → Apps → Safari → Extensions**) → **SafariScraper** → on, and set **All Websites → Allow**.

## Use

In Safari, tap the puzzle-piece / **ᴀA** button → **SafariScraper**.

- Images show up in a grid. Tap one to deselect it, filter by minimum size, or use **All / None**.
- **Scroll & rescan** scrolls the page to trigger lazy-loading, then scans again.
- **Save to Photos**: the native extension downloads the originals (no CORS limits) and adds them to your library. WebP/AVIF get converted to JPEG/PNG.
- **Share…**: fetches the images in the browser (with your cookies) and opens the share sheet, so **Save N Images** works for logged-in sites.
- **Zip**: bundles everything into one `.zip` and opens the share sheet (Save to Files).

If the share sheet doesn't open after a big download, the button changes to "Share N now". Tap it again; iOS only allows the share sheet right after a tap.

## CardScraper

Open a character page → extensions menu → **CardScraper**.

- Picks the largest image on screen (tap a thumbnail to choose another) and converts it to PNG.
- Grabs the **public description** (the text block under the image) into `creator_notes`, which SillyTavern shows as Creator's Notes.
- Finds sections by their headings: *Scenario*, *Personality*, *First message*, *Example dialogs*. Token counts like "(310 tokens)" are ignored, and collapsed sections still get read.
- Converts the page's formatting back to **Markdown**: *italics* (roleplay actions), **bold**, ~~strike~~, headings, nested lists, quotes, code blocks, links, rules and tables. Untick "Keep formatting as Markdown" for plain text.
- Every field is editable before saving. Missing ones are flagged so you can paste them in.
- **Save card PNG** writes the card JSON (V2 spec, V1 fields mirrored) base64-encoded into a `tEXt` chunk named `chara`. That's what SillyTavern, Agnai, RisuAI and others import. **JSON** saves the same data as a `.json` file.
- By default Personality is stored in the card's `description` field, which is the main character definition in SillyTavern. Untick the box to store it in `personality` instead.

Save it with **Save to Files**, not Photos: Photos can strip the embedded text.

### Batch: your whole JanitorAI character list

Open **My Characters** (each character has an **Edit** button), open CardScraper and choose **Batch → Scrape all characters**.

- It scrolls until the whole list has loaded, then for each character it clicks **Edit**, reads the **General** tab (image, Title, Chat name, Bio) and the **Definition** tab (Personality, Scenario, initial message from *Write* plus any alternate initial messages, Example dialogs), and goes **Back** to the list.
- **Read-only:** it only clicks Edit, the two tabs, the initial-message chips and Back. It never clicks Delete, "+" or Update character, and never types into a field.
- A pill at the top of the page shows progress and has a **Stop** button. You can close the popup while it runs. Progress is kept in the tab, so page loads don't interrupt it.
- When it finishes, the Batch tab lists every character with a thumbnail, what was found, and any problems (empty fields, no image, wrong page opened). Untick the ones you don't want, then **Save N cards** (separate PNGs) or **Zip** (one file).
- Each card: name = Title; Chat name = nickname (V3 field); Bio → Creator's Notes; Personality → Description (toggle); alternate initial messages → alternate greetings. PNGs carry both V2 (`chara`) and V3 (`ccv3`) data.

### Batch: all your JanitorAI chats

Open **My Chats**, open CardScraper → **Batch → Find all chats**.

- It expands each character under *All characters* and lists every chat (date, persona, message count, preview) without opening any.
- Pick chats (per character or one by one), then **Export N chats**. It opens each chat, reads the whole history (only the swipe that's showing), and goes back.
- Speakers come from each message's name label. The chat's persona chips (*as Joseph*, *as Wyatt 2*…) decide who is you, so nothing needs setting by hand. Chats with two personas keep both names.
- Problems are flagged per chat: fewer messages than the list said, unknown speakers, chats that didn't open. **Retry N with problems** re-runs just those.
- **Save N chats (.zip)** gives one folder per character with SillyTavern `.jsonl` files (`Date - as Persona (N msgs).jsonl`).
- Read-only: it expands rows and opens chats, nothing else (never *Start new chat*, *Select*, edit or delete). Chat text is kept in the site's IndexedDB until you save or **Start over**. Big chats take minutes, so keep Safari open with the screen on.

### Chat export

On a chat page CardScraper opens on its **Chat** tab (or tap **Chat** yourself).

- Scrolls up until the whole history has loaded. Messages are collected as it goes, so sites that unload old messages still export completely.
- Reads the speaker of **every message on its own**: its name label, or its avatar matched to a labelled message. Nothing is inferred from message order, so double and triple posts come out right. Pages with no names or avatars fall back to per-message `user`/`bot` markers or bubble alignment.
- A **Speakers** list shows everyone found. Choose **Character** or **You** for each. Extra speakers (narrators, NPCs) keep their own names in the file.
- Messages with no detectable speaker are marked **?** and must be set before saving. Tap a chip to change any message's speaker, ✕ to drop junk.
- **Save chat (.jsonl)** writes a SillyTavern chat file. In SillyTavern, open the character → **Manage chat files → Import chat**.
- Timestamps, copy buttons and other UI are stripped. *Actions* are kept as Markdown (toggleable).

## What SafariScraper finds

`<img>` (largest `srcset` candidate), lazy-load attributes (`data-src`, `data-original`, `data-lazy-src`, …), `<picture>` sources, links that point at image files, CSS background images, video posters and `og:image` / `twitter:image`.

## Layout

```
App/                          SwiftUI container app (setup screen, Photos permission)
Extension/
  SafariWebExtensionHandler.swift   native side: download + save to Photos
  Resources/                  the web extension (manifest v3)
    content.js                page scanner
    popup.{html,css,js}       picker UI
    background.js             relays to native handler
    zip.js                    tiny store-only zip writer
CardExtension/
  Resources/                  CardScraper web extension
    content.js                image + section scraper
    png.js                    PNG tEXt "chara" card writer
project.yml                   XcodeGen spec (CI generates the .xcodeproj)
.github/workflows/build.yml   builds + fake-signs (ldid) the IPA
scripts/make_icons.py         regenerates icons
```

Bundle IDs are `com.safariscraper.app` / `com.safariscraper.app.extension`. Change them in `project.yml` if your signing setup needs your own prefix.

## Limitations

- **Save to Photos** downloads outside Safari, so it doesn't send your cookies. For images behind a login, use **Share…** or **Zip**.
- `blob:` URLs and images drawn on `<canvas>` aren't captured.
- Requires iOS 15.4+.
