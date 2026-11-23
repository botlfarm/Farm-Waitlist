import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    include: ['tests/backend/**/*.test.ts', 'tests/frontend/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 15000,
  },
});
