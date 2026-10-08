// Drag and drop with pointer events, so it works the same with a mouse, a
// finger or a pen. A mouse drag starts once the pointer moves; a touch drag
// starts after holding still for a moment, so a quick swipe still scrolls.
//
// makeDraggable(container, {
//   items:   selector of the draggable elements inside container,
//   canDrag: (el, event) => whether this press may start a drag,
//   ghost:   (el) => HTML of the card that follows the pointer,
//   over:    (el, x, y) => { label, ok } describing what a drop here does,
//   drop:    (el) => called on release over a place where ok was true,
//   end:     () => called when the drag ends either way,
//   scroller: () => the element to scroll near the edges,
// })

const HOLD_MS = 360;
const SLOP_PX = 6;
const EDGE_PX = 64;
const MAX_SPEED = 16;

export function makeDraggable(container, opts) {
  let press = null; // a pointer that is down on an item but not dragging yet
  let drag = null; // the drag in progress
  let suppressClick = false;

  container.addEventListener("pointerdown", (e) => {
    if (drag || press || e.button !== 0 || !e.isPrimary) return;
    const el = e.target.closest(opts.items);
    if (!el || !container.contains(el) || !opts.canDrag(el, e)) return;
    press = { el, id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse" };
    if (press.touch) {
      el.classList.add("pressing");
      press.timer = setTimeout(() => start(e.clientX, e.clientY), HOLD_MS);
    }
  });

  addEventListener("pointermove", (e) => {
    if (drag && e.pointerId === drag.id) {
      e.preventDefault();
      move(e.clientX, e.clientY);
      return;
    }
    if (!press || e.pointerId !== press.id) return;
    const far = Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP_PX;
    if (!far) return;
    if (press.touch) cancelPress(); // moving before the hold ends means scrolling
    else start(e.clientX, e.clientY);
  }, { passive: false });

  addEventListener("pointerup", (e) => {
    if (drag && e.pointerId === drag.id) finish(true);
    else if (press && e.pointerId === press.id) cancelPress();
  });
  addEventListener("pointercancel", () => {
    if (drag) finish(false);
    cancelPress();
  });
  addEventListener("keydown", (e) => {
    if (drag && e.key === "Escape") finish(false);
  });
  addEventListener("blur", () => drag && finish(false));

  // Once a touch drag has started, the finger moves the card, not the page.
  container.addEventListener("touchmove", (e) => {
    if (drag) e.preventDefault();
  }, { passive: false });
  // Rows are links, which the browser would drag on its own.
  container.addEventListener("dragstart", (e) => e.preventDefault());
  // A long press would otherwise open the link menu or select text.
  container.addEventListener("contextmenu", (e) => {
    if (press || drag) e.preventDefault();
  });
  // The release at the end of a drag isn't a click on the row under it.
  container.addEventListener("click", (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press.el.classList.remove("pressing");
    press = null;
  }

  function start(x, y) {
    const { el, id, touch } = press;
    clearTimeout(press.timer);
    el.classList.remove("pressing");
    press = null;

    const rect = el.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.innerHTML = `<p class="drag-label"></p><div class="drag-card">${opts.ghost(el)}</div>`;
    ghost.style.width = `${Math.min(rect.width, 340)}px`;
    document.body.append(ghost);

    drag = {
      el, id, ghost, x, y, touch,
      label: ghost.querySelector(".drag-label"),
      // Keep the card where it was grabbed.
      dx: Math.min(x - rect.left, 40),
      dy: Math.min(y - rect.top, 24),
      ok: false,
    };
    el.classList.add("drag-source");
    document.documentElement.classList.add("dragging");
    getSelection()?.removeAllRanges();
    navigator.vibrate?.(12);
    move(x, y);
    drag.frame = requestAnimationFrame(autoScroll);
  }

  function move(x, y) {
    drag.x = x;
    drag.y = y;
    const { label = "", ok = false } = opts.over(drag.el, x, y) ?? {};
    drag.ok = ok;
    drag.label.textContent = label || "\u00a0"; // keeps its height while hidden
    drag.label.hidden = !label;
    drag.ghost.classList.toggle("can-drop", ok);
    // On touch the card floats above the finger, so the row under it stays visible.
    const top = drag.touch ? y - drag.ghost.offsetHeight - 16 : y - drag.dy - drag.label.offsetHeight - 6;
    drag.ghost.style.transform = `translate(${x - drag.dx}px, ${top}px)`;
  }

  // Scrolls while the pointer is near the top or bottom of the scrolling area.
  function autoScroll() {
    if (!drag) return;
    const scroller = opts.scroller();
    const isPage = scroller === document.scrollingElement;
    const top = isPage ? 0 : scroller.getBoundingClientRect().top;
    const bottom = isPage ? innerHeight : scroller.getBoundingClientRect().bottom;
    let speed = 0;
    if (drag.y < top + EDGE_PX) speed = -MAX_SPEED * Math.min(1, (top + EDGE_PX - drag.y) / EDGE_PX);
    else if (drag.y > bottom - EDGE_PX) speed = MAX_SPEED * Math.min(1, (drag.y - bottom + EDGE_PX) / EDGE_PX);
    if (speed) {
      const before = scroller.scrollTop;
      scroller.scrollTop += speed;
      if (scroller.scrollTop !== before) move(drag.x, drag.y); // what's under the pointer changed
    }
    drag.frame = requestAnimationFrame(autoScroll);
  }

  function finish(dropped) {
    const { el, ghost, ok, frame } = drag;
    cancelAnimationFrame(frame);
    drag = null;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    el.classList.remove("drag-source");
    document.documentElement.classList.remove("dragging");
    ghost.classList.add(dropped && ok ? "dropped" : "returning");
    setTimeout(() => ghost.remove(), 160);
    opts.end();
    if (dropped && ok) opts.drop(el);
  }
}
