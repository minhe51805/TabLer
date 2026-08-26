// Diagnose Monaco gutter alignment in the running webview.
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
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
await send("Runtime.enable");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ensure an editor exists: click "+ New Query" if needed.
let check = await send("Runtime.evaluate", {
  expression: `!!document.querySelector('.sql-editor-shell .monaco-editor')`,
  returnByValue: true,
});
if (!check.result.value) {
  await send("Runtime.evaluate", {
    expression: `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /new query/i.test(b.textContent)); if (b) { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'clicked'; } return 'no-button'; })()`,
    returnByValue: true,
  });
  await sleep(4000);
}

const expr = `(() => {
  const eds = document.querySelectorAll('.sql-editor-shell .monaco-editor');
  const ed = eds[0];
  if (!ed) return JSON.stringify({ err: 'still no editor' });
  const ln = ed.querySelector('.margin-view-overlays .line-numbers');
  if (!ln) return JSON.stringify({ err: 'no line numbers', editors: eds.length });
  const c = getComputedStyle(ln);
  const zooms = [];
  let el = ln;
  while (el && el !== document.documentElement) {
    const z = getComputedStyle(el).zoom;
    if (z && z !== '1') zooms.push({ cls: (el.className||'').toString().slice(0,50), zoom: z });
    el = el.parentElement;
  }
  // live test: force width and see if it sticks after a frame
  ln.style.width = '35px';
  return JSON.stringify({
    editors: eds.length,
    inlineAttr: ln.getAttribute('style'),
    computed: { width: c.width, maxWidth: c.maxWidth, display: c.display, position: c.position, fontSize: c.fontSize, zoom: c.zoom },
    ancestorZooms: zooms,
    rectBefore: ln.getBoundingClientRect().width,
  });
})()`;
const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log(res.result.value);
await sleep(500);
const after = await send("Runtime.evaluate", {
  expression: `(() => { const ln = document.querySelector('.sql-editor-shell .monaco-editor .margin-view-overlays .line-numbers'); const r = ln.getBoundingClientRect(); ln.style.width=''; return JSON.stringify({ rectAfterForce: r.width, computedAfter: getComputedStyle(ln).width, attrAfter: ln.getAttribute('style') }); })()`,
  returnByValue: true,
});
console.log(after.result.value);
ws.close();

