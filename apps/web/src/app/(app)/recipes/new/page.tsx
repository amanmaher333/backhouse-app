'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { RecipeEditor } from '@/components/recipe-editor';

function NewRecipe() {
  const kind = useSearchParams().get('kind') === 'prep' ? 'prep' : 'menu';
  return <RecipeEditor initialKind={kind} />;
}

export default function NewRecipePage() {
  return (
    <Suspense>
      <NewRecipe />
    </Suspense>
  );
}
