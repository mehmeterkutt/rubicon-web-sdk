// A Vue Router app (step 8.1): the SDK is created first, as an app's entry does, then the router
// mounts. `/account` redirects to `/login` in a navigation guard, the form Vue apps use for
// authentication, so the history sees one push; `/orders` redirects while its component mounts,
// a push and then a replace; `/` redirects at the load when asked by `?redirect`. Render functions,
// so the fixture needs no compiler plugin.
import { createApp, h, onMounted } from 'vue';
import { RouterLink, RouterView, createRouter, createWebHistory, useRouter } from 'vue-router';
import { createAnalytics } from 'rubicon-analytics';

const config = window.__rubiconTest;
if (config !== undefined) window.__analytics = createAnalytics(config);

const Home = {
  render: () =>
    h('main', null, [
      h('h1', null, 'Home'),
      h(RouterLink, { to: '/orders', id: 'orders' }, () => 'Orders'),
      h(RouterLink, { to: '/account', id: 'account' }, () => 'Account'),
    ]),
};
const Orders = {
  setup() {
    const router = useRouter();
    onMounted(() => {
      void router.replace('/login');
    });
    return () => h('main', null, 'Orders');
  },
};
const Login = { render: () => h('main', null, h('h1', { id: 'login' }, 'Login')) };

const router = createRouter({
  history: createWebHistory('/frameworks/vue-router/'),
  routes: [
    { path: '/', component: Home, beforeEnter: (to) => ('redirect' in to.query ? '/login' : true) },
    { path: '/orders', component: Orders },
    { path: '/account', component: Home, beforeEnter: () => '/login' },
    { path: '/login', component: Login },
  ],
});

createApp({ render: () => h(RouterView) })
  .use(router)
  .mount('#app');
