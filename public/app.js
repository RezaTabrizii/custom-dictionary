import { makeDraggable } from "./drag.js";

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
  auth: $("#auth"),
  authForm: $("#auth-form"),
  authTitle: $("#auth-title"),
  authLead: $("#auth-lead"),
  authError: $("#auth-error"),
  authSubmit: $("#auth-submit"),
  authSwitch: $("#auth-switch"),
  authToggle: $("#auth-toggle"),
  authSwitchText: $("#auth-switch-text"),
  accountBtn: $("#account-btn"),
  accountMenu: $("#account-menu"),
  pwDialog: $("#password-dialog"),
  pwForm: $("#password-form"),
  dropTop: $("#drop-top"),
  menu: $("#group-menu"),
};

const POS_SHORT = {
  noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.", pronoun: "pron.",
  preposition: "prep.", conjunction: "conj.", interjection: "interj.",
  determiner: "det.", "phrasal verb": "phr. v.", idiom: "idiom", other: "",
};

const POS_NAMES = Object.keys(POS_SHORT);

let words = [];
let groups = []; // { id, name, parentId }; a word's groupId says which group it's in
let pending = null; // the word currently being looked up
let relatives = []; // other forms of a new word being added, like "quickly" for "quick"
let editing = null; // index of the meaning being edited, "new" for a new one, or null
let renaming = null; // { id, isNew } of the group whose name is being typed

/* ---------- API ---------- */

const storage = {
  get: (k) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  remove: (k) => { try { localStorage.removeItem(k); } catch {} },
};
storage.remove("password"); // the shared password of earlier versions

// Groups the user has closed, remembered on this device.
const collapsed = new Set(JSON.parse(storage.get("collapsed") || "[]"));
const saveCollapsed = () => storage.set("collapsed", JSON.stringify([...collapsed]));

