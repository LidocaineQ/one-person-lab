import { buildWorkItemProjectionV2 } from './work-item-projection/projection.ts';
import { projectRuntimeActivityItems } from './work-item-projection/runtime-activity-projection.ts';

export function buildAppStateRuntimeActivityItems(profile: 'fast' | 'full' = 'full') {
  return projectRuntimeActivityItems(buildWorkItemProjectionV2({ profile }));
}
