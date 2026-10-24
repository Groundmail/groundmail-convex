import { defineApp } from 'convex/server'
import groundmail from '../../src/component/convex.config.js'

const app = defineApp()
app.use(groundmail)

export default app
