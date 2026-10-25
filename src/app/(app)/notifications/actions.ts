'use server';

import { revalidatePath } from 'next/cache';
import { acknowledgeNotification } from '@/lib/visits';

export async function acknowledgeAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('Missing notification id.');
  await acknowledgeNotification(id);
  revalidatePath('/notifications');
}
