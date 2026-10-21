import type { Draft } from '../../shared/types.ts';

const manualOnly = () => {
  throw new Error('平台代发与代填已取消，请导出素材后到官方平台手动发布。');
};
// Keep named exports for older integrations, without browser or upload side effects.
export async function preparePublish(_draft: Draft): Promise<never> {
  return manualOnly();
}
export async function publishNative(_draft: Draft): Promise<never> {
  return manualOnly();
}
export async function reconcilePublish(_draft: Draft): Promise<never> {
  return manualOnly();
}
