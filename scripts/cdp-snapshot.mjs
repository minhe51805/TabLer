// Back to launcher, connect Mathlab, open query tab, diagnose gutter.
const list = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
const errors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
    errors.push(`[log] ${msg.params.entry.text.slice(0, 150)}`);
  }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  return r.result.value;
};

// 0. go back to launcher if on another screen
console.log("screen:", await evalJs(`JSON.stringify(Array.from(document.querySelectorAll('button,[role=button],a')).map(b => (b.getAttribute('aria-label') || b.title || b.innerText || '').trim()).filter(Boolean).slice(0, 20))`));
await sleep(2500);

// 1. try each LOCAL connection
const names = await evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.startup-connection-row')).map(r => r.querySelector('.startup-connection-title')?.textContent.trim()))`);
console.log("rows:", names);
for (const name of JSON.parse(names)) {
  const clicked = await evalJs(`(() => {
    const rows = Array.from(document.querySelectorAll('.startup-connection-row'));
    const row = rows.find(r => r.querySelector('.startup-connection-title')?.textContent.trim() === ${JSON.stringify(name)});
    if (!row) return 'gone';
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach((t) => {
      const Ev = t.startsWith('pointer') ? PointerEvent : MouseEvent;
      row.dispatchEvent(new Ev(t, { bubbles: true, cancelable: true, view: window, button: 0 }));
    });
    return 'clicked';
  })()`);
  await sleep(4000);
  const state = await evalJs(`JSON.stringify({ editor: !!document.querySelector('.sql-editor-shell .monaco-editor'), launcher: !!document.querySelector('.startup-connection-row'), head: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 80) })`);
  console.log(`[${name}] ${clicked} -> ${state}`);
  if (JSON.parse(state).editor || !JSON.parse(state).launcher) break;
}
await sleep(8000);
for (let i = 0; i < 10; i++) {
  const t = await evalJs(`(() => {
    const toast = document.querySelector('[class*=toast], [class*=notification], [role=alert], [class*=error]');
    return JSON.stringify({
      launcher: !!document.querySelector('.startup-connection-row'),
      editor: !!document.querySelector('.sql-editor-shell .monaco-editor'),
      toast: toast ? toast.textContent.slice(0, 100) : null,
      head: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 90),
    });
  })()`);
  console.log(`t+${i + 1}s:`, t);
  if (JSON.parse(t).editor) break;
  await sleep(1000);
}

// 1c. click the sidebar connection entry to connect
console.log("connect-try:", await evalJs(`(() => {
  const el = document.querySelector('[title="application_service"]');
  if (!el) return 'not-found';
  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach((t) => {
    const Ev = t.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ev(t, { bubbles: true, cancelable: true, view: window, button: 0 }));
  });
  return 'clicked ' + el.tagName + ' cls ' + String(el.className).slice(0, 50);
})()`));
await sleep(8000);
console.log("state:", await evalJs(`JSON.stringify({ editor: !!document.querySelector('.sql-editor-shell .monaco-editor'), head: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 100) })`));
console.log("new-query:", await evalJs(`(() => {
  if (document.querySelector('.sql-editor-shell .monaco-editor')) return 'editor-already';
  const b = Array.from(document.querySelectorAll('button')).find(b => /new query/i.test(b.textContent || b.title || ''));
  if (!b) return 'no-button; on: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 100);
  ['mousedown','mouseup','click'].forEach(t => b.dispatchEvent(new MouseEvent(t, { bubbles: true })));
  return 'clicked';
})()`));
await sleep(6000);

// 3. diagnostics
console.log(await evalJs(`(() => {
  const ed = document.querySelector('.sql-editor-shell .monaco-editor');
  if (!ed) return JSON.stringify({ err: 'no editor', on: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 120) });
  const pane = document.querySelector('.sql-editor-pane');
  const ln = ed.querySelector('.margin-view-overlays .line-numbers');
  const line = ed.querySelector('.view-line');
  const margin = ed.querySelector('.margin');
  const collapsedBar = document.querySelector('.sql-results-collapsed-bar');
  const r = (el) => el ? Math.round(el.getBoundingClientRect().x) : null;
  return JSON.stringify({
    lineNumberX: r(ln),
    textX: r(line),
    marginWidth: margin ? Math.round(margin.getBoundingClientRect().width) : null,
    lnComputedWidth: ln ? getComputedStyle(ln).width : null,
    lnY: ln ? Math.round(ln.getBoundingClientRect().y) : null,
    lineY: line ? Math.round(line.getBoundingClientRect().y) : null,
    paneBottomGap: pane ? Math.round(pane.getBoundingClientRect().height - ed.getBoundingClientRect().height) : null,
    collapsedBarPresent: !!collapsedBar,
  });
})()`));
console.log("errors:", errors.slice(-5).join("\n") || "(none)");
ws.close();