// Calls the API with the session cookie. A request that finds the session
// gone shows the sign-in screen.
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body && JSON.stringify(body),
    credentials: "same-origin",
  }).catch(() => {
    throw new Error("You're offline. Connect to the internet and try again.");
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/")) {
    showAuth("Your session has ended. Sign in again.");
    throw new Error("Sign in to continue.");
  }
  if (!res.ok) throw new Error(data.error ?? "Something went wrong. Try again.");
  return data;
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

const query = () => els.input.value.trim().toLowerCase();
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
const touchFirst = matchMedia("(hover: none)").matches;

function wordHtml(w, selected) {
  return `<li data-kind="word" data-id="${w.id}"><a class="word-row" href="#${w.id}" draggable="false" ${w.id === selected ? 'aria-current="true"' : ""}>
      <span class="w">${esc(w.word)}<span class="pos">${esc(posList(w))}</span></span>
      <span class="fa" lang="fa" dir="rtl">${esc(firstPersian(w))}</span>
    </a></li>`;
}

const firstPersian = (w) => w.senses.find((s) => s.persian.length)?.persian[0] ?? "";

function groupHtml(g, inner, count, forceOpen) {
  const open = forceOpen || !collapsed.has(g.id);
  const head = renaming?.id === g.id
    ? `<form class="group-rename" data-id="${g.id}" autocomplete="off">
        ${icon("folder")}
        <input name="name" type="text" maxlength="60" enterkeyhint="done" aria-label="Group name"
               placeholder="Name this group" value="${renaming.isNew ? "" : esc(g.name)}">
        <button class="icon-btn" type="submit" data-keep-focus aria-label="Save the name">${icon("check")}</button>
        <button class="icon-btn" type="button" data-action="cancel-rename" data-keep-focus
                aria-label="${renaming.isNew ? "Undo this group" : "Keep the old name"}">${icon("x")}</button>
      </form>`
    : `<button class="group-toggle" type="button" data-action="toggle-group" aria-expanded="${open}">
        ${icon("caret-right")}${icon("folder")}<span class="group-name">${esc(g.name)}</span>
      </button>
      <span class="group-count" aria-label="${count === 1 ? "1 word" : `${count} words`}">${count}</span>
      <button class="icon-btn group-menu" type="button" data-action="group-menu" aria-label="Options for ${esc(g.name)}" aria-haspopup="menu">${icon("dots-three")}</button>`;
  return `<li class="group${open ? "" : " collapsed"}" data-kind="group" data-id="${g.id}">
      <div class="group-head">${head}</div>
      <div class="group-body" ${open ? "" : "inert"}><ul class="group-children">${inner}</ul></div>
    </li>`;
}

function renderList() {
  const q = query();
  const selected = selectedId();
  const groupsIn = Map.groupBy(groups, (g) => g.parentId);
  const wordsIn = Map.groupBy(words, (w) => w.groupId);

  // One level of the tree: its groups (A to Z) then its words (newest first).
  // While searching, a group shows when its name or anything inside it matches.
  function level(parentId, showAll) {
    let html = "";
    let shown = 0;
    let total = 0;
    for (const g of (groupsIn.get(parentId) ?? []).toSorted(byName)) {
      const nameMatches = Boolean(q) && g.name.toLowerCase().includes(q);
      const inner = level(g.id, showAll || nameMatches);
      total += inner.total;
      if (!showAll && !nameMatches && !inner.shown) continue;
      shown += inner.shown;
      html += groupHtml(g, inner.html, inner.total, Boolean(q));
    }
    for (const w of wordsIn.get(parentId) ?? []) {
      total++;
      if (!showAll && !matches(w, q)) continue;
      shown++;
      html += wordHtml(w, selected);
    }
    return { html, shown, total };
  }
  const tree = level(null, !q);

  const hint = !q && !groups.length && words.length >= 2
    ? `<li class="list-hint">${touchFirst ? "Hold a word and drag it onto another" : "Drag a word onto another"} to put them in a group.</li>`
    : "";
  els.list.innerHTML =
    [pending, ...relatives].filter(Boolean).map((w) => `<li><div class="word-row pending">
        <span class="w">${w === pending ? "Looking up" : "Adding"} "${esc(w)}"…</span><span class="skeleton"></span>
      </div></li>`).join("") + tree.html + hint;

  els.count.textContent = words.length === 1 ? "1 word" : `${words.length} words`;

  if (pending || relatives.length || tree.shown) {
    els.empty.hidden = true;
  } else if (!words.length) {
    els.empty.hidden = false;
    els.empty.innerHTML = `<h2>Your dictionary is empty</h2>
      <p>Type or say an English word above. Vazhe fills in its Persian meanings, word type, a definition and an example.</p>`;
  } else {
    els.empty.hidden = false;
    els.empty.innerHTML = `<p>No saved word matches "${esc(els.input.value.trim())}". Press Add to look it up.</p>`;
  }

  if (renaming) {
    const input = els.list.querySelector(".group-rename input");
    input?.focus({ preventScroll: true });
    input?.closest(".group").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function renderDetail() {
  const w = words.find((x) => x.id === selectedId());
  els.app.classList.toggle("has-selection", Boolean(w));
  if (!w) {
    els.detail.innerHTML = els.detailEmpty;
    return;
  }

  const byPos = Map.groupBy(w.senses.map((s, i) => ({ ...s, i })), (s) => s.partOfSpeech);
  const sensesHtml = [...byPos].map(([pos, senses]) => `
    <section class="pos-group">
      <h2>${esc(pos)}</h2>
      <ol class="senses">${senses.map((s) => s.i === editing ? `
        <li class="sense editing">${senseForm(s, s.i)}</li>` : `
        <li class="sense">
          ${s.persian.length
            ? `<p class="meaning" lang="fa" dir="rtl">${esc(s.persian.join("، "))}</p>`
            : `<button class="add-fa" type="button" data-action="edit-sense" data-index="${s.i}">${icon("plus")}<span>Add Persian meaning</span></button>`}
          ${s.definition ? `<p class="definition">${esc(s.definition)}</p>` : ""}
          ${s.example ? `<p class="example">${esc(s.example)}</p>` : ""}
          <button class="icon-btn sense-edit" type="button" data-action="edit-sense" data-index="${s.i}" aria-label="Edit this meaning">${icon("pencil")}</button>
        </li>`).join("")}
      </ol>
    </section>`).join("");

  const newSenseHtml = editing === "new"
    ? `<section class="pos-group new-sense"><h2>New meaning</h2>${senseForm({ partOfSpeech: w.senses[0]?.partOfSpeech ?? "noun", persian: [], definition: "", example: "" }, "new")}</section>`
    : `<button class="btn quiet add-sense" type="button" data-action="edit-sense" data-index="new">${icon("plus")}<span>Add a meaning</span></button>`;

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
          ${w.audio || "speechSynthesis" in window ? `<button class="icon-btn" type="button" data-action="speak" aria-label="Hear the pronunciation">${icon("speaker-high")}</button>` : ""}
          <span>${esc(w.phonetic)}</span>
        </div>
      </header>
      ${w.senses.some((s) => s.persian.length) || editing !== null ? "" : `<p class="no-persian">No Persian meaning was found for this word. You can add your own.</p>`}
      ${sensesHtml}
      ${newSenseHtml}
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
        ${groups.length ? `<label class="group-picker">${icon("folder")}<span class="sr-only">Group</span>
          <select class="input" name="group" aria-label="Group">
            <option value="">No group</option>
            ${groupPaths().map(([id, path]) => `<option value="${id}" ${id === w.groupId ? "selected" : ""}>${esc(path)}</option>`).join("")}
          </select>
        </label>` : ""}
        <button class="btn danger" type="button" data-action="delete-word">${icon("trash")}<span>Delete word</span></button>
      </footer>
    </article>`;
}

// Every group as [id, "Parent / Child"], in tree order.
function groupPaths() {
  const groupsIn = Map.groupBy(groups, (g) => g.parentId);
  const out = [];
  const walk = (parentId, prefix) => {
    for (const g of (groupsIn.get(parentId) ?? []).toSorted(byName)) {
      out.push([g.id, prefix + g.name]);
      walk(g.id, `${prefix}${g.name} / `);
    }
  };
  walk(null, "");
  return out;
}

function senseForm(s, index) {
  return `<form class="sense-form" data-index="${index}" autocomplete="off">
    <label><span>Persian meanings <span class="hint">separate them with commas</span></span>
      <span class="field">
        <input id="persian-input" name="persian" type="text" lang="fa" dir="rtl" maxlength="400" value="${esc(s.persian.join("، "))}">
        <button class="icon-btn mic" type="button" data-mic-for="persian-input" aria-label="Say a Persian meaning" ${Recognition ? "" : "hidden"}>${icon("microphone")}</button>
      </span>
    </label>
    <label>Word type
      <select class="input" name="partOfSpeech">${POS_NAMES.map((p) => `<option ${p === s.partOfSpeech ? "selected" : ""}>${p}</option>`).join("")}</select>
    </label>
    <label><span>Definition <span class="hint">in English</span></span>
      <textarea class="input" name="definition" rows="2" maxlength="400">${esc(s.definition)}</textarea>
    </label>
    <label>Example
      <textarea class="input" name="example" rows="2" maxlength="400">${esc(s.example)}</textarea>
    </label>
    <p class="form-error" role="alert"></p>
    <div class="actions">
      <button class="btn primary" type="submit">Save</button>
      <button class="btn quiet" type="button" data-action="cancel-edit">Cancel</button>
      ${index === "new" ? "" : `<button class="btn danger" type="button" data-action="delete-sense" data-index="${index}">${icon("trash")}<span>Delete meaning</span></button>`}
    </div>
  </form>`;
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
    const { related = [], skipped, hasFamily, ...entry } = await api("/words", { method: "POST", body: { word } });
    if (!words.some((w) => w.id === entry.id)) words.unshift(entry);
    if (entry.existing) setStatus(`"${entry.word}" is already in your dictionary.`);
    els.input.value = "";
    select(entry.id);
    if (hasFamily) addRelatives(entry, related);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    pending = null;
    els.addBtn.disabled = false;
    render();
  }
}

const quoteList = (list) => {
  const q = list.map((w) => `"${w}"`);
  return q.length > 1 ? `${q.slice(0, -1).join(", ")} and ${q.at(-1)}` : q[0];
};

// Adds the other forms of a new word in the background and groups the family.
// `include` lists forms the user deleted before but now wants added.
async function addRelatives(entry, names, include = []) {
  relatives = names;
  if (names.length) setStatus(`Adding other forms of "${entry.word}": ${names.join(", ")}…`);
  renderList();
  try {
    const result = await api(`/words/${entry.id}/family`, { method: "POST", body: { include } });
    words.unshift(...result.added.toReversed());
    applyTree(result);
    relatives = [];
    render();

    const parts = [];
    if (result.added.length) parts.push(`Also added ${quoteList(result.added.map((w) => w.word))}.`);
    if (result.failed.length) parts.push(`Couldn't look up ${quoteList(result.failed)}.`);
    if (result.skipped.length) {
      parts.push(`Skipped ${quoteList(result.skipped)}, which you deleted before.`);
    }
    setStatus(parts.join(" "));
    if (result.skipped.length) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-btn";
      btn.textContent = result.skipped.length > 1 ? "Add them anyway" : "Add it anyway";
      btn.addEventListener("click", () => addRelatives(entry, result.skipped, result.skipped));
      els.status.append(" ", btn);
    }

    if (result.groupId) {
      collapsed.delete(result.groupId);
      saveCollapsed();
      renderList();
      showLanded({ kind: "group", id: result.groupId });
    }
  } catch (err) {
    relatives = [];
    renderList();
    setStatus(`Couldn't add the other forms of "${entry.word}". ${err.message}`, true);
  }
}

function editSense(index) {
  editing = index;
  renderDetail();
  $(".sense-form [name=persian]")?.focus();
}

async function saveSenses(w, senses, form) {
  try {
    const updated = await api(`/words/${w.id}/senses`, { method: "PUT", body: { senses } });
    editing = null;
    replaceWord({ ...w, senses: updated.senses });
  } catch (err) {
    if (form) form.querySelector(".form-error").textContent = err.message;
    else alert(err.message);
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
  if (e.target.classList.contains("sense-form")) {
    e.preventDefault();
    const form = e.target;
    const w = words.find((x) => x.id === selectedId());
    const f = form.elements;
    const sense = {
      partOfSpeech: f.partOfSpeech.value,
      persian: f.persian.value.split(/[,،;؛]/).map((p) => p.trim()).filter(Boolean),
      definition: f.definition.value.trim(),
      example: f.example.value.trim(),
    };
    if (!sense.persian.length && !sense.definition) {
      form.querySelector(".form-error").textContent = "Add a Persian meaning or a definition.";
      return f.persian.focus();
    }
    const index = form.dataset.index;
    const senses = index === "new" ? [...w.senses, sense] : w.senses.map((s, i) => (i === Number(index) ? sense : s));
    return saveSenses(w, senses, form);
  }
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

  if (btn.dataset.action === "speak") pronounce(w);
  if (btn.dataset.action === "edit-sense") editSense(btn.dataset.index === "new" ? "new" : Number(btn.dataset.index));
  if (btn.dataset.action === "cancel-edit") {
    editing = null;
    renderDetail();
  }
  if (btn.dataset.action === "delete-sense") {
    if (!confirm("Delete this meaning?")) return;
    const index = Number(btn.dataset.index);
    await saveSenses(w, w.senses.filter((_, i) => i !== index), btn.form);
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
      groups = (await api("/tree")).groups; // a group left empty is gone
      select(null);
      render();
    } catch (err) {
      alert(err.message);
    }
  }
});

