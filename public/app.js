const $ = (sel) => document.querySelector(sel);

const els = {
  app: $(".app"),
  form: $("#add-form"),
  input: $("#word-input"),
  addBtn: $("#add-btn"),
  status: $("#status"),
  list: $("#word-list"),
  empty: $("#empty"),
  count: $("#count"),
  detail: $("#detail"),
  detailEmpty: $("#detail").innerHTML,
  pwDialog: $("#password-dialog"),
  pwForm: $("#password-form"),
  pwInput: $("#password-input"),
};

const POS_SHORT = {
  noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.", pronoun: "pron.",
  preposition: "prep.", conjunction: "conj.", interjection: "interj.",
  determiner: "det.", "phrasal verb": "phr. v.", idiom: "idiom", other: "",
};

let words = [];
let pending = null; // the word currently being looked up

/* ---------- API ---------- */

const storage = {
  get: (k) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-app-password": storage.get("password") },
    body: body && JSON.stringify(body),
  }).catch(() => {
    throw new Error("You're offline. Connect to the internet and try again.");
  });
  if (res.status === 401) {
    await askPassword();
    return api(path, { method, body });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Something went wrong. Try again.");
  return data;
}

function askPassword() {
  return new Promise((resolve) => {
    els.pwInput.value = "";
    els.pwDialog.showModal();
    els.pwForm.addEventListener("submit", () => {
      storage.set("password", els.pwInput.value);
      resolve();
    }, { once: true });
  });
}

/* ---------- Rendering ---------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="icons.svg#i-${name}"/></svg>`;

const posList = (w) => [...new Set(w.senses.map((s) => POS_SHORT[s.partOfSpeech]).filter(Boolean))].join(" ");

function matches(w, q) {
  if (!q) return true;
  return w.word.toLowerCase().includes(q) || w.senses.some((s) => s.persian.some((p) => p.includes(q)));
}

function renderList() {
  const q = els.input.value.trim().toLowerCase();
  const shown = words.filter((w) => matches(w, q));
  const selected = selectedId();

  els.list.innerHTML =
    (pending ? `<li><div class="word-row pending">
        <span class="w">Looking up "${esc(pending)}"…</span><span class="skeleton"></span>
      </div></li>` : "") +
    shown.map((w) => `<li><a class="word-row" href="#${w.id}" ${w.id === selected ? 'aria-current="true"' : ""}>
        <span class="w">${esc(w.word)}<span class="pos">${esc(posList(w))}</span></span>
        <span class="fa" lang="fa" dir="rtl">${esc(w.senses[0]?.persian[0] ?? "")}</span>
      </a></li>`).join("");

  els.count.textContent = words.length === 1 ? "1 word" : `${words.length} words`;

  if (pending || shown.length) {
    els.empty.hidden = true;
  } else if (!words.length) {
    els.empty.hidden = false;
    els.empty.innerHTML = `<h2>Your dictionary is empty</h2>
      <p>Type or say an English word above. Vazhe fills in its Persian meanings, word type, a definition and an example.</p>`;
  } else {
    els.empty.hidden = false;
    els.empty.innerHTML = `<p>No saved word matches "${esc(els.input.value.trim())}". Press Add to look it up.</p>`;
  }
}

function renderDetail() {
  const w = words.find((x) => x.id === selectedId());
  els.app.classList.toggle("has-selection", Boolean(w));
  if (!w) {
    els.detail.innerHTML = els.detailEmpty;
    return;
  }

  const groups = Map.groupBy(w.senses, (s) => s.partOfSpeech);
  const sensesHtml = [...groups].map(([pos, senses]) => `
    <section class="pos-group">
      <h2>${esc(pos)}</h2>
      <ol class="senses">${senses.map((s) => `
        <li class="sense">
          ${s.persian.length ? `<p class="meaning" lang="fa" dir="rtl">${esc(s.persian.join("، "))}</p>` : ""}
          <p class="definition">${esc(s.definition)}</p>
          ${s.example ? `<p class="example">${esc(s.example)}</p>` : ""}
        </li>`).join("")}
      </ol>
    </section>`).join("");

  const mineHtml = w.examples.length
    ? `<ul class="mine-list">${w.examples.map((e) => `
        <li><p>${esc(e.text)}</p>
          <button class="icon-btn" type="button" data-action="delete-example" data-id="${e.id}" aria-label="Delete this sentence">${icon("trash")}</button>
        </li>`).join("")}</ul>`
    : `<p class="mine-empty">No sentences yet. Write or say one that uses this word.</p>`;

  els.detail.innerHTML = `
    <article class="entry">
      <a class="btn quiet back" href="#" aria-label="Back to your words">${icon("arrow-left")}<span>Words</span></a>
      <header class="entry-head">
        <h1 class="headword">${esc(w.word)}</h1>
        <div class="pron">
          ${"speechSynthesis" in window ? `<button class="icon-btn" type="button" data-action="speak" aria-label="Hear it">${icon("speaker-high")}</button>` : ""}
          <span>${esc(w.phonetic)}</span>
        </div>
      </header>
      ${w.senses.some((s) => s.persian.length) ? "" : `<p class="no-persian">No Persian meaning was found for this word.</p>`}
      ${sensesHtml}
      <section class="mine">
        <h2>Your sentences</h2>
        ${mineHtml}
        <form class="sentence-form" id="sentence-form" autocomplete="off">
          <label for="sentence-input">New sentence with "${esc(w.word)}"</label>
          <div class="row">
            <div class="field">
              <input id="sentence-input" name="text" type="text" maxlength="400" enterkeyhint="done">
              <button class="icon-btn mic" type="button" data-mic-for="sentence-input" aria-label="Say a sentence" ${Recognition ? "" : "hidden"}>${icon("microphone")}</button>
            </div>
            <button class="btn primary" type="submit">Add sentence</button>
          </div>
        </form>
      </section>
      <footer class="entry-foot">
        <button class="btn danger" type="button" data-action="delete-word">${icon("trash")}<span>Delete word</span></button>
      </footer>
    </article>`;
}

function render() {
  renderList();
  renderDetail();
}

function setStatus(text = "", isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

const selectedId = () => Number(location.hash.slice(1)) || null;

function select(id) {
  location.hash = id ? String(id) : "";
}

/* ---------- Actions ---------- */

