'use client';
// `/orders` redirects to `/login` once it renders, the client-side guard of a Next.js app.
import { createElement as h, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Orders() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/login');
  }, [router]);
  return h('main', null, 'Orders');
}
