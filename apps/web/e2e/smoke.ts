/**
 * UI-Smoke (Phase 7 Härtung): jede Seite und jeden Tab der Funktions-Registry in
 * Einfach, Profi und auf dem Handy gegen eine LAUFENDE App besuchen (E2E_BASE_URL,
 * Standard http://127.0.0.1:3010) und ehrlich melden: Seitenfehler, Laufzeitfehler
 * in der Konsole, kaputte Texte (undefined/NaN), leere Seiten, Überlauf auf dem Handy.
 * Navigiert wird innerhalb EINER Seite per Hash, damit das Auth-Rate-Limit (20/min)
 * nicht greift. Exit 1 bei Befunden — läuft in der CI (Job ui-smoke) und lokal:
 *   E2E_CHROMIUM=/pfad/zu/chromium npx tsx apps/web/e2e/smoke.ts
 */
import { chromium, type Browser } from 'playwright';
import { NAV_PAGES } from '../src/lib/navigation.js';

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3010';
const SETTLE_MS = Number(process.env.E2E_SETTLE_MS ?? 1200);
/** Bildschirmfotos der Routen mit Befund (in der CI als Artefakt hochgeladen). */
const OUT_DIR = process.env.E2E_OUT ?? 'e2e-out';

type Finding = { sweep: string; route: string; kind: string; detail: string };
type Viewport = { width: number; height: number };

/** Nur echte Laufzeitfehler zählen — fehlgeschlagene Ressourcen (4xx/5xx einer nicht verbundenen Quelle) sind ehrliche Zustände. */
const RUNTIME_ERROR = /TypeError|ReferenceError|RangeError|SyntaxError|Uncaught|Cannot read|is not a function|is not defined|Minified React error|Maximum update depth/;
const BROKEN_TEXT = /\bundefined\b|\bNaN\b|\[object Object\]|TRPCClientError/;

/**
 * Läuft im Browser: welche Elemente stehen rechts über den Bildschirm hinaus? Elemente in
 * einem eigenen Scroll-Container (overflow-x auto/scroll, z. B. die Segmentleiste) und
 * fixierte Elemente zählen nicht — sie machen die Seite nicht breiter. Ergebnis als Text,
 * damit ein Befund das Element benennt statt nur „zu breit“.
 */
function overflowDetail(): string {
  const vw = window.innerWidth;
  const sw = document.documentElement.scrollWidth;
  if (sw <= vw + 1) return '';
  const inScroller = (el: Element): boolean => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a).overflowX;
      if ((o === 'auto' || o === 'scroll') && a.getBoundingClientRect().right <= vw + 1) return true;
    }
    return false;
  };
  const hits: { right: number; text: string }[] = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= vw + 1) continue;
    if (getComputedStyle(el).position === 'fixed' || inScroller(el)) continue;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    const txt = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    hits.push({ right: r.right, text: `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} rechts=${Math.round(r.right)} breit=${Math.round(r.width)}${txt ? ` „${txt}“` : ''}` });
  }
  hits.sort((a, b) => b.right - a.right);
  return `Seite ${sw}px breit bei ${vw}px Bildschirm — ${hits.length ? hits.slice(0, 4).map((h) => h.text).join(' | ') : 'kein Element außerhalb eines Scroll-Containers benennbar'}`;
}

/** Alle Seiten + Tabs aus der Registry — eine neue Seite wird automatisch mitgeprüft. */
export const routes: string[] = NAV_PAGES.flatMap((p) => [p.hash, ...(p.tabs ?? []).map((t) => `${p.hash}?tab=${t.id}`)]);

async function sweep(browser: Browser, name: string, viewport: Viewport, mode: 'einfach' | 'profi', findings: Finding[]): Promise<void> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((m: string) => {
    localStorage.setItem('gladiator.uiMode', m);
    localStorage.setItem('i18nextLng', 'de');
  }, mode);
  const page = await ctx.newPage();
  let pageErrors: string[] = [];
  let consoleErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error' && RUNTIME_ERROR.test(m.text())) consoleErrors.push(m.text().slice(0, 300));
  });

  await page.goto(`${BASE}/#/`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(SETTLE_MS * 2);
  // Angemeldet (Auto-Login von localhost)? Sonst ist jede weitere Aussage wertlos.
  const loggedIn = (await page.locator('nav.areanav, nav.tabbar').count()) > 0;
  if (!loggedIn) {
    findings.push({ sweep: name, route: '#/', kind: 'login', detail: 'Nicht angemeldet — AUTO_LOGIN_EMAIL/Nutzer fehlt oder Auto-Login ist von dieser Adresse nicht erlaubt.' });
    await ctx.close();
    return;
  }

  for (const route of routes) {
    pageErrors = [];
    consoleErrors = [];
    await page.evaluate((h: string) => {
      window.location.hash = h.slice(1);
    }, route);
    await page.waitForTimeout(SETTLE_MS);
    const body = await page.locator('main').innerText().catch(() => '');
    let overflow = viewport.width < 600 ? await page.evaluate(overflowDetail) : '';
    if (overflow) {
      // Noch einmal messen: ein Überlauf nur während des Ladens ist kein Befund, ein bleibender schon.
      await page.waitForTimeout(SETTLE_MS);
      const again = await page.evaluate(overflowDetail);
      if (!again) console.log(`  Hinweis [${name}] ${route}: Überlauf nur während des Ladens (${overflow})`);
      overflow = again;
    }
    const before = findings.length;
    const push = (kind: string, detail: string) => findings.push({ sweep: name, route, kind, detail });
    for (const e of pageErrors) push('pageerror', e);
    for (const e of consoleErrors) push('console', e);
    const broken = body.match(new RegExp(`[^\\n]*(${BROKEN_TEXT.source})[^\\n]*`));
    if (broken) push('text', broken[0].trim().slice(0, 160));
    if (body.trim().length < 40) push('empty', `nur ${body.trim().length} Zeichen Text`);
    if (overflow) push('overflow', overflow);
    if (findings.length > before) {
      mkdirSync(OUT_DIR, { recursive: true });
      const file = join(OUT_DIR, `${name.replace('/', '-')}-${route.replace(/[^a-z0-9]+/gi, '_')}.png`);
      await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
    }
  }
  await ctx.close();
}

const browser = await chromium.launch({
  ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}),
  args: ['--no-proxy-server'],
});
const findings: Finding[] = [];
try {
  await sweep(browser, 'desktop/profi', { width: 1440, height: 1000 }, 'profi', findings);
  await sweep(browser, 'desktop/einfach', { width: 1440, height: 1000 }, 'einfach', findings);
  await sweep(browser, 'handy/einfach', { width: 390, height: 844 }, 'einfach', findings);
} finally {
  await browser.close();
}

console.log(`UI-Smoke: ${routes.length} Routen × 3 Durchläufe gegen ${BASE}`);
if (findings.length === 0) {
  console.log('UI-Smoke grün — keine Seitenfehler, keine kaputten Texte, keine leeren Seiten, kein Überlauf.');
  process.exit(0);
}
console.error(`UI-Smoke: ${findings.length} Befunde`);
for (const f of findings) console.error(`  [${f.sweep}] ${f.route} · ${f.kind}: ${f.detail}`);
process.exit(1);
