import { apiFetch } from '@/lib/api';
import type { SessionDetail } from '@/lib/types';
import { notFound } from 'next/navigation';
import { MixerShell } from './_mixer-shell';

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await apiFetch<SessionDetail>(`/api/sessions/${id}`);
  if (!session) notFound();

  return (
    <MixerShell
      sessionId={session.id}
      sessionName={session.name}
      storageMode={session.storageMode}
      initialStems={session.stems}
    />
  );
}
