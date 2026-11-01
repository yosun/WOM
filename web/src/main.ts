import './styles.css';
import { api } from './api.ts';
import { renderBuild } from './build.ts';
import { clear } from './dom.ts';
import { renderHome } from './home.ts';
import { renderViewer } from './viewer.ts';

const root = document.getElementById('app')!;
let teardown: (() => void) | null = null;

async function route() {
  teardown?.();
  teardown = null;
  clear(root);
  document.title = 'World of a Memory';
  const hash = location.hash || '#/';
  const m = /^#\/world\/([a-z0-9]+)(\/build)?$/.exec(hash);
  if (!m) {
    document.body.className = 'page-home';
    renderHome(root);
    return;
  }
  const id = m[1];
  const forceBuild = Boolean(m[2]);
  let ready = false;
  try {
    const r = await api.get(id);
    ready = Boolean(r.manifest.scene) && !r.running;
  } catch {
    location.hash = '#/';
    return;
  }
  if (ready && !forceBuild) {
    document.body.className = 'page-viewer';
    teardown = renderViewer(root, id);
  } else {
    document.body.className = 'page-build';
    teardown = renderBuild(root, id, () => {
      location.hash = `#/world/${id}`;
      if (forceBuild) return;
      void route();
    });
  }
}

window.addEventListener('hashchange', () => void route());
void route();
