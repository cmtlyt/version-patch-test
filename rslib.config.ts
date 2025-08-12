import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [
    {
      format: 'esm',
      syntax: ['node 20'],
      dts: true,
      bundle: true,
      autoExternal: {
        dependencies: false,
      },
      output: {
        target: 'node',
      },
    },
  ],
});
