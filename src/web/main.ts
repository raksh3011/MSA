import './style.css';
import { startApp } from './app';
import { Backend, STATIC_MODE, type Session } from './backend';
import { logoMark, NAME, SHORT, TAGLINE } from './brand';
import { $, clear, h } from './dom';
import type { mountDemoBar } from './demo';
import type { LocalBackend } from './local';
import { DEMO_PASSWORD, PERSONAS } from './personas';
import { applyTheme, getTheme, toggleTheme } from './theme';

const root = $('#root');
let backend: Backend;
let current: Session | null = null;
let demo: ReturnType<typeof mountDemoBar> | undefined;
applyTheme(getTheme());

async function boot(): Promise<void> {
  root.replaceChildren(h('div', { class: 'boot' }, 'Connecting…'));
  const connected = await Backend.connect();
  if (!connected) return showOffline();
  backend = connected;
  if (STATIC_MODE && !demo) demo = (await import('./demo')).mountDemoBar(connected as LocalBackend, { session: () => current, switchTo: switchRole });
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
  current = session;
  startApp(root, backend, session, () => {
    current = null;
    sessionStorage.removeItem('orvms_session');
    showLanding();
    demo?.refresh();
  });
  demo?.refresh();
  if (STATIC_MODE && !sessionStorage.getItem('orvms_tour_seen')) setTimeout(() => demo?.tour(), 900);
}

/** Static demo: sign in without typing (the sandbox password is public). */
async function quickLogin(username: string): Promise<void> {
  const res = await backend.request<{ token?: string; user?: Session['user']; error?: string }>('POST', '/api/auth/login', undefined, { username, password: DEMO_PASSWORD });
  if (res.status === 200 && res.data.token && res.data.user) {
    const session = { token: res.data.token, user: res.data.user };
    try {
      sessionStorage.setItem('orvms_session', JSON.stringify(session));
    } catch {
      /* private mode */
    }
    launch(session);
  }
}

async function switchRole(username: string): Promise<void> {
  if (current?.user.username === username) return;
  document.querySelector<HTMLButtonElement>('.um-item.danger')?.click(); // runs the app's own teardown, then the landing page
  await quickLogin(username);
}

function modeBanner(): HTMLElement {
  if (STATIC_MODE) return h('div', { class: 'banner live' }, 'Simulated traffic · the full server runs in this tab · pick a role below');
  return h('div', { class: 'banner live' }, `LIVE - connected to the ${SHORT} server`);
}

function showOffline(): void {
  root.className = '';
  clear(root);
  root.append(
    h(
      'main',
      { class: 'login-wrap' },
      h(
        'div',
        { class: 'login' },
        h('div', { class: 'brand-lockup', style: 'margin-bottom:1rem' }, logoMark(), h('div', {}, h('div', { class: 'brand-name' }, SHORT), h('div', { class: 'brand-sub' }, NAME))),
        h('p', { role: 'alert' }, `The ${SHORT} server is not reachable.`),
        h('p', { class: 'muted' }, 'Start it with "npm run live" (local) or check the deployed Worker, then retry.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => void boot() }, 'Retry')),
      ),
    ),
  );
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
      STATIC_MODE
        ? h(
            'section',
            { class: 'quick', 'aria-label': 'Try a role' },
            h('h3', {}, 'Try a role (one click, no sign-up)'),
            h('div', { class: 'quick-grid' }, ...PERSONAS.map((p) => h('button', { class: 'quick-card', onclick: () => void quickLogin(p.username) }, h('strong', {}, p.label), h('span', { class: 'who' }, p.who), h('span', {}, p.blurb)))),
          )
        : null,
      h('p', { class: 'limits' }, 'Data limits: public AIS only shows vessels that transmit it. Small fishing boats and vessels that switch AIS off are often invisible, and AIS positions can be wrong or spoofed. Zones and boundaries are modelled from coastlines using UNCLOS distances and equidistance lines - they are not the official gazetted limits. ORVMS is decision support, not a navigation or legal-boundary tool.'),
      h('p', { class: 'footer' }, 'Map: Esri Ocean Basemap (GEBCO, NOAA). Coastlines: Natural Earth (public domain). Live AIS (Baltic): Fintraffic / digitraffic.fi, CC BY 4.0.'),
    ),
  );
}

function showLogin(preset: string): void {
  root.className = '';
  const user = h('input', { id: 'u', autocomplete: 'username', value: preset, required: true });
  const pass = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true, value: STATIC_MODE ? DEMO_PASSWORD : undefined });
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
    h('div', {}, h('p', { class: 'muted' }, STATIC_MODE ? `Demo accounts. The sandbox password (${DEMO_PASSWORD}) is already filled in.` : 'Seeded accounts (password is set by the server administrator):'), h('div', { class: 'demo-accounts' }, ...(['analyst', 'cg.mumbai', 'cg.gandhinagar', 'cg.kochi', 'cg.chennai', 'cg.portblair', 'operator', 'riskofficer', 'orgadmin', 'kt.operator', 'kt.admin', 'admin'] as const).map((n) => h('button', { type: 'button', class: 'btn small', onclick: () => { (user as HTMLInputElement).value = n; } }, n)))),
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
