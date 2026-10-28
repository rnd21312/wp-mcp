/**
 * The inspector agent injected into previewed pages (served by the preview origin, so page scripts can never touch
 * the panel). It talks to the panel over postMessage: hover/select, DOM tree, matched CSS rules (stylesheets are
 * proxied same-origin so their rules are readable), computed styles, box model, live CSS.
 */
export const AGENT_JS = String.raw`(function () {
  var params = new URL(document.currentScript.src).searchParams;
  var PO = params.get('o');
  var rules = [];
  var ids = new WeakMap();
  var byId = {};
  var nextId = 1;
  var inspecting = true;
  var selected = null;

  function send(m) { try { parent.postMessage(Object.assign({ wpm: 1 }, m), PO); } catch (e) {} }
  function idOf(el) { if (!ids.has(el)) { ids.set(el, nextId); byId[nextId] = el; nextId++; } return ids.get(el); }

  var ov = document.createElement('div');
  ov.id = 'wpm-ov';
  ov.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;left:0;top:0;width:0;height:0';
  var tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.3 ui-monospace,monospace;background:#1e293b;color:#fff;padding:3px 6px;border-radius:4px;white-space:nowrap';
  function layer(color) { var d = document.createElement('div'); d.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;background:' + color; document.documentElement.appendChild(d); return d; }
  var lm, lb, lp, lc;
  function ensure() { if (lm) return; lm = layer('rgba(246,178,107,.55)'); lb = layer('rgba(255,229,153,.6)'); lp = layer('rgba(147,196,125,.55)'); lc = layer('rgba(111,168,220,.55)'); document.documentElement.appendChild(tip); }
  function place(d, x, y, w, h) { d.style.left = x + 'px'; d.style.top = y + 'px'; d.style.width = Math.max(0, w) + 'px'; d.style.height = Math.max(0, h) + 'px'; d.style.display = 'block'; }
  function px(v) { return parseFloat(v) || 0; }
  function highlight(el, keep) {
    ensure();
    if (!el || el.nodeType !== 1) { [lm, lb, lp, lc, tip].forEach(function (d) { d.style.display = 'none'; }); return; }
    var r = el.getBoundingClientRect(); var cs = getComputedStyle(el);
    var m = ['Top', 'Right', 'Bottom', 'Left'].map(function (s) { return px(cs['margin' + s]); });
    var b = ['Top', 'Right', 'Bottom', 'Left'].map(function (s) { return px(cs['border' + s + 'Width']); });
    var p = ['Top', 'Right', 'Bottom', 'Left'].map(function (s) { return px(cs['padding' + s]); });
    place(lm, r.left - m[3], r.top - m[0], r.width + m[3] + m[1], r.height + m[0] + m[2]);
    place(lb, r.left, r.top, r.width, r.height);
    place(lp, r.left + b[3], r.top + b[0], r.width - b[3] - b[1], r.height - b[0] - b[2]);
    place(lc, r.left + b[3] + p[3], r.top + b[0] + p[0], r.width - b[3] - b[1] - p[3] - p[1], r.height - b[0] - b[2] - p[0] - p[2]);
    tip.textContent = label(el) + '  ' + Math.round(r.width) + ' x ' + Math.round(r.height);
    tip.style.display = 'block'; tip.style.left = Math.max(0, r.left) + 'px'; tip.style.top = Math.max(0, r.top - 24) + 'px';
  }
  function label(el) { var s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; var c = (el.className && el.className.baseVal === undefined ? String(el.className) : '').trim().split(/\s+/).filter(Boolean).slice(0, 2); if (c.length) s += '.' + c.join('.'); return s; }
  function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1'); }
  function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
  function selectors(el) {
    var out = []; var tag = el.tagName.toLowerCase();
    if (el.id) out.push('#' + esc(el.id));
    var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean);
    cls.forEach(function (c) { out.push('.' + esc(c)); out.push(tag + '.' + esc(c)); });
    var parts = []; var n = el;
    while (n && n !== document.body && parts.length < 6) {
      var sib = n.parentElement ? Array.prototype.filter.call(n.parentElement.children, function (x) { return x.tagName === n.tagName; }) : [n];
      parts.unshift(n.id ? '#' + esc(n.id) : n.tagName.toLowerCase() + ':nth-of-type(' + (sib.indexOf(n) + 1) + ')');
      if (n.id || unique(parts.join(' > '))) break; n = n.parentElement;
    }
    out.push(parts.join(' > '));
    var seen = {}; out = out.filter(function (s) { if (seen[s]) return false; seen[s] = 1; return true; });
    return out.filter(unique).concat(out.filter(function (s) { return !unique(s); })).slice(0, 6);
  }

  function walk(list, sheet, el, acc, media) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.type === 1) {
        if (r.selectorText.indexOf('data-wpm') >= 0) continue;
        var hit = false; try { hit = el.matches(r.selectorText); } catch (e) {}
        if (hit) {
          var props = []; for (var k = 0; k < r.style.length; k++) { var n = r.style[k]; props.push([n, r.style.getPropertyValue(n), r.style.getPropertyPriority(n)]); }
          var id = rules.push(r) - 1;
          var owner = sheet.ownerNode;
          acc.push({ id: id, selector: r.selectorText, media: media, props: props, source: owner ? (owner.getAttribute && owner.getAttribute('data-wpm-src')) || (owner.tagName === 'STYLE' ? 'inline <style>' : sheet.href) : sheet.href, order: acc.length });
        }
      } else if (r.type === 4) {
        var ok = true; try { ok = matchMedia(r.conditionText || r.media.mediaText).matches; } catch (e) {}
        if (ok) walk(r.cssRules, sheet, el, acc, '@media ' + (r.conditionText || r.media.mediaText));
      } else if (r.cssRules && r.type === 12) { walk(r.cssRules, sheet, el, acc, media); }
    }
  }
  var COMPUTED = ['display','position','top','right','bottom','left','float','z-index','width','height','min-width','max-width','min-height','max-height','margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','border-top-width','border-right-width','border-bottom-width','border-left-width','border-style','border-color','border-radius','color','background-color','background-image','font-family','font-size','font-weight','line-height','letter-spacing','text-align','text-decoration','text-transform','opacity','overflow','flex-direction','justify-content','align-items','gap','box-shadow','transform','cursor','visibility'];
  function info(el) {
    rules = []; var acc = [];
    for (var s = 0; s < document.styleSheets.length; s++) { var sh = document.styleSheets[s]; var rs; try { rs = sh.cssRules; } catch (e) { continue; } if (!rs) continue; walk(rs, sh, el, acc, ''); }
    acc.reverse();
    var cs = getComputedStyle(el); var comp = {}; COMPUTED.forEach(function (p) { comp[p] = cs.getPropertyValue(p); });
    var r = el.getBoundingClientRect();
    var attrs = {}; Array.prototype.forEach.call(el.attributes, function (a) { if (a.name !== 'style' || a.value) attrs[a.name] = a.value.slice(0, 300); });
    var leaf = el.children.length === 0 && (el.textContent || '').trim().length > 0;
    return { id: idOf(el), tag: el.tagName.toLowerCase(), label: label(el), selectors: selectors(el), rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }, rules: acc, inline: el.getAttribute('style') || '', computed: comp, attrs: attrs, leaf: leaf, text: leaf ? (el.textContent || '').trim() : '', box: { margin: ['Top', 'Right', 'Bottom', 'Left'].map(function (x) { return cs['margin' + x]; }), border: ['Top', 'Right', 'Bottom', 'Left'].map(function (x) { return cs['border' + x + 'Width']; }), padding: ['Top', 'Right', 'Bottom', 'Left'].map(function (x) { return cs['padding' + x]; }), w: Math.round(r.width), h: Math.round(r.height) } };
  }
  function tree(el, depth, budget) {
    var kids = [];
    if (depth > 0) for (var i = 0; i < el.children.length && budget.n > 0; i++) { var c = el.children[i]; if (/^(SCRIPT|STYLE|LINK|META|NOSCRIPT|BR)$/.test(c.tagName) || c.id === 'wpm-ov') continue; budget.n--; kids.push(tree(c, depth - 1, budget)); }
    return { id: idOf(el), label: label(el), n: el.children.length, kids: kids };
  }
  function select(el) {
    if (selected) selected.removeAttribute('data-wpm-sel');
    selected = el; if (!el) { highlight(null); return; }
    el.setAttribute('data-wpm-sel', '1'); highlight(el); send({ type: 'selected', info: info(el) });
  }

  var st = document.createElement('style'); st.textContent = '[data-wpm-sel]{outline:2px solid #f59e0b!important;outline-offset:-2px}'; document.head.appendChild(st);

  document.addEventListener('mousemove', function (e) { if (!inspecting) return; var t = e.target; if (t && t.nodeType === 1) highlight(t); }, true);
  document.addEventListener('mouseleave', function () { if (selected) highlight(selected); else highlight(null); }, true);
  document.addEventListener('click', function (e) { if (!inspecting) return; e.preventDefault(); e.stopPropagation(); select(e.target); }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
  window.addEventListener('scroll', function () { if (selected) highlight(selected); }, true);
  window.addEventListener('resize', function () { if (selected) highlight(selected); });

  function live(key, css) { var s = document.querySelector('style[data-wpm-live="' + key + '"]'); if (!s) { s = document.createElement('style'); s.setAttribute('data-wpm-live', key); document.head.appendChild(s); } s.textContent = css; }

  window.addEventListener('message', function (e) {
    var m = e.data; if (!m || !m.wpm || e.source !== parent) return;
    if (m.type === 'inspect') { inspecting = !!m.on; if (!inspecting) highlight(selected); }
    else if (m.type === 'select') { var el = byId[m.id]; if (el) { el.scrollIntoView({ block: 'center' }); select(el); } }
    else if (m.type === 'tree') send({ type: 'tree', tree: tree(document.body, 7, { n: 1500 }) });
    else if (m.type === 'css-live') live(m.key || 'main', m.css || '');
    else if (m.type === 'css-replace') { var l = document.querySelector('link[data-wpm-src*="' + m.match + '"]'); if (l) l.disabled = true; live('replace:' + m.match, m.css || ''); }
    else if (m.type === 'edit-rule') { var r = rules[m.id]; if (r) { if (m.value === '') r.style.removeProperty(m.prop); else r.style.setProperty(m.prop, m.value, m.important ? 'important' : ''); if (selected) { highlight(selected); send({ type: 'refreshed', info: info(selected) }); } } }
    else if (m.type === 'edit-inline') { if (selected) { if (m.value === '') selected.style.removeProperty(m.prop); else selected.style.setProperty(m.prop, m.value); highlight(selected); } }
    else if (m.type === 'set-text') { var t = byId[m.id]; if (t) t.textContent = m.text; }
    else if (m.type === 'reselect') { if (selected) send({ type: 'selected', info: info(selected) }); }
    else if (m.type === 'seo') { document.documentElement.classList.toggle('wpm-seo', !!m.on); live('seo', m.on ? ':is(h1,h2,h3,h4,h5,h6){outline:2px solid #8b5cf6!important;outline-offset:2px}img:not([alt]),img[alt=""]{outline:3px solid #ef4444!important}a[rel~=nofollow]{outline:2px dotted #f59e0b!important}' : ''); }
  });

  send({ type: 'ready', title: document.title, url: location.href });
})();`;
