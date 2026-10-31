import './style.css';
import { startApp } from './app';
import { Backend, DEMO_PASSWORD, type Session } from './backend';
import { logoMark, NAME, SHORT, TAGLINE } from './brand';
import { $, clear, h } from './dom';
import { applyTheme, getTheme, toggleTheme } from './theme';

const root = $('#root');
let backend: Backend;
applyTheme(getTheme());

async function boot(): Promise<void> {
  root.replaceChildren(h('div', { class: 'boot' }, 'Connecting…'));
  backend = await Backend.connect(new URLSearchParams(location.search).has('demo'));
  const saved = readSession();
  if (saved) {
    const check = await backend.request('GET', '/api/me', saved.token);
    if (check.status === 200) return launch(saved);
    sessionStorage.removeItem('orvms_session');
  }
  showLanding();
}

function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem('orvms_session');
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function launch(session: Session): void {
  startApp(root, backend, session, () => {
    sessionStorage.removeItem('orvms_session');
    showLanding();
  });
}

function modeBanner(): HTMLElement {
  return backend.mode === 'live'
    ? h('div', { class: 'banner live' }, `LIVE - connected to the ${SHORT} server`)
    : h('div', { class: 'banner demo' }, 'DEMO MODE - runs entirely in your browser (no server). After signing in, choose simulated scenarios or real live AIS from the data-source menu.');
}

function themeButton(): HTMLElement {
  return h('button', { class: 'btn small ghost', 'aria-label': 'Toggle light / dark theme', onclick: () => toggleTheme() }, '◐ Theme');
}

function showLanding(): void {
  root.className = '';
  const card = (icon: string, title: string, who: string, text: string, bullets: string[], action: HTMLElement): HTMLElement =>
    h(
      'article',
      { class: 'persona' },
      h('div', { class: 'ico', 'aria-hidden': 'true' }, icon),
      h('p', { class: 'who' }, who),
      h('h2', {}, title),
      h('p', { class: 'muted' }, text),
      h('ul', { class: 'feature-list' }, ...bullets.map((b) => h('li', {}, b))),
      action,
    );

  clear(root);
  root.append(
    modeBanner(),
    h(
      'main',
      { class: 'landing' },
      h('div', { class: 'land-top' }, h('div', { class: 'brand-lockup' }, logoMark(), h('div', {}, h('div', { class: 'brand-name' }, SHORT), h('div', { class: 'brand-sub' }, NAME))), themeButton()),
      h('div', { class: 'hero' }, h('h1', {}, 'Maritime risk intelligence for the supply chain.'), h('p', { class: 'tagline' }, TAGLINE)),
      h(
        'div',
        { class: 'personas' },
        card('⚓', 'Coast Guard & Maritime Security', 'Analysts · watch officers', 'A live vessel picture with graded alerts, and a case desk where reports are routed to the nearest controller and worked against SLAs.', ['EEZ, territorial-sea and boundary alerts', 'Dark-vessel and spoofing detection', 'Cases with priority, SLA timers and escalation'], h('button', { class: 'btn primary', onclick: () => showLogin('analyst') }, 'Sign in as analyst')),
        card('🚢', 'Shipping & Supply-chain Teams', 'Operators · risk officers · org admins', 'Plan voyages with an automatic route risk assessment, get them approved, and see which customer deliveries are at risk - live.', ['Voyage approvals (four-eyes) and live route monitoring', 'Supply-chain control tower: ETA, delivery risk, cargo value exposed', 'Fleet registry, API keys, signed webhooks, plan & usage'], h('button', { class: 'btn primary', onclick: () => showLogin('operator') }, 'Sign in as operator')),
      ),
      h('p', { class: 'limits' }, 'Data limits: public AIS only shows vessels that transmit it. Small fishing boats and vessels that switch AIS off are often invisible, and AIS positions can be wrong or spoofed. Zones and boundaries are modelled from coastlines using UNCLOS distances and equidistance lines - they are not the official gazetted limits. ORVMS is decision support, not a navigation or legal-boundary tool.'),
      h('p', { class: 'footer' }, 'Map: Esri Ocean Basemap (GEBCO, NOAA). Coastlines: Natural Earth (public domain). Live AIS (Baltic): Fintraffic / digitraffic.fi, CC BY 4.0.'),
    ),
  );
}

function showLogin(preset: string): void {
  root.className = '';
  const user = h('input', { id: 'u', autocomplete: 'username', value: backend.mode === 'demo' ? preset : '', required: true });
  const pass = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', value: backend.mode === 'demo' ? DEMO_PASSWORD : '', required: true });
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'login',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        err.textContent = '';
        const res = await backend.request<{ token?: string; user?: Session['user']; error?: string }>('POST', '/api/auth/login', undefined, {
          username: (user as HTMLInputElement).value.trim(),
          password: (pass as HTMLInputElement).value,
        });
        if (res.status === 200 && res.data.token && res.data.user) {
          const session = { token: res.data.token, user: res.data.user };
          try {
            sessionStorage.setItem('orvms_session', JSON.stringify(session));
          } catch {
            /* private mode: session lasts for this page only */
          }
          launch(session);
        } else {
          err.textContent = res.data.error ?? 'Sign-in failed';
        }
      },
    },
    h('div', { class: 'brand-lockup', style: 'margin-bottom:1rem' }, logoMark(), h('div', {}, h('div', { class: 'brand-name' }, SHORT), h('div', { class: 'brand-sub' }, 'Sign in'))),
    backend.mode === 'demo'
      ? h('div', {}, h('p', { class: 'muted' }, `Demo mode accounts - password "${DEMO_PASSWORD}":`), h('div', { class: 'demo-accounts' }, ...(['analyst', 'cg.mumbai', 'cg.gandhinagar', 'cg.kochi', 'cg.chennai', 'cg.portblair', 'operator', 'riskofficer', 'orgadmin', 'kt.operator', 'kt.admin', 'admin'] as const).map((n) => h('button', { type: 'button', class: 'btn small', onclick: () => { (user as HTMLInputElement).value = n; } }, n))))
      : null,
    h('label', { for: 'u' }, 'Username'),
    user,
    h('label', { for: 'p' }, 'Password'),
    pass,
    err,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: showLanding }, 'Back'), h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')),
  );
  clear(root);
  root.append(modeBanner(), h('main', { class: 'login-wrap' }, form));
  user.focus();
}

void boot();
