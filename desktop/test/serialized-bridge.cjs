'use strict';
// HOST/CONTRACT seam, not Electron isolated-world proof. Each function result
// is JSON serialized into a different VM. Rejected Errors are reconstructed
// with message only: no custom properties survive this simulated boundary.
const fs = require('node:fs'); const vm = require('node:vm'); const path = require('node:path');
function serializedBridge(renderer, dispatch) {
  let exposed;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    TextEncoder,
    require: name => {
      if (name !== 'electron') throw Error('Unexpected preload import');
      return { contextBridge: { exposeInMainWorld: (name, value) => { exposed = value; } }, ipcRenderer: {
        invoke: async (channel, value) => JSON.parse(JSON.stringify(await dispatch(channel, value === undefined ? undefined : JSON.parse(JSON.stringify(value))))),
        on() {}, removeListener() {}
      } };
    }
  });
  const copy = value => vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(value)) + ')', renderer);
  const bridge = {};
  for (const name of ['request', 'saveExport', 'close']) bridge[name] = async (...args) => {
    try { return copy(await exposed[name](...args)); }
    catch (error) { throw vm.runInContext('new Error(' + JSON.stringify(error.message) + ')', renderer); }
  };
  bridge.onEngineState = () => () => {};
  Object.defineProperty(renderer.window, 'GridBaseNative', { value: Object.freeze(bridge), writable: false, configurable: false });
  return bridge;
}
module.exports = { serializedBridge };
