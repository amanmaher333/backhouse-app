'use client';

import { useParams } from 'next/navigation';
import { RecipeEditor } from '@/components/recipe-editor';
import { useApi } from '@/lib/session';
import type { RecipeDetail } from '@/lib/types-recipes';

export default function RecipePage() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<RecipeDetail>(`/recipes/${id}`, [id]);
  if (error) return <div className="page"><div className="notice notice-error">{error.message}</div></div>;
  if (!data) return <div className="page" />;
  return <RecipeEditor key={data.id} recipe={data} />;
}
