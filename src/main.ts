import './style.css';
import { App } from './app/App';

const root = document.getElementById('app')!;
const app = new App(root);
app.start().catch((e) => {
  console.error(e);
  root.insertAdjacentHTML('beforeend', `<pre style="color:#f66;position:absolute;top:0;left:0">${String(e?.stack ?? e)}</pre>`);
});
