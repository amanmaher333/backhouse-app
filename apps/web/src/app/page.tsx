'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/lib/session';

export default function Home() {
  const { status, can } = useSession();
  const router = useRouter();
  useEffect(() => {
    // The agent inbox is home for anyone who can see agent work.
    if (status === 'authenticated') router.replace(can('agent:read') ? '/inbox' : '/overview');
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);
  return null;
}
