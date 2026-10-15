// A React Router app in declarative mode (step 8.1): the SDK is created first, as an app's entry
// does, then the router renders. `/orders` redirects to `/login` while rendering, the guard most
// apps write with `<Navigate replace>`; `/` does the same at the load when asked by `?redirect`.
// Without JSX, so the fixture needs no compiler plugin.
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { createAnalytics } from 'rubicon-analytics';

const config = window.__rubiconTest;
if (config !== undefined) window.__analytics = createAnalytics(config);

function Home() {
  const location = useLocation();
  if (location.search.includes('redirect')) return h(Navigate, { to: '/login', replace: true });
  return h('main', null, h('h1', null, 'Home'), h(Link, { to: '/orders', id: 'orders' }, 'Orders'));
}

function Orders() {
  return h(Navigate, { to: '/login', replace: true });
}

function Login() {
  return h('main', null, h('h1', { id: 'login' }, 'Login'));
}

createRoot(document.getElementById('root')).render(
  h(
    BrowserRouter,
    { basename: '/frameworks/react-router' },
    h(
      Routes,
      null,
      h(Route, { path: '/', element: h(Home) }),
      h(Route, { path: '/orders', element: h(Orders) }),
      h(Route, { path: '/login', element: h(Login) }),
    ),
  ),
);