els.detail.addEventListener("change", async (e) => {
  if (e.target.name !== "group") return;
  const id = selectedId();
  const groupId = e.target.value ? Number(e.target.value) : null;
  if (await changeTree(`/words/${id}/group`, "PUT", { groupId })) {
    render();
    showLanded({ kind: "word", id });
  }
});

els.detail.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || editing === null) return;
  editing = null;
  renderDetail();
});

addEventListener("hashchange", () => {
  editing = null;
  render();
  if (selectedId()) els.detail.focus({ preventScroll: true });
  els.detail.scrollTop = 0;
});

/* ---------- Groups ---------- */

// Takes the server's answer to a change: the groups and each word's group.
function applyTree(tree) {
  groups = tree.groups;
  const groupOf = new Map(tree.words.map((w) => [w.id, w.groupId]));
  words = words.map((w) => ({ ...w, groupId: groupOf.get(w.id) ?? null }));
}

const groupById = (id) => groups.find((g) => g.id === id);

// Whether group `id` is `ancestor` or inside it.
function isWithin(id, ancestor) {
  for (let g = id; g != null; g = groupById(g)?.parentId) if (g === ancestor) return true;
  return false;
}

const itemOf = (li) => ({ kind: li.dataset.kind, id: Number(li.dataset.id) });
const parentOf = ({ kind, id }) => (kind === "word" ? words.find((w) => w.id === id)?.groupId : groupById(id)?.parentId) ?? null;

