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
- **Other forms come along.** Adding a word also adds its other forms and groups them: "quick" brings "quickly", "quickness" and "quicken" into a group called *quick*, and adding "quickly" brings the others the same way. They come from the offline data's word families (suffix forms only: *un-* words have their own meaning, and *quicker* or *ran* are forms the lookup already handles). Only common words are added (rare ones like "quickener" are left out), at most 8, nearest first. A form you delete isn't added back by itself; the status line says when one was skipped and offers to add it anyway. To see a word's family and what would happen to each word, run `npm run check:family -- quick`.
- **Group your words** by dragging one onto another: a new group holds both, and you name it right away. Drop words or groups onto a group to move them in; groups can sit inside groups. Use the *Move to the top level* zone that appears over the search box, or a row's top or bottom edge, to move something out. On a phone, hold a word for a moment, then drag. Each group's ⋯ menu renames or ungroups it, and a word's page has a group picker too.
- **Search** your words in English or Persian from the same box.
- **Accounts.** Everyone signs in with their own username and password and gets their own dictionary. You decide who can join with an invite code.
- **Works on the web and Android.** It's a Progressive Web App: open it in Chrome on your phone and choose *Install app*. It also opens offline, showing your last saved words.

## How it works

```
public/                  the app: plain HTML, CSS and JavaScript, no build step
public/drag.js           drag and drop for mouse, touch and pen
src/app.js               the API (Express)
src/auth.js              password hashing, session tokens, attempt limits
src/db.js                storage: one SQLite file, every person's words kept apart
src/lookup.js            word lookup with Claude (when an API key is set)
src/freeLookup.js        free word lookup: online English dictionaries + offline Persian
src/sources.js           the online dictionaries: Merriam-Webster, Free Dictionary, Wiktionary
src/lexicon.js           the offline Persian data (kaikki.org / Wiktionary)
scripts/build-lexicon.js builds the offline data file
scripts/users.js         manages accounts from the command line
scripts/check-sources.js checks each online dictionary with a real request
lexicon/en-fa.jsonl.gz   the offline data file, once you've built it
lexicon/common-words.txt.gz  common English words, used when building the word families
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

This downloads the full English Wiktionary file (several GB, so make sure you have the disk space) to `lexicon/kaikki-English.jsonl`. If the connection drops, it resumes where it stopped, and if you run the command again later it reuses a finished download. It then keeps only words with Persian translations, plus the word families (quick, quickly, quickness…) of those words, and writes the small file `lexicon/en-fa.jsonl.gz`. Afterwards you can delete `lexicon/kaikki-English.jsonl`. Commit the small file so every deployment has it:

```bash
git add lexicon/en-fa.jsonl.gz && git commit -m "Add offline dictionary data" && git push
```

If the download is slow or fails, download `kaikki.org-dictionary-English.jsonl` from kaikki.org yourself (in a browser, for example) and pass the file: `npm run build:lexicon -- path/to/kaikki.org-dictionary-English.jsonl`.

A file built before word families were added has none, so other forms aren't added until you rebuild it.

On its first start, the server fills its database from that file. Later starts skip this step unless the file has changed, for example after you rebuild it with newer Wiktionary data. Then it reloads the offline dictionary and keeps your saved words.

## Run it on your computer

You need Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env    # optional: add a Claude API key; leave it empty for the free lookup
npm run dev
```

Open http://localhost:3000 and create your account. The first account keeps the words saved before accounts existed.

Run the tests with `npm test`.

## Accounts and security

Each person has their own words, sentences and groups; the offline dictionary data is shared.

- **Who can join.** The first account can be created freely. After that, sign-up needs the invite code in `SIGNUP_CODE`, which you give to the people you want; without one, sign-up is closed. When `SIGNUP_CODE` is set, the first account needs it too, so set it before the app is reachable from the internet.
- **Passwords** are at least 8 characters and are stored only as salted scrypt hashes; nobody, including you, can read them from the database. A wrong username and a wrong password look the same, and repeated failures are slowed down (10 per username, 20 per address, per 15 minutes).
- **Sessions** use a random token in an HttpOnly, SameSite=Strict cookie (also Secure over https), valid for 30 days of use. The database keeps only a hash of each token. Signing out ends the session and removes this device's offline copy of the words; changing the password signs out every other device.
- **Other protections:** changes are accepted only from the app's own pages, pages are sent with a strict Content Security Policy and other security headers, errors never show internals, and each account can look up at most 150 words an hour, so nobody can run up your Claude bill.

Manage accounts from the command line on the server, for example when someone forgets their password:

```bash
npm run users                       # list accounts
npm run users -- add sara           # create an account (asks for the password)
npm run users -- password sara      # set a new password and sign them out everywhere
npm run users -- delete sara        # delete an account and all its words
npm run backup                      # save a copy of the database to data/backups
npm run restore -- <file>           # put a backup back (stop the app first)
```

