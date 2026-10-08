# Vazhe (واژه)

Your own English to Persian dictionary. It starts empty and you fill it.

- **Add a word** by typing it or saying it into the microphone. Vazhe looks it up and saves every common meaning with:
  - the Persian equivalents
  - the word type (noun, verb, adjective and so on)
  - a short English definition
  - an English example sentence
  - the pronunciation, written in IPA and playable with the speaker button
- **Hear each word** pronounced. The speaker button plays a real recording from Wiktionary when one exists; otherwise it uses your phone's or browser's built-in voice.
- **Add your own sentences** under any word, typed or spoken.
- **Fill in or correct meanings.** A meaning without Persian has an *Add Persian meaning* button, and the pencil next to any meaning lets you change its Persian (typed or spoken), word type, definition and example, or delete it. *Add a meaning* adds one of your own.
- **Search** your words in English or Persian from the same box.
- **Works on the web and Android.** It's a Progressive Web App: open it in Chrome on your phone and choose *Install app*. It also opens offline, showing your last saved words.

## How it works

```
public/                  the app: plain HTML, CSS and JavaScript, no build step
src/app.js               the API (Express)
src/db.js                storage: one SQLite file
src/lookup.js            word lookup with Claude (when an API key is set)
src/freeLookup.js        free word lookup: online English dictionaries + offline Persian
src/sources.js           the online dictionaries: Merriam-Webster, Free Dictionary, Wiktionary
src/lexicon.js           the offline Persian data (kaikki.org / Wiktionary)
scripts/build-lexicon.js builds the offline data file
scripts/check-sources.js checks each online dictionary with a real request
lexicon/en-fa.jsonl.gz   the offline data file, once you've built it
```

When you add a word, the server looks it up and stores the answer in SQLite. Words you already have are never looked up twice. Speech input uses the browser's built-in speech recognition, which works in Chrome and Edge on desktop and Android. The mic button is hidden in browsers without it, such as Firefox.

### Where meanings come from

**With a Claude API key** (`ANTHROPIC_API_KEY` set), Claude provides everything: word types, Persian meanings, definitions and examples. It costs about $0.01 per new word and corrects spelling and speech mistakes. The pronunciation recording comes from the offline dictionary or the Free Dictionary API.

**Without a key**, it's free and combines these sources:

