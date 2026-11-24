import type { Screen } from '../../../packages/core-contracts/src/index.ts';

export const screens = [
  { id: 'inicio', variant: 'citizen', load: () => import('../app/(tabs)/index') },
  { id: 'mandato', variant: 'citizen', load: () => import('../app/(tabs)/mandato') },
  { id: 'causas', variant: 'citizen', load: () => import('../app/(tabs)/causas') },
  { id: 'agenda', variant: 'citizen', load: () => import('../app/(tabs)/agenda') },
  { id: 'participe', variant: 'citizen', load: () => import('../app/(tabs)/participe') },
] satisfies Screen[];