With Docker, run these inside the container instead (see [Day to day](#day-to-day)).

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
2. Set `SIGNUP_CODE` (so strangers can't create accounts) and `TRUST_PROXY=loopback` in `.env`, and start the app.
3. In a second terminal, run `cloudflared tunnel --url http://localhost:3000`.
4. Open the `https://….trycloudflare.com` address it prints on your phone. The microphone and *Install app* both work.

The address changes every time you start the tunnel, and an installed app keeps its old address. So for daily use, install the app from your permanent address once you put it online.

## Put it online

The app is a single Node server, and everything it saves (accounts, words, groups) lives in one SQLite file. The included `Dockerfile` and `docker-compose.yml` run it on any server with Docker, with that file kept in the `data` folder next to `docker-compose.yml` (for example `~/vazhe/data/dictionary.db`), so it survives updates and rebuilds.

### Deploy with Docker on your server

You need a server with Docker and the Compose plugin, and, for https, a domain name whose DNS points at the server.

```bash
git clone https://github.com/RezaTabrizii/custom-dictionary.git vazhe
cd vazhe
cp .env.example .env
nano .env        # set SIGNUP_CODE, and DOMAIN for https (see below)
```

Then start it one of two ways:

- **With automatic https (recommended).** Set `DOMAIN=dict.example.com` and `BIND=127.0.0.1` in `.env`, open ports 80 and 443 in the server's firewall, and run:

  ```bash
  docker compose --profile https up -d --build
  ```

  This also starts [Caddy](https://caddyserver.com), which gets a free Let's Encrypt certificate for your domain and renews it by itself. Open `https://dict.example.com`.

- **Behind your own proxy** (nginx, Traefik, a panel such as Coolify or CapRover) that already handles https: run `docker compose up -d --build` and point the proxy at port 3000. With a proxy on the same server, also set `BIND=127.0.0.1` so the app isn't reachable around it.

Then open the site and create your account with the invite code. Set `SIGNUP_CODE` **before** this first visit: with it set, nobody without the code can take the first account.

The container runs as an unprivileged user on a read-only file system, restarts after crashes and reboots, and reports its health to Docker (`docker compose ps` shows `healthy`). `TRUST_PROXY` is preset to trust private Docker addresses, so it works with Caddy or a proxy on the same server without changes.

### Day to day

```bash
docker compose logs -f app                               # see what it's doing
docker compose exec app node scripts/users.js            # list accounts
docker compose exec app node scripts/users.js password sara   # reset a password
docker compose exec app node scripts/users.js add sara        # create an account
docker compose exec app node scripts/users.js delete sara     # delete an account
```

**Update** to the latest version from GitHub (your data stays in `data/`):

```bash
git pull
docker compose --profile https up -d --build    # or without --profile https
```

**Back up** the database. This is safe while the app is running:

```bash
docker compose exec app node scripts/backup.js     # writes data/backups/dictionary-<date>.db
```

Keep a copy somewhere other than the server too, for example by downloading `data/backups` to your PC with `scp`. To **restore** one, put it in `data/backups/`, stop the app, put the copy back, and start it again:

```bash
docker compose stop app
docker compose run --rm --no-deps app node scripts/restore.js /data/backups/dictionary-2026-10-09-12-00-00.db
docker compose start app
```

To **move your dictionary from your PC** to the server, run `npm run backup` on the PC, copy the file into `~/vazhe/data/backups/` on the server (with `scp`), and restore it as above.

Deleting the `data` folder deletes every account and word, so back it up before cleaning up the server.

### Other hosts

Any host that runs Node 22.13+ or Docker **and keeps a persistent disk** works too (Fly.io, Railway or Render with a disk). Set the variables from `.env.example` there, with `DATA_DIR` on the persistent disk (the Docker image uses `/data`) and `TRUST_PROXY=1`, deploy the `Dockerfile` or run `npm ci --omit=dev && npm start`, and serve it over https. Phones only allow the microphone and app install on https sites.

## Install on Android

1. Open your deployed site in Chrome.
2. Tap the menu, then **Install app** (or **Add to Home screen**).

Vazhe then opens full screen like any other app. If you later want it in the Play Store, the same site can be wrapped as a Trusted Web Activity with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap), with no code changes.

## Credits

English definitions without a key: [Merriam-Webster's Learner's Dictionary](https://learnersdictionary.com), the [Free Dictionary API](https://dictionaryapi.dev) and [Wiktionary](https://en.wiktionary.org).

Offline dictionary data: [Wiktionary](https://en.wiktionary.org) via [kaikki.org](https://kaikki.org), under CC BY-SA 4.0 and GFDL. Common-word list: words seen at least 50 times in [FrequencyWords](https://github.com/hermitdave/FrequencyWords) (MIT), built from OpenSubtitles.

Fonts: [Geist](https://vercel.com/font) and [Vazirmatn](https://github.com/rastikerdar/vazirmatn), both under the SIL Open Font License. Icons: [Phosphor](https://phosphoricons.com) (MIT).