async function changeTree(path, method, body) {
  try {
    const tree = await api(path, { method, body });
    applyTree(tree);
    return tree;
  } catch (err) {
    setStatus(err.message, true);
    return null;
  }
}

// Briefly highlights an item in its new place, or the closed group it went into.
function showLanded({ kind, id }) {
  let li = els.list.querySelector(`li[data-kind="${kind}"][data-id="${id}"]`);
  while (li?.closest(".group.collapsed")) li = li.closest(".group.collapsed");
  li?.classList.add("landed");
  li?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setOpen(li, open) {
  const id = Number(li.dataset.id);
  li.classList.toggle("collapsed", !open);
  li.querySelector(":scope > .group-head .group-toggle")?.setAttribute("aria-expanded", String(open));
  li.querySelector(":scope > .group-body").inert = !open;
  open ? collapsed.delete(id) : collapsed.add(id);
  saveCollapsed();
}

async function saveGroupName(form) {
  const id = Number(form.dataset.id);
  const name = form.elements.name.value.trim();
  renaming = null;
  if (name && name !== groupById(id)?.name) await changeTree(`/groups/${id}`, "PATCH", { name });
  renderList();
  els.list.querySelector(`li[data-kind="group"][data-id="${id}"] .group-toggle`)?.focus({ preventScroll: true });
}

async function cancelRename() {
  const { id, isNew } = renaming;
  renaming = null;
  // Undoing a new group puts its words back where they were.
  if (isNew) await changeTree(`/groups/${id}`, "DELETE");
  renderList();
}

function startRename(id, isNew = false) {
  renaming = { id, isNew };
  renderList();
}

els.list.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const li = btn.closest(".group");
  if (btn.dataset.action === "toggle-group") setOpen(li, li.classList.contains("collapsed"));
  if (btn.dataset.action === "group-menu") openMenu(btn, Number(li.dataset.id));
  if (btn.dataset.action === "cancel-rename") cancelRename();
});

