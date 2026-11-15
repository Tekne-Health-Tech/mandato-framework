import type { JobRequest, WebModule } from '../../../../../packages/core-contracts/src/index';

const greet = (): JobRequest => ({ queue: 'hello.greet', data_class: 'C1', payload: {} });

const web: WebModule = {
  routes: [{ path: '/hello', permission: 'demo.hello.read', load: async () => ({ default: () => null }) }],
  contentEnrichers: [{ id: 'hello.on_save', onSave: () => greet() }],
};
export default web;
