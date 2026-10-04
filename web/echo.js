/**
 * The Echo-style demo page.
 *
 * A screen and the lines somebody might say to it. Every line is a real tool call to this server. No assistant
 * model runs here, so the lines are fixed and listed in echo-scenes.json; what comes back is whatever the
 * server says today, for the farm built on this page.
 *
 * One line takes something typed: the eight digits a crew member reads out from their own Sudor. That is the
 * only thing that crosses from one add-on to the other by hand. After it, this server asks that one directly.
 */

const SESSION_KEY = 'orbita.demo.session';
const SESSION_FORMAT = /^[0-9a-f]{32}$/;
const el = (id) => document.getElementById(id);

function newSession() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
let session = null;
try { session = localStorage.getItem(SESSION_KEY); } catch { /* private mode */ }
if (!session || !SESSION_FORMAT.test(session)) {
  session = newSession();
  try { localStorage.setItem(SESSION_KEY, session); } catch { /* nothing to do */ }
}

let rpcId = 0;
async function callTool(name, args) {
  const started = performance.now();
  const res = await fetch('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orbita-demo': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  let json;
  try { json = JSON.parse(line ? line.slice(6) : raw); } catch { throw new Error(`The server answered with something unreadable (HTTP ${res.status}).`); }
  if (json.error) throw new Error(json.error.message || 'The call failed.');
  return { ms: Math.round(performance.now() - started), text: json.result?.content?.[0]?.text ?? '', data: json.result?.structuredContent ?? {} };
}

function speak(text) {
  if (!el('voice').checked || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function showCard(card) {
  const box = el('card');
  box.replaceChildren();
  if (!card || card.kind !== 'card') { box.hidden = true; return; }
  const title = document.createElement('h3');
  title.textContent = card.title ?? '';
  box.append(title);
  if (card.status?.label) {
    const s = document.createElement('span');
    s.className = `status ${card.status.tone === 'bad' ? 'bad' : card.status.tone === 'good' ? 'good' : ''}`;
    s.textContent = card.status.label;
    box.append(s);
  }
  const list = document.createElement('ul');
  for (const line of [...(card.lines ?? []), card.confirm, card.foot].filter(Boolean)) {
    const li = document.createElement('li');
    li.textContent = line;
    list.append(li);
  }
  if (list.children.length) box.append(list);
  box.hidden = false;
}

async function say(line, typed, focusBack) {
  const controls = [...document.querySelectorAll('.chip, .typed')];
  controls.forEach((b) => (b.disabled = true));
  el('heard').classList.remove('idle');
  el('heard').textContent = typed ? `${line.say} ${typed}` : line.say;
  el('answer').textContent = '…';
  try {
    const args = { ...(line.args ?? {}) };
    if (line.input) args[line.input] = typed;
    const r = await callTool(line.tool, args);
    el('answer').textContent = r.text;
    el('meta').textContent = `${line.tool} answered in ${r.ms} ms${r.data.decidedBy ? `, decided by the ${r.data.decidedBy}` : ''}`;
    showCard(r.data.card);
    speak(r.text);
  } catch (err) {
    el('answer').textContent = err.message;
    el('meta').textContent = '';
    showCard(null);
  } finally {
    controls.forEach((b) => (b.disabled = false));
    focusBack?.focus();
  }
}

async function start() {
  el('heard').classList.add('idle');
  const scenes = await (await fetch('/echo-scenes.json')).json();
  const host = el('lines');
  let n = 0;
  for (const group of scenes.groups) {
    const box = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = group.name;
    box.append(title);
    for (const line of group.lines) {
      if (line.input) {
        // A line with something to type: the words, a box for the rest, and a button that says it.
        const form = document.createElement('form');
        form.className = 'chip-form';
        const id = `typed-${(n += 1)}`;
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = line.say;
        const box2 = document.createElement('input');
        box2.id = id;
        box2.className = 'typed';
        box2.inputMode = 'numeric';
        box2.autocomplete = 'off';
        box2.placeholder = line.hint ?? '';
        const go = document.createElement('button');
        go.type = 'submit';
        go.className = 'chip go';
        go.textContent = 'Say it';
        form.append(label, box2, go);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (box2.value.trim()) void say(line, box2.value.trim(), go);
        });
        box.append(form);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = line.say;
      b.addEventListener('click', () => void say(line, '', b));
      box.append(b);
    }
    host.append(box);
  }
  el('reset').addEventListener('click', () => {
    try { localStorage.setItem(SESSION_KEY, newSession()); } catch { /* nothing to do */ }
    location.reload();
  });
}

void start();