els.list.addEventListener("submit", (e) => {
  if (!e.target.classList.contains("group-rename")) return;
  e.preventDefault();
  saveGroupName(e.target);
});

// Leaving the name field saves it, as Enter does.
els.list.addEventListener("focusout", (e) => {
  const form = e.target.closest?.(".group-rename");
  if (form && renaming?.id === Number(form.dataset.id) && !form.contains(e.relatedTarget)) saveGroupName(form);
});

els.list.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.closest(".group-rename") && renaming) {
    e.preventDefault();
    cancelRename();
  }
});

// The name field's buttons don't take focus, so pressing them doesn't save first.
els.list.addEventListener("pointerdown", (e) => {
  if (e.target.closest("[data-keep-focus]")) e.preventDefault();
});

/* Group menu */

let menuGroup = null;

function openMenu(btn, id) {
  menuGroup = id;
  const r = btn.getBoundingClientRect();
  els.menu.hidden = false;
  const below = r.bottom + els.menu.offsetHeight + 8 < innerHeight;
  els.menu.style.top = `${below ? r.bottom + 4 : r.top - els.menu.offsetHeight - 4}px`;
  els.menu.style.left = `${Math.max(8, r.right - els.menu.offsetWidth)}px`;
  els.menu.querySelector("button").focus();
}

function closeMenu() {
  if (els.menu.hidden) return;
  els.menu.hidden = true;
  menuGroup = null;
}

