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
- **Search** your words in English or Persian from the same box.
- **Works on the web and Android.** It's a Progressive Web App: open it in Chrome on your phone and choose *Install app*. It also opens offline, showing your last saved words.

## How it works

```
public/                  the app: plain HTML, CSS and JavaScript, no build step
src/app.js               the API (Express)
src/db.js                storage: one SQLite file
src/lookup.js            word lookup with Claude (when an API key is set)
src/freeLookup.js        free word lookup: Free Dictionary API + offline Persian
src/lexicon.js           the offline Persian data (kaikki.org / Wiktionary)
scripts/build-lexicon.js builds the offline data file
lexicon/en-fa.jsonl.gz   the offline data file, once you've built it
```

When you add a word, the server looks it up and stores the answer in SQLite. Words you already have are never looked up twice. Speech input uses the browser's built-in speech recognition, which works in Chrome and Edge on desktop and Android. The mic button is hidden in browsers without it, such as Firefox.

### Where meanings come from

**With a Claude API key** (`ANTHROPIC_API_KEY` set), Claude provides everything: word types, Persian meanings, definitions and examples. It costs about $0.01 per new word and corrects spelling and speech mistakes. The pronunciation recording comes from the offline dictionary or the Free Dictionary API.

**Without a key**, it's free and combines two sources:

| | Source |
|---|---|
| Word types, English definitions, examples, pronunciation and its recording | [Free Dictionary API](https://dictionaryapi.dev) (online, no key) |
| Persian meanings | The offline dictionary (kaikki.org / Wiktionary data) |

Each English meaning gets the Persian of the offline meaning with the same word type and the closest definition. Inflected forms are looked up by their base word ("ran" finds "run"). If one source has nothing:

- **Free Dictionary doesn't have the word, or can't be reached:** the English comes from the offline dictionary too.
- **The offline dictionary doesn't have the word:** it's saved with English only, and its page says no Persian meaning was found.
- **Neither has it:** you get a "not found" message.

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

## Put it online

The app is a single Node server, and your dictionary lives in one file (`data/dictionary.db`). Any host that runs Node or Docker **and keeps a persistent disk** will do, for example Fly.io, Railway or Render (with a disk), or your own VPS.

1. Set the environment variables:
   - `ANTHROPIC_API_KEY`: optional; leave it unset for the free lookup
   - `APP_PASSWORD`: set one, so strangers can't use your dictionary or your API key
   - `DATA_DIR`: a folder on the persistent disk (the Docker image uses `/data`)
2. Deploy with the included `Dockerfile`, or run `npm ci --omit=dev && npm start`.
3. Serve it over HTTPS. Phones only allow the microphone and app install on HTTPS sites; most hosts do this for you.

## Install on Android

1. Open your deployed site in Chrome.
2. Tap the menu, then **Install app** (or **Add to Home screen**).

Vazhe then opens full screen like any other app. If you later want it in the Play Store, the same site can be wrapped as a Trusted Web Activity with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap), with no code changes.

## Credits

English definitions without a key: [Free Dictionary API](https://dictionaryapi.dev), from Wiktionary.

Offline dictionary data: [Wiktionary](https://en.wiktionary.org) via [kaikki.org](https://kaikki.org), under CC BY-SA 4.0 and GFDL.

Fonts: [Geist](https://vercel.com/font) and [Vazirmatn](https://github.com/rastikerdar/vazirmatn), both under the SIL Open Font License. Icons: [Phosphor](https://phosphoricons.com) (MIT).
