import BundleGate from '../BundleGate';

// RSC shell: full-bleed paper page, no site chrome — the player IS the page.
// All resolution (bundle → server, access enforcement) happens in BundleGate.
export default async function QuestPage({
  params,
}: {
  params: Promise<{ questId: string }>;
}) {
  const { questId } = await params;
  return (
    <main
      style={{
        background: 'var(--p-bg, #FBF1E5)',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px 8px',
      }}
    >
      <BundleGate questId={questId} />
    </main>
  );
}
