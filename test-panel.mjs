/**
 * The Echo Show panel, run the way an MCP Apps host runs it.
 *
 * The first version of the panel only listened for messages and pointed at
 * itself with a flat 'ui.resourceUri' key. The spec wants a nested
 * _meta.ui.resourceUri, and a host may not send the view anything until the
 * view has said ui/initialize and confirmed with ui/notifications/initialized.
 * So on a real host it would have stayed on its example forever, and no test
 * noticed because no test ever played the host. This one does.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { registerTools } from './dist/tools.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const html = readFileSync('./ui/window.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function boot({ embedded = true } = {}) {
  const els = new Map();
  const element = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, textContent: '', innerHTML: '', className: '', hidden: false, style: {}, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        classList: { toggle() {} },
      });
    }
    return els.get(id);
  };
  const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, scrollWidth: 480, scrollHeight: 320 };
  const sent = [];
  const listeners = [];
  const window = { addEventListener: (_type, fn) => listeners.push(fn) };
  window.parent = embedded ? { postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) } : window;
  const deliver = (data) => listeners.forEach((fn) => fn({ data }));
  vm.runInNewContext(script, {
    window, document: { getElementById: element, documentElement: root },
    setTimeout, clearTimeout, Promise, Date, Math, JSON, String, Number, Array, Object, Map, console,
  });
  return { els, root, sent, deliver };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

const slots = Array.from({ length: 8 }, (_, i) => ({
  time: new Date(Date.UTC(2026, 8, 14, i * 3)).toISOString(), kp: [2, 3, 6, 7, 5, 3, 2, 2][i], observed: i < 2,
}));

console.log('\nNo em dashes on screen');
check('no em dash characters or entities in the panel', !/&mdash;|\u2014|\u2013/.test(html));

console.log('\nThe handshake a host requires before it sends anything');
const host = boot();
check('the example is on screen before any host speaks, so it is never blank',
  /North 40/.test(host.els.get('title')?.textContent ?? ''), host.els.get('title')?.textContent);
const init = host.sent[0];
check('the first message is ui/initialize with an id', init?.method === 'ui/initialize' && init?.id != null, JSON.stringify(init));
check('...on the 2026-01-26 apps protocol', init?.params?.protocolVersion === '2026-01-26');
check('...declaring inline and fullscreen, which is where display modes are declared',
  JSON.stringify(init?.params?.appCapabilities?.availableDisplayModes) === JSON.stringify(['inline', 'fullscreen']));
check('it does not claim to be initialized before the host answers',
  !host.sent.some((m) => m.method === 'ui/notifications/initialized'));

host.deliver({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark', displayMode: 'inline' } } });
await tick();
check('once answered, it confirms with ui/notifications/initialized', host.sent.some((m) => m.method === 'ui/notifications/initialized'));
check('...and follows the host theme', host.root.attrs['data-theme'] === 'dark', JSON.stringify(host.root.attrs));

host.deliver({
  jsonrpc: '2.0', method: 'ui/notifications/tool-result',
  params: {
    content: [{ type: 'text', text: 'Clear for survey work.' }],
    structuredContent: {
      operation: 'surveying', field: 'Lot 12', equipment: 'the rover', correction: 'rtk',
      go: true, reason: 'Clear for survey work.', expectedErrorM: 0.02, toleranceM: 0.03,
      thresholdKp: 5.2, dataAgeMinutes: 3, slots,
    },
  },
});
check('a real tool result replaces the example', /Lot 12/.test(host.els.get('title').textContent), host.els.get('title').textContent);
check('...with the verdict chip showing clear', /\bgo\b/.test(host.els.get('chip').className) && !host.els.get('chip').hidden);
check('...and it tells the host its size so the frame fits', host.sent.some((m) => m.method === 'ui/notifications/size-changed'));

host.deliver({
  jsonrpc: '2.0', method: 'ui/notifications/tool-result',
  params: { content: [], structuredContent: { kpNow: 3, slots, dataAgeMinutes: 1 } },
});
check('a storm status result carries no single verdict, so no Hold chip', host.els.get('chip').hidden === true);

host.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
check('theme changes from the host are followed', host.root.attrs['data-theme'] === 'light');

console.log('\nOutside a host');
const alone = boot({ embedded: false });
check('standing alone it sends nothing and keeps the example up',
  alone.sent.length === 0 && /North 40/.test(alone.els.get('title').textContent));

console.log('\nTools point at the panel the way the spec says');
const tools = {};
registerTools({ registerTool: (name, config) => { tools[name] = config; } }, () => 'panel-test');
const withMeta = Object.entries(tools).filter(([, c]) => c._meta);
check('some tools do link a panel', withMeta.length >= 3, String(withMeta.length));
check('every link is the nested _meta.ui.resourceUri',
  withMeta.every(([, c]) => c._meta.ui?.resourceUri === 'ui://orbita/window.html'),
  JSON.stringify(withMeta.map(([n, c]) => [n, c._meta])));
check('no tool still uses the flat key that no host reads',
  withMeta.every(([, c]) => !Object.prototype.hasOwnProperty.call(c._meta, 'ui.resourceUri')));
check('what_should_i_do is registered', 'what_should_i_do' in tools);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
