# Vazhe (واژه)

Your own English to Persian dictionary. It starts empty and you fill it.

- **Add a word** by typing it or saying it into the microphone. Vazhe looks it up and saves every common meaning with:
  - the Persian equivalents
  - the word type (noun, verb, adjective and so on)
  - a short English definition
  - an English example sentence
- **Add your own sentences** under any word, typed or spoken.
- **Search** your words in English or Persian from the same box.
- **Works on the web and Android.** It's a Progressive Web App: open it in Chrome on your phone and choose *Install app*. It also opens offline, showing your last saved words.

## How it works

```
public/       the app: plain HTML, CSS and JavaScript, no build step
src/app.js    the API (Express)
src/db.js     storage: one SQLite file
src/lookup.js the word lookup, done by Claude
```

When you add a word, the server asks Claude for its meanings and stores the answer in SQLite. Words you already have are never looked up twice. Speech input uses the browser's built-in speech recognition, which works in Chrome and Edge on desktop and Android. The mic button is hidden in browsers without it, such as Firefox.

## Run it on your computer

You need Node.js 22.13 or newer and a Claude API key from [console.anthropic.com](https://console.anthropic.com).

```bash
npm install
cp .env.example .env    # then put your API key in .env
npm run dev
```

Open http://localhost:3000.

Run the tests with `npm test`.

## Put it online

The app is a single Node server, and your dictionary lives in one file (`data/dictionary.db`). Any host that runs Node or Docker **and keeps a persistent disk** will do, for example Fly.io, Railway or Render (with a disk), or your own VPS.

1. Set the environment variables:
   - `ANTHROPIC_API_KEY`: required
   - `APP_PASSWORD`: set one, so strangers can't use your dictionary or your API key
   - `DATA_DIR`: a folder on the persistent disk (the Docker image uses `/data`)
2. Deploy with the included `Dockerfile`, or run `npm ci --omit=dev && npm start`.
3. Serve it over HTTPS. Phones only allow the microphone and app install on HTTPS sites; most hosts do this for you.

## Install on Android

1. Open your deployed site in Chrome.
2. Tap the menu, then **Install app** (or **Add to Home screen**).

Vazhe then opens full screen like any other app. If you later want it in the Play Store, the same site can be wrapped as a Trusted Web Activity with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap), with no code changes.

## Credits

Fonts: [Geist](https://vercel.com/font) and [Vazirmatn](https://github.com/rastikerdar/vazirmatn), both under the SIL Open Font License. Icons: [Phosphor](https://phosphoricons.com) (MIT).