els.menu.addEventListener("click", async (e) => {
  const choice = e.target.closest("[data-menu]")?.dataset.menu;
  const id = menuGroup;
  if (!choice) return;
  closeMenu();
  if (choice === "rename") startRename(id);
  if (choice === "ungroup") {
    const inside = [
      ...words.filter((w) => w.groupId === id).map((w) => ({ kind: "word", id: w.id })),
      ...groups.filter((g) => g.parentId === id).map((g) => ({ kind: "group", id: g.id })),
    ];
    if (await changeTree(`/groups/${id}`, "DELETE")) {
      render();
      inside.forEach(showLanded);
    }
  }
});

document.addEventListener("pointerdown", (e) => {
  if (!els.menu.hidden && !els.menu.contains(e.target) && !e.target.closest(".group-menu")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.menu.hidden) closeMenu();
});
addEventListener("resize", closeMenu);
addEventListener("scroll", closeMenu, true);

/* Moving words and groups by drag and drop */

let target = null; // what a drop would do right now
let springTimer = null; // opens a closed group the pointer rests on
let springId = null;

// What dropping `item` at x, y would do, or null if nothing (or nothing useful).
function dropTargetAt(item, x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  if (hit.closest("#drop-top")) return toGroup(item, null, els.dropTop);
  if (!els.list.contains(hit)) return null;

  const li = hit.closest("li[data-kind]");
  if (!li) return toGroup(item, null, els.list); // empty space in the list
  const r = li.getBoundingClientRect();

  if (li.dataset.kind === "word") {
    const w = words.find((x) => x.id === Number(li.dataset.id));
    const edge = Math.min(r.height * 0.22, 12);
    // The middle of a word makes a group; its top or bottom edge means "at this level".
    if (y > r.top + edge && y < r.bottom - edge) return combineWith(item, w, li);
    return toGroup(item, w.groupId, w.groupId ? li.parentElement.closest(".group") : els.list);
  }

  const id = Number(li.dataset.id);
  const head = li.querySelector(":scope > .group-head");
  const hr = head.getBoundingClientRect();
  if (head.contains(hit) && y < hr.top + Math.min(hr.height * 0.22, 10)) {
    const parentId = groupById(id).parentId;
    return toGroup(item, parentId, parentId ? li.parentElement.closest(".group") : els.list);
  }
  return toGroup(item, id, li, head.contains(hit));
}

function combineWith(item, w, li) {
  if (item.kind === "word" && item.id === w.id) return null;
  if (item.kind === "group" && isWithin(w.groupId, item.id)) return null;
  return { type: "combine", word: w, el: li, label: `New group with “${w.word}”` };
}

function toGroup(item, groupId, el, onHead = false) {
  if (item.kind === "group" && isWithin(groupId, item.id)) return null;
  if (groupId === parentOf(item)) return null; // already there
  const label = groupId === null ? "Move to the top level" : `Move into “${groupById(groupId).name}”`;
  return { type: "move", groupId, el, onHead, label };
}

function clearDropMarks() {
  document.querySelectorAll(".drop-combine, .drop-into, .drop-root").forEach((el) =>
    el.classList.remove("drop-combine", "drop-into", "drop-root"));
}

function springOpen(t) {
  const id = t?.type === "move" && t.onHead && t.el.classList.contains("collapsed") ? t.groupId : null;
  if (id === springId) return;
  clearTimeout(springTimer);
  springId = id;
  if (id) springTimer = setTimeout(() => setOpen(t.el, true), 650);
}

