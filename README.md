# LAN File Transfer

Send photos and videos between an iPhone and an Android device (or any two
browsers) over the same WiFi network — no internet, no app store, no cloud.
One computer runs a small Node.js server; both phones just open a web page.

## How it works

- **Sender page** (`/send.html`) — pick multiple photos/videos, see them
  listed with size, choose to keep the original format or convert on the
  way in, and upload with a progress bar.
- **Receiver page** (`/receive.html`) — connects over WebSocket and shows the
  file list updating live, no refresh needed, with a real thumbnail for
  every photo and video (not just an icon).
- The server stores uploaded files on disk, generates a preview thumbnail,
  optionally converts the file, then pushes a `files-added` event to every
  connected browser the instant that's done.

### Thumbnails for everything, including formats browsers can't preview

Phone browsers can't natively display many formats cameras produce — Chrome
and Firefox on Android can't render HEIC photos, no mobile browser can show
a frame of an MKV or AVI file just from a `<video>` tag, and so on. To get
around that, the server builds a small JPEG preview for every photo and
video the moment it's processed:

- Photos: [`sharp`](https://sharp.pixelplumbing.com/) decodes the image
  (auto-rotating using its EXIF orientation) and writes a resized JPEG
  preview.
- Videos: [`ffmpeg`](https://ffmpeg.org/) (bundled automatically via
  `@ffmpeg-installer/ffmpeg`, no separate install needed) grabs a frame
  roughly 10% into the video as the preview.

If a preview can't be built for some exotic format, the app doesn't fail —
the receive page falls back to the original file (for web-safe images) or
a plain icon, and the file is still fully uploaded and downloadable.

### Broad format support

The upload accepts essentially any common camera/phone format, matched
primarily by file extension (since phones often mislabel the MIME type for
newer formats):

- **Images**: JPEG, PNG, GIF, WEBP, BMP, TIFF, HEIC/HEIF, AVIF, SVG, ICO,
  plus common RAW formats (DNG, CR2/CR3, NEF, ARW, RAF, ORF, RW2, SRW).
- **Videos**: MP4, MOV, M4V, WEBM, MKV, AVI, WMV, FLV, MPG/MPEG, 3GP/3G2,
  OGV, TS, M2TS/MTS.

### Convert on upload, or keep the original

The send page shows a "Photos" and/or "Videos" format dropdown once you've
selected files of that kind. Options:

- **Keep original format** (default) — the file is stored exactly as sent.
- **Photos** → convert to JPEG, PNG, or WEBP.
- **Videos** → convert to MP4 (H.264/AAC) or WEBM (VP9/Opus).

This is handy for, e.g., converting iPhone HEIC photos or MOV videos into
formats that are easier to open on a Windows PC or share elsewhere.
Conversion happens on the server after the file finishes uploading, so for
large videos the app shows a "Processing…" state — this can take anywhere
from a couple of seconds to a minute or two depending on the video's size
and the server machine's CPU.

## Requirements

- A computer (Mac, Windows, or Linux) on the same WiFi network as both
  phones. This is the machine that runs the server — it can be a laptop, a
  Raspberry Pi, anything that runs Node.js.
- [Node.js](https://nodejs.org) 16 or newer installed on that computer.
- Both phones connected to **the same WiFi network** as the computer (not
  cellular data, and not a guest network that isolates devices from each
  other — see Troubleshooting below).

## Setup

1. Copy this folder onto the computer that will act as the server.
2. Open a terminal in the folder and install dependencies:

   ```bash
   npm install
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. The terminal prints something like:

   ```
   LAN File Transfer is running.

     Local:    http://localhost:8080
     Network:  http://192.168.1.42:8080

   Open the "Network" URL on both devices (same WiFi).
   ```

   That `192.168.1.42` address (yours will differ) is what you type into
   the phones' browsers.

## Using it

1. **On the sending phone** (e.g. iPhone): open Safari and go to
   `http://192.168.1.42:8080/send.html`. Tap the picker, choose one or more
   photos/videos from your library, review the list, then tap **Upload**.
2. **On the receiving phone** (e.g. Android): open Chrome/Firefox and go to
   `http://192.168.1.42:8080/receive.html`. Uploaded files appear in the
   list automatically, in real time, with no need to reload the page.
3. Tap **Save** next to any file to download it to that device.
4. You can also just open `http://192.168.1.42:8080/` for a landing page
   with links to both views.

Finding the IP address yourself, if you need it again later:

- **macOS**: `ipconfig getifaddr en0` (or `en1` for WiFi on some Macs)
- **Windows**: `ipconfig` → look for "IPv4 Address" under your WiFi adapter
- **Linux**: `ip addr show` or `hostname -I`

## Configuration

- **Port**: defaults to `8080`. Change it with an environment variable:
  `PORT=3000 npm start`.
- **Where files land**: the `uploads/` folder next to `server.js`.
- **Max file size**: 4 GB per file by default (edit `MAX_FILE_SIZE_MB` in
  `server.js` to change it).
- **Accepted types**: see "Broad format support" above — matched by file
  extension first, with a MIME-type fallback for unrecognized extensions.
- **Thumbnails**: stored alongside uploads in a hidden `uploads/.thumbnails`
  folder; deleted automatically when the source file is deleted.

## Troubleshooting

- **Phones can't reach the server / "Offline" status on the send page**:
  Most home routers are fine, but some WiFi networks (especially "Guest"
  networks, or corporate/campus WiFi) enable **client/AP isolation**, which
  blocks devices from talking to each other even on the same network. Use
  your main home network, a phone's personal hotspot, or check your
  router's settings for an "AP isolation" / "client isolation" toggle.
- **Firewall prompt on first run**: your OS may ask whether to allow Node.js
  to accept incoming network connections — choose **Allow** (for private/
  home networks).
- **iOS Safari won't let me pick multiple photos**: this app's file input
  uses `multiple` and `accept="image/*,video/*"`, which iOS Safari
  supports from iOS 14+ — tap the input, then use the "Select" option in
  Photos to multi-select before tapping Add.
- **Large videos are slow**: this is standard HTTP upload over WiFi, so
  transfer speed depends on your network. It works fully offline as long as
  both devices are on the same WiFi network (the network doesn't need
  internet access at all). Converting a video also adds processing time on
  top of the upload itself.
- **`npm install` fails on `sharp` or `@ffmpeg-installer/ffmpeg`**: these
  packages download a prebuilt native binary for your OS/CPU during
  install. They cover the common platforms (macOS Intel/Apple Silicon,
  Windows x64, Linux x64/arm64), but on an unusual platform the install can
  fail. If you don't need thumbnails/conversion, you can remove those two
  packages from `package.json` and the corresponding `require()` lines at
  the top of `server.js` — uploads still work, just without previews or
  conversion (the receive page's icon fallback still applies).

## Notes on scope

This is built for trusted local-network use (e.g. moving files between your
own devices at home). It has no login and no per-user access control —
anyone on the same WiFi network who has the URL can upload or download
files while the server is running. Don't run it on a network you don't
trust, and stop the server (`Ctrl+C`) when you're done.
