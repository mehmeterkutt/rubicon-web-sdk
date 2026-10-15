'use client';
// `/`: a link to `/orders`, and a redirect to `/login` right after the load when asked by `?redirect`.
import { createElement as h, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    if (window.location.search.includes('redirect')) router.replace('/login');
  }, [router]);
  return h('main', null, h('h1', null, 'Home'), h(Link, { href: '/orders', id: 'orders' }, 'Orders'));
}
