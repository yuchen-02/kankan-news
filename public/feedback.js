// Feedback form: a modal that asks one question at a time and posts the answers to the feedback
// service (worker/). Self-contained on purpose, so another project can copy this file and the
// .fb-* rules in style.css:
//
//   import { initFeedback } from "./feedback.js";
//   initFeedback({ button, endpoint: "https://feedback.xxx.workers.dev", project: "my-site" });
//
// To add a question: add a step to STEPS here and a field to FIELDS in worker/src/index.js.

export const STEPS = [
  { key: "name", title: "怎麼稱呼你", type: "input", required: true, max: 40, placeholder: "暱稱" },
  { key: "message", title: "想回饋什麼意見", type: "textarea", required: true, max: 2000, placeholder: "功能、操作、看到的問題都可以" },
  { key: "wish", title: "希望我們怎麼處理", type: "textarea", required: false, max: 1000, placeholder: "例如：增加某個功能、修正某個問題" },
];

/** Check one step's answer; returns an error text or "". Exported for tests. */
export function checkStep(step, value) {
  const v = String(value ?? "").trim();
  if (step.required && !v) return "這題需要填寫";
  if (v.length > step.max) return `最多 ${step.max} 字`;
  return "";
}

/** The request body the service expects. Exported for tests. */
export function buildPayload(project, answers, page) {
  return { project, answers, page, website: "" };
}

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
};

export function initFeedback({ button, endpoint, project, steps = STEPS, onToast = () => {} }) {
  let root = null, step = 0, sending = false, closing = false;
  const answers = {};

  // The dialog grows out of the button and shrinks back into it: its transform-origin is the
  // button's centre, measured in the dialog's own coordinates.
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function aim() {
    const d = root.querySelector(".fb-dialog");       // offsetLeft/Top ignore the scale, unlike getBoundingClientRect
    const b = button.getBoundingClientRect();
    d.style.transformOrigin = `${b.left + b.width / 2 - d.offsetLeft}px ${b.top + b.height / 2 - d.offsetTop}px`;
  }
  function close() {
    if (!root || closing) return;
    const gone = root;
    closing = true;
    document.removeEventListener("keydown", onKey);
    const finish = () => { gone.remove(); if (root === gone) root = null; closing = false; button.focus(); };
    if (still()) return finish();
    aim();
    gone.classList.remove("open");
    setTimeout(finish, 260);
  }
  const onKey = (e) => { if (e.key === "Escape" && !sending) close(); };

  function render() {
    const s = steps[step];
    const last = step === steps.length - 1;
    const field = el(s.type === "input" ? "input" : "textarea", {
      class: "fb-field", id: "fb-field", maxlength: String(s.max), placeholder: s.placeholder || "",
      ...(s.type === "input" ? { type: "text", autocomplete: "nickname" } : { rows: "6" }),
    });
    field.value = answers[s.key] ?? "";
    const error = el("p", { class: "fb-error", role: "alert" });
    const back = el("button", { type: "button", class: "btn fb-btn", text: "上一步" });
    const next = el("button", { type: "submit", class: "btn fb-btn fb-primary", text: last ? "送出" : "下一步" });
    back.hidden = step === 0;
    back.addEventListener("click", () => { answers[s.key] = field.value; step--; render(); });

    const form = el("form", { class: "fb-form", novalidate: "" },
      el("p", { class: "fb-step", text: `第 ${step + 1} / ${steps.length} 題${s.required ? "" : "（選填）"}` }),
      el("label", { class: "fb-title", for: "fb-field", text: s.title }),
      field, error,
      el("div", { class: "fb-actions" }, back, next));
    // honeypot: invisible to people; a bot that fills every field gives itself away
    const trap = el("input", { type: "text", name: "website", class: "fb-trap", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    form.append(trap);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      answers[s.key] = field.value;
      const problem = checkStep(s, field.value);
      if (problem) { error.textContent = problem; field.focus(); return; }
      if (!last) { step++; render(); return; }
      sending = true; next.disabled = back.disabled = true; next.textContent = "送出中…"; error.textContent = "";
      try {
        if (!endpoint) throw new Error("意見表單尚未設定");
        const body = buildPayload(project, answers, location.href);
        body.website = trap.value;
        const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "送出失敗，請稍後再試");
        sending = false;
        for (const k of Object.keys(answers)) delete answers[k];
        step = 0;
        close();
        onToast("已送出，謝謝你的意見！");
      } catch (err) {
        sending = false; next.disabled = back.disabled = false; next.textContent = "送出";
        error.textContent = err.message || "送出失敗，請稍後再試";
      }
    });

    root.querySelector(".fb-body").replaceChildren(form);
    field.focus();
  }

  function open() {
    if (root || closing) return;
    root = el("div", { class: "fb-shade" },
      el("div", { class: "fb-dialog", role: "dialog", "aria-modal": "true", "aria-label": "意見表單" },
        el("div", { class: "fb-head" },
          el("h2", { text: "意見表單" }),
          el("button", { type: "button", class: "btn icon-btn fb-x", "aria-label": "關閉", title: "關閉" })),
        el("div", { class: "fb-body" }),
        el("p", { class: "fb-note", text: "不用登入直接填，不會收集到你的個資，也請不要傳垃圾訊息ovo。" })));
    root.querySelector(".fb-x").innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    root.querySelector(".fb-x").addEventListener("click", () => { if (!sending) close(); });
    root.addEventListener("mousedown", (e) => { if (e.target === root && !sending) close(); });
    document.body.append(root);
    document.addEventListener("keydown", onKey);
    step = 0;
    render();
    aim();
    requestAnimationFrame(() => requestAnimationFrame(() => root?.classList.add("open")));
  }

  button.addEventListener("click", open);
  return { open, close };
}
