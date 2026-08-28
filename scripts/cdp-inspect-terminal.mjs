// Inspect the live terminal in the running app via CDP (port 9333):
// renderer size, devicePixelRatio, xterm DOM state, and PTY-side sizing.
const list = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) {
  console.log("NO_PAGE");
  process.exit(1);
}
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
await new Promise((resolve) => (ws.onopen = resolve));

const expression = `(() => {
  const header = document.querySelector('.workspace-terminal-header');
  if (!header) return 'NO_TERMINAL_DOM';
  const rect = header.getBoundingClientRect();
  const probe = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  const stack = document.elementsFromPoint(probe.x, probe.y).map((el) => ({
    tag: el.tagName,
    cls: String(el.className).slice(0, 80),
  }));

  function chainInfo(el) {
    const info = [];
    let node = el;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      info.push({
        tag: node.tagName,
        cls: String(node.className).slice(0, 60),
        opacity: cs.opacity,
        filter: cs.filter,
        backdropFilter: cs.backdropFilter,
        mixBlendMode: cs.mixBlendMode,
        transform: cs.transform === 'none' ? undefined : cs.transform,
      });
      node = node.parentElement;
    }
    return info;
  }

  const headerStyle = getComputedStyle(header);
  return JSON.stringify({
    devicePixelRatio: window.devicePixelRatio,
    headerRect: rect.toJSON(),
    headerComputed: {
      background: headerStyle.backgroundColor,
      color: headerStyle.color,
      opacity: headerStyle.opacity,
      filter: headerStyle.filter,
      backdropFilter: headerStyle.backdropFilter,
      fontSize: headerStyle.fontSize,
    },
    elementsAtHeaderCenter: stack,
    ancestorEffects: chainInfo(header),
  });
})()`;

const result = await send("Runtime.evaluate", { expression, returnByValue: true });
const { writeFileSync } = await import("node:fs");
writeFileSync("term-inspect-result.txt", String(result.result.value));
console.log("DONE");
ws.close();
process.exit(0);