makeDraggable(els.list, {
  items: "li[data-kind]",
  // Groups are dragged by their header; nothing moves while searching or naming.
  canDrag: (li, e) => !query() && !pending && !renaming && !e.target.closest(".group-menu")
    && (li.dataset.kind === "word" || e.target.closest(".group-head")?.parentElement === li),
  ghost: (li) => {
    const item = itemOf(li);
    if (item.kind === "group") {
      const g = groupById(item.id);
      return `${icon("folder")}<span class="w">${esc(g.name)}</span><span class="group-count">${li.querySelector(".group-count").textContent}</span>`;
    }
    const w = words.find((x) => x.id === item.id);
    return `<span class="w">${esc(w.word)}</span><span class="fa" lang="fa" dir="rtl">${esc(firstPersian(w))}</span>`;
  },
  over: (li, x, y) => {
    const item = itemOf(li);
    document.documentElement.classList.toggle("dragging-nested", parentOf(item) !== null);
    clearDropMarks();
    target = dropTargetAt(item, x, y);
    springOpen(target);
    if (!target) return null;
    if (target.type === "combine") target.el.classList.add("drop-combine");
    else if (target.groupId === null) target.el.classList.add("drop-root");
    else target.el.classList.add("drop-into");
    // The top-level zone says what it does itself.
    return { label: target.el === els.dropTop ? "" : target.label, ok: true };
  },
  end: () => {
    clearDropMarks();
    springOpen(null);
    document.documentElement.classList.remove("dragging-nested");
  },
  drop: async (li) => {
    const item = itemOf(li);
    const t = target;
    if (t.type === "combine") {
      const tree = await changeTree("/groups", "POST", {
        parentId: t.word.groupId,
        items: [item, { kind: "word", id: t.word.id }],
      });
      if (!tree) return;
      collapsed.delete(tree.created);
      startRename(tree.created, true);
      els.list.querySelector(`li[data-kind="group"][data-id="${tree.created}"]`)?.classList.add("landed");
      return;
    }
    const ok = item.kind === "word"
      ? await changeTree(`/words/${item.id}/group`, "PUT", { groupId: t.groupId })
      : await changeTree(`/groups/${item.id}`, "PATCH", { parentId: t.groupId });
    if (!ok) return;
    render();
    showLanded(item);
  },
  scroller: () => (matchMedia("(min-width: 900px)").matches ? els.list : document.scrollingElement),
});

/* ---------- Pronunciation ---------- */

// Plays the recorded pronunciation, or the device's voice when there is none
// or it can't be played (for example offline).
let player = null;

function pronounce(w) {
  player?.pause();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (!w.audio) return speakWithVoice(w.word);
  player = new Audio(w.audio);
  player.play().catch(() => speakWithVoice(w.word));
}

function speakWithVoice(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  speechSynthesis.speak(u);
}

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
    recognition.lang = input.lang === "fa" ? "fa-IR" : "en-US";
    recognition.interimResults = true;
    btn.classList.add("listening");
    btn.setAttribute("aria-pressed", "true");

    let heard = "";
    recognition.onresult = (ev) => {
      heard = [...ev.results].map((r) => r[0].transcript).join("");
      input.value = isWord || !before.trim() ? heard : `${before}${input.lang === "fa" ? "،" : ""} ${heard}`;
      if (isWord) renderList();
    };
    recognition.onerror = (ev) => {
      if (ev.error !== "not-allowed") return;
      setStatus(window.isSecureContext
        ? "Allow microphone access to speak words."
        : "The microphone needs a secure connection. Open the app over https, or see the README for using it on your phone.", true);
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

/* ---------- Loading ---------- */

async function load() {
  try {
    [words, { groups }] = await Promise.all([api("/words"), api("/tree")]);
  } catch (err) {
    setStatus(err.message, true);
  }
  render();
}

/* ---------- Accounts ---------- */

let signupMode = "closed"; // "open" (first account), "code" (invite code) or "closed"
let authMode = "login";

// Removes saved copies of anyone's words from this device's offline cache.
async function forgetCachedData() {
  if (!("caches" in window)) return;
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      if (new URL(request.url).pathname.includes("/api/")) await cache.delete(request);
    }
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  const first = signup && signupMode === "open";
  els.authTitle.textContent = first ? "Create your account" : signup ? "Create an account" : "Sign in";
  els.authLead.textContent = first
    ? "You're the first one here, so your account keeps the words already saved."
    : "Your own English to Persian dictionary.";
  els.authSubmit.textContent = signup ? "Create account" : "Sign in";
  $("#auth-password").autocomplete = signup ? "new-password" : "current-password";
  $("#auth-password-hint").hidden = !signup;
  $("#auth-code-row").hidden = !(signup && signupMode === "code");
  els.authSwitch.hidden = signupMode === "closed" && !signup;
  els.authSwitchText.textContent = signup ? "Have an account?" : "New here?";
  els.authToggle.textContent = signup ? "Sign in" : "Create an account";
  els.authError.textContent = "";
}

function showAuth(message = "") {
  words = [];
  groups = [];
  closeAccountMenu();
  if (els.pwDialog.open) els.pwDialog.close();
  document.querySelector(".app").hidden = true;
  els.auth.hidden = false;
  setAuthMode(authMode);
  els.authError.textContent = message;
  $("#auth-username").focus();
}

