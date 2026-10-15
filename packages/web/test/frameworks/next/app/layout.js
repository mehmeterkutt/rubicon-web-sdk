import { createElement as h } from 'react';
import Analytics from './analytics';

export const metadata = { title: 'Next.js fixture' };

export default function RootLayout({ children }) {
  return h('html', { lang: 'en' }, h('body', null, h(Analytics), children));
}
