import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),base:'./',envDir:false,server:{fs:{allow:[fileURLToPath(new URL('../..',import.meta.url))]}},build:{outDir:'dist',emptyOutDir:true},test:{include:['tests/**/*.test.ts'],environment:'node'}});
