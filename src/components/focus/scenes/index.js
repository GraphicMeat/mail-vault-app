/**
 * The focus-lock scenes. Each loads on demand, with three.js, only when a
 * lock opens on it; nothing here pulls three into the main bundle.
 */
export const SCENE_LOADERS = {
  countryside: () => import('./countryside.js'),
  sea: () => import('./sea.js'),
  town: () => import('./town.js'),
};

export const loadWorld = () => import('./world.js');
