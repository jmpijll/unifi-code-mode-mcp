// Test-only preload: exercise bundled specs without contacting a tenant or upstream CDN.
import { MockAgent, setGlobalDispatcher } from 'undici';

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);