function enter(user) {
  els.auth.hidden = true;
  els.authForm.reset();
  document.querySelector(".app").hidden = false;
  $("#account-name").textContent = user.username;
  els.accountBtn.setAttribute("aria-label", `Account: ${user.username}`);
  setStatus();
  load();
}

els.authToggle.addEventListener("click", () => {
  setAuthMode(authMode === "login" ? "signup" : "login");
  $("#auth-username").focus();
});

$("#auth-reveal").addEventListener("click", (e) => {
  const input = $("#auth-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  e.currentTarget.setAttribute("aria-pressed", String(show));
  e.currentTarget.setAttribute("aria-label", show ? "Hide password" : "Show password");
  e.currentTarget.querySelector("use").setAttribute("href", `icons.svg#i-${show ? "eye-slash" : "eye"}`);
});

els.authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = els.authForm.elements;
  const body = { username: f.username.value.trim(), password: f.password.value };
  if (authMode === "signup") {
    if (body.password.length < 8) {
      els.authError.textContent = "Use a password of at least 8 characters.";
      return f.password.focus();
    }
    if (signupMode === "code") body.code = f.code.value.trim();
  }
  els.authSubmit.disabled = true;
  els.authError.textContent = "";
  try {
    const { user } = await api(`/auth/${authMode === "signup" ? "signup" : "login"}`, { method: "POST", body });
    await forgetCachedData();
    f.password.type = "password";
    enter(user);
  } catch (err) {
    els.authError.textContent = err.message;
    f.password.select();
  } finally {
    els.authSubmit.disabled = false;
  }
});

/* Account menu */

function closeAccountMenu() {
  els.accountMenu.hidden = true;
  els.accountBtn.setAttribute("aria-expanded", "false");
}

els.accountBtn.addEventListener("click", () => {
  if (!els.accountMenu.hidden) return closeAccountMenu();
  const r = els.accountBtn.getBoundingClientRect();
  els.accountMenu.hidden = false;
  els.accountBtn.setAttribute("aria-expanded", "true");
  els.accountMenu.style.top = `${r.bottom + 4}px`;
  els.accountMenu.style.left = `${Math.max(8, r.right - els.accountMenu.offsetWidth)}px`;
  els.accountMenu.querySelector("button").focus();
});

document.addEventListener("pointerdown", (e) => {
  if (!els.accountMenu.hidden && !els.accountMenu.contains(e.target) && !els.accountBtn.contains(e.target)) closeAccountMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.accountMenu.hidden) {
    closeAccountMenu();
    els.accountBtn.focus();
  }
});

els.accountMenu.addEventListener("click", async (e) => {
  const choice = e.target.closest("[data-account]")?.dataset.account;
  if (!choice) return;
  closeAccountMenu();
  if (choice === "password") {
    els.pwForm.reset();
    els.pwForm.querySelector(".form-error").textContent = "";
    els.pwDialog.showModal();
  }
  if (choice === "sign-out") {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    await forgetCachedData();
    select(null);
    authMode = "login";
    showAuth();
  }
});

els.pwForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = els.pwForm.elements;
  const error = els.pwForm.querySelector(".form-error");
  if (f.password.value.length < 8) {
    error.textContent = "Use a new password of at least 8 characters.";
    return f.password.focus();
  }
  try {
    await api("/auth/password", { method: "POST", body: { current: f.current.value, password: f.password.value } });
    els.pwDialog.close();
    setStatus("Your password was changed. Other devices were signed out.");
  } catch (err) {
    error.textContent = err.message;
  }
});
els.pwForm.querySelector("[data-close]").addEventListener("click", () => els.pwDialog.close());

/* ---------- Start ---------- */

async function start() {
  try {
    const status = await api("/auth/status");
    signupMode = status.signup;
    if (status.user) return enter(status.user);
    authMode = signupMode === "open" ? "signup" : "login";
    showAuth();
  } catch (err) {
    // Offline: show the words saved on this device, if any.
    document.querySelector(".app").hidden = false;
    setStatus(err.message, true);
    load();
  }
}

start();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
