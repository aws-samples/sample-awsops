import { Suspense } from 'react';
import AssistantClient from '@/components/chat/AssistantClient';

// useSearchParams (in AssistantClient) requires a Suspense boundary under the
// app router; the page shell is a server component that provides it.
export default function AssistantPage() {
  return (
    <Suspense fallback={<div className="p-6 text-[13px] text-ink-400">로딩 중…</div>}>
      <AssistantClient />
    </Suspense>
  );
}
