export type Theme = 'dark' | 'light';

export function getTheme(): Theme {
  try {
    const saved = localStorage.getItem('orvms_theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('orvms_theme', t);
  } catch {
    /* storage unavailable */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}