async function addWord(raw) {
  const word = raw.replace(/[.,!?;:]+$/, "").trim();
  if (!word || pending) return;
  pending = word;
  els.addBtn.disabled = true;
  setStatus();
  renderList();
  try {
    const entry = await api("/words", { method: "POST", body: { word } });
    if (!words.some((w) => w.id === entry.id)) words.unshift(entry);
    if (entry.existing) setStatus(`"${entry.word}" is already in your dictionary.`);
    els.input.value = "";
    select(entry.id);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    pending = null;
    els.addBtn.disabled = false;
    render();
  }
}

function replaceWord(updated) {
  words = words.map((w) => (w.id === updated.id ? updated : w));
  render();
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  addWord(els.input.value);
});

els.input.addEventListener("input", () => {
  setStatus();
  renderList();
});

els.detail.addEventListener("submit", async (e) => {
  if (e.target.id !== "sentence-form") return;
  e.preventDefault();
  const input = e.target.elements.text;
  const text = input.value.trim();
  if (!text) return input.focus();
  try {
    replaceWord(await api(`/words/${selectedId()}/examples`, { method: "POST", body: { text } }));
    $("#sentence-input")?.focus();
  } catch (err) {
    alert(err.message);
  }
});

els.detail.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const w = words.find((x) => x.id === selectedId());
  if (!w) return;

  if (btn.dataset.action === "speak") {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(w.word);
    u.lang = "en-US";
    speechSynthesis.speak(u);
  }
  if (btn.dataset.action === "delete-example") {
    try {
      await api(`/examples/${btn.dataset.id}`, { method: "DELETE" });
      replaceWord({ ...w, examples: w.examples.filter((x) => x.id !== Number(btn.dataset.id)) });
    } catch (err) {
      alert(err.message);
    }
  }
  if (btn.dataset.action === "delete-word") {
    if (!confirm(`Delete "${w.word}" and your sentences for it?`)) return;
    try {
      await api(`/words/${w.id}`, { method: "DELETE" });
      words = words.filter((x) => x.id !== w.id);
      select(null);
      render();
    } catch (err) {
      alert(err.message);
    }
  }
});

addEventListener("hashchange", () => {
  render();
  if (selectedId()) els.detail.focus({ preventScroll: true });
  els.detail.scrollTop = 0;
});

/* ---------- Speech input ---------- */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (Recognition) {
  document.querySelectorAll(".mic").forEach((b) => (b.hidden = false));

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".mic");
    if (!btn) return;
    if (recognition) return recognition.stop();

    const input = document.getElementById(btn.dataset.micFor);
    const isWord = input === els.input;
    const before = input.value;
    recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    btn.classList.add("listening");
    btn.setAttribute("aria-pressed", "true");

    let heard = "";
    recognition.onresult = (ev) => {
      heard = [...ev.results].map((r) => r[0].transcript).join("");
      input.value = isWord ? heard : `${before} ${heard}`.trim();
      if (isWord) renderList();
    };
    recognition.onerror = (ev) => {
      if (ev.error === "not-allowed") setStatus("Allow microphone access to speak words.", true);
    };
    recognition.onend = () => {
      recognition = null;
      btn.classList.remove("listening");
      btn.setAttribute("aria-pressed", "false");
      if (isWord && heard) addWord(heard.toLowerCase());
      else input.focus();
    };
    recognition.start();
  });
}

/* ---------- Start ---------- */

async function load() {
  try {
    words = await api("/words");
  } catch (err) {
    setStatus(err.message, true);
  }
  render();
}

load();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
