import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: {
    include: ['chart.js', 'chartjs-plugin-datalabels', 'papaparse', '@supabase/supabase-js'],
  },
})
