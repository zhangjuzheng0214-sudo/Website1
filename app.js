/* JSON Formatter & Minifier — client-side only, no network */
(function () {
  'use strict';

  // ---------- element refs ----------
  const $ = (id) => document.getElementById(id);
  const input = $('input');
  const highlight = $('highlight');
  const highlightCode = $('highlightCode');
  const gutter = $('gutter');
  const tree = $('tree');
  const editArea = $('editArea');
  const output = $('output');
  const statusMsg = $('statusMsg');
  const charCount = $('charCount');
  const lineCount = $('lineCount');
  const emptyHint = $('emptyHint');
  const toastEl = $('toast');

  const themeToggle = $('themeToggle');
  const sampleBtn = $('sampleBtn');
  const clearBtn = $('clearBtn');
  const copyInBtn = $('copyInBtn');
  const downloadInBtn = $('downloadInBtn');
  const formatBtn = $('formatBtn');
  const editToggle = $('editToggle');
  const collapseAllBtn = $('collapseAllBtn');
  const expandAllBtn = $('expandAllBtn');
  const copyOutBtn = $('copyOutBtn');
  const downloadOutBtn = $('downloadOutBtn');
  const minifyBtn = $('minifyBtn');

  let errorLine = 0;
  let lastFormatted = '';
  let mode = 'tree'; // 'tree' | 'edit'
  let parseTimer = null;

  // ---------- theme ----------
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const dark = t === 'dark';
    themeToggle.querySelector('.theme-icon').textContent = dark ? '☀️' : '🌙';
    themeToggle.querySelector('.theme-label').textContent = dark ? 'Light' : 'Dark';
    try { localStorage.setItem('jsonfmt-theme', t); } catch (e) {}
  }
  (function initTheme() {
    let t = 'light';
    try { t = localStorage.getItem('jsonfmt-theme') || 'light'; } catch (e) {}
    applyTheme(t);
  })();
  themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  // ---------- helpers ----------
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.style.background = isErr ? 'var(--danger)' : 'var(--text)';
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 1900);
  }

  function setStatus(msg, kind) {
    statusMsg.textContent = msg;
    statusMsg.className = 'status-msg' + (kind ? ' ' + kind : '');
  }

  // ---------- syntax highlight (line based) ----------
  function highlightLine(line) {
    let out = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      const c = line[i];
      if (c === '"') {
        let j = i + 1;
        let str = c;
        while (j < n) {
          if (line[j] === '\\') {
            str += line[j];
            if (j + 1 < n) { str += line[j + 1]; j += 2; continue; }
            j++; break;
          } else if (line[j] === '"') { str += line[j]; j++; break; }
          else { str += line[j]; j++; }
        }
        let k = j;
        while (k < n && /\s/.test(line[k])) k++;
        if (line[k] === ':') out += '<span class="tk-key">' + esc(str) + '</span>';
        else out += '<span class="tk-str">' + esc(str) + '</span>';
        i = j;
      } else if (c === '-' || (c >= '0' && c <= '9')) {
        let j = i;
        let num = '';
        if (c === '-') { num += '-'; j++; }
        while (j < n && /[0-9.eE+-]/.test(line[j])) { num += line[j]; j++; }
        out += '<span class="tk-num">' + esc(num) + '</span>';
        i = j;
      } else if (line.startsWith('true', i) || line.startsWith('false', i) || line.startsWith('null', i)) {
        const kw = line.startsWith('true', i) ? 'true' : line.startsWith('false', i) ? 'false' : 'null';
        out += '<span class="tk-bool">' + kw + '</span>';
        i += kw.length;
      } else if ('{}[],:'.includes(c)) {
        out += '<span class="tk-punct">' + esc(c) + '</span>';
        i++;
      } else {
        out += esc(c);
        i++;
      }
    }
    return out;
  }

  function renderEditor() {
    const text = input.value;
    const lines = text.length ? text.split('\n') : [''];
    const total = lines.length;
    if (errorLine > total) errorLine = total;

    highlightCode.innerHTML = lines.map((ln, idx) => {
      const cls = (idx + 1 === errorLine) ? 'hl-line err' : 'hl-line';
      return '<div class="' + cls + '">' + highlightLine(ln) + '</div>';
    }).join('');

    gutter.innerHTML = lines.map((_, idx) => {
      const cls = (idx + 1 === errorLine) ? 'ln err' : 'ln';
      return '<div class="' + cls + '">' + (idx + 1) + '</div>';
    }).join('');

    charCount.textContent = text.length;
    lineCount.textContent = total;
  }

  function markErrorLine(line) {
    errorLine = line || 0;
    renderEditor();
  }
  function clearErrorLine() {
    if (errorLine !== 0) { errorLine = 0; renderEditor(); }
  }

  // ---------- parse ----------
  function parseJSON(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      let line = 0, col = 0;
      const msg = e && e.message ? e.message : 'Invalid JSON';
      const mPos = msg.match(/position (\d+)/);
      if (mPos) {
        const pos = parseInt(mPos[1], 10);
        const before = text.slice(0, pos);
        line = before.split('\n').length;
        const nl = before.lastIndexOf('\n');
        col = pos - nl;
      } else {
        const mLC = msg.match(/line (\d+) column (\d+)/i);
        if (mLC) { line = parseInt(mLC[1], 10); col = parseInt(mLC[2], 10); }
      }
      return { ok: false, error: { line: line, col: col, msg: msg } };
    }
  }

  function cleanMsg(msg) {
    return msg
      .replace(/ in JSON at position \d+/, '')
      .replace(/^JSON\.parse:\s*/, '')
      .replace(/^\w+ (.*)$/, '$1');
  }

  function countKeys(v) {
    let c = 0;
    (function walk(x) {
      if (x && typeof x === 'object') {
        if (Array.isArray(x)) x.forEach(walk);
        else { c += Object.keys(x).length; Object.values(x).forEach(walk); }
      }
    })(v);
    return c;
  }

  // ---------- tree render ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function span(cls, text) { return el('span', cls, text); }

  function renderValue(value) {
    if (value === null) return span('tk-bool', 'null');
    const t = typeof value;
    if (t === 'object') {
      return Array.isArray(value) ? renderArray(value, undefined, false) : renderObject(value, undefined, false);
    }
    if (t === 'string') return span('tk-str', JSON.stringify(value));
    if (t === 'number') return span('tk-num', String(value));
    if (t === 'boolean') return span('tk-bool', String(value));
    return span('', 'undefined');
  }

  function makeNode(openCh, closeCh, label, body, previewText, trailingComma) {
    const wrap = el('div', 'jnode');
    const head = el('div', 'jhead');
    if (label) head.appendChild(label);
    const tg = el('span', 'toggle', '▼');
    const open = span('tk-punct', openCh);
    const prev = el('span', 'jpreview', ' … ' + previewText + ' ');
    prev.style.display = 'none';
    head.appendChild(tg); head.appendChild(open); head.appendChild(prev);
    wrap.appendChild(head);

    const b = el('div', 'jbody');
    body.forEach((child) => b.appendChild(child));
    wrap.appendChild(b);

    const foot = el('div', 'jfoot');
    foot.appendChild(span('tk-punct', closeCh));
    if (trailingComma) foot.appendChild(span('tk-punct', ','));
    wrap.appendChild(foot);

    tg.addEventListener('click', () => {
      const collapsed = wrap.classList.toggle('collapsed');
      tg.textContent = collapsed ? '▶' : '▼';
      prev.style.display = collapsed ? 'inline' : 'none';
    });
    return wrap;
  }

  function renderObject(obj, keyName, trailingComma) {
    const keys = Object.keys(obj);
    const label = keyName !== undefined
      ? (function () { const d = el('div'); d.appendChild(span('tk-key', JSON.stringify(keyName))); d.appendChild(span('tk-punct', ': ')); return d; })()
      : null;

    if (keys.length === 0) {
      const line = el('div', 'jrow');
      if (label) label.childNodes.forEach((c) => line.appendChild(c.cloneNode(true)));
      line.appendChild(span('tk-punct', '{ }'));
      if (trailingComma) line.appendChild(span('tk-punct', ','));
      return line;
    }

    const body = [];
    keys.forEach((k, idx) => {
      const last = idx === keys.length - 1;
      const v = obj[k];
      if (v !== null && typeof v === 'object') {
        body.push(Array.isArray(v) ? renderArray(v, k, !last) : renderObject(v, k, !last));
      } else {
        const row = el('div', 'jrow');
        row.appendChild(span('tk-key', JSON.stringify(k)));
        row.appendChild(span('tk-punct', ': '));
        row.appendChild(renderValue(v));
        if (!last) row.appendChild(span('tk-punct', ','));
        body.push(row);
      }
    });
    return makeNode('{', '}', label, body, keys.length + ' ' + (keys.length === 1 ? 'key' : 'keys'), trailingComma);
  }

  function renderArray(arr, keyName, trailingComma) {
    const label = keyName !== undefined
      ? (function () { const d = el('div'); d.appendChild(span('tk-key', JSON.stringify(keyName))); d.appendChild(span('tk-punct', ': ')); return d; })()
      : null;

    if (arr.length === 0) {
      const line = el('div', 'jrow');
      if (label) label.childNodes.forEach((c) => line.appendChild(c.cloneNode(true)));
      line.appendChild(span('tk-punct', '[ ]'));
      if (trailingComma) line.appendChild(span('tk-punct', ','));
      return line;
    }

    const body = [];
    arr.forEach((item, idx) => {
      const last = idx === arr.length - 1;
      if (item !== null && typeof item === 'object') {
        body.push(Array.isArray(item) ? renderArray(item, undefined, !last) : renderObject(item, undefined, !last));
      } else {
        const row = el('div', 'jrow');
        row.appendChild(renderValue(item));
        if (!last) row.appendChild(span('tk-punct', ','));
        body.push(row);
      }
    });
    return makeNode('[', ']', label, body, arr.length + ' ' + (arr.length === 1 ? 'item' : 'items'), trailingComma);
  }

  function renderTree(value) {
    tree.innerHTML = '';
    tree.appendChild(renderValue(value));
  }

  // ---------- view modes ----------
  function showTree() {
    mode = 'tree';
    tree.hidden = false;
    editArea.hidden = true;
    minifyBtn.hidden = true;
    editToggle.hidden = false;
    editToggle.textContent = 'Edit';
    collapseAllBtn.hidden = false;
    expandAllBtn.hidden = false;
    emptyHint.hidden = tree.childNodes.length > 0;
  }
  function showEdit() {
    mode = 'edit';
    if (!editArea.value.trim() && lastFormatted) editArea.value = lastFormatted;
    tree.hidden = true;
    editArea.hidden = false;
    minifyBtn.hidden = false;
    editToggle.textContent = 'Tree';
    collapseAllBtn.hidden = true;
    expandAllBtn.hidden = true;
    emptyHint.hidden = true;
  }

  // ---------- core actions ----------
  function runFormat() {
    const text = input.value;
    if (text.trim() === '') {
      tree.innerHTML = '';
      errorLine = 0;
      renderEditor();
      setStatus('Empty input — paste some JSON.', '');
      emptyHint.hidden = false;
      return;
    }
    const res = parseJSON(text);
    if (res.ok) {
      lastFormatted = JSON.stringify(res.value, null, 2);
      renderTree(res.value);
      showTree();
      setStatus('Valid JSON — ' + countKeys(res.value) + ' keys formatted.', 'ok');
      clearErrorLine();
    } else {
      markErrorLine(res.error.line);
      const at = res.error.line ? 'line ' + res.error.line + (res.error.col ? ', col ' + res.error.col : '') : '';
      setStatus('Invalid JSON' + (at ? ' at ' + at : '') + ': ' + cleanMsg(res.error.msg), 'err');
    }
  }

  function runMinify() {
    const text = editArea.value;
    const res = parseJSON(text);
    if (res.ok) {
      input.value = JSON.stringify(res.value);
      renderEditor();
      runFormat();
      toast('Minified to input →');
    } else {
      toast('Cannot minify — invalid JSON in editor', true);
    }
  }

  function setAllCollapsed(c) {
    tree.querySelectorAll('.jnode').forEach((node) => {
      const tg = node.querySelector('.toggle');
      const prev = node.querySelector('.jpreview');
      if (c && !node.classList.contains('collapsed')) {
        node.classList.add('collapsed'); tg.textContent = '▶'; if (prev) prev.style.display = 'inline';
      } else if (!c && node.classList.contains('collapsed')) {
        node.classList.remove('collapsed'); tg.textContent = '▼'; if (prev) prev.style.display = 'none';
      }
    });
  }

  // ---------- copy / download ----------
  function copyText(text) {
    if (!text) { toast('Nothing to copy', true); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard')).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard'); }
    catch (e) { toast('Copy failed', true); }
    document.body.removeChild(ta);
  }
  function downloadText(text, name) {
    if (!text) { toast('Nothing to download', true); return; }
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- sample ----------
  const SAMPLE = {
    name: 'JSON Formatter',
    version: 1.0,
    active: true,
    tags: ['format', 'validate', 'minify'],
    author: { name: 'Li', city: 'Ningbo', social: null },
    features: [
      { id: 1, label: 'Foldable tree' },
      { id: 2, label: 'Error highlight' }
    ],
    note: 'Edit on the left, fold on the right.'
  };

  // ---------- events ----------
  input.addEventListener('input', () => {
    renderEditor();
    clearTimeout(parseTimer);
    parseTimer = setTimeout(runFormat, 250);
  });
  input.addEventListener('scroll', () => {
    highlight.scrollTop = input.scrollTop;
    highlight.scrollLeft = input.scrollLeft;
    gutter.scrollTop = input.scrollTop;
  });
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runFormat(); }
  });

  editArea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runMinify(); }
  });

  formatBtn.addEventListener('click', runFormat);
  minifyBtn.addEventListener('click', runMinify);
  editToggle.addEventListener('click', () => { if (mode === 'tree') showEdit(); else showTree(); });
  collapseAllBtn.addEventListener('click', () => setAllCollapsed(true));
  expandAllBtn.addEventListener('click', () => setAllCollapsed(false));

  sampleBtn.addEventListener('click', () => {
    input.value = JSON.stringify(SAMPLE, null, 2);
    renderEditor();
    runFormat();
    toast('Sample loaded');
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    renderEditor();
    tree.innerHTML = '';
    errorLine = 0;
    renderEditor();
    setStatus('Cleared.', '');
    emptyHint.hidden = false;
  });

  copyInBtn.addEventListener('click', () => copyText(input.value));
  copyOutBtn.addEventListener('click', () => copyText(mode === 'edit' ? editArea.value : lastFormatted));
  downloadInBtn.addEventListener('click', () => downloadText(input.value, 'input.json'));
  downloadOutBtn.addEventListener('click', () => downloadText(mode === 'edit' ? editArea.value : lastFormatted, 'output.json'));

  // ---------- init ----------
  input.value = JSON.stringify(SAMPLE, null, 2);
  renderEditor();
  runFormat();
})();
