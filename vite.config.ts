import { defineConfig, type Plugin } from 'vite'
import { createApiHandler } from './src/server/api'

function interferometryApi(): Plugin {
  return {
    name: 'interferometry-api',
    configureServer(server) {
      const dbPath = process.env.GSB_DB_PATH ?? '.data/app.db'
      const handler = createApiHandler({ dbPath, casepackDir: 'casepack/interferometry-stripe-book' })
      server.middlewares.use('/api', (req, res, next) => {
        void handler(req, res).catch(next)
      })
    },
  }
}

export default defineConfig({
  plugins: [interferometryApi()],
  server: { strictPort: true },
})