| | Source |
|---|---|
| Word types, English definitions, examples, pronunciation and its recording | The first online dictionary that knows the word, in this order:<br>1. [Merriam-Webster Learner's](https://dictionaryapi.com), when `MERRIAM_WEBSTER_KEY` is set (free key, 1,000 lookups a day)<br>2. [Free Dictionary API](https://dictionaryapi.dev) (no key)<br>3. [Wiktionary](https://en.wiktionary.org/api/rest_v1/) from Wikimedia (no key, no pronunciation) |
| Persian meanings | The offline dictionary (kaikki.org / Wiktionary data) |

Each English meaning gets the Persian of the offline meaning with the same word type and the closest definition. Inflected forms are looked up by their base word ("ran" finds "run"). If a dictionary is down or doesn't know the word, the next one is asked. If none of them has it:

- **The offline dictionary has the word:** its English is used too.
- **The offline dictionary doesn't have it either:** you get a "not found" message.

A word found online but missing from the offline dictionary is saved with English only, and its page says no Persian meaning was found.

To check that every online dictionary works (and your Merriam-Webster key), run:

```bash
npm run check:sources            # checks "run"
npm run check:sources -- happy   # checks another word
```

It shows what each dictionary returns, whether its recordings play, and what the app would save.

## Set up the free offline dictionary

The offline data comes from [kaikki.org](https://kaikki.org), which publishes English Wiktionary as structured data. Build the file once, on any computer with internet:

```bash
npm run build:lexicon
```

This downloads the full English Wiktionary file (several GB, so make sure you have the disk space) to `lexicon/kaikki-English.jsonl`. If the connection drops, it resumes where it stopped, and if you run the command again later it reuses a finished download. It then keeps only words with Persian translations and writes the small file `lexicon/en-fa.jsonl.gz`. Afterwards you can delete `lexicon/kaikki-English.jsonl`. Commit the small file so every deployment has it:

```bash
git add lexicon/en-fa.jsonl.gz && git commit -m "Add offline dictionary data" && git push
```

If the download is slow or fails, download `kaikki.org-dictionary-English.jsonl` from kaikki.org yourself (in a browser, for example) and pass the file: `npm run build:lexicon -- path/to/kaikki.org-dictionary-English.jsonl`.

On its first start, the server fills its database from that file. Later starts skip this step unless the file has changed, for example after you rebuild it with newer Wiktionary data. Then it reloads the offline dictionary and keeps your saved words.

## Run it on your computer

You need Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env    # optional: add a Claude API key; leave it empty for the free lookup
npm run dev
```

Open http://localhost:3000.

Run the tests with `npm test`.

### Use it on your phone while it runs on your PC

1. Connect the phone to the same Wi-Fi as the PC.
2. Start the app. It prints an address like `on your network: http://192.168.1.20:3000`.
3. Open that address in Chrome on the phone. If it doesn't load, allow Node.js through the firewall on private networks (Windows asks the first time; otherwise Windows Security → Firewall → Allow an app).

Over plain `http://` with an IP address, Chrome blocks the microphone and the *Install app* option. To allow them for your PC's address, on the phone:

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Enter the exact address, for example `http://192.168.1.20:3000`, and set the flag to **Enabled**.
3. Tap **Relaunch**.

The address can change when the PC reconnects to Wi-Fi. If it does, update the flag with the new one.

**Or give it a real https address** with a free Cloudflare quick tunnel (no account needed). This also works when the phone isn't on your Wi-Fi:

1. Install `cloudflared` on the PC (Windows: `winget install --id Cloudflare.cloudflared`).
2. Set `APP_PASSWORD` in `.env` and start the app. The tunnel makes it reachable from the internet, so the password keeps others out.
3. In a second terminal, run `cloudflared tunnel --url http://localhost:3000`.
4. Open the `https://….trycloudflare.com` address it prints on your phone. The microphone and *Install app* both work.

The address changes every time you start the tunnel, and an installed app keeps its old address. So for daily use, install the app from your permanent address once you put it online.

## Put it online

The app is a single Node server, and your dictionary lives in one file (`data/dictionary.db`). Any host that runs Node or Docker **and keeps a persistent disk** will do, for example Fly.io, Railway or Render (with a disk), or your own VPS.

1. Set the environment variables:
   - `ANTHROPIC_API_KEY`: optional; leave it unset for the free lookup
   - `MERRIAM_WEBSTER_KEY`: optional; your Merriam-Webster Learner's key
   - `APP_PASSWORD`: set one, so strangers can't use your dictionary or your API key
   - `DATA_DIR`: a folder on the persistent disk (the Docker image uses `/data`)
2. Deploy with the included `Dockerfile`, or run `npm ci --omit=dev && npm start`.
3. Serve it over HTTPS. Phones only allow the microphone and app install on HTTPS sites; most hosts do this for you.

## Install on Android

1. Open your deployed site in Chrome.
2. Tap the menu, then **Install app** (or **Add to Home screen**).

Vazhe then opens full screen like any other app. If you later want it in the Play Store, the same site can be wrapped as a Trusted Web Activity with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap), with no code changes.

## Credits

English definitions without a key: [Merriam-Webster's Learner's Dictionary](https://learnersdictionary.com), the [Free Dictionary API](https://dictionaryapi.dev) and [Wiktionary](https://en.wiktionary.org).

Offline dictionary data: [Wiktionary](https://en.wiktionary.org) via [kaikki.org](https://kaikki.org), under CC BY-SA 4.0 and GFDL.

Fonts: [Geist](https://vercel.com/font) and [Vazirmatn](https://github.com/rastikerdar/vazirmatn), both under the SIL Open Font License. Icons: [Phosphor](https://phosphoricons.com) (MIT).
