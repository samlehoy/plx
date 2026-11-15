# plx Companion Browser Extension

Companion extension to sync browser session credentials (Deezer `arl`, Spotify `sp_dc`, YouTube Music cookies) from **Chrome**, **Edge**, or **Brave** to the `plx` CLI.

## How to Install (One-time setup)

1. Open your browser's extensions page:
   - **Chrome**: `chrome://extensions`
   - **Brave**: `brave://extensions`
   - **Edge**: `edge://extensions`
2. Enable **Developer mode** (toggle in top right or sidebar).
3. Click **Load unpacked**.
4. Select this `extension` folder inside the `plx` repository.

## How to Sync

1. In your terminal, run `plx`.
2. From the menu, choose **"Sync via Browser Extension"** (or choose it when prompted for a provider credential).
   *The CLI prints the local address it is waiting on and for how long.*
3. In your browser, click the **plx Companion** icon in the extensions toolbar.
4. Click **"Sync to plx CLI"**.
5. The CLI will receive the credentials, validate them with the live services, and save them into `credentials.json`.

## How it works

The popup reads the cookies for `spotify.com`, `deezer.com`, `youtube.com` and `google.com` and
POSTs them, unfiltered, to the CLI on `127.0.0.1`. The CLI picks the cookies it needs and builds the
credentials with the same code the on-disk browser readers use (`credentialsFromCookies` in
`src/browser.ts`), so the extension holds no copy of those rules. The CLI rejects any request from a
web page (only a `chrome-extension://` Origin is allowed). It also ignores requests that carry no
usable session and keeps waiting.

If you change `DEFAULT_SYNC_PORT` in `src/sync-server.ts`, change `PLX_SYNC_URL` in `popup.js` too.
