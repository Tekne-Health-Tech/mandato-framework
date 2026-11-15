import type { MobileModule } from '../../../../../packages/core-contracts/src/index';

const mobile: MobileModule = {
  screens: [{ id: 'hello', variant: 'citizen', load: async () => ({ default: () => null }) }],
};
export default mobile;
