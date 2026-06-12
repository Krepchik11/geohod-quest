import { redirect } from 'next/navigation';

// The player lives at /quest/{questId}. Bare /quest goes to the collection;
// the legacy ?golden= form redirects so old links keep working.
export default async function QuestIndex({
  searchParams,
}: {
  searchParams: Promise<{ golden?: string }>;
}) {
  const { golden } = await searchParams;
  redirect(golden ? `/quest/${encodeURIComponent(golden)}` : '/my-quests');
}
